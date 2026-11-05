// Resolve every @deepseek-ai/* peer dependency to the local stub module.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@deepseek-ai/")) {
    return { url: new URL("./stub-dsh.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
