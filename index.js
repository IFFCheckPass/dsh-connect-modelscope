/**
 * Host half of dsh-connect-modelscope.
 *
 * Owns the `modelscope` LLM provider (OpenAI-compatible endpoint) and serves the
 * same-origin routes the Client half uses for the magicube-balance readout and
 * the provider configuration card (access token + which models to publish).
 *
 * The transport is the shipped pi-ai adapter reused exactly the way
 * dsh-connect-trae reuses it: build a pi `provider` over `openAICompletionsApi`,
 * wrap it in a profile, hand that to `PiAiAdapter`. No custom SSE conversion.
 */
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER_ID = 'modelscope';
const PROVIDER_NAME = 'ModelScope';
const API_BASE = 'https://api-inference.modelscope.cn/v1';
const BALANCE_URL = 'https://modelscope.cn/openapi/v1/magicubes/balance';
const TOKEN_URL = 'https://modelscope.cn/my/myaccesstoken';
const KEY_ENV = 'MODELSCOPE_API_KEY';
const ROUTE_BASE = '/plugins/dsh-connect-modelscope';
const STATE_PATH = `${ROUTE_BASE}/state`;
const CONFIG_PATH = `${ROUTE_BASE}/config`;
const CONFIG_FILENAME = 'modelscope.json';

const CATALOG_TTL_MS = 10 * 60 * 1000;
const BALANCE_TTL_MS = 45 * 1000;
const TOKEN_TTL_MS = 60 * 1000;
const FALLBACK_CONTEXT_WINDOW = 200000;
const BODY_LIMIT = 64 * 1024;

/**
 * Context window every model reports to DSH.
 *
 * `/v1/models` publishes `id/object/owned_by/created` and nothing else, so there
 * is no window to read. DSH REJECTS a model whose `contextWindow` is not a
 * positive integer (`INVALID_MODEL_CONTEXT`) — an omitted window is a load
 * failure, not a cosmetic gap — so every descriptor must carry a number.
 *
 * 131072 is a deliberately conservative placeholder: understating a window only
 * makes DSH compact earlier, while overstating one sends an oversized request
 * upstream. `modelscope.json` may carry a `contextWindows` map
 * (`{"<model id>": 262144}`) for models whose real window is known.
 */
const DEFAULT_CONTEXT_WINDOW = 131072;

/** Useful window for one model, honoring the optional per-model override. */
function contextWindowOf(id, overrides) {
  const override = overrides?.[id];
  if (Number.isInteger(override) && override > 0) return override;
  return DEFAULT_CONTEXT_WINDOW;
}

/** Request budgets the shipped adapter expects on a profile. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

/** pi-ai credential lifecycle we do not implement; the adapter never touches it. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error('dsh-connect-modelscope has no pi-ai credential lifecycle'); },
    async delete() {},
  },
  authContext: { async env() {}, async fileExists() { return false; } },
};

const here = dirname(fileURLToPath(import.meta.url));

/** `<dshHome>/modelscope.json` — user-facing config, same convention as dsh-plugin-memory. */
function configFilePath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), CONFIG_FILENAME);
}

/**
 * Per-call prices transcribed from the model pages (ModelScope publishes no price
 * API; the number is rendered client-side only). Sparse on purpose: an unpriced
 * model simply shows its bare name.
 */
