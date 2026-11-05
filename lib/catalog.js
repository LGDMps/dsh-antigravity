/**
 * Model catalog for the Antigravity adapter.
 *
 * Everything in this module is pure: it turns the backend's
 * `fetchAvailableModels` payload into the model entries DSH offers, and keeps
 * the persisted model settings consistent with that live catalog. No network,
 * credentials, or DSH imports live here, so the whole model-list pipeline can
 * be tested without a DSH install.
 */

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
const TIERED_EFFORT_LEVELS = ["low", "medium", "high"];
const EFFORT_SUFFIX = /^(.*)-(minimal|low|medium|high|xhigh)$/i;
const TIERED_SUFFIX = /-tiered$/i;
const INTERNAL_MODEL_PREFIXES = ["chat_", "tab_"];
const CUSTOM_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const RUNTIME_MODEL_PREFIX = /^(gemini-|claude-|gpt-oss-)/i;

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function remainingPercent(remaining) {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

export function formatReset(resetTime) {
  if (!resetTime) return "n/a";
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) return resetTime;
  const delta = timestamp - Date.now();
  if (delta <= 0) return "now";
  const totalMinutes = Math.round(delta / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function isUsableModelId(id) {
  return RUNTIME_MODEL_PREFIX.test(id) && !/\s/.test(id) && !/^MODEL_/i.test(id);
}

/** Split a trailing reasoning level off a runtime model id. */
export function splitEffortSuffix(id) {
  const match = EFFORT_SUFFIX.exec(String(id));
  if (!match) return undefined;
  return { base: match[1], effort: match[2].toLowerCase() };
}

/** "claude-opus-5-5" -> "Claude Opus 5.5"; "gemini-3.8-flash-tiered" -> "Gemini 3.8 Flash Tiered". */
export function modelNameFromId(id) {
  return String(id)
    .replace(/(\d+)-(\d+)(?=[-_]|$)/g, "$1.$2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bOss\b/g, "OSS");
}

function stripEffortLabel(label) {
  return String(label || "")
    .replace(/\s*\((?:minimal|low|medium|high|xhigh)\)\s*$/i, "")
    .trim();
}

export function extractModelVersion(model) {
  const name = String(model?.name || "");
  const id = String(model?.id || model?.modelId || "");
  const idMatch =
    id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i) || id.match(/\b(\d+(?:\.\d+)+)\b/);
  if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  const nameMatch =
    name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i) || name.match(/\b(\d+(?:\.\d+)+)\b/);
  if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  return [0];
}

function compareVersionsDesc(v1, v2) {
  const len = Math.max(v1.length, v2.length);
  for (let i = 0; i < len; i++) {
    const num1 = v1[i] !== undefined ? v1[i] : 0;
    const num2 = v2[i] !== undefined ? v2[i] : 0;
    if (num1 !== num2) return num2 - num1;
  }
  return 0;
}

function sameVersion(left, right) {
  if (!left.length || !right.length) return true;
  if (left[0] === 0 || right[0] === 0) return true;
  return compareVersionsDesc(left, right) === 0;
}

function getFamilyOrder(model) {
  const text = `${model?.id || ""} ${model?.name || ""}`.toLowerCase();
  if (text.includes("gemini")) return 1;
  if (text.includes("claude")) return 2;
  if (text.includes("gpt")) return 3;
  return 4;
}

function getVariantScore(model) {
  const text = `${model?.name || ""} ${model?.id || ""}`.toLowerCase();
  if (text.includes("ultra")) return 1;
  if (text.includes("pro") && !text.includes("lite")) return 2;
  if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
  if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
  if (text.includes("image")) return 5;
  if (text.includes("lite") && !text.includes("thinking")) return 6;
  if (text.includes("lite") && text.includes("thinking")) return 7;
  return 10;
}

export function compareAntigravityModels(a, b) {
  const famA = getFamilyOrder(a);
  const famB = getFamilyOrder(b);
  if (famA !== famB) return famA - famB;

  const verComp = compareVersionsDesc(extractModelVersion(a), extractModelVersion(b));
  if (verComp !== 0) return verComp;

  const variantA = getVariantScore(a);
  const variantB = getVariantScore(b);
  if (variantA !== variantB) return variantA - variantB;

  return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
}

export function compareAntigravityModelOptions(a, b) {
  const aEnabled = Boolean(a?.enabled);
  const bEnabled = Boolean(b?.enabled);
  if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
  return compareAntigravityModels(a, b);
}

/** Per-request output-token ceiling, derived from the upstream model id. */
export function maxOutputTokensFor(runtimeModel) {
  const id = String(runtimeModel || "");
  if (id.startsWith("claude-")) return 64000;
  if (id.startsWith("gpt-oss-")) return 32768;
  if (id.startsWith("gemini-3.1-pro") || id === "gemini-pro-agent") return 65535;
  if (id.startsWith("gemini-")) return 65536;
  return 8192;
}

function shapeFor(id, info) {
  const lower = String(id).toLowerCase();
  const supportsImages = isRecord(info) ? Boolean(info.supportsImages) : false;
  const isMultimodal = supportsImages || /gemini|claude/i.test(id);
  return {
    inputModalities: isMultimodal ? ["text", "image"] : ["text"],
    contextWindow: lower.includes("claude") ? 200000 : lower.includes("gpt-oss") ? 131072 : 1048576,
    maxTokens: maxOutputTokensFor(id),
  };
}

function effortRank(level) {
  const index = EFFORT_LEVELS.indexOf(level);
  return index === -1 ? EFFORT_LEVELS.length : index;
}

function groupToEntry(group) {
  const bare = group.members.find((member) => !member.effort);
  const effortMembers = group.members
    .filter((member) => member.effort)
    .sort((left, right) => effortRank(left.effort) - effortRank(right.effort));
  const supportInfo = bare?.info ?? effortMembers[0]?.info ?? {};
  const quotaMember =
    group.members.find((member) => typeof member.info?.quotaInfo?.remainingFraction === "number") ??
    bare ??
    effortMembers[0] ??
    group.members[0];

  const efforts = {};
  for (const member of effortMembers) efforts[member.effort] = member.runtimeId;

  const isTiered = TIERED_SUFFIX.test(group.id);
  const reasoningEfforts = effortMembers.length
    ? effortMembers.map((member) => member.effort)
    : isTiered
      ? [...TIERED_EFFORT_LEVELS]
      : [];

  const label = stripEffortLabel(
    supportInfo.displayName || supportInfo.label || supportInfo.modelName || "",
  );
  const name =
    label && sameVersion(extractModelVersion({ id: group.id }), extractModelVersion({ name: label }))
      ? label
      : modelNameFromId(group.id);

  return {
    id: group.id,
    name,
    ...shapeFor(group.id, supportInfo),
    reasoningEfforts,
    runtime: {
      ...(bare ? { bare: bare.runtimeId } : {}),
      efforts,
    },
    quotaModelId: quotaMember?.runtimeId,
    custom: false,
  };
}

/**
 * Build the model entries for one account from a raw `fetchAvailableModels`
 * payload. Effort variants of one model collapse into a single entry that keeps
 * an exact runtime-id map, so nothing is fabricated and nothing is mistranslated.
 */
export function buildCatalogModels(payload) {
  const models = isRecord(payload) && isRecord(payload.models) ? payload.models : {};
  const groups = new Map();

  for (const [runtimeId, info] of Object.entries(models)) {
    if (!isUsableModelId(runtimeId) || !isRecord(info)) continue;
    if (info.isInternal) continue;
    if (INTERNAL_MODEL_PREFIXES.some((prefix) => runtimeId.startsWith(prefix))) continue;

    const split = splitEffortSuffix(runtimeId);
    const baseId = split ? split.base : runtimeId;
    let group = groups.get(baseId);
    if (!group) {
      group = { id: baseId, members: [] };
      groups.set(baseId, group);
    }
    group.members.push({ runtimeId, effort: split?.effort, info });
  }

  const entries = [...groups.values()].map(groupToEntry);
  entries.sort(compareAntigravityModels);
  return entries;
}

/** Entry for a model id the user typed by hand; it is sent upstream verbatim. */
export function customModelEntry(id) {
  return {
    id,
    name: modelNameFromId(id),
    ...shapeFor(id, undefined),
    reasoningEfforts: [],
    runtime: {},
    quotaModelId: undefined,
    custom: true,
  };
}

export function normalizeCustomModelId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id || !CUSTOM_MODEL_ID.test(id)) return { ok: false, error: "invalid-model-id" };
  return { ok: true, id };
}

