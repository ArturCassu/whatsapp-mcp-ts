#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const zapTs = pathToFileURL(path.join(root, "src", "zap.ts")).href;
await import(zapTs);
