/**
 * Google Antigravity / Cloud Code Assist adapter for DeepSeek Harness.
 *
 * This plugin is intentionally shaped like a DSH Web plugin: Cordis loads this
 * module, `apply()` registers a harness LlmAdapter, and OAuth credentials live
 * under DSH home. It does not require an external Antigravity CLI.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import {
  addCustomModel,
  buildCatalogModels,
  clampFraction,
  compareAntigravityModels,
  configuredModels,
  customModelEntry,
  formatReset,
  isRecord,
  maxOutputTokensFor,
  modelByPublicId,
  modelOptionsPayload,
  normalizeCustomModelId,
  normalizeModelSettings,
  reconcileCatalogSettings,
  resolveRuntimeModelId,
  remainingPercent,
  removeCustomModel,
} from "./catalog.js";

export { compareAntigravityModels };

export const PROVIDER = "agy";
export const PROVIDER_NAME = "Antigravity (AGY)";
export const name = "dsh-antigravity";
export const inject = ["llm"];

const STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const DISCOVERY_TIMEOUT_MS = 8000;
const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const REDIRECT_PATH = "/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const DEFAULT_CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
    "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const DEFAULT_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.';

const PLATFORM =
  process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
const GEMINI_ROLE = {
  user: "user",
  model: "model",
};
const TOOL_CALLING_MODE = {
  none: "NONE",
  any: "ANY",
  auto: "AUTO",
  validated: "VALIDATED",
};

const ROUTING = {
  "claude-opus-4-6": {
    off: "claude-opus-4-6-thinking",
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
      xhigh: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6-thinking",
    routing: {
      minimal: "claude-sonnet-4-6-thinking",
      low: "claude-sonnet-4-6-thinking",
      medium: "claude-sonnet-4-6-thinking",
      high: "claude-sonnet-4-6-thinking",
      xhigh: "claude-sonnet-4-6-thinking",
    },
    defaultRequestId: "claude-sonnet-4-6-thinking",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-tiered",
    routing: {
      minimal: "gemini-3.7-flash-tiered",
      low: "gemini-3.7-flash-tiered",
      medium: "gemini-3.7-flash-tiered",
      high: "gemini-3.7-flash-tiered",
      xhigh: "gemini-3.7-flash-tiered",
    },
    defaultRequestId: "gemini-3.7-flash-tiered",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-high",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3-flash-agent",
  },
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-pro-agent",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-pro-agent",
  },
  "gemini-3.1-flash-image": {
    off: "gemini-3.1-flash-image",
    routing: {
      minimal: "gemini-3.1-flash-image",
      low: "gemini-3.1-flash-image",
      medium: "gemini-3.1-flash-image",
      high: "gemini-3.1-flash-image",
      xhigh: "gemini-3.1-flash-image",
    },
    defaultRequestId: "gemini-3.1-flash-image",
  },
  "gemini-3-flash": {
    off: "gemini-3-flash",
    routing: {
      minimal: "gemini-3-flash",
      low: "gemini-3-flash",
      medium: "gemini-3-flash",
      high: "gemini-3-flash",
      xhigh: "gemini-3-flash",
    },
    defaultRequestId: "gemini-3-flash",
  },
  "gemini-2.5-pro": {
    off: "gemini-2.5-pro",
    routing: {
      minimal: "gemini-2.5-pro",
      low: "gemini-2.5-pro",
      medium: "gemini-2.5-pro",
      high: "gemini-2.5-pro",
      xhigh: "gemini-2.5-pro",
    },
    defaultRequestId: "gemini-2.5-pro",
  },
  "gemini-2.5-flash": {
    off: "gemini-2.5-flash",
    routing: {
      minimal: "gemini-2.5-flash",
      low: "gemini-2.5-flash",
      medium: "gemini-2.5-flash",
      high: "gemini-2.5-flash",
      xhigh: "gemini-2.5-flash",
    },
    defaultRequestId: "gemini-2.5-flash",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
      xhigh: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

/**
 * Static metadata for model ids that may still be pinned inside older DSH
 * sessions but are no longer advertised by the account's live catalog. The
 * offered model list itself always comes from the live catalog, never from this
 * table.
 */
const LEGACY_MODEL_METADATA = [
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    inputModalities: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    reasoningEfforts: ["medium"],
  },
];

const diagnostics = {
  endpoint: "",
  status: undefined,
  projectId: "",
  resolvedRuntimeModel: "",
  availableModels: "",
  matchedModelDebug: "",
  error: "",
};

const projectCache = new Map();
let cachedQuota = undefined;
let webLoginFlow = undefined;

let toolCallCounter = 0;

const DEFAULT_PROXY_PORT = 7890;
const DEFAULT_PROXY_CONFIG = Object.freeze({ enabled: false, port: DEFAULT_PROXY_PORT });
let proxyFetch = undefined;
let undiciModule = undefined;
let undiciLoadError = undefined;
let currentProxyConfig = { ...DEFAULT_PROXY_CONFIG };
let proxyAgent = undefined;
let proxyConfigError = undefined;
let proxyReady = undefined;

/**
 * Load the optional `undici` dependency on first proxy use.
 *
 * A local-directory plugin install (`link:`) does not install the plugin's own
 * dependencies, so importing `undici` at module scope would make the whole
 * plugin fail to load with ERR_MODULE_NOT_FOUND. Proxy use alone needs it.
 * @returns the undici module.
 */
async function loadUndici() {
  if (undiciLoadError !== undefined) throw undiciLoadError;
  if (undiciModule === undefined) {
    try {
      undiciModule = await import("undici");
      proxyFetch = undiciModule.fetch;
    } catch (error) {
      undiciLoadError = new Error(
        "antigravity: the proxy feature needs the 'undici' package, which is not installed next to this plugin. " +
          "Install a packaged release (tarball) so its dependencies are installed, or run `pnpm install` in the plugin directory. " +
          "Proxy stays disabled until then.",
        { cause: error },
      );
      throw undiciLoadError;
    }
  }
  return undiciModule;
}

export function credentialPath() {
  return dshHomePath("storages", "antigravity-oauth.json");
}

export function modelSettingsPath() {
  return dshHomePath("storages", "antigravity-settings.json");
}

export function proxySettingsPath() {
  return dshHomePath("storages", "antigravity-proxy.json");
}

function normalizeProxyConfig(raw) {
  const enabled = raw?.enabled === true;
  const source = raw?.port ?? DEFAULT_PROXY_PORT;
  const port = typeof source === "number" ? source : Number(String(source).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("proxy port must be an integer from 1 to 65535");
  }
  return { enabled, port };
}

function proxyConfigView() {
  return {
    enabled: currentProxyConfig.enabled,
    port: currentProxyConfig.port,
    url: `http://127.0.0.1:${currentProxyConfig.port}`,
    ...(proxyConfigError ? { error: proxyConfigError } : {}),
  };
}

function describeFetchError(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    if (Array.isArray(current.errors)) {
      for (const child of current.errors) {
        const text = child instanceof Error ? child.message : String(child);
        if (text && !messages.includes(text)) messages.push(text);
      }
    }
    const text = current instanceof Error ? current.message : String(current);
    if (text && !messages.includes(text)) messages.push(text);
    if (!current.cause || current.cause === current) break;
    current = current.cause;
  }
  return messages.join(" → ");
}

