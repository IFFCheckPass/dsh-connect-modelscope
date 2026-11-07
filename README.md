# dsh-connect-modelscope

把 [魔搭社区（ModelScope）](https://modelscope.cn) 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 bundle 插件。

装上之后：

- **「模型」设置页出现 ModelScope 条目** —— 与 Trae 等其他连接器并列，点进去可管理。
- **对话栏显示剩余魔粒** —— 严格读取：只在当前会话选中的是 ModelScope 模型时出现，形如 `魔粒 550`，纯文本、无边框，点击刷新；选了别的 provider 时一律隐藏。
- **插件设置页配置 provider** —— 粘贴 ModelScope 访问令牌，勾选要发布给 DSH 的模型（默认全部对话模型）。
- 模型列表从 `https://api-inference.modelscope.cn/v1/models` 实时拉取，新上架的模型自动出现，不用改配置。

## 功能

| 能力 | 说明 |
|---|---|
| Provider | 注册 `modelscope` 路由，OpenAI 兼容端点 `https://api-inference.modelscope.cn/v1` |
| 模型目录 | 每次保存配置后重新拉取；自动跳过图像 / 视频 / 音频 / 向量模型（DSH 驱动不了它们） |
| 魔粒余额 | 官方 OpenAPI `GET /openapi/v1/magicubes/balance`，45 秒缓存，点击立即刷新 |
| 令牌 | 存进 DSH 自己的 credentials 服务，插件配置文件里不落明文 |
| 零配置 | 已存在 `MODELSCOPE_API_KEY`（凭据库或环境变量）时直接复用，不用重填 |

## 安装

在 DeepSeek Harness 里安装 bundle：

```bash
# 从 npm
dsh plugin add dsh-connect-modelscope --profile <profile>

# 或者本地目录（开发时）
# plugin_manager → install_bundle → 指向本仓库目录
```

安装后重启 DSH（host 半只在启动时加载）。

## 配置

1. 打开 设置 → 插件 → **魔搭连接器**。
2. 到 [访问令牌](https://modelscope.cn/my/myaccesstoken) 生成一个 `ms-` 开头的令牌，粘贴进「访问令牌」并点「保存令牌」。
3. 在「启用模型」里勾选要用的模型，点「保存模型」。
4. 在对话的模型选择器里选 ModelScope 下的模型，输入框左侧就会出现魔粒读数。

## 关于魔粒

- 魔粒**按「模型请求」计费**，不是按 token。一次对话在 agent 循环里通常是多次请求（每轮工具调用一次），所以长任务消耗会比直觉快很多。
- 官方要求账号绑定阿里云中国站并完成实名认证，否则推理接口返回 401。
- 官方声明：API 请勿用于需要高并发或 SLA 保障的线上任务。
- 余额耗尽时上游返回 `QuotaLimitExceed` / `E3027`，插件会显示「魔粒 不足」。

## 已知限制

- **没有单价接口**：魔搭不对外提供每个模型的魔粒单价，价格只渲染在模型详情页上。因此本插件**不显示单价**，避免给出错误数字。
- **上下文窗口是估的**：`/v1/models` 不返回 context window，插件统一报 `131072`（128K）这个保守值。窗口报小只会让 DSH 早一点压缩上下文；需要更贴近真实值时，在 设置 → 模型 → ModelScope 的 `contextWindows` 里按模型覆盖（0.2.0 起，改完即生效），或在 `~/.dsh/modelscope.json` 里加 `contextWindows`（两处会合并，设置页优先）：

  ```json
  {
    "enabledModelIds": null,
    "contextWindows": { "deepseek-ai/DeepSeek-V4-Pro": 262144 }
  }
  ```

- 只发布**文本对话**模型；图像、视频、音频、embedding 类会被跳过并在卡片里列出。
- 需要账号侧先能跑通一次推理（绑阿里云 + 实名），否则余额能读、模型能选，但请求会 401。

## 目录结构

```
index.js            host 半：注册 provider、余额路由、配置读写
client.js           client 半：输入框读数 + 设置卡片（无构建步骤）
cordis.patch.yml    bundle 的 loader patch
locale/{en,zh}.json 插件标题与描述
icon.svg            图标
prices.json         可选的单价表（当前为空，见「已知限制」）
```

## 实现要点

- 复用官方 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 与 pi-ai 的 `openAICompletionsApi`，不自写 SSE 转换。
- 浏览器拿不到令牌：client 半只读插件自己的同源路由 `/plugins/dsh-connect-modelscope/*`，该路由只接受回环来源。
- 模型描述符必须带正整数 `contextWindow`，否则 DSH 会用 `INVALID_MODEL_CONTEXT` 拒掉整条 provider 路由。

## 版本记录

### 0.2.1

- peer 范围按插件市场指南加显式预发布分支：`>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`。node-semver 的规则会静默排除不带同元组预发布比较符的 rc 构建，旧写法在 DeepSeek Harness 出 `0.2.0-rc.*` 时会让用户 `ERESOLVE`；纯元数据改动，已对 `0.1.7-rc.5 / 0.1.7 / 0.2.0-rc.1 / 0.2.0` 逐一验证。

### 0.2.0

- 「模型」设置页新增 ModelScope 条目：导出 settings schema（此前没有 schema，目录 join 找不到命名空间，整行被页面隐藏）；同场加 `registerModelDiscovery`，模型目录探测与 trae 同一通道。
- 对话栏魔粒读数改为严格读取：选中 provider 无法确定或不是 ModelScope 时一律隐藏（0.1.x 在读不到选中状态时常驻显示）。
- `contextWindows` 覆盖可以在设置页编辑（volatile，即时生效），与 `modelscope.json` 合并、设置页优先。
- 0.1.x 的同源放行热修（Origin 的 host:port 与 Host 头一致时放行，局域网 IP 访问 GUI 时配置卡片才可用）收编进源码。

## License

MIT