function loadPriceTable() {
  for (const candidate of [join(here, 'prices.json'), join(here, '..', 'prices.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      const rows = Array.isArray(parsed) ? parsed : parsed.models;
      if (Array.isArray(rows)) return rows;
    } catch {}
  }
  return [];
}

const KIND_RE = {
  video: /(^|[\/-])(wan|hunyuanvideo|videocomposer|cogvideox|i2v|t2v|vace|animate)/i,
  image: /(image|flux|kolors|sd[-_]?xl|stable-diffusion|z-image|qwen-image|seedream)/i,
  audio: /(speech|tts|asr|whisper|audio|voice|cosyvoice)/i,
  embed: /(embedding|rerank|bge-|gte-)/i,
};

function kindOf(id) {
  const hits = [];
  for (const [kind, re] of Object.entries(KIND_RE)) if (re.test(id)) hits.push(kind);
  if (hits.includes('video')) return 'video';
  if (hits.includes('image')) return 'image';
  if (hits.includes('audio')) return 'audio';
  if (hits.includes('embed')) return 'embed';
  return 'chat';
}

/** `deepseek-ai/DeepSeek-V4.1-Flash-1017` -> `DeepSeek V4.1 Flash 1017`, plus the price when known. */
function displayName(id, price) {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const base = tail.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (price === undefined || price === null) return base;
  return `${base} · ${price}魔粒`;
}

function unwrapCredential(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  const direct = ['value', 'secret', 'key', 'apiKey', 'token'];
  for (const field of direct) {
    if (typeof value[field] === 'string' && value[field].length > 0) return value[field];
  }
  if (value.credential && typeof value.credential.key === 'string' && value.credential.key.length > 0) {
    return value.credential.key;
  }
  for (const nested of ['data', 'record', 'resolved']) {
    if (value[nested]) {
      const inner = unwrapCredential(value[nested]);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** A token that never contains whitespace and looks like a ModelScope access token. */
function sanitizeToken(raw) {
  if (typeof raw !== 'string') return undefined;
  const token = raw.trim();
  if (token.length === 0 || token.length > 512) return undefined;
  if (/\s/.test(token)) return undefined;
  return token;
}

export const name = 'dsh-connect-modelscope';
export const inject = ['llm'];

export function apply(ctx) {
  const prices = new Map();
  for (const row of loadPriceTable()) {
    if (!row || typeof row.id !== 'string') continue;
    const cost = typeof row.cost === 'number' ? row.cost : Number(row.cost);
    if (Number.isFinite(cost)) prices.set(row.id, cost);
  }

  /* ---------------------------------------------------------------- config */

  let config = { enabledModelIds: null, token: undefined };
  /** Loader entry id of this plugin instance; the settings namespace is keyed by it. */
  const entryId = (() => {
    const id = ctx?.fiber?.entry?.options?.id;
    return typeof id === 'string' && id.length > 0 ? id : name;
  })();

  function readConfig() {
    try {
      const path = configFilePath();
      if (!existsSync(path)) return { enabledModelIds: null, token: undefined, contextWindows: undefined };
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const ids = Array.isArray(parsed?.enabledModelIds)
        ? parsed.enabledModelIds.filter((id) => typeof id === 'string' && id.length > 0)
        : null;
      const contextWindows = {};
      if (parsed?.contextWindows && typeof parsed.contextWindows === 'object') {
        for (const [id, value] of Object.entries(parsed.contextWindows)) {
          if (Number.isInteger(value) && value > 0) contextWindows[id] = value;
        }
      }
      return {
        enabledModelIds: ids,
        token: sanitizeToken(parsed?.token),
        contextWindows: Object.keys(contextWindows).length > 0 ? contextWindows : undefined,
      };
    } catch {
      return { enabledModelIds: null, token: undefined, contextWindows: undefined };
    }
  }

  function writeConfig(next) {
    const path = configFilePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const body = {
        enabledModelIds: next.enabledModelIds ?? null,
        // Only written when the credentials service refused to hold the token.
        ...(next.token === undefined ? {} : { token: next.token }),
        ...(next.contextWindows === undefined ? {} : { contextWindows: next.contextWindows }),
      };
      writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  config = readConfig();

  /* ----------------------------------------------------------- credentials */

  let cachedToken;
  let tokenCheckedAt = 0;

  function dropTokenCache() {
    cachedToken = undefined;
    tokenCheckedAt = 0;
  }

  async function accessToken(force = false) {
    const now = Date.now();
    if (!force && cachedToken !== undefined && now - tokenCheckedAt < TOKEN_TTL_MS) return cachedToken;
    tokenCheckedAt = now;
    cachedToken = undefined;
    try {
      const credentials = ctx.get('credentials');
      if (credentials && typeof credentials.resolve === 'function') {
        cachedToken = unwrapCredential(await credentials.resolve(KEY_ENV));
      }
    } catch {}
    if (cachedToken === undefined) {
      const fromEnv = process.env[KEY_ENV];
      if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) cachedToken = fromEnv.trim();
    }
    if (cachedToken === undefined) cachedToken = config.token;
    return cachedToken;
  }

  /** Store the token in the host credential store; fall back to the private config file. */
  async function saveToken(token) {
    let stored = 'credentials';
    try {
      const credentials = ctx.get('credentials');
      if (!credentials || typeof credentials.set !== 'function') throw new Error('no credentials service');
      await credentials.set(KEY_ENV, token);
    } catch {
      stored = 'config-file';
    }
    dropTokenCache();
    return stored;
  }

  /* -------------------------------------------------------------- catalog */

  let catalog = { at: 0, models: [] };
  let lastCatalogError;

  async function loadCatalog(force = false) {
    const now = Date.now();
    if (!force && catalog.models.length > 0 && now - catalog.at < CATALOG_TTL_MS) return catalog.models;
    try {
      const headers = { accept: 'application/json' };
      const token = await accessToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${API_BASE}/models`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const rows = Array.isArray(body?.data) ? body.data : [];
      const models = [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : undefined;
        if (!id) continue;
        const kind = kindOf(id);
        models.push({ id, kind, price: prices.get(id), chat: kind === 'chat' });
      }
      models.sort((a, b) => a.id.localeCompare(b.id));
      catalog = { at: now, models };
      lastCatalogError = undefined;
      return models;
    } catch (error) {
      lastCatalogError = error instanceof Error ? error.message : String(error);
      return catalog.models;
    }
  }

  /** Chat models, narrowed by the user's selection (null = every chat model). */
  function enabledModels() {
    const chat = catalog.models.filter((model) => model.chat);
    const ids = config.enabledModelIds;
    if (ids === null) return chat;
    const allowed = new Set(ids);
    return chat.filter((model) => allowed.has(model.id));
  }

  /** pi-ai model descriptors; rebuilt each call so a refreshed catalog or selection wins. */
  function buildPiModels() {
    return enabledModels().map((model) => ({
      id: model.id,
      name: displayName(model.id, model.price),
      api: 'openai-completions',
      provider: PROVIDER_ID,
      baseUrl: API_BASE,
      input: ['text'],
      // Required: DSH rejects a route whose contextWindow is not a positive
      // integer, so this field is never omitted.
      contextWindow: contextWindowOf(model.id, config.contextWindows),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
    }));
  }

  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      auth: {
        apiKey: {
          name: 'ModelScope access token',
          async resolve() {
            const token = await accessToken();
            return token === undefined ? undefined : { auth: { apiKey: token }, source: 'ModelScope' };
          },
        },
      },
      models: buildPiModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildPiModels(),
  };

  const profile = {
    provider: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    streamIdleTimeoutMs: 180000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-modelscope retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    defaultContextWindow: FALLBACK_CONTEXT_WINDOW,
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  const adapter = new PiAiAdapter({
    profiles: () => new Map([[PROVIDER_ID, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => accessToken(),
  });

  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter));

  /* ------------------------------------------------------- provider directory */

  // Declaring the route in the configurable-provider directory is what makes the
  // settings surface and the credential readers aware of it. It is optional for
  // the readout, so a host without it (or a declaration conflict) must not take
  // the whole plugin down with it.
  const providerEntry = {
    provider: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    settingsNs: entryId,
    settingsPath: [],
  };

  ctx.effect(() => {
    if (typeof ctx.llm.registerConfigurableProviders !== 'function') return;
    let directory;
    try {
      directory = ctx.llm.registerConfigurableProviders([providerEntry]);
    } catch (error) {
      console.error('[dsh-connect-modelscope] provider directory registration failed', error);
      return;
    }
    return () => {
      try {
        directory();
      } catch {}
    };
  });

  /* -------------------------------------------------------------- balance */

  let balanceCache;
  async function readBalance(force) {
    const now = Date.now();
    if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.state;
    const token = await accessToken(force);
    if (token === undefined) {
      balanceCache = { at: now, state: { configured: false, error: 'missing-token', tokenUrl: TOKEN_URL } };
      return balanceCache.state;
    }
    try {
      const response = await fetch(BALANCE_URL, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.success === false) {
        const code = body?.code ?? `HTTP ${response.status}`;
        balanceCache = {
          at: now,
          state: { configured: true, error: code, message: body?.message, tokenUrl: TOKEN_URL },
        };
        return balanceCache.state;
      }
      const data = body?.data ?? {};
      const state = {
        configured: true,
        available: Number(data.available_balance ?? data.total_balance ?? 0),
        frozen: Number(data.frozen_amount ?? 0),
        total: Number(data.total_balance ?? data.available_balance ?? 0),
        error: undefined,
        at: new Date().toISOString(),
        tokenUrl: TOKEN_URL,
      };
      balanceCache = { at: now, state };
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      balanceCache = { at: now, state: { configured: true, error: 'unreachable', message, tokenUrl: TOKEN_URL } };
      return balanceCache.state;
    }
  }

  /* ----------------------------------------------------------------- http */

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  function loopbackOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const { hostname } = new URL(origin);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
    } catch {
      return false;
    }
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.byteLength ?? chunk.length ?? 0;
      if (size > BODY_LIMIT) throw new Error('request body too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    return JSON.parse(text);
  }

  function statePayload() {
    const chat = catalog.models.filter((model) => model.chat);
    const enabled = enabledModels();
    return {
      build: 'r3',
      provider: providerEntry,
      balance: balanceCache?.state ?? { configured: false, error: 'missing-token', tokenUrl: TOKEN_URL },
      tokenUrl: TOKEN_URL,
      catalog: {
        total: catalog.models.length,
        chat: chat.length,
        skipped: catalog.models.length - chat.length,
        enabled: enabled.length,
        error: lastCatalogError,
        models: chat.map((model) => ({
          id: model.id,
          name: displayName(model.id, model.price),
          price: model.price ?? null,
          contextWindow: contextWindowOf(model.id, config.contextWindows),
          enabled: config.enabledModelIds === null || config.enabledModelIds.includes(model.id),
        })),
        incompatible: catalog.models
          .filter((model) => !model.chat)
          .map((model) => ({ id: model.id, kind: model.kind })),
      },
    };
  }

  ctx.inject(['webServer'], (webCtx) => {
    const disposers = [];

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
          if (!loopbackOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
          try {
            const url = new URL(req.url ?? STATE_PATH, 'http://127.0.0.1');
            const force = url.searchParams.get('refresh') === '1';
            await loadCatalog(force);
            if (force) await readBalance(true);
            else await readBalance(false);
            json(res, 200, statePayload());
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );

    disposers.push(
      webCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (req, res) => {
          if (!loopbackOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          try {
            const body = await readJsonBody(req);
            const next = { ...config };
            let stored;

            if (body.token !== undefined) {
              if (body.token === null || body.token === '') {
                try {
                  const credentials = ctx.get('credentials');
                  if (credentials && typeof credentials.unset === 'function') await credentials.unset(KEY_ENV);
                } catch {}
                next.token = undefined;
                dropTokenCache();
                stored = 'cleared';
              } else {
                const token = sanitizeToken(body.token);
                if (token === undefined) return json(res, 400, { error: 'invalid token' });
                stored = await saveToken(token);
                next.token = stored === 'config-file' ? token : undefined;
              }
            }

            if (body.enabledModelIds !== undefined) {
              if (body.enabledModelIds === null) {
                next.enabledModelIds = null;
              } else if (Array.isArray(body.enabledModelIds)) {
                const ids = body.enabledModelIds.filter((id) => typeof id === 'string' && id.length > 0);
                next.enabledModelIds = ids;
              } else {
                return json(res, 400, { error: 'enabledModelIds must be an array or null' });
              }
            }

            config = next;
            const saved = writeConfig(config);
            // A new token invalidates every cached reading.
            await loadCatalog(true);
            const balance = await readBalance(true);
            json(res, 200, { ...statePayload(), balance, saved, tokenStoredIn: stored });
          } catch (error) {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {}
      }
    };
  });

  // Warm both caches so the first painted readout is not empty.
  void loadCatalog().catch(() => {});
  void readBalance(false).catch(() => {});
}