async function applyProxyConfig(config) {
  const nextAgent = config.enabled
    ? new (await loadUndici()).ProxyAgent(`http://127.0.0.1:${config.port}`)
    : undefined;
  const previous = proxyAgent;
  currentProxyConfig = config;
  proxyAgent = nextAgent;
  proxyConfigError = undefined;
  if (previous) void previous.close().catch(() => undefined);
}

async function loadProxyConfig() {
  try {
    const parsed = JSON.parse(await readFile(proxySettingsPath(), "utf8"));
    if (!isRecord(parsed)) throw new Error("Antigravity proxy config must be a JSON object");
    await applyProxyConfig(normalizeProxyConfig(parsed));
  } catch (error) {
    if (error?.code === "ENOENT") {
      await applyProxyConfig({ ...DEFAULT_PROXY_CONFIG });
    } else {
      proxyConfigError = error instanceof Error ? error.message : String(error);
      currentProxyConfig = { ...DEFAULT_PROXY_CONFIG };
      proxyAgent = undefined;
    }
  }
  return proxyConfigView();
}

function ensureProxyReady() {
  proxyReady ??= loadProxyConfig();
  return proxyReady;
}

export async function getProxyConfig() {
  await ensureProxyReady();
  return proxyConfigView();
}

export async function setProxyConfig(input) {
  await ensureProxyReady();
  const next = normalizeProxyConfig(input);
  if (next.enabled) await loadUndici();
  const file = proxySettingsPath();
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  await writeFile(tempFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tempFile, file);
  await applyProxyConfig(next);
  return proxyConfigView();
}

export async function antigravityFetch(input, init = {}) {
  await ensureProxyReady();
  if (!currentProxyConfig.enabled || !proxyAgent) return fetch(input, init);
  const fetchImpl = proxyFetch ?? (await loadUndici()).fetch;
  return fetchImpl(input, { ...init, dispatcher: proxyAgent });
}

export async function testProxyConnection(port = currentProxyConfig.port) {
  let draft;
  try {
    draft = normalizeProxyConfig({ enabled: true, port });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let undici;
  try {
    undici = await loadUndici();
  } catch (error) {
    return { ok: false, error: describeFetchError(error) };
  }
  const agent = new undici.ProxyAgent(`http://127.0.0.1:${draft.port}`);
  const started = Date.now();
  try {
    const response = await undici.fetch("https://oauth2.googleapis.com/", {
      method: "GET",
      dispatcher: agent,
      signal: AbortSignal.timeout(15000),
    });
    void response.arrayBuffer().catch(() => undefined);
    return { ok: true, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: describeFetchError(error) };
  } finally {
    await agent.close().catch(() => undefined);
  }
}

function antigravityEnv(namePart) {
  return process.env[`ANTIGRAVITY_${namePart}`] || process.env[`NOAGY_${namePart}`];
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeText(text) {
  return String(text ?? "").toWellFormed();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nowRequestId() {
  return `antigravity-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}

function setLastEndpoint(endpoint) {
  diagnostics.endpoint = endpoint || "";
}

function setLastStatus(status) {
  diagnostics.status = status;
}

function setLastProjectId(projectId) {
  diagnostics.projectId = projectId || "";
}

function setLastResolvedRuntimeModel(modelId) {
  diagnostics.resolvedRuntimeModel = modelId || "";
}

function setLastAvailableModels(text) {
  diagnostics.availableModels = text || "";
}

function setLastMatchedModelDebug(text) {
  diagnostics.matchedModelDebug = text || "";
}

function setLastError(error) {
  diagnostics.error = safeError(error || "");
}

export function getAntigravityDiagnostics() {
  return { ...diagnostics };
}

function assertSafeApiBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "googleapis.com" ||
    host.endsWith(".googleapis.com") ||
    host.endsWith(".sandbox.googleapis.com");
  if (!allowed) {
    throw new Error(
      `ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function endpointCandidates() {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
}

function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")) {
  const host = (raw || "127.0.0.1").trim().toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host)) {
    throw new Error(
      `Unsafe ANTIGRAVITY_CALLBACK_HOST="${host}". Only loopback hosts are allowed: 127.0.0.1, ::1, localhost.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

function callbackPort() {
  const raw = antigravityEnv("CALLBACK_PORT");
  if (!raw) return 51121;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ANTIGRAVITY_CALLBACK_PORT: ${raw}`);
  }
  return parsed;
}

function redirectUri() {
  return `http://localhost:${callbackPort()}${REDIRECT_PATH}`;
}

function clientId() {
  return antigravityEnv("CLIENT_ID") || DEFAULT_CLIENT_ID;
}

function clientSecret() {
  return antigravityEnv("CLIENT_SECRET") || DEFAULT_CLIENT_SECRET;
}

function defaultUserAgent() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/1.15.8 ${os}/${arch}`;
}

function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: PLATFORM,
      pluginType: "GEMINI",
    }),
  };
}

function attributionHeaderBag() {
  try {
    return attributionHeaders() || {};
  } catch {
    return {};
  }
}

function jsonOrTextError(text) {
  const parsed = safeJsonParse(text);
  if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message;
  }
  return text;
}

function jsonHeaders(token) {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectId(seed = "antigravity-default") {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

function extractProjectId(data) {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(token) {
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await antigravityFetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      return extractProjectId(await response.json());
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssistUncached(token) {
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await antigravityFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      const project = extractProjectId(await response.json());
      if (project) return project;
      return await listCloudAICompanionProjects(token);
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssist(token) {
  const cached = projectCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    projectCache.delete(token);
    projectCache.set(token, cached);
    return cached.projectId;
  }
  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  if (projectCache.size > 32) {
    const oldestKey = projectCache.keys().next().value;
    if (oldestKey !== undefined) projectCache.delete(oldestKey);
  }
  return projectId;
}

function resolveProjectId(options) {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    options.warmedProject ||
    options.credentialProjectId ||
    defaultProjectId(options.email || "antigravity-default")
  );
}

function summarizeModelCandidate(value) {
  if (!isRecord(value)) return String(value ?? "none");
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|auth|credential|secret|email/i.test(key)) continue;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
    else if (Array.isArray(raw)) out[key] = `[array:${String(raw.length)}]`;
    else if (isRecord(raw)) out[key] = `{${Object.keys(raw).slice(0, 12).join(",")}}`;
  }
  return JSON.stringify(out).slice(0, 1200);
}

function progressBar(remaining, width = 20) {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

async function postJson(path, token, body) {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await antigravityFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });
      setLastEndpoint(endpoint);
      setLastStatus(response.status);
      const text = await response.text();
      const data = safeJsonParse(text) ?? { raw: text };
      if (!response.ok) {
        lastErrorText =
          isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
            ? data.error.message
            : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`${path} failed (${String(response.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: response.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

async function fetchAvailableModelsFromEndpoint(endpoint, token, projectId) {
  try {
    const response = await antigravityFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ project: projectId }),
    });
    const text = await response.text();
    const data = safeJsonParse(text) ?? { raw: text };
    if (!response.ok) {
      const lastErrorText =
        isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
          ? data.error.message
          : text;
      setLastError(lastErrorText);
      return undefined;
    }
    return { endpoint, status: response.status, data };
  } catch (error) {
    setLastError(error);
    return undefined;
  }
}

