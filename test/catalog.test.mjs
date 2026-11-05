import assert from "node:assert/strict";
import test from "node:test";

import {
  addCustomModel,
  allModelEntries,
  buildCatalogModels,
  configuredModels,
  customModelEntry,
  modelByPublicId,
  modelOptionsPayload,
  normalizeCustomModelId,
  normalizeModelSettings,
  reconcileCatalogSettings,
  removeCustomModel,
  resolveRuntimeModelId,
} from "../lib/catalog.js";

/**
 * Trimmed copy of a real `fetchAvailableModels` response: one Google AI Pro
 * account, 2026-11. It contains the internal entries the backend mixes in, the
 * effort variants of two Claude models, and no Gemini 4 model.
 */
const LIVE_CATALOG = {
  defaultAgentModelId: "claude-opus-5-5-low",
  models: {
    chat_20706: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
    chat_23310: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
    "claude-opus-5-5-high": {
      displayName: "Claude Opus 5.5 (High)",
      recommended: true,
      supportsThinking: true,
      quotaInfo: { remainingFraction: 1, resetTime: "2026-11-05T16:00:10Z" },
    },
    "claude-opus-5-5-low": {
      displayName: "Claude Opus 5.5 (Low)",
      supportsThinking: true,
      quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-05T16:00:10Z" },
    },
    "claude-opus-5-5-medium": {
      displayName: "Claude Opus 5.5 (Medium)",
      supportsThinking: true,
      quotaInfo: { remainingFraction: 0.75 },
    },
    "claude-sonnet-5-5-high": { displayName: "Claude Sonnet 5.5 (High)", supportsThinking: true },
    "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)", supportsThinking: true },
    "gemini-2.5-flash": { displayName: "Gemini 3.5 Flash Lite", supportsThinking: true },
    "gemini-2.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite" },
    "gemini-2.5-flash-thinking": { displayName: "Gemini 3.5 Flash Lite", supportsThinking: true },
    "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", supportsThinking: true },
    "gemini-3-flash": { displayName: "Gemini 3 Flash", supportsThinking: true },
    "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image", supportsImages: true },
    "gemini-3.1-flash-lite": { displayName: "Gemini 3.1 Flash Lite" },
    "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite", supportsThinking: true },
    "gemini-3.8-flash-tiered": { recommended: true, supportsThinking: true },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", supportsThinking: true },
    tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
    tab_jump_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
  },
};

const LEGACY_ROUTES = {
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
    defaultRequestId: "gemini-pro-agent",
  },
};

function ids(entries) {
  return entries.map((entry) => entry.id);
}

test("builds one entry per model, folding effort variants", () => {
  const entries = buildCatalogModels(LIVE_CATALOG);
  assert.deepEqual(ids(entries).sort(), [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-pro",
    "gemini-3-flash",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash-tiered",
    "gpt-oss-120b",
  ]);
});

test("drops internal entries and never fabricates models the account cannot see", () => {
  const offered = new Set(ids(buildCatalogModels(LIVE_CATALOG)));
  for (const ghost of [
    "chat_20706",
    "tab_flash_lite_preview",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ]) {
    assert.equal(offered.has(ghost), false, `${ghost} must not be offered`);
  }
});

test("Claude effort variants become one entry with an exact runtime map", () => {
  const opus = buildCatalogModels(LIVE_CATALOG).find((entry) => entry.id === "claude-opus-5-5");
  assert.equal(opus.name, "Claude Opus 5.5");
  assert.deepEqual(opus.reasoningEfforts, ["low", "medium", "high"]);
  assert.deepEqual(opus.runtime, {
    efforts: {
      low: "claude-opus-5-5-low",
      medium: "claude-opus-5-5-medium",
      high: "claude-opus-5-5-high",
    },
  });
  assert.equal(resolveRuntimeModelId(opus, "high"), "claude-opus-5-5-high");
  assert.equal(resolveRuntimeModelId(opus, "low"), "claude-opus-5-5-low");
  assert.equal(resolveRuntimeModelId(opus, "off"), "claude-opus-5-5-high");
  assert.equal(resolveRuntimeModelId(opus, undefined), "claude-opus-5-5-high");
  // A level below the advertised minimum degrades to the closest one available.
  assert.equal(resolveRuntimeModelId(opus, "minimal"), "claude-opus-5-5-low");
  // An unknown level falls back to the highest advertised one, never to a made-up id.
  assert.equal(resolveRuntimeModelId(opus, "bogus"), "claude-opus-5-5-high");
  assert.ok(
    ["claude-opus-5-5-high", "claude-opus-5-5-low", "claude-opus-5-5-medium"].includes(
      opus.quotaModelId,
    ),
  );
});

