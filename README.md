# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-antigravity"><img src="https://img.shields.io/npm/v/dsh-antigravity.svg" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
</p>

English | [简体中文](./README.zh.md)

Google Antigravity / Cloud Code Assist model provider for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a DSH Web plugin. It registers a DSH `LlmAdapter`
under provider route `antigravity`, stores OAuth credentials under DSH home,
talks to the Cloud Code Assist streaming API directly, and provides full bilingual (English & Simplified Chinese) i18n support in the Web settings page.

> Unofficial integration. This project is not affiliated with or endorsed by
> Google. Use it only with accounts and services you are authorized to access.

## Compatibility

Declared support: DeepSeek Harness `>=0.1.5-rc.1 <0.3.0` (the `engines.dsh`
range in `package.json`). Verified against DSH **0.2.1-rc.5**: the host adapter,
the `/antigravity/api` routes, and the Web settings module all load and serve.

DSH 0.2.1 rejects plugins whose declared DSH requirements do not cover the
running version, so an older build of this plugin is refused before install.
Keep `engines.dsh` up to date when a new DSH release lands, or grant the
one-off exact-version exemption with `dsh plugin allow-version` when you accept
the risk of an untested pairing.

## Install into DSH Web

### Option 1: From npm (Recommended)

```sh
dsh plugin --profile web add dsh-antigravity
```

### Option 2: Direct from GitHub

```sh
dsh plugin --profile web add github:Miyamiz39/dsh-antigravity
```

### Option 3: From Local Release Tarball

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.0.10.tgz
```

The package declares a DSH bundle patch, so installation automatically mounts
the host plugin and browser settings page.

If your DSH version does not support `dsh plugin add`, copy the package into
the Web profile manually:

```sh
cp -R dsh-antigravity "$DSH_HOME/profiles/web/node_modules/"
```

Then add the plugin to the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-antigravity
      name: dsh-antigravity
```

Restart DSH:

```sh
dsh web
```

## Login

Open **Settings > Antigravity** and click **Login**. The settings page starts
Google OAuth and refreshes quota after login completes.

![Antigravity Settings - Not Signed In](./assets/images/settings-not-signed-in.png)

After login, the settings page displays account information, quota grouped by model family, reset times, and model selector options:

- **Gemini Models** — Gemini Flash / Pro variants share one quota pool (green bars).
- **Claude and GPT models** — Claude Opus, Claude Sonnet, and GPT-OSS share a separate 3P quota pool (cyan bars).

Each group shows a **5-hour limit** (smooths short-term demand) and a **weekly limit** (tied to your subscription tier) with a live countdown to reset.

![Antigravity Settings - Signed In with Quota](./assets/images/settings-signed-in.png)

The plugin starts a loopback OAuth callback server at
`http://localhost:51121/oauth-callback`. If the Web service cannot open a
browser, run the terminal helper on the same machine:

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity/bin/antigravity-login.mjs"
```

Credentials are stored at:

```text
$DSH_HOME/storages/antigravity-oauth.json
```

Keep that file private. It contains access and refresh tokens.

## Proxy Settings

Open **Settings > Antigravity > Proxy Settings** to enable a dedicated proxy and enter the local HTTP proxy port (default `7890`). When enabled, Google OAuth token, account, quota, model-discovery, and chat-stream requests are routed through `http://127.0.0.1:<port>`. Changes apply to new requests immediately without restarting DSH.

The **Test connection** button probes Google OAuth through the port currently entered and reports the HTTP status and latency. This supports local HTTP/HTTPS CONNECT proxies only, not SOCKS ports. The Google authorization page opened in the browser continues to use the browser/system proxy.

The proxy configuration is stored at:

```text
$DSH_HOME/storages/antigravity-proxy.json
```

## Models

After login, select the **Antigravity** provider in DSH's model picker. Use the
model selector in **Settings > Antigravity** to enable or disable individual
models (enabled models are prioritized at the top of the list) — the live remaining quota percentage is shown next to each one.

Registered model IDs:

| Model ID | Name | Quota pool |
|---|---|---|
| `gemini-3.7-flash` | Gemini 3.7 Flash | Gemini |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Gemini |
| `gemini-3.5-flash` | Gemini 3.5 Flash | Gemini |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Gemini |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Gemini |
| `gemini-3-flash` | Gemini 3 Flash | Gemini |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Gemini |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Gemini |
| `claude-opus-4-6` | Claude Opus 4.6 | Claude & GPT (3P) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Claude & GPT (3P) |
| `gpt-oss-120b` | GPT-OSS 120B | Claude & GPT (3P) |

Models in the same quota pool share a weekly limit and a 5-hour limit. Quota is
consumed proportionally to token cost, so heavier models (e.g. Claude Opus)
drain the pool faster than lighter ones.

The plugin resolves these public IDs to runtime model IDs using the live
`fetchAvailableModels` catalog when available, with static routing fallbacks.

For reasoning-capable models, the plugin defaults to medium effort (or high when
that is the only advertised level), explicitly requests upstream thoughts, and
maps streamed thoughts to DSH `reasoning` content blocks. The effort remains
selectable from the model picker.

## License

MIT