async function fetchMergedAvailableModels(token, projectId) {
  const results = await Promise.all(
    endpointCandidates().map((endpoint) => fetchAvailableModelsFromEndpoint(endpoint, token, projectId)),
  );
  const mergedModels = {};
  let defaultAgentModelId;
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (!result) continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    if (isRecord(result.data) && isRecord(result.data.models)) {
      Object.assign(mergedModels, result.data.models);
    }
    if (isRecord(result.data) && typeof result.data.defaultAgentModelId === "string") {
      defaultAgentModelId = result.data.defaultAgentModelId;
    }
  }

  if (!lastEndpoint) throw new Error("/v1internal:fetchAvailableModels failed: no endpoint available");
  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: { models: mergedModels, defaultAgentModelId },
  };
}

function parseQuotaSummary(data) {
  const summary = isRecord(data) ? data : {};
  const groups = [];
  for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
    if (!isRecord(group)) continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!isRecord(bucket)) continue;
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const models = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const quotaInfo = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function parseTier(value) {
  if (!isRecord(value)) return undefined;
  if (!value.id && !value.name) return undefined;
  return {
    id: value.id ? String(value.id) : undefined,
    name: value.name ? String(value.name) : undefined,
    description: value.description ? String(value.description) : undefined,
  };
}

export async function fetchAccountQuota(store = new FileCredentialStore(), modelSettings) {
  const { token, projectId: credentialProjectId } = await ensureApiKey(store);
  const [assistResult, summary] = await Promise.all([
    postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }).catch(() => null),
    postJson("/v1internal:retrieveUserQuotaSummary", token, {}),
  ]);

  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    credentialProjectId,
    warmedProject: discoveredProject ?? null,
  });
  setLastProjectId(projectId);

  const available = await fetchMergedAvailableModels(token, projectId);
  const { groups, description } = parseQuotaSummary(summary.data);
  const { models, defaultAgentModelId } = parseModels(available.data);
  const catalogModels = buildCatalogModels(available.data);
  if (catalogModels.length) {
    setLastAvailableModels(catalogModels.map((model) => model.id).join(","));
  }
  const assistData = isRecord(assistResult?.data) ? assistResult.data : {};
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  cachedQuota = {
    projectId,
    endpoint: summary.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    models,
    catalogModels,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };

  if (modelSettings) {
    await modelSettings.reconcileCatalog(catalogModels);
  }

  return cachedQuota;
}

export function getCachedQuota() {
  return cachedQuota;
}