test("tiered models expose thinking levels while keeping their runtime id", () => {
  const tiered = buildCatalogModels(LIVE_CATALOG).find(
    (entry) => entry.id === "gemini-3.8-flash-tiered",
  );
  assert.equal(tiered.name, "Gemini 3.8 Flash Tiered");
  assert.deepEqual(tiered.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(resolveRuntimeModelId(tiered, "high"), "gemini-3.8-flash-tiered");
  assert.equal(resolveRuntimeModelId(tiered, "off"), "gemini-3.8-flash-tiered");
});

test("models without effort variants get no effort picker", () => {
  const lite = buildCatalogModels(LIVE_CATALOG).find((entry) => entry.id === "gemini-3.5-flash-lite");
  assert.deepEqual(lite.reasoningEfforts, []);
  assert.equal(resolveRuntimeModelId(lite, "high"), "gemini-3.5-flash-lite");
});

test("custom entries are passed through verbatim", () => {
  const argon = customModelEntry("gemini-4-argon-medium");
  assert.equal(argon.custom, true);
  assert.equal(argon.name, "Gemini 4 Argon Medium");
  assert.equal(resolveRuntimeModelId(argon, "high"), "gemini-4-argon-medium");
  assert.equal(resolveRuntimeModelId(argon, undefined), "gemini-4-argon-medium");
});

test("legacy ids keep their old routing instead of being rewritten randomly", () => {
  const legacy = { id: "gemini-3.1-pro", runtime: {}, custom: false };
  assert.equal(resolveRuntimeModelId(legacy, "high", LEGACY_ROUTES), "gemini-pro-agent");
  assert.equal(resolveRuntimeModelId(legacy, "off", LEGACY_ROUTES), "gemini-3.1-pro-low");
  assert.equal(resolveRuntimeModelId({ id: "unknown-x", runtime: {} }, "high", LEGACY_ROUTES), "unknown-x");
});

test("custom model ids are validated", () => {
  assert.equal(normalizeCustomModelId("gemini-4-argon-medium").ok, true);
  assert.equal(normalizeCustomModelId("  gemini-4-argon-high  ").id, "gemini-4-argon-high");
  assert.equal(normalizeCustomModelId("has space").ok, false);
  assert.equal(normalizeCustomModelId("").ok, false);
  assert.equal(normalizeCustomModelId(undefined).ok, false);
  assert.equal(normalizeCustomModelId("-leading").ok, false);
  assert.equal(normalizeCustomModelId("a".repeat(121)).ok, false);
});

test("first catalog fetch enables everything it offers", () => {
  const catalog = buildCatalogModels(LIVE_CATALOG);
  const reconciled = reconcileCatalogSettings(undefined, catalog);
  assert.equal(reconciled.enabledModelIds.length, catalog.length);
  assert.deepEqual(
    [...reconciled.enabledModelIds].sort(),
    catalog.map((entry) => entry.id).sort(),
  );
});

test("newly discovered models are enabled; vanished ones are dropped", () => {
  const before = buildCatalogModels(LIVE_CATALOG);
  const settings = {
    catalogModels: before,
    enabledModelIds: before.map((entry) => entry.id).filter((id) => id !== "gemini-2.5-pro"),
    customModels: [],
  };
  const withArgon = buildCatalogModels({
    models: {
      ...LIVE_CATALOG.models,
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" },
    },
  });
  const afterCatalog = withArgon.filter((entry) => entry.id !== "gemini-2.5-flash-lite");
  const reconciled = reconcileCatalogSettings(settings, afterCatalog);

  assert.equal(reconciled.enabledModelIds.includes("gemini-4-argon"), true, "new model auto-enabled");
  assert.equal(reconciled.enabledModelIds.includes("gemini-2.5-flash-lite"), false, "removed model dropped");
  assert.equal(reconciled.enabledModelIds.includes("gemini-2.5-pro"), false, "manual opt-out preserved");
});

test("custom models survive refreshes and are adopted once the catalog owns them", () => {
  const base = buildCatalogModels(LIVE_CATALOG);
  const withCustom = addCustomModel(
    { catalogModels: base, enabledModelIds: base.map((entry) => entry.id) },
    "gemini-4-argon-medium",
  );
  assert.equal(withCustom.ok, true);

  const refreshed = reconcileCatalogSettings(withCustom.settings, base);
  assert.deepEqual(refreshed.customModels, ["gemini-4-argon-medium"]);
  assert.equal(refreshed.enabledModelIds.includes("gemini-4-argon-medium"), true);

  const catalogWithArgon = buildCatalogModels({
    models: { ...LIVE_CATALOG.models, "gemini-4-argon-medium": { displayName: "Gemini 4 Argon" } },
  });
  const adopted = reconcileCatalogSettings(refreshed, catalogWithArgon);
  assert.deepEqual(adopted.customModels, [], "catalog takes ownership of the id");
  assert.equal(adopted.enabledModelIds.includes("gemini-4-argon"), true);
});

test("adding a custom model rejects duplicates, catalog ids and junk", () => {
  const base = buildCatalogModels(LIVE_CATALOG);
  const settings = { catalogModels: base, enabledModelIds: [] };
  assert.equal(addCustomModel(settings, "gemini-4-argon-medium").ok, true);
  const once = addCustomModel(settings, "gemini-4-argon-medium").settings;
  assert.equal(addCustomModel(once, "gemini-4-argon-medium").error, "model-id-exists");
  assert.equal(addCustomModel(settings, "gemini-3.8-flash-tiered").error, "model-id-in-catalog");
  assert.equal(addCustomModel(settings, "claude-opus-5-5-high").error, "model-id-in-catalog");
  assert.equal(addCustomModel(settings, "bad id").error, "invalid-model-id");
});

test("removing a custom model unchecks it", () => {
  const base = buildCatalogModels(LIVE_CATALOG);
  const added = addCustomModel({ catalogModels: base, enabledModelIds: [] }, "x-model-1").settings;
  const removed = removeCustomModel(added, "x-model-1");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.settings.customModels, []);
  assert.deepEqual(removed.settings.enabledModelIds, []);
  assert.equal(removeCustomModel(added, "never-added").error, "unknown-model-id");
});

