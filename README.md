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

A local-directory install is linked, not copied, so this package's own
dependencies are not installed. The plugin still loads without them; only
**Proxy Settings** needs the `undici` package — install from a tarball/registry
so dependencies are installed, or run `pnpm install` once in the plugin
checkout.

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

After login, select the **Antigravity** provider in DSH's model picker. The
model list is built from the account's live Antigravity catalog on login and
refresh, so it reflects the account's plan, region, and rollout: a model the
account cannot see is not offered. Use the model selector in
**Settings > Antigravity** to check or uncheck models (checked models are
prioritized; the live remaining quota percentage is shown next to each one);
changes save automatically.

- **Merged reasoning variants** — effort variants of one model (for example
  `claude-opus-5-5-low|medium|high`) appear as one selectable entry with a
  reasoning-effort selector instead of separate entries.
- **Tiered models** — an ID ending in `-tiered` (for example the tiered Flash model)
  exposes `low`, `medium`, and `high`, mapped to the upstream `thinkingLevel`.
- **Self-updating list** — a newly available model is enabled automatically after
  a refresh; a model that leaves the catalog is no longer offered.

For reasoning-capable models the plugin requests upstream thoughts explicitly,
maps streamed thoughts to DSH `reasoning` content blocks, and defaults to
`medium` effort when the model advertises it (otherwise the closest level it
offers). The effort stays selectable from the model picker.

### Custom model IDs

In **Settings > Antigravity > model selector**, add an ID that is not in the
catalog, or one you want to use before the plugin is updated:

- The ID is sent to Antigravity verbatim — exactly as entered, with no rewriting
  and no effort-suffix mapping — and skips catalog resolution entirely.
- An ID the live catalog already serves (including one of its effort variants)
  is rejected as a duplicate, so the same model cannot appear twice.
- Checked custom IDs appear in DSH's model picker; removing one stops offering it.
- IDs containing whitespace, or outside the safe ID character set, are rejected.

Models in the same quota pool share a weekly limit and a 5-hour limit: Gemini
models share one pool, Claude and GPT models share a separate 3P pool. Quota is
consumed proportionally to token cost, so heavier models drain it faster.

## License

MIT