export function formatQuotaSummary(quota) {
  const lines = [];
  lines.push("Antigravity quota");
  if (quota.planLabel) lines.push(`plan=${quota.planLabel}`);
  lines.push(`project=${quota.projectId}`);
  lines.push(`fetched=${new Date(quota.fetchedAt).toLocaleString()}`);

  if (!quota.groups.length) {
    lines.push("");
    lines.push("No quota groups returned.");
  } else {
    for (const group of quota.groups) {
      lines.push("");
      lines.push(group.displayName);
      for (const bucket of group.buckets) {
        const remaining = remainingPercent(bucket.remainingFraction);
        lines.push(
          `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${remaining ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
        );
      }
    }
  }

  const rows = quota.models.filter((model) => !/tab_|chat_/i.test(model.modelId)).slice(0, 24);
  if (rows.length) {
    lines.push("");
    lines.push("Models");
    const maxId = Math.max(...rows.map((model) => model.modelId.length), 8);
    for (const model of rows) {
      const remaining = remainingPercent(model.remainingFraction);
      const flags = [
        model.recommended ? "recommended" : "",
        model.supportsThinking ? "thinking" : "",
        model.supportsImages ? "images" : "",
      ]
        .filter(Boolean)
        .join(",");
      const display = model.displayName && model.displayName !== model.modelId ? `  ${model.displayName}` : "";
      lines.push(
        `${model.modelId.padEnd(maxId)}  rem ${remaining === undefined ? "  ?" : String(remaining).padStart(5)}%  reset ${formatReset(model.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${display}`,
      );
    }
    lines.push("");
    lines.push("Note: remaining % is pool-shared, not a private per-model budget.");
  }
  return lines.join("\n").trimEnd();
}

function getMaxOutputTokens(modelId, runtimeModel) {
  return maxOutputTokensFor(runtimeModel || modelId);
}

function defaultReasoningEffort(model) {
  if (!model.reasoningEfforts?.length) return undefined;
  if (model.reasoningEfforts.includes("medium")) return "medium";
  if (model.reasoningEfforts.includes("high")) return "high";
  return model.reasoningEfforts[0];
}

function reasoningInfo(model) {
  if (!model.reasoningEfforts.length) return {};
  const defaultEffort = defaultReasoningEffort(model);
  return {
    reasoning: {
      efforts: model.reasoningEfforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
      ...(defaultEffort ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}),
    },
  };
}

function resolveReasoning(model, effort) {
  if (effort === undefined) return defaultReasoningEffort(model);
  if (effort === "off") return effort;
  if (model.reasoningEfforts && model.reasoningEfforts.includes(effort)) return effort;
  // Older sessions may retain an effort no longer exposed by a live catalog.
  if (model.reasoningEfforts && model.reasoningEfforts.includes("high")) return "high";
  return defaultReasoningEffort(model) || "high";
}

function antigravityThinking(modelId, runtimeModel, effort, maxTokens) {
  if (effort === undefined) return undefined;
  if (effort === "off") return { includeThoughts: false, thinkingBudget: 0 };

  if (runtimeModel === "gemini-3.7-flash-tiered" || runtimeModel.endsWith("-tiered")) {
    return {
      includeThoughts: true,
      thinkingLevel:
        effort === "high" || effort === "xhigh" ? "HIGH" : effort === "medium" ? "MEDIUM" : "LOW",
    };
  }

  let thinkingBudget;
  if (modelId.startsWith("claude-")) thinkingBudget = 1024;
  else if (modelId.startsWith("gpt-oss-")) thinkingBudget = 8192;
  else if (modelId.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") {
    thinkingBudget = effort === "high" || effort === "xhigh" ? 10001 : 1001;
  } else if (modelId.startsWith("gemini-3.5-flash") || runtimeModel === "gemini-3-flash-agent") {
    thinkingBudget =
      effort === "high" || effort === "xhigh" ? 10000 : effort === "medium" ? 4000 : 1000;
  } else {
    thinkingBudget = effort === "high" || effort === "xhigh" ? -1 : effort === "medium" ? 4000 : 1000;
  }

  if (maxTokens !== undefined && thinkingBudget > 0 && maxTokens <= thinkingBudget) {
    throw new LlmError(
      `Antigravity maxTokens must exceed the thinking budget (${thinkingBudget}) for ${modelId}/${effort}`,
      "INVALID_REQUEST",
    );
  }
  return { includeThoughts: true, thinkingBudget };
}

function hasImages(messages) {
  return messages.some((message) => {
    try {
      return contentHasImage(message.content);
    } catch {
      return false;
    }
  });
}

function sanitizeToolCallId(id, fallbackName) {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId, runtimeModel) {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

function parseArguments(raw) {
  if (isRecord(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") return {};
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  return isRecord(parsed) ? parsed : {};
}

function imageBlockToPart(block) {
  if (!isRecord(block) || block.type !== "image") return undefined;
  let data = asString(block.dataBase64) || asString(block.data) || asString(block.base64);
  const source = isRecord(block.source) ? block.source : undefined;
  if (!data && source) data = asString(source.dataBase64) || asString(source.data) || asString(source.base64);
  let mimeType =
    asString(block.mediaType) ||
    asString(block.mimeType) ||
    (source ? asString(source.mediaType) || asString(source.mimeType) : undefined) ||
    "image/png";
  if (data?.startsWith("data:")) {
    const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
    if (match) {
      mimeType = match[1] || mimeType;
      data = match[2] || "";
    }
  }
  if (!data) throw new LlmError("antigravity: image content has no readable image bytes", "INVALID_REQUEST");
  return { inlineData: { mimeType, data } };
}

export function withToolResultImages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let images = [];
  const flush = () => {
    if (images.length > 0) {
      out.push({ role: "user", content: images });
      images = [];
    }
  };
  for (const message of messages) {
    if (message.role === "assistant") flush();
    out.push(message);
    if (message.role === "tool" && Array.isArray(message.content)) {
      const parts = message.content.filter(
        (part) => isRecord(part) && part.type === "image" && (part.dataBase64 || part.data || part.base64)
      );
      if (parts.length > 0) {
        images.push({ type: "text", text: `Images from tool result ${String(message.toolCallId || "")}:` }, ...parts);
      }
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "tool-result") continue;
        if (Array.isArray(block.content)) {
          const parts = block.content.filter(
            (part) => isRecord(part) && part.type === "image" && (part.dataBase64 || part.data || part.base64)
          );
          if (parts.length > 0) {
            images.push({ type: "text", text: `Images from tool result ${String(block.toolCallId || "")}:` }, ...parts);
          }
        }
      }
    }
  }
  flush();
  return out;
}

export async function resolveImages(messages, attachments, signal) {
  if (!Array.isArray(messages)) return messages;
  const hasImage = (block) =>
    isRecord(block) &&
    (block.type === "image" ||
      (block.type === "tool-result" && Array.isArray(block.content) && block.content.some(hasImage)));
  if (!messages.some((message) => Array.isArray(message.content) && message.content.some(hasImage))) {
    return messages;
  }
  const resolveBlock = async (block) => {
    if (!isRecord(block)) return [block];
    if (block.type === "tool-result" && Array.isArray(block.content)) {
      const resolvedContent = (await Promise.all(block.content.map(resolveBlock))).flat();
      return [{ ...block, content: resolvedContent }];
    }
    if (block.type !== "image") return [block];
    if (block.attachment) {
      if (typeof attachments?.readImage !== "function") {
        throw new LlmError(
          "antigravity: the request carries an attachment-backed image but no attachments service is mounted",
          "UNSUPPORTED",
        );
      }
      const stored = await attachments.readImage(block.attachment, signal);
      if (!stored?.data?.length) {
        throw new LlmError("antigravity: attachment image read returned no bytes", "INVALID_REQUEST");
      }
      return [{
        type: "image",
        mediaType: stored.ref.mediaType,
        dataBase64: Buffer.from(stored.data).toString("base64"),
      }];
    }
    // Fail here, before acquiring credentials or sending a request, if an image cannot be encoded.
    imageBlockToPart(block);
    return [block];
  };

  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? (await Promise.all(message.content.map(resolveBlock))).flat()
        : message.content,
    }))
  );
}

function contentToUserParts(content) {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text") {
      parts.push({ text: sanitizeText(block.text) });
    } else if (isRecord(block) && block.type === "image") {
      const imagePart = imageBlockToPart(block);
      if (imagePart) parts.push(imagePart);
    }
  }
  return parts;
}

function toolResultText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return sanitizeText(block.text);
      if (block.type === "tool-result") return toolResultText(block.content);
      return "";
    })
    .join("");
}

function replayBlockFor(message, index) {
  const source = message.source;
  if (!source || source.kind !== "model") return undefined;
  const state = source.replayState;
  if (!isRecord(state)) return undefined;
  if (state.kind !== "antigravity" || state.version !== 1) return undefined;
  if (state.provider !== PROVIDER || state.model !== source.model) return undefined;
  if (!Array.isArray(state.blocks)) return undefined;
  return state.blocks[index];
}

function assistantParts(message, model, runtimeModel, toolNames) {
  const parts = [];
  if (!Array.isArray(message.content)) return parts;
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!isRecord(block)) continue;
    const replay = replayBlockFor(message, index);
    if (block.type === "text" && String(block.text || "").trim()) {
      parts.push({ text: sanitizeText(block.text) });
    } else if (block.type === "reasoning" && String(block.text || "").trim()) {
      if (replay?.type === "reasoning" && replay.thinkingSignature) {
        parts.push({
          thought: true,
          text: sanitizeText(block.text),
          thoughtSignature: replay.thinkingSignature,
        });
      } else {
        parts.push({ text: sanitizeText(block.text) });
      }
    } else if (block.type === "tool-call") {
      const toolId = String(block.id || "");
      toolNames.set(toolId, block.name);
      parts.push({
        functionCall: {
          name: block.name,
          args: parseArguments(block.arguments),
          ...(toolCallIdNeeded(model.id, runtimeModel)
            ? { id: sanitizeToolCallId(toolId, block.name) }
            : {}),
        },
        ...(replay?.type === "tool-call" && replay.thoughtSignature
          ? { thoughtSignature: replay.thoughtSignature }
          : {}),
      });
    }
  }
  return parts;
}

function pushToolResult(contents, result, toolNames, model, runtimeModel) {
  const toolCallId = String(result.toolCallId || "");
  const toolName = toolNames.get(toolCallId) || "unknown";
  const responseText = toolResultText(result.content) || (result.isError ? "Tool failed" : "");
  const part = {
    functionResponse: {
      name: toolName,
      response: result.isError ? { error: responseText } : { output: responseText },
      ...(toolCallIdNeeded(model.id, runtimeModel)
        ? { id: sanitizeToolCallId(toolCallId, toolName) }
        : {}),
    },
  };
  const last = contents[contents.length - 1];
  if (last?.role === GEMINI_ROLE.user && last.parts.some((entry) => "functionResponse" in entry)) {
    last.parts.push(part);
  } else {
    contents.push({ role: GEMINI_ROLE.user, parts: [part] });
  }
}

function messageText(message) {
  const content = message.content;
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" ? sanitizeText(block.text) : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function convertMessages(options, model, runtimeModel, systemTexts = []) {
  const contents = [];
  const toolNames = new Map();
  const normalizedMessages = withToolResultImages(options.messages);
  for (const message of normalizedMessages) {
    if (message.role === "assistant") {
      const parts = assistantParts(message, model, runtimeModel, toolNames);
      if (parts.length) contents.push({ role: GEMINI_ROLE.model, parts });
      continue;
    }
    if (message.role === "tool") {
      pushToolResult(contents, message, toolNames, model, runtimeModel);
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      const text = messageText(message);
      if (text) systemTexts.push(text);
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const nonResultContent = content.filter((block) => !isRecord(block) || block.type !== "tool-result");
    const userParts = contentToUserParts(nonResultContent);
    if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts });
    for (const block of content) {
      if (isRecord(block) && block.type === "tool-result") {
        pushToolResult(contents, block, toolNames, model, runtimeModel);
      }
    }
  }
  return contents;
}

function stripMetaSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((entry) => typeof entry === "string" && entry !== "null");
}

function normalizeCustomToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function convertTools(tools, useLegacyParameters) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

function mapToolChoiceMode(toolChoice) {
  if (toolChoice === "none") return TOOL_CALLING_MODE.none;
  if (toolChoice === "any" || toolChoice === "required") return TOOL_CALLING_MODE.any;
  return TOOL_CALLING_MODE.auto;
}

export function buildRequest(options, model, projectId, runtimeModel, effort) {
  const systemTexts = [];
  const request = {
    contents: convertMessages(options, model, runtimeModel, systemTexts),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
        ...(options.system ? [{ text: sanitizeText(options.system) }] : []),
        ...systemTexts.map((text) => ({ text })),
      ],
    },
  };
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const thinkingConfig = model.custom
    ? undefined
    : antigravityThinking(model.id, runtimeModel, effort, options.maxTokens);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined
      ? Math.min(options.maxTokens, maxAllowed)
      : Math.min(maxAllowed, model.maxTokens || maxAllowed);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const usesLegacyToolSchema = model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-");
  const tools = convertTools(options.tools, usesLegacyToolSchema);
  if (tools) {
    request.tools = tools;
    if (model.id.startsWith("claude-")) {
      request.toolConfig = options.toolChoice
        ? { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } }
        : { functionCallingConfig: { mode: TOOL_CALLING_MODE.validated } };
    } else if (options.toolChoice) {
      request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } };
    }
  }
  if (options.sessionId) request.sessionId = String(options.sessionId);
  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: nowRequestId(),
  };
}

function mapUsage(usage) {
  const inputTokens = Math.max(0, (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0));
  const outputTokens = usage.candidatesTokenCount || 0;
  return {
    inputTokens,
    outputTokens,
    ...(usage.cachedContentTokenCount > 0 ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
    ...(usage.thoughtsTokenCount !== undefined ? { reasoningTokens: usage.thoughtsTokenCount } : {}),
  };
}

function classifyAntigravityError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(message)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT";
  return "ANTIGRAVITY_ERROR";
}

function friendlyAntigravityError(status, text) {
  const message = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(message)) {
      return "Antigravity login expired or credentials are invalid. Next: run /antigravity-login, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(message)) {
      return `Antigravity request format was rejected by the backend (${message}). Next: switch to a simpler model or update the plugin.`;
    }
    return `Bad request from Antigravity. Backend said: ${message}`;
  }
  if (status === 401) return "Antigravity authentication failed. Next: run /antigravity-login, then retry.";
  if (status === 403) return `Antigravity denied this request. Backend said: ${message}`;
  if (status === 404) return `Antigravity could not find the requested model/resource. Backend said: ${message}`;
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) return "Antigravity reported a conflict. Next: retry once or start a new chat session.";
  if (status === 429) {
    const wait = message.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/quota/i.test(message)) return `Quota reached.${wait ? ` Please wait ${wait}.` : ""}`;
    return `Rate limited by Antigravity.${wait ? ` Reset: ${wait}.` : ""}`;
  }
  if (status === 500) return "Antigravity had an internal server error. Next: retry or switch models.";
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry.";
  if (status === 503) return /No capacity available/i.test(message)
    ? "This model has no capacity right now. Next: retry later or switch models."
    : "Antigravity is temporarily unavailable. Next: retry or switch models.";
  if (status === 504) return "Antigravity timed out upstream. Next: retry.";
  return message || "Antigravity request failed";
}

function formatRequestDiagnostics(extra) {
  return `endpoint=${diagnostics.endpoint || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${diagnostics.matchedModelDebug || "none"}, available=${diagnostics.availableModels || "unknown"}`;
}

function finishReasonOf(rawReason, hasToolCall, hasContent, errorMessage) {
  if (errorMessage && isContextWindowExceededError(errorMessage)) {
    return { kind: "error", failure: { message: errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE } };
  }
  if (!hasContent) {
    return {
      kind: "error",
      failure: { message: "Antigravity returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
    };
  }
  if (hasToolCall) return { kind: "tool-calls" };
  if (rawReason === "MAX_TOKENS") return { kind: "max-tokens" };
  if (!rawReason || rawReason === "STOP") return { kind: "stop" };
  return {
    kind: "error",
    failure: { message: `Antigravity finished with reason ${rawReason}`, code: "ANTIGRAVITY_FINISH_REASON" },
  };
}

function replayStateOf(model, runtimeModel, replayBlocks) {
  return {
    kind: "antigravity",
    version: 1,
    provider: PROVIDER,
    model: model.id,
    runtimeModel,
    blocks: replayBlocks,
  };
}

export function processStreamLine(line, state) {
  if (!line.startsWith("data:")) return [];
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return [];
  const chunk = safeJsonParse(json);
  if (!isRecord(chunk)) return [];
  if (isRecord(chunk.error)) {
    const message = chunk.error.message || JSON.stringify(chunk.error);
    throw new LlmError(String(message), classifyAntigravityError(String(message)));
  }
  const responseData = isRecord(chunk.response) ? chunk.response : chunk;
  const candidate = Array.isArray(responseData.candidates) ? responseData.candidates[0] : undefined;
  const parts = isRecord(candidate?.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const out = [];

  const closeCurrentBlock = () => {
    if (!state.currentBlock) return;
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      out.push({
        type: "block-end",
        index,
        block: { type: "text", text: state.currentBlock.text },
      });
    } else {
      out.push({
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      });
    }
    state.currentBlock = null;
  };

  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.text !== undefined) {
      const isThinking = part.thought === true;
      const blockType = isThinking ? "reasoning" : "text";
      if (!state.currentBlock || state.currentBlock.type !== blockType) {
        closeCurrentBlock();
        state.currentBlock = {
          type: blockType,
          text: "",
          thinkingSignature: undefined,
          textSignature: undefined,
        };
        state.blocks.push(state.currentBlock);
        state.replayBlocks.push({ type: blockType });
        out.push({ type: "block-start", index: state.blocks.length - 1, blockType });
      }
      const delta = sanitizeText(part.text);
      state.currentBlock.text += delta;
      state.hasContent = true;
      if (isThinking && part.thoughtSignature) {
        state.currentBlock.thinkingSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].thinkingSignature = part.thoughtSignature;
      } else if (!isThinking && part.thoughtSignature) {
        state.currentBlock.textSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].textSignature = part.thoughtSignature;
      }
      out.push({
        type: isThinking ? "reasoning-delta" : "text-delta",
        index: state.blocks.length - 1,
        text: delta,
      });
    }
    if (isRecord(part.functionCall)) {
      closeCurrentBlock();
      const toolName = asString(part.functionCall.name) || "";
      const toolId = sanitizeToolCallId(part.functionCall.id || "", toolName);
      const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
      const argsText = JSON.stringify(args);
      const index = state.blocks.length;
      const block = { type: "tool-call", id: ToolCallId(toolId), name: toolName, arguments: argsText };
      state.blocks.push(block);
      state.replayBlocks.push({
        type: "tool-call",
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
      state.hasContent = true;
      state.hasToolCall = true;
      out.push({ type: "block-start", index, blockType: "tool-call" });
      out.push({
        type: "tool-call-delta",
        index,
        id: ToolCallId(toolId),
        ...(toolName ? { name: toolName } : {}),
        argumentsDelta: argsText,
      });
      out.push({ type: "block-end", index, block });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (isRecord(responseData.usageMetadata)) state.usage = responseData.usageMetadata;
  return out;
}

async function* streamResponseToChunks(response, model, runtimeModel, state) {
  if (!response.body) throw new LlmError("Antigravity response has no body", "TRANSPORT");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = (line) => processStreamLine(line.replace(/\r$/, ""), state);
  const emitBufferedLines = function* () {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield* emitLine(line);
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });
    yield* emitBufferedLines();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* emitLine(buffer.trimEnd());
    buffer = "";
  }

  if (state.currentBlock) {
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      yield { type: "block-end", index, block: { type: "text", text: state.currentBlock.text } };
    } else {
      yield {
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      };
    }
    state.currentBlock = null;
  }

  if (!state.hasContent) return;
  yield { type: "usage", usage: mapUsage(state.usage || {}) };
  yield {
    type: "finish",
    reason: finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent),
    replayState: replayStateOf(model, runtimeModel, state.replayBlocks),
  };
}

export function createStreamState() {
  return {
    blocks: [],
    replayBlocks: [],
    currentBlock: null,
    finishReason: undefined,
    usage: undefined,
    hasContent: false,
    hasToolCall: false,
  };
}

function oauthCallbackHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function sanitizeOAuthProviderError(text) {
  const redacted = redactSecrets(text).trim();
  const parsed = safeJsonParse(redacted);
  if (isRecord(parsed)) {
    const parts = [parsed.error, parsed.error_description].filter(
      (part) => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 300);
  }
  return redacted.slice(0, 300) || "unknown OAuth provider error";
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function getUserEmail(token) {
  try {
    const response = await antigravityFetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    return asString(data.email);
  } catch {
    return undefined;
  }
}

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    const callbackUrl = redirectUri();
    const server = createServer((request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, oauthCallbackHeaders("text/plain; charset=utf-8"));
        response.end("Method Not Allowed");
        return;
      }
      const url = new URL(request.url || "", callbackUrl);
      if (url.pathname !== REDIRECT_PATH) {
        response.writeHead(404, oauthCallbackHeaders());
        response.end("Antigravity OAuth callback route not found.");
        return;
      }
      const providerError = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (providerError) {
        const safe = escapeHtml(providerError.slice(0, 200));
        response.writeHead(400, oauthCallbackHeaders());
        response.end(`Antigravity authentication failed: ${safe}`);
        finish(() => rejectCode(new Error(`OAuth error: ${providerError.slice(0, 200)}`)));
        return;
      }
      if (!code || !state) {
        response.writeHead(400, oauthCallbackHeaders());
        response.end("Antigravity authentication failed: missing code or state.");
        finish(() => rejectCode(new Error("Missing code or state in OAuth callback")));
        return;
      }
      if (state !== expectedState) {
        response.writeHead(400, oauthCallbackHeaders());
        response.end("Antigravity authentication failed: invalid state.");
        finish(() => rejectCode(new Error("OAuth state mismatch")));
        return;
      }
      response.writeHead(200, oauthCallbackHeaders());
      response.end("Antigravity authentication complete. You can close this window and return to DSH.");
      finish(() => resolveCode({ code, state }));
    });
    server.on("error", reject);
    server.listen(callbackPort(), resolveCallbackHost(), () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error("OAuth callback timed out waiting for browser login")));
        server.close();
      }, OAUTH_CALLBACK_TIMEOUT_MS);
      resolve({ server, waitForCode: () => codePromise });
    });
  });
}

export function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }
  } catch {
    // Best effort only.
  }
}

export function browserInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type === "auth_url") openBrowser(event.url);
    },
  };
}

export function terminalInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type !== "auth_url") return;
      console.log(event.instructions || "Open the following URL to sign in:");
      console.log(event.url);
      openBrowser(event.url);
    },
  };
}

export async function loginAntigravity(interaction = browserInteraction()) {
  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  try {
    const callbackUrl = redirectUri();
    const authParams = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: callbackUrl,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    interaction.notify?.({
      type: "auth_url",
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions: "Complete Google sign-in. DSH will capture the local callback.",
    });

    const { code, state: returnedState } = await waitForCode();
    if (returnedState !== state) throw new Error("OAuth state mismatch");
    if (interaction.signal?.aborted) throw new Error("OAuth login aborted");

    const tokenResponse = await antigravityFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl,
        code_verifier: verifier,
      }).toString(),
      signal: interaction.signal,
    });
    if (!tokenResponse.ok) {
      throw new Error(
        `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
      );
    }
    const tokenData = await tokenResponse.json();
    if (!tokenData.refresh_token) {
      throw new Error("No refresh token received. Re-run /antigravity-login and allow offline access.");
    }
    const [email, discoveredProject] = await Promise.all([
      getUserEmail(tokenData.access_token),
      loadCodeAssist(tokenData.access_token),
    ]);
    return {
      refresh: tokenData.refresh_token,
      access: tokenData.access_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
      email,
    };
  } finally {
    server.close();
  }
}

function credentialSummary(credentials) {
  if (!credentials) return { authenticated: false };
  return {
    authenticated: true,
    email: credentialEmail(credentials),
    projectId: credentialProjectId(credentials),
    expires: credentials.expires,
  };
}

async function exchangeOAuthCode(code, verifier, callbackUrl) {
  const tokenResponse = await antigravityFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
    );
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.refresh_token) {
    throw new Error("No refresh token received. Re-run login and allow offline access.");
  }
  const [email, discoveredProject] = await Promise.all([
    getUserEmail(tokenData.access_token),
    loadCodeAssist(tokenData.access_token),
  ]);
  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
    projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
    email,
  };
}

export async function beginWebLogin(store) {
  if (webLoginFlow?.status === "pending") {
    return {
      status: webLoginFlow.status,
      authUrl: webLoginFlow.authUrl,
      startedAt: webLoginFlow.startedAt,
    };
  }

  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const { server, waitForCode } = await startCallbackServer(state);
  const callbackUrl = redirectUri();
  const authParams = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: callbackUrl,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  const flow = {
    status: "pending",
    authUrl: `${AUTH_URL}?${authParams.toString()}`,
    startedAt: Date.now(),
    error: "",
  };
  webLoginFlow = flow;

  void (async () => {
    try {
      const { code, state: returnedState } = await waitForCode();
      if (returnedState !== state) throw new Error("OAuth state mismatch");
      const credentials = await exchangeOAuthCode(code, verifier, callbackUrl);
      await store.write(credentials);
      flow.status = "complete";
      flow.email = credentialEmail(credentials);
      flow.completedAt = Date.now();
      cachedQuota = undefined;
    } catch (error) {
      flow.status = "error";
      flow.error = safeError(error);
      flow.completedAt = Date.now();
    } finally {
      server.close();
    }
  })();

  return {
    status: flow.status,
    authUrl: flow.authUrl,
    startedAt: flow.startedAt,
  };
}

export function getWebLoginStatus() {
  if (!webLoginFlow) return { status: "idle" };
  return {
    status: webLoginFlow.status,
    startedAt: webLoginFlow.startedAt,
    completedAt: webLoginFlow.completedAt,
    email: webLoginFlow.email,
    error: webLoginFlow.error,
  };
}

function credentialProjectId(credentials) {
  return asString(credentials?.projectId);
}

function credentialEmail(credentials) {
  return asString(credentials?.email);
}

function needsRefresh(credentials) {
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}

export async function refreshAntigravityToken(credentials) {
  if (!credentials?.refresh) throw new Error("Missing Antigravity refresh token. Run /antigravity-login.");
  const response = await antigravityFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`,
    );
  }
  const data = await response.json();
  const existingProjectId = credentialProjectId(credentials);
  const discoveredProject = existingProjectId ? undefined : await loadCodeAssist(data.access_token);
  const email = credentialEmail(credentials);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId:
      existingProjectId || discoveredProject || defaultProjectId(email || "antigravity-default"),
  };
}

export function getApiKey(credentials) {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}

export class FileCredentialStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = credentialPath()) {
    this.#file = file;
  }

  path() {
    return this.#file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(credentials) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) await this.write(updated);
      return updated ?? current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async delete() {
    await this.#chain.catch(() => {});
    try {
      await unlink(this.#file);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

export class FileModelSettingsStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = modelSettingsPath()) {
    this.#file = file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return normalizeModelSettings(isRecord(parsed) ? parsed : undefined);
    } catch (error) {
      if (error && error.code === "ENOENT") return normalizeModelSettings(undefined);
      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeModelSettings(settings);
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify({ ...normalized, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
    return this.read();
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) return this.write(updated);
      return current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  setEnabledModelIds(enabledModelIds) {
    return this.modify((current) => ({ ...current, enabledModelIds }));
  }

  reconcileCatalog(catalogModels) {
    return this.modify((current) => reconcileCatalogSettings(current, catalogModels));
  }
}

function modelFromSettings(settings, modelId) {
  const entry = modelByPublicId(settings, modelId);
  if (entry) return entry;
  const legacy = LEGACY_MODEL_METADATA.find((model) => model.id === modelId);
  if (legacy) return { ...legacy, runtime: {}, custom: false };
  // An id the plugin does not know is sent upstream exactly as pinned, instead
  // of silently resolving to some other model.
  return customModelEntry(modelId);
}

export async function loginAndSave(store, interaction = browserInteraction()) {
  const credentials = await loginAntigravity(interaction);
  await store.write(credentials);
  return credentials;
}

async function ensureApiKey(store) {
  let credentials = await store.read();
  if (!credentials) {
    throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
  }
  if (needsRefresh(credentials)) {
    credentials = await store.modify(async (current) => {
      if (!current) throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
      if (!needsRefresh(current)) return current;
      return refreshAntigravityToken(current);
    });
  }
  let warmedProject = null;
  if (!credentialProjectId(credentials) && !antigravityEnv("PROJECT_ID")) {
    warmedProject = await loadCodeAssist(credentials.access);
    if (warmedProject) {
      await store.modify(async (current) => (current ? { ...current, projectId: warmedProject } : current));
    }
  }
  const projectId = resolveProjectId({
    credentialProjectId: credentialProjectId(credentials),
    email: credentialEmail(credentials),
    warmedProject,
  });
  setLastProjectId(projectId);
  return { token: credentials.access, projectId, email: credentialEmail(credentials) };
}

function resolveRuntimeCandidates(model, effort) {
  const override = antigravityEnv("RUNTIME_MODEL")?.trim();
  const runtimeModel = override || resolveRuntimeModelId(model, effort, ROUTING);
  setLastMatchedModelDebug(
    summarizeModelCandidate({
      modelId: model?.id,
      resolved: runtimeModel,
      custom: model?.custom === true,
    }),
  );
  return [runtimeModel];
}

async function fetchStreamResponse(endpoint, headers, body, signal) {
  try {
    return await antigravityFetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (error) {
    setLastError(error);
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
    throw error;
  }
}

async function* requestAntigravityChunks(options, model, signal, store, resolveAttachments) {
  const attachments = resolveAttachments?.();
  const resolvedMessages = await resolveImages(options.messages, attachments, signal);
  const resolvedOptions = { ...options, messages: resolvedMessages };

  if (hasImages(resolvedOptions.messages) && !model.inputModalities.includes("image")) {
    throw new LlmError(`antigravity model "${model.id}" does not support image content`, "UNSUPPORTED_CONTENT");
  }

  const { token, projectId } = await ensureApiKey(store);
  const effort = resolveReasoning(model, resolvedOptions.reasoningEffort);
  const runtimeCandidates = resolveRuntimeCandidates(model, effort);
  const requestHeaders = {
    ...antigravityHeaders(token),
    ...attributionHeaderBag(),
    ...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
  };

  let response;
  let lastText = "";
  let runtimeModel = runtimeCandidates[0];

  for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
    if (emptyAttempt > 0) {
      const delay = 500 * 2 ** (emptyAttempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    for (let candidateIndex = 0; candidateIndex < runtimeCandidates.length; candidateIndex++) {
      runtimeModel = runtimeCandidates[candidateIndex];
      setLastResolvedRuntimeModel(runtimeModel);
      const body = JSON.stringify(buildRequest(resolvedOptions, model, projectId, runtimeModel, effort));

      for (const endpoint of endpointCandidates()) {
        setLastEndpoint(endpoint);
        response = await fetchStreamResponse(endpoint, requestHeaders, body, signal);
        setLastStatus(response.status);
        if (response.ok) break;
        lastText = await response.text();
        if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
        if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
      }

      if (response?.ok) break;
      if (response?.status === 404 && candidateIndex + 1 < runtimeCandidates.length) continue;
      break;
    }

    if (!response || !response.ok) {
      const friendly = friendlyAntigravityError(response?.status, lastText);
      throw new LlmError(
        `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`,
        classifyAntigravityError(friendly),
      );
    }

    const state = createStreamState();
    for await (const chunk of streamResponseToChunks(response, model, runtimeModel, state)) {
      yield chunk;
    }
    if (state.hasContent) return;
  }

  throw new LlmError("Antigravity API returned an empty response", EMPTY_RESPONSE_CODE);
}

export class AntigravityAdapter extends LlmAdapter {
  #store;
  #modelSettings;
  #resolveAttachments;

  constructor(
    store = new FileCredentialStore(),
    modelSettings = new FileModelSettingsStore(),
    resolveAttachments,
  ) {
    super();
    this.#store = store;
    this.#modelSettings = modelSettings;
    this.#resolveAttachments = resolveAttachments;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    const settings = await this.#modelSettings.read();
    return configuredModels(settings).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    }));
  }

  async resolveModel(provider, modelId, signal) {
    if (signal?.aborted) return Promise.reject(new LlmError("antigravity model resolution aborted", "ABORTED"));
    const settings = await this.#modelSettings.read();
    const model = modelFromSettings(settings, modelId);
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    };
  }

  async *stream(options) {
    const settings = await this.#modelSettings.read();
    const model = modelFromSettings(settings, options.model);

    const consumer = new AbortController();
    const upstream =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);
    const iterator = requestAntigravityChunks(
      options,
      model,
      watchdog.signal,
      this.#store,
      this.#resolveAttachments,
    )[Symbol.asyncIterator]();

    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT");
        }
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
      throw error;
    } finally {
      consumer.abort("antigravity stream consumer stopped");
      if (!exhausted) {
        try {
          await iterator.return(undefined);
        } catch {
          // Ignore upstream cleanup failure after consumer cancellation.
        }
      }
      watchdog[Symbol.dispose]();
    }
  }
}

function doctorText() {
  const current = getAntigravityDiagnostics();
  return [
    `provider=${PROVIDER}`,
    `lastResolvedRuntimeModel=${current.resolvedRuntimeModel || "none"}`,
    `availableModels=${current.availableModels || "none"}`,
    `matchedModel=${current.matchedModelDebug || "none"}`,
    `lastEndpoint=${current.endpoint || "none"}`,
    `lastStatus=${current.status ?? "none"}`,
    `lastProjectId=${current.projectId || "none"}`,
    `catalogModels=${getCachedQuota()?.catalogModels?.length ?? "none"}`,
    `lastError=${current.error ? redactSecrets(current.error) : "none"}`,
    `credentialPath=${credentialPath()}`,
    "transport=native-cloud-code-assist-sse",
    "runtimeCli=not-used",
    "commands=/antigravity-login /antigravity-quota /antigravity-doctor /antigravity-logout",
  ].join("\n");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method-not-allowed" });
}

function quotaCardRows(quota) {
  const modelRows = (quota.models || [])
    .filter((model) => !/tab_|chat_/i.test(model.modelId))
    .map((model) => ({
      id: model.modelId,
      label: model.displayName || model.modelId,
      remainingPercent: remainingPercent(model.remainingFraction),
      remainingFraction: model.remainingFraction,
      resetLabel: formatReset(model.resetTime),
      resetTime: model.resetTime,
      provider: model.modelProvider,
      recommended: model.recommended,
      supportsThinking: model.supportsThinking,
      supportsImages: model.supportsImages,
    }));
  const bucketRows = (quota.groups || []).flatMap((group) =>
    (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      group: group.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
    })),
  );
  const groups = (quota.groups || []).map((group) => ({
    displayName: group.displayName,
    description: group.description,
    buckets: (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
    })),
  }));
  return { modelRows, bucketRows, groups, groupDescription: quota.groupDescription };
}

async function webStatus(store, modelSettings) {
  const credentials = await store.read();
  const quota = getCachedQuota();
  const settings = await modelSettings.read();
  return {
    ...credentialSummary(credentials),
    login: getWebLoginStatus(),
    models: modelOptionsPayload(settings, quota),
    quota:
      quota === undefined
        ? undefined
        : {
            projectId: quota.projectId,
            planLabel: quota.planLabel,
            fetchedAt: quota.fetchedAt,
            ...quotaCardRows(quota),
          },
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = safeJsonParse(text);
  if (!isRecord(parsed)) throw new Error("invalid JSON request body");
  return parsed;
}

function emitLlmAdaptersUpdated(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    setLastError(error);
  }
}

function registerWebApi(ctx, store, modelSettings) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: "/antigravity/api",
          handler: async (request, response) => {
            const url = new URL(request.url || "/", "http://dsh.local");
            const path = url.pathname.replace(/^\/antigravity\/api\/?/, "");
            try {
              if (path === "status" || path === "") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              if (path === "login") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const value = await beginWebLogin(store);
                return sendJson(response, 200, { ok: true, value });
              }
              if (path === "quota") {
                if (request.method !== "GET" && request.method !== "POST") {
                  return sendMethodNotAllowed(response);
                }
                const quota = await fetchAccountQuota(store, modelSettings);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, {
                  ok: true,
                  value: {
                    projectId: quota.projectId,
                    planLabel: quota.planLabel,
                    fetchedAt: quota.fetchedAt,
                    ...quotaCardRows(quota),
                    models: modelOptionsPayload(await modelSettings.read(), quota),
                  },
                });
              }
              if (path === "proxy") {
                if (request.method === "GET") {
                  return sendJson(response, 200, { ok: true, value: await getProxyConfig() });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  return sendJson(response, 200, { ok: true, value: await setProxyConfig(body) });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "proxy/test") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                return sendJson(response, 200, {
                  ok: true,
                  value: await testProxyConnection(body.port),
                });
              }
              if (path === "models/custom") {
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  const parsed = normalizeCustomModelId(body.id);
                  if (!parsed.ok) return sendJson(response, 400, { ok: false, error: parsed.error });
                  let rejection;
                  await modelSettings.modify((current) => {
                    const result = addCustomModel(current, parsed.id);
                    if (!result.ok) {
                      rejection = result.error;
                      return undefined;
                    }
                    return result.settings;
                  });
                  if (rejection) return sendJson(response, 409, { ok: false, error: rejection });
                  emitLlmAdaptersUpdated(ctx);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(await modelSettings.read(), getCachedQuota()),
                  });
                }
                if (request.method === "DELETE") {
                  const id = url.searchParams.get("id") || "";
                  let rejection;
                  await modelSettings.modify((current) => {
                    const result = removeCustomModel(current, id);
                    if (!result.ok) {
                      rejection = result.error;
                      return undefined;
                    }
                    return result.settings;
                  });
                  if (rejection) return sendJson(response, 404, { ok: false, error: rejection });
                  emitLlmAdaptersUpdated(ctx);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(await modelSettings.read(), getCachedQuota()),
                  });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "models") {
                if (request.method === "GET") {
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(await modelSettings.read(), getCachedQuota()),
                  });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  if (!Array.isArray(body.enabledModelIds)) {
                    return sendJson(response, 400, { ok: false, error: "enabledModelIds must be an array" });
                  }
                  const settings = await modelSettings.setEnabledModelIds(body.enabledModelIds);
                  emitLlmAdaptersUpdated(ctx);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(settings, getCachedQuota()),
                  });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "logout") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                await store.delete();
                cachedQuota = undefined;
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              return sendJson(response, 404, { ok: false, error: "not-found" });
            } catch (error) {
              return sendJson(response, 500, { ok: false, error: safeError(error) });
            }
          },
        }),
      "dsh-antigravity: web api",
    );
  });
}

async function warmModelCatalog(ctx, store, modelSettings) {
  try {
    const credentials = await store.read();
    if (!credentials) return;
    await fetchAccountQuota(store, modelSettings);
    emitLlmAdaptersUpdated(ctx);
  } catch (error) {
    setLastError(error);
  }
}

export function apply(ctx) {
  const store = new FileCredentialStore(credentialPath());
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  const resolveAttachments = () => ctx.get("attachments");
  const adapter = new AntigravityAdapter(store, modelSettings, resolveAttachments);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  registerWebApi(ctx, store, modelSettings);
  void warmModelCatalog(ctx, store, modelSettings);
}

apply.inject = ["llm"];

export default apply;
