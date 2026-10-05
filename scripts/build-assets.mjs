#!/usr/bin/env node
// Copies the non-TypeScript files the code reads beside itself (via import.meta.url) into the compiled tree, at the same relative paths.
// usage: node scripts/build-assets.mjs [srcDir=src] [outDir=dist]
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const [src = "src", out = "dist"] = process.argv.slice(2);
const ASSETS = ["core/schema.sql", "core/embed/models.lock.json", "core/compile/tectonic.lock.json", "core/verify/eos-onnx.lock.json"];
for (const rel of ASSETS) {
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  cpSync(join(src, rel), join(out, rel));
}
