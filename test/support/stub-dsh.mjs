// Minimal stand-ins for the DSH peer packages, so lib/index.js can be imported
// (and its module-level code exercised) without a DSH install.
export const CONTEXT_WINDOW_EXCEEDED_CODE = "LLM_CONTEXT_WINDOW_EXCEEDED";
export const EMPTY_RESPONSE_CODE = "LLM_EMPTY_RESPONSE";
export const QUOTA_EXCEEDED_CODE = "LLM_QUOTA_EXCEEDED";

export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

export class LlmAdapter {}

export function ToolCallId(value) {
  return value;
}

export function ReasoningEffortId(value) {
  return value;
}

export function attributionHeaders() {
  return {};
}

export function contentHasImage(content) {
  return Array.isArray(content) && content.some((block) => block?.type === "image");
}

export function isContextWindowExceededError() {
  return false;
}

export function isQuotaExceededError() {
  return false;
}

export function dshHomePath(...parts) {
  return [process.env.DSH_HOME || ".dsh-home", ...parts].join("/");
}

export function idleWatchdog(signal) {
  return {
    signal,
    async next(iterator) {
      return iterator.next();
    },
    [Symbol.dispose]() {},
  };
}

export function timeoutOf() {
  return undefined;
}