function normalizeEntry(raw) {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || /\s/.test(raw.id)) return undefined;
  const reasoningEfforts = Array.isArray(raw.reasoningEfforts)
    ? [...new Set(raw.reasoningEfforts.filter((level) => EFFORT_LEVELS.includes(level)))]
    : [];
  const runtime = isRecord(raw.runtime) ? raw.runtime : {};
  const rawEfforts = isRecord(runtime.efforts) ? runtime.efforts : {};
  const efforts = {};
  for (const level of EFFORT_LEVELS) {
    if (typeof rawEfforts[level] === "string" && rawEfforts[level]) efforts[level] = rawEfforts[level];
  }
  const inputModalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((item) => item === "text" || item === "image")
    : [];
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name ? raw.name : modelNameFromId(raw.id),
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : shapeFor(raw.id).contextWindow,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : maxOutputTokensFor(raw.id),
    reasoningEfforts,
    runtime: {
      ...(typeof runtime.bare === "string" && runtime.bare ? { bare: runtime.bare } : {}),
      efforts,
    },
    quotaModelId: typeof raw.quotaModelId === "string" ? raw.quotaModelId : undefined,
    custom: raw.custom === true,
  };
}

export function normalizeModelSettings(raw) {
  const catalogModels = Array.isArray(raw?.catalogModels)
    ? raw.catalogModels.map(normalizeEntry).filter(Boolean)
    : [];
  const customModels = Array.isArray(raw?.customModels)
    ? [
        ...new Set(
          raw.customModels
            .map((value) => normalizeCustomModelId(value))
            .filter((result) => result.ok)
            .map((result) => result.id),
        ),
      ]
    : [];
  const enabledModelIds = Array.isArray(raw?.enabledModelIds)
    ? [
        ...new Set(
          raw.enabledModelIds.filter(
            (id) => typeof id === "string" && id.length > 0 && !/\s/.test(id),
          ),
        ),
      ]
    : [];
  return {
    enabledModelIds,
    customModels,
    catalogModels,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

/**
 * True when a catalog entry already serves this id, either as the public entry
 * id or as one of its exact runtime ids (for example "claude-opus-5-5-high").
 */
export function catalogOwnsModelId(catalogModels, id) {
  return (Array.isArray(catalogModels) ? catalogModels : []).some((model) => {
    if (model.id === id) return true;
    const runtime = isRecord(model.runtime) ? model.runtime : {};
    if (runtime.bare === id) return true;
    return isRecord(runtime.efforts) && Object.values(runtime.efforts).includes(id);
  });
}

/** Catalog entries plus the user's manual entries, minus ids the catalog owns. */
export function allModelEntries(settings) {
  const normalized = normalizeModelSettings(settings);
  const custom = normalized.customModels
    .filter((id) => !catalogOwnsModelId(normalized.catalogModels, id))
    .map((id) => customModelEntry(id));
  return [...normalized.catalogModels, ...custom];
}

export function configuredModels(settings) {
  const normalized = normalizeModelSettings(settings);
  const enabled = new Set(normalized.enabledModelIds);
  return allModelEntries(normalized)
    .filter((model) => enabled.has(model.id))
    .sort(compareAntigravityModels);
}

export function modelByPublicId(settings, modelId) {
  return allModelEntries(settings).find((model) => model.id === modelId);
}

/**
 * Fold a freshly fetched catalog into the persisted settings.
 *
 * - Models that vanished from the catalog stop being offered and enabled.
 * - Models discovered for the first time are enabled automatically, so a model
 *   that becomes available to the account appears in DSH without manual work.
 * - Manual entries are preserved, and dropped once the catalog itself serves
 *   the same id (directly or as one of its runtime ids).
 */
export function reconcileCatalogSettings(settings, catalogModels) {
  const normalized = normalizeModelSettings(settings);
  const fresh = Array.isArray(catalogModels) ? catalogModels : [];
  const freshIds = new Set(fresh.map((model) => model.id));
  const knownIds = new Set([
    ...normalized.catalogModels.map((model) => model.id),
    ...normalized.enabledModelIds,
  ]);
  const customModels = normalized.customModels.filter((id) => !catalogOwnsModelId(fresh, id));
  const availableIds = new Set([...freshIds, ...customModels]);

  const enabledModelIds = new Set(
    normalized.enabledModelIds.filter((id) => availableIds.has(id)),
  );
  for (const id of freshIds) {
    if (!knownIds.has(id)) enabledModelIds.add(id);
  }

  return {
    catalogModels: fresh,
    customModels,
    enabledModelIds: [...enabledModelIds],
    updatedAt: normalized.updatedAt,
  };
}

/** Add a manual model id to the settings (and enable it). */
export function addCustomModel(settings, rawId) {
  const normalized = normalizeModelSettings(settings);
  const parsed = normalizeCustomModelId(rawId);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const inCatalog = catalogOwnsModelId(normalized.catalogModels, parsed.id);
  if (inCatalog) return { ok: false, error: "model-id-in-catalog" };
  if (normalized.customModels.includes(parsed.id)) return { ok: false, error: "model-id-exists" };
  const enabled = new Set(normalized.enabledModelIds);
  enabled.add(parsed.id);
  return {
    ok: true,
    settings: {
      ...normalized,
      customModels: [...normalized.customModels, parsed.id],
      enabledModelIds: [...enabled],
    },
  };
}

/** Remove a manual model id (and stop offering it). */
export function removeCustomModel(settings, rawId) {
  const normalized = normalizeModelSettings(settings);
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!normalized.customModels.includes(id)) return { ok: false, error: "unknown-model-id" };
  return {
    ok: true,
    settings: {
      ...normalized,
      customModels: normalized.customModels.filter((entry) => entry !== id),
      enabledModelIds: normalized.enabledModelIds.filter((entry) => entry !== id),
    },
  };
}

function quotaFields(fraction, resetTime) {
  return {
    available: true,
    remainingFraction: fraction,
    remainingPercent: remainingPercent(fraction),
    resetLabel: resetTime ? formatReset(resetTime) : undefined,
    resetTime: resetTime ? String(resetTime) : undefined,
  };
}

/** Every upstream id an entry can be sent as; any of them may carry quota rows. */
function runtimeIdsOf(model) {
  const ids = [];
  const push = (id) => {
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  };
  push(model.id);
  push(model.quotaModelId);
  const runtime = isRecord(model.runtime) ? model.runtime : {};
  push(runtime.bare);
  if (isRecord(runtime.efforts)) {
    for (const value of Object.values(runtime.efforts)) push(value);
  }
  return ids;
}

function quotaForModel(model, quota) {
  if (!quota) return {};
  const ids = runtimeIdsOf(model);
  const catalogModels = Array.isArray(quota.catalogModels) ? quota.catalogModels : [];
  const byId = new Map(catalogModels.filter(isRecord).map((entry) => [entry.id, entry]));
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry && typeof entry.remainingFraction === "number") {
      return quotaFields(entry.remainingFraction, entry.resetTime);
    }
  }
  const rows = Array.isArray(quota.models) ? quota.models : [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.remainingFraction !== "number") continue;
    if (ids.includes(row.modelId)) return quotaFields(row.remainingFraction, row.resetTime);
  }
  return {};
}

