/**
 * Client half of dsh-connect-modelscope.
 *
 * Two pieces of UI, both fed by the Host half's same-origin routes (the access
 * token never leaves the Host):
 *
 * 1. `conversation.input.left` — a plain-text magicube readout, `魔粒 550`. The
 *    form follows dsh-connect-trae's composer readout: no border, no fill at
 *    rest, 12px tertiary text, tabular figures. It is secondary information and
 *    must not shout at the composer row. It is NOT gated on the selected
 *    provider: the magicubes belong to the account, so the readout stays useful
 *    while another provider is selected.
 * 2. `plugins.bundle.config` — the provider configuration card: paste the
 *    access token, tick which models to publish.
 */
window.__ModuleLoader__.load({
  id: 'dsh-connect-modelscope',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATE_PATH = '/plugins/dsh-connect-modelscope/state';
    const CONFIG_PATH = '/plugins/dsh-connect-modelscope/config';
    const PROVIDER_ID = 'modelscope';
    const POLL_MS = 60000;
    const LOW_BALANCE = 50;

    const CSS = `
.dsm-ms-root{display:inline-flex;align-items:center;min-width:0}
.dsm-ms-trigger{appearance:none;display:inline-flex;align-items:center;align-self:stretch;padding:2px 6px;border:0;border-radius:6px;background:transparent;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}
.dsm-ms-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-ms-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-ms-trigger[data-warn="1"]{color:var(--dsw-alias-text-warning,#c98a00)}
.dsm-ms-card{display:flex;flex-direction:column;gap:14px;padding:4px 0 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#444)}
.dsm-ms-section{display:flex;flex-direction:column;gap:8px}
.dsm-ms-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);letter-spacing:.02em}
.dsm-ms-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-ms-input{flex:1 1 260px;min-width:0;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:8px;background:var(--dsw-alias-bg-primary,Field);color:inherit;font:inherit;font-variant-numeric:tabular-nums}
.dsm-ms-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-ms-button{appearance:none;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:8px;background:var(--dsw-alias-interactive-bg,rgba(127,127,127,.08));color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.dsm-ms-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-ms-button[disabled]{opacity:.5;cursor:default}
.dsm-ms-ghost{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;font:inherit;padding:0 2px;text-decoration:underline;text-underline-offset:2px}
.dsm-ms-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px 12px;max-height:320px;overflow:auto;padding:6px 2px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:10px}
.dsm-ms-item{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 4px;border-radius:6px;font-size:12px;line-height:18px}
.dsm-ms-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-ms-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-ms-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-ms-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-text-warning,#c98a00)}
.dsm-ms-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-text-success,#2e9e5b)}
.dsm-ms-link{color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:none}
.dsm-ms-link:hover{text-decoration:underline}
`;

    let styleInjected = false;
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return;
      styleInjected = true;
      const style = document.createElement('style');
      style.setAttribute('data-dsh-connect-modelscope', '');
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    async function getJson(path) {
      const response = await fetch(path, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    function exhausted(code) {
      return code === 'QuotaLimitExceed' || code === 'E3027';
    }

    function balanceText(state) {
      if (!state) return '魔粒 …';
      const balance = state.balance ?? {};
      if (balance.configured === false) return '魔粒 未配置';
      if (typeof balance.available === 'number') return `魔粒 ${balance.available}`;
      if (exhausted(balance.error)) return '魔粒 不足';
      return '魔粒 ?';
    }

    function balanceTitle(state, error) {
      if (error && !state) return `读取失败：${error}`;
      if (!state) return '正在读取魔搭魔粒余额';
      const balance = state.balance ?? {};
      if (balance.configured === false) return `未配置 ModelScope 访问令牌，点此打开令牌页 ${state.tokenUrl ?? ''}`;
      if (balance.error) {
        return `${exhausted(balance.error) ? '魔粒已用尽' : `读取失败：${balance.error}`}。点击重试`;
      }
      const parts = [`可用 ${balance.available}`];
      if (typeof balance.frozen === 'number' && balance.frozen > 0) parts.push(`预扣 ${balance.frozen}`);
      if (typeof balance.total === 'number' && balance.total !== balance.available) parts.push(`合计 ${balance.total}`);
      const skipped = state.catalog?.skipped ?? 0;
      if (skipped > 0) parts.push(`已跳过 ${skipped} 个非对话模型`);
      parts.push('点击刷新');
      return parts.join(' · ');
    }

    /** The provider the current Session is set to, from the modelSelection projection. */
    function selectedProviderOf(projection) {
      const provider = (projection?.next ?? projection?.lastUsed)?.provider;
      return typeof provider === 'string' && provider !== '' ? provider : undefined;
    }

    function BalanceReadout(props) {
      // `useProjection` arrives as a standard slot prop (the same hook
      // dsh-connect-trae's composer readout uses).
      const useProjection = props?.useProjection;
      const projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
      const provider = selectedProviderOf(projection);

      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const alive = React.useRef(true);

      const load = React.useCallback(async (force) => {
        setBusy(true);
        try {
          const next = await getJson(STATE_PATH + (force ? '?refresh=1' : ''));
          if (alive.current) {
            setState(next);
            setError(null);
          }
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (alive.current) setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        alive.current = true;
        void load(false);
        const timer = setInterval(() => void load(false), POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, [load]);

      // Magicubes only pay for ModelScope calls, so the readout belongs to a
      // ModelScope selection — the same rule dsh-connect-trae applies to its own
      // providers. When the projection cannot say who is selected, the readout
      // stays visible rather than guessing.
      if (provider !== undefined && provider !== PROVIDER_ID) return null;

      const balance = state?.balance ?? {};
      const available = balance.available;
      const low = typeof available === 'number' && available < LOW_BALANCE;
      const unconfigured = balance.configured === false;
      const text = error && !state ? '魔粒 读取失败' : balanceText(state);
      // A spent account is as actionable as an unconfigured one: both want the
      // user to look at the ModelScope page, so both take the warning colour.
      const warn = unconfigured || low || exhausted(balance.error);

      const onClick = () => {
        if (unconfigured && state?.tokenUrl) {
          window.open(state.tokenUrl, '_blank', 'noreferrer,noopener');
          return;
        }
        void load(true);
      };

      return h(
        'span',
        { className: 'dsm-ms-root' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsm-ms-trigger',
            onClick,
            title: balanceTitle(state, error),
            'aria-label': text,
            'aria-busy': busy ? 'true' : 'false',
            'data-warn': warn ? '1' : '0',
            'data-dsh-connect-modelscope-balance': '',
          },
          text,
        ),
      );
    }

    function SettingsCard() {
      const [state, setState] = React.useState(null);
      const [token, setToken] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const alive = React.useRef(true);

      const adopt = React.useCallback((next) => {
        setState(next);
        const models = next?.catalog?.models ?? [];
        const picked = models.filter((model) => model.enabled).map((model) => model.id);
        setDraft({ enabledModelIds: picked, loaded: models.length });
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const next = await getJson(STATE_PATH);
          if (alive.current) adopt(next);
        } catch (cause) {
          if (alive.current) setFailure(cause instanceof Error ? cause.message : String(cause));
        }
      }, [adopt]);

      React.useEffect(() => {
        alive.current = true;
        void refresh();
        return () => {
          alive.current = false;
        };
      }, [refresh]);

      const models = state?.catalog?.models ?? [];
      const balance = state?.balance ?? {};
      const incompatible = state?.catalog?.incompatible ?? [];
      const selected = draft?.enabledModelIds ?? [];
      const selectedSet = new Set(selected);
      const savedCount = state?.catalog?.enabled ?? 0;
      const dirty = draft !== null && draft.loaded > 0 && selected.length !== savedCount;

      const toggle = (id) => {
        setDraft((current) => {
          if (current === null) return current;
          const set = new Set(current.enabledModelIds);
          if (set.has(id)) set.delete(id);
          else set.add(id);
          return { ...current, enabledModelIds: [...set] };
        });
        setMessage(null);
      };

      const selectAll = () => {
        setDraft({ enabledModelIds: models.map((model) => model.id), loaded: models.length });
        setMessage(null);
      };

      const selectNone = () => {
        setDraft({ enabledModelIds: [], loaded: models.length });
        setMessage(null);
      };

      const submit = async (body, note) => {
        setBusy(true);
        setFailure(null);
        setMessage(null);
        try {
          const next = await postJson(CONFIG_PATH, body);
          if (!alive.current) return;
          adopt(next);
          setToken('');
          setMessage(note);
        } catch (cause) {
          if (alive.current) setFailure(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const saveToken = () => {
        const value = token.trim();
        if (value === '') return;
        void submit({ token: value }, '令牌已保存。');
      };

      const tokenLine = balance.configured === false
        ? h('span', { className: 'dsm-ms-warn' }, '未配置令牌')
        : balance.error
          ? h('span', { className: 'dsm-ms-warn' }, `令牌可用，但余额读取失败：${balance.error}`)
          : h('span', { className: 'dsm-ms-ok' }, `令牌可用 · 剩余魔粒 ${balance.available}`);

      return h(
        'div',
        { className: 'dsm-ms-card' },
        h(
          'div',
          { className: 'dsm-ms-section' },
          h('div', { className: 'dsm-ms-label' }, '访问令牌'),
          h(
            'div',
            { className: 'dsm-ms-row' },
            h('input', {
              className: 'dsm-ms-input',
              type: 'password',
              placeholder: '粘贴 ms- 开头的 ModelScope 访问令牌',
              value: token,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setToken(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') saveToken();
              },
            }),
            h(
              'button',
              { type: 'button', className: 'dsm-ms-button', disabled: busy || token.trim() === '', onClick: saveToken },
              '保存令牌',
            ),
            h(
              'button',
              { type: 'button', className: 'dsm-ms-button', disabled: busy, onClick: () => void submit({ token: '' }, '令牌已清除。') },
              '清除',
            ),
          ),
          h(
            'div',
            { className: 'dsm-ms-note' },
            tokenLine,
            ' · ',
            h(
              'a',
              {
                className: 'dsm-ms-link',
                href: state?.tokenUrl ?? 'https://modelscope.cn/my/myaccesstoken',
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              '打开令牌页',
            ),
            '（令牌只保存在本机，浏览器拿不到明文）',
          ),
        ),
        h(
          'div',
          { className: 'dsm-ms-section' },
          h(
            'div',
            { className: 'dsm-ms-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'dsm-ms-label' }, `启用模型 · ${selected.length}/${models.length}`),
            h(
              'div',
              { className: 'dsm-ms-row', style: { gap: '10px' } },
              h('button', { type: 'button', className: 'dsm-ms-ghost', onClick: selectAll }, '全选'),
              h('button', { type: 'button', className: 'dsm-ms-ghost', onClick: selectNone }, '全不选'),
              h(
                'button',
                { type: 'button', className: 'dsm-ms-button', disabled: busy || !dirty, onClick: () => void submit({ enabledModelIds: selected }, `已启用 ${selected.length} 个模型。`) },
                '保存模型',
              ),
            ),
          ),
          models.length === 0
            ? h(
                'div',
                { className: 'dsm-ms-note' },
                state?.catalog?.error ? `模型目录读取失败：${state.catalog.error}` : '正在读取模型目录…',
              )
            : h(
                'div',
                { className: 'dsm-ms-list' },
                models.map((model) =>
                  h(
                    'label',
                    {
                      key: model.id,
                      className: 'dsm-ms-item',
                      title: `${model.id} · ${typeof model.price === 'number' ? `${model.price}魔粒/次` : '单价未知'}`,
                    },
                    h('input', { type: 'checkbox', checked: selectedSet.has(model.id), onChange: () => toggle(model.id) }),
                    h('span', { className: 'dsm-ms-name' }, model.name),
                  ),
                ),
              ),
          h(
            'div',
            { className: 'dsm-ms-note' },
            `目录共 ${state?.catalog?.total ?? 0} 个模型，其中 ${models.length} 个可用于对话。`,
            incompatible.length > 0
              ? ` 已跳过 ${incompatible.length} 个非对话模型（DSH 不支持图像/视频/音频）：${incompatible
                  .map((row) => row.id)
                  .join('、')}`
              : '',
          ),
          h(
            'div',
            { className: 'dsm-ms-note' },
            '魔粒按「模型请求」计费，一次对话在 agent 循环里通常是多次请求。魔搭声明：请勿用于需要高并发或 SLA 保障的线上任务。',
          ),
        ),
        message === null ? null : h('div', { className: 'dsm-ms-ok' }, message),
        failure === null ? null : h('div', { className: 'dsm-ms-warn' }, `操作失败：${failure}`),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle();

        try {
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              { name: 'conversation.input.left', id: 'modelscope-balance', order: 40 },
              BalanceReadout,
            ),
          );
        } catch (error) {
          console.error('[dsh-connect-modelscope] composer readout failed to register', error);
        }

        try {
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: 'dsh-connect-modelscope', priority: 30 },
              SettingsCard,
            ),
          );
        } catch (error) {
          console.error('[dsh-connect-modelscope] settings card failed to register', error);
        }
      },
    };
  },
});