test("selector payload carries custom flag, enabled state and per-model quota", () => {
  const base = buildCatalogModels(LIVE_CATALOG);
  const settings = addCustomModel(
    {
      catalogModels: base,
      enabledModelIds: base.map((entry) => entry.id).filter((id) => id !== "gemini-2.5-pro"),
    },
    "gemini-4-argon-medium",
  ).settings;

  const quota = {
    catalogModels: [
      { id: "claude-opus-5-5-low", remainingFraction: 0.5, resetTime: "2026-11-05T16:00:10Z" },
      { id: "gemini-3.8-flash-tiered", remainingFraction: 1 },
    ],
    models: [],
  };
  const payload = modelOptionsPayload(settings, quota);

  assert.equal(payload.options[0].enabled, true, "enabled models sort first");
  const argon = payload.options.find((option) => option.id === "gemini-4-argon-medium");
  assert.equal(argon.custom, true);
  assert.equal(argon.enabled, true);

  const opus = payload.options.find((option) => option.id === "claude-opus-5-5");
  assert.equal(opus.custom, false);
  assert.equal(opus.remainingPercent, 50);
  assert.ok(opus.resetLabel);

  const off = payload.options.find((option) => option.id === "gemini-2.5-pro");
  assert.equal(off.enabled, false);
});

test("settings are normalized defensively", () => {
  const normalized = normalizeModelSettings({
    catalogModels: [{ id: "gemini-x" }, { id: "bad id" }, null, "junk"],
    customModels: ["ok-id", "ok-id", "has space", 7],
    enabledModelIds: ["ok-id", "ok-id", "with space", 3],
  });
  assert.deepEqual(normalized.catalogModels.map((entry) => entry.id), ["gemini-x"]);
  assert.deepEqual(normalized.customModels, ["ok-id"]);
  assert.deepEqual(normalized.enabledModelIds, ["ok-id"]);
});

test("configured models are the enabled ones the catalog still knows", () => {
  const base = buildCatalogModels(LIVE_CATALOG);
  const settings = {
    catalogModels: base,
    enabledModelIds: ["gemini-3.8-flash-tiered", "claude-opus-5-5", "no-such-model"],
    customModels: [],
  };
  assert.deepEqual(
    ids(configuredModels(settings)).sort(),
    ["claude-opus-5-5", "gemini-3.8-flash-tiered"],
  );
  assert.deepEqual(ids(configuredModels({ catalogModels: [], enabledModelIds: [] })), []);
  assert.equal(modelByPublicId(settings, "claude-opus-5-5").name, "Claude Opus 5.5");
  assert.equal(allModelEntries(settings).length, base.length);
});
