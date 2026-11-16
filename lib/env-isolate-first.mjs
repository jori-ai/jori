// env-isolate-first.mjs — import this FIRST in a process-manager child's entry
// point. ES modules evaluate their imports in order, so this runs before any
// other module of the process: when the installation lists the process in
// agent-env.json `isolate`, it re-execs in place with the .env values out of
// its starting environment (lib/env-isolate.cjs), before anything else loads.
// The process name comes from the entry file (env-isolate.cjs ENTRIES).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isolateProcessEnv, nameForEntry } = require("./env-isolate.cjs");

const name = nameForEntry(process.argv[1]);
if (name) isolateProcessEnv(name);
