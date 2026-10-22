// Lets `node --test` run the app's TypeScript modules directly: resolves the "@/" alias and
// extensionless imports, and stubs "server-only" (which only works inside Next.js).
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
