# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-antigravity"><img src="https://img.shields.io/npm/v/dsh-antigravity.svg" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
</p>

[English](./README.md) | 简体中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Google Antigravity / Cloud Code Assist 模型提供商插件。

这是一个 DSH Web 插件。它在 provider 路由 `antigravity` 下注册 DSH `LlmAdapter`，OAuth 凭证存储于 DSH home 目录下，直接与 Cloud Code Assist 流式 API 通信，并且 Web 设置页面完整支持中英文双语国际化（i18n）。

> 非官方集成。本项目与 Google 无关，亦未获得 Google 认可。请仅在您有权访问的账号和服务中使用。

## 兼容性

声明支持范围：DeepSeek Harness `>=0.1.5-rc.1 <0.3.0`（即 `package.json` 中的 `engines.dsh`）。已在 DSH **0.2.1-rc.5** 上验证：host 适配器、`/antigravity/api` 路由和 Web 设置模块均可正常加载与提供。

DSH 0.2.1 会在安装前检查插件声明的 DSH 版本要求，不覆盖当前版本的旧构建会被直接拒绝安装。每次 DSH 发布新版本时请同步更新 `engines.dsh`；如果确认愿意承担未测试组合的风险，也可以用 `dsh plugin allow-version` 对具体版本做一次性豁免。

---

## 安装到 DSH Web

### 方式一：通过 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-antigravity
```

### 方式二：直接从 GitHub 安装

```sh
dsh plugin --profile web add github:Miyamiz39/dsh-antigravity
```

### 方式三：通过本地 Release 包安装

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.0.10.tgz
```

该 package 声明了 DSH bundle patch，安装后会自动挂载 host 插件与浏览器设置页面。

本地目录安装是「链接」而不是复制，因此不会安装本包自己的依赖。插件本身没有依赖也能加载；只有 **代理设置** 需要 `undici`——请改用 tarball/registry 安装（依赖会一并安装），或在插件目录里执行一次 `pnpm install`。

如果您的 DSH 版本暂不支持 `dsh plugin add`，可手动复制到 Web profile：

```sh
cp -R dsh-antigravity "$DSH_HOME/profiles/web/node_modules/"
```

然后在 profile 的 `cordis.patch.yml` 中添加该插件：

```yaml
- insert:
    - id: dsh-antigravity
      name: dsh-antigravity
```

重启 DSH：

```sh
dsh web
```

---

## 登录与授权

打开 **设置（Settings）> Antigravity** 并点击 **登录（Login）**。设置页面将发起 Google OAuth 授权流程，并在登录完成后自动刷新配额（Quota）。

![Antigravity Settings - 未登录](./assets/images/settings-not-signed-in.png)

登录成功后，设置页面将展示账号信息、按模型分组的实时配额进度条、重置倒计时以及模型选择器：

- **Gemini Models** —— Gemini Flash / Pro 变体共享同一个配额池（绿色进度条）。
- **Claude and GPT models** —— Claude Opus、Claude Sonnet 与 GPT-OSS 共享独立的 3P 配额池（青色进度条）。

每个分组均展示 **5 小时限额**（平滑短期突发用量）与 **每周限额**（绑定至订阅级别，如 Google AI Pro），并配有实时重置倒计时。

![Antigravity Settings - 已登录](./assets/images/settings-signed-in.png)

插件会在本地启动一个 loopback OAuth 回调服务（`http://localhost:51121/oauth-callback`）。如果 Web 服务无法自动唤起浏览器，可在同机器终端运行命令行登录助手：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity/bin/antigravity-login.mjs"
```

凭证存储路径：

```text
$DSH_HOME/storages/antigravity-oauth.json
```

> 请妥善保管该文件，其中包含 access token 与 refresh token。

---

## 代理设置

在 **设置 > Antigravity > 代理设置** 中可启用独立代理，并填写本机 HTTP 代理端口（默认 `7890`）。启用后，插件会把 Google OAuth token、账号信息、配额、模型发现和对话流请求发送到 `http://127.0.0.1:<端口>`，无需重启即可对后续请求生效。

设置页的 **测试连接** 会通过当前输入的端口访问 Google OAuth 服务，并显示 HTTP 状态与耗时。该功能仅支持本机 HTTP/HTTPS CONNECT 代理，不支持 SOCKS 端口。浏览器中的 Google 授权页仍使用浏览器/系统代理。

代理配置保存在：

```text
$DSH_HOME/storages/antigravity-proxy.json
```

---

## 模型列表

登录后，在 DSH 模型选择器中选择 **Antigravity** 提供商。模型列表由账号在 Antigravity 侧的实时目录生成：登录或刷新时会读取 `fetchAvailableModels` 返回的可用模型，因此列表取决于账号的套餐、区域与灰度节奏，账号看不到的模型不会被提供。您可以在 **设置 > Antigravity** 的模型选择器中按需勾选或关闭模型（已勾选的模型将自动置顶展示，并显示其实时可用额度百分比），修改会自动保存。

- **推理档位合并** —— 同一模型的多个强度档位（例如 `claude-opus-5-5-low|medium|high`）会合并为一个可选项并提供推理强度选择，而不是拆成多个条目。
- **tiered 模型** —— ID 以 `-tiered` 结尾的模型（例如 tiered Flash 模型）提供 `low`、`medium`、`high` 三档，并映射到上游的 `thinkingLevel`。
- **列表自动同步** —— 刷新后新出现的模型会自动启用；不再出现在目录中的模型也不再提供。

对于支持推理的模型，插件会显式请求上游返回 thoughts，并把流中的 thoughts 映射为 DSH `reasoning` 内容块；默认采用该模型提供的 `medium` 档（未提供时取最接近的档位），仍可在模型选择器中调整。

### 自定义模型 ID

在 **设置 > Antigravity > 模型选择器** 中，可以添加目录里没有的模型 ID，或在新模型被收录前先行使用：

- 输入的 ID 会原样发送给 Antigravity，不做改写、不做推理档位后缀映射，也完全跳过目录解析。
- 若该 ID 已由实时目录提供（包含它的任一档位变体），会按重复项拒绝，避免同一模型出现两次。
- 已勾选的自定义 ID 会出现在 DSH 模型选择器中；移除后即不再提供。
- 包含空白字符或不符合安全 ID 字符集的 ID 会被拒绝。

同一额度池内的模型共享 5 小时与每周额度：Gemini 模型共用一个额度池，Claude 与 GPT 模型共用独立的 3P 额度池；额度按 Token 成本比例扣除，模型越重消耗越快。

---

## 许可证

[MIT](./LICENSE)
