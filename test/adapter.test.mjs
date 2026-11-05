/**
 * Adapter-level tests with the DSH peer packages stubbed out: the plugin module
 * must load, register its adapter, build valid upstream requests, and answer the
 * settings-page routes the UI depends on.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Keep the plugin's file stores inside a throwaway home directory.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "agy-test-"));

register("./support/loader.mjs", import.meta.url);
const mod = await import("../lib/index.js");

const CATALOG_ENTRY = {
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  inputModalities: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 64000,
  reasoningEfforts: ["low", "medium", "high"],
  runtime: {
    efforts: {
      low: "claude-opus-5-5-low",
      medium: "claude-opus-5-5-medium",
      high: "claude-opus-5-5-high",
    },
  },
  custom: false,
};

const CUSTOM_ENTRY = {
  id: "gemini-4-argon-medium",
  name: "Gemini 4 Argon Medium",
  inputModalities: ["text", "image"],
  contextWindow: 1048576,
  maxTokens: 65536,
  reasoningEfforts: [],
  runtime: {},
  custom: true,
};

function createContext() {
  const state = { registered: [], emitted: [], routes: undefined };
  const ctx = {
    llm: {
      registerAdapter(providers, adapter) {
        state.registered.push({ providers, adapter });
      },
    },
    emit(event) {
      state.emitted.push(event);
    },
    inject(_deps, callback) {
      callback({
        effect(fn) {
          fn();
        },
        webServer: {
          register(config) {
            state.routes = config;
            return () => {};
          },
        },
      });
    },
    get() {
      return undefined;
    },
  };
  return { ctx, state };
}

function callRoute(routes, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers ?? {});
      },
      end(chunk) {
        this.body += chunk ?? "";
        resolve({ status: this.statusCode, body: this.body ? JSON.parse(this.body) : undefined });
      },
    };
    Promise.resolve(routes.handler(request, response)).catch(reject);
  });
}

test("the plugin module loads and registers the agy adapter", () => {
  assert.equal(typeof mod.default, "function");
  assert.equal(mod.PROVIDER, "agy");
  const { ctx, state } = createContext();
  mod.apply(ctx);
  assert.equal(state.registered.length, 1);
  assert.deepEqual(state.registered[0].providers, ["agy"]);
});

test("catalog entries resolve to exact runtime ids and carry thinking config", () => {
  const request = mod.buildRequest(
    { model: CATALOG_ENTRY.id, messages: [] },
    CATALOG_ENTRY,
    "test-project",
    "claude-opus-5-5-medium",
    "medium",
  );
  assert.equal(request.model, "claude-opus-5-5-medium");
  assert.equal(request.project, "test-project");
  assert.equal(request.request.generationConfig.maxOutputTokens, 64000);
  assert.deepEqual(request.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: 1024,
  });
});

test("custom models are sent verbatim without a thinking contract", () => {
  const request = mod.buildRequest(
    { model: CUSTOM_ENTRY.id, messages: [] },
    CUSTOM_ENTRY,
    "test-project",
    CUSTOM_ENTRY.id,
    undefined,
  );
  assert.equal(request.model, "gemini-4-argon-medium");
  assert.equal(request.request.generationConfig.thinkingConfig, undefined);
  assert.equal(request.request.generationConfig.maxOutputTokens, 65536);
});

test("settings-page routes manage custom model ids", async () => {
  const { ctx, state } = createContext();
  mod.apply(ctx);
  assert.ok(state.routes?.handler, "web routes registered");
  assert.equal(state.routes.path, "/antigravity/api");

  const empty = await callRoute(state.routes, "GET", "/antigravity/api/models");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.value.options, []);

  const added = await callRoute(state.routes, "POST", "/antigravity/api/models/custom", {
    id: "gemini-4-argon-medium",
  });
  assert.equal(added.status, 200);
  const argon = added.body.value.options.find(
    (option) => option.id === "gemini-4-argon-medium",
  );
  assert.equal(argon.custom, true);
  assert.equal(argon.enabled, true);
  assert.equal(argon.name, "Gemini 4 Argon Medium");

  const duplicate = await callRoute(state.routes, "POST", "/antigravity/api/models/custom", {
    id: "gemini-4-argon-medium",
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "model-id-exists");

  const invalid = await callRoute(state.routes, "POST", "/antigravity/api/models/custom", {
    id: "has space",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid-model-id");

  const removed = await callRoute(
    state.routes,
    "DELETE",
    "/antigravity/api/models/custom?id=gemini-4-argon-medium",
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.value.options, []);

  const missing = await callRoute(state.routes, "DELETE", "/antigravity/api/models/custom?id=nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "unknown-model-id");

  assert.ok(state.emitted.includes("llm/adapters-updated"));
});
