import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../../src/", import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  let spec = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
  if ((spec.startsWith(".") || spec.startsWith("file:")) && !/\.[cm]?[jt]sx?$/.test(spec)) {
    const base = new URL(spec, context.parentURL).href;
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      if (existsSync(fileURLToPath(base + ext))) return next(base + ext, context);
    }
  }
  return next(spec, context);
}