/** The model selector payload served to the settings page. */
export function modelOptionsPayload(settings, quota) {
  const normalized = normalizeModelSettings(settings);
  const enabled = new Set(normalized.enabledModelIds);
  const options = allModelEntries(normalized).map((model) => ({
    id: model.id,
    name: model.name,
    inputModalities: model.inputModalities,
    reasoningEfforts: model.reasoningEfforts,
    custom: model.custom === true,
    enabled: enabled.has(model.id),
    ...quotaForModel(model, quota),
  }));
  options.sort(compareAntigravityModelOptions);
  return { enabledModelIds: [...enabled], options };
}

const EFFORT_FALLBACK_ORDER = {
  minimal: ["minimal", "low", "medium", "high"],
  low: ["low", "medium", "high", "minimal"],
  medium: ["medium", "high", "low", "minimal"],
  high: ["high", "medium", "low", "minimal"],
  xhigh: ["xhigh", "high", "medium", "low", "minimal"],
};

export function effortFallbackOrder(effort) {
  return EFFORT_FALLBACK_ORDER[effort] ?? ["high", "medium", "low", "minimal"];
}

/**
 * Resolve the upstream id for one offered model.
 *
 * Entries built from the live catalog carry an exact runtime map, so a reasoning
 * level maps to an id the account actually advertises. Manual entries are passed
 * upstream verbatim. Ids kept alive only by old DSH sessions fall back to
 * `legacyRoutes`, the static routing table the caller owns.
 */
export function resolveRuntimeModelId(model, effort, legacyRoutes = {}) {
  if (!model) return undefined;
  if (model.custom) return model.id;

  const runtime = isRecord(model.runtime) ? model.runtime : undefined;
  const efforts = isRecord(runtime?.efforts) ? runtime.efforts : {};
  const hasRuntimeMap = Boolean(runtime?.bare) || Object.keys(efforts).length > 0;

  if (!hasRuntimeMap) {
    const route = isRecord(legacyRoutes) ? legacyRoutes[model.id] : undefined;
    if (!isRecord(route)) return model.id;
    const routing = isRecord(route.routing) ? route.routing : {};
    if (effort === undefined || effort === "off") {
      return route.off ?? routing.high ?? route.defaultRequestId ?? model.id;
    }
    for (const level of effortFallbackOrder(effort)) {
      if (routing[level]) return routing[level];
    }
    return route.off ?? route.defaultRequestId ?? model.id;
  }

  if (effort === undefined || effort === "off") {
    return runtime.bare ?? efforts.high ?? efforts.medium ?? efforts.low ?? model.id;
  }
  for (const level of effortFallbackOrder(effort)) {
    if (efforts[level]) return efforts[level];
  }
  return runtime.bare ?? model.id;
}
