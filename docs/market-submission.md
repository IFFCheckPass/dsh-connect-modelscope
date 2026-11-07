# 插件市场收录准备（awesome-dsh-plugin）

对照 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 的收录要求逐项核对。
投稿动作本身等主人验收 0.2.0 后再执行（一个 PR 只加一个文件）。

## 硬性要求核对

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` manifest（含 `cordis.patch.yml`） | ✓ bundle.patch + client 都在 |
| 仓库有真实可用代码 | ✓ |
| 仓库创建满 1 天 | ✓（2026-10-30 建） |
| 活跃维护 | ✓ |
| 仓库 topic 含 `dsh-plugin` | ✓（另有 deepseek-harness / magicube / model-provider / modelscope） |
| 描述只说功能、无营销词、与代码一致 | 见下方草稿，逐句可核 |
| 一个 PR 最多 3 条 | 本投稿只 1 条 |
| 官方 `@deepseek-ai/*` 包用 peerDependencies | ✓（待办见 0.2.1 一节） |

## 推荐项核对

| 推荐 | 状态 |
|---|---|
| npm 发布（免 allowBuilds 构建授权） | ✓ 0.2.0 在 npm，`latest` 指向它 |
| npm `repository` 字段指回本仓库（自动关联下载量） | ✓ |
| 预构建 tarball（`tarball:` 字段） | 不需要——npm 已发布 |
| 市场卡片图标 `icon:` | ✓ `assets/icon-512.png`（GitHub 托管位图，PNG；SVG 不收） |
| 截图 `screenshots.json`（1–8 张） | 待 0.2.0 本地升级后截图，见下 |

## 条目 YAML 草稿

投稿 = 在 `awesome-dsh-plugin` 仓库开 PR，新增**一个文件** `data/plugins/IFFCheckPass__dsh-connect-modelscope.yml`：

```yaml
url: https://github.com/IFFCheckPass/dsh-connect-modelscope
name: IFFCheckPass/dsh-connect-modelscope
category: model
description:
  en: 'ModelScope connector: OpenAI-compatible chat models, a Models-page provider entry, and a composer magicube balance while a ModelScope model is selected.'
  zh: '魔搭社区连接器：接入 OpenAI 兼容对话模型，「模型」设置页出现 ModelScope 条目，选中魔搭模型时在对话栏显示魔粒余额。'
icon: https://raw.githubusercontent.com/IFFCheckPass/dsh-connect-modelscope/main/assets/icon-512.png
```

- 描述含 `: `（冒号加空格），按指南要求**必须加引号**。
- `category: model`（模型 provider 连接器；分类不准维护者会直接改，不打回）。
- `description.zh` 可选但已备好；en 是必填项。
- npm 关联自动从 registry 采集，条目里**不要**手写 `npm:` 字段。

描述逐句与代码对照（评审第 1 条）：

| 声明 | 代码事实 |
|---|---|
| OpenAI-compatible chat models | `openAICompletionsApi` + `https://api-inference.modelscope.cn/v1`，目录来自 `/v1/models`，只发布文本对话模型 |
| Models-page provider entry | 0.2.0 导出 `Config` schema + `registerConfigurableProviders` + `registerModelDiscovery` |
| composer magicube balance while a ModelScope model is selected | client 严格 gate：`provider !== 'modelscope'` 即返回 null |

## 截图计划（升级 0.2.0 后补）

在仓库根放 `screenshots.json`（**不在 npm `files` 白名单里，不会进 tarball**），列出 1–8 张相对路径图片：

1. 设置 → 模型：provider 列表里出现 ModelScope 行（市场详情页主图）
2. 选中魔搭模型时的对话栏魔粒读数
3. 插件设置卡片：访问令牌 + 模型勾选列表
4. （可选）设置页 contextWindows 编辑器

图放 `docs/assets/`，JSON 相对路径指向它们。升级并验收后截图、写 `screenshots.json`、一起推上来即可——截图推自己仓库就生效，不用动市场那边。

## 0.2.1 待办：peer 范围的预发布分支

contributing.md 明确警告：不带显式预发布分支的 peer 范围会**静默排除** harness 的所有 rc 构建（node-semver 规则）。现在的写法在 DSH 出 `0.2.0-rc.1` 时会让用户 ERESOLVE。发 0.2.1 时改：

```jsonc
"peerDependencies": {
  "@deepseek-ai/dsh-llm": ">=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-llm-pi-ai": ">=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0",
  "@deepseek-ai/schemastery": ">=3.18.4 <4.0.0",
  "@earendil-works/pi-ai": ">=0.85.1 <2.0.0"
}
```

纯元数据改动，可与 0.2.1 的任何其他修正一起发。

## 投稿当日流程

1. （验收完成后）确认 npm `latest` = 待收录版本，仓库 README 与描述一致。
2. fork `awesome-dsh-plugin/awesome-dsh-plugin`，加 `data/plugins/IFFCheckPass__dsh-connect-modelscope.yml`（内容即上方草稿，按最新 README 现状微调）。
3. 开 PR；CI 查条目数 / `dsh.bundle` / 仓库年龄 / awesome-lint；被 `held: author` 就按评论改后同分支推送并**只留一条**说明评论。
4. 合并后 README 与网站自动重建，dsh-market 详情页随后展示截图与 npm 下载量。
