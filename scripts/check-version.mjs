#!/usr/bin/env node
/** Verify all application version fields match a release version. */
import fs from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node scripts/check-version.mjs <x.y.z>");
  process.exit(1);
}
const files = [
  ["package.json", (text) => JSON.parse(text).version],
  ["src-tauri/tauri.conf.json", (text) => JSON.parse(text).version],
  ["src-tauri/Cargo.toml", (text) => text.match(/^version\s*=\s*"([^"]+)"/m)?.[1]],
  ["src-tauri/Cargo.lock", (text) => text.match(/name = "chimera-switch"\nversion = "([^"]+)"/)?.[1]],
];
const failures = [];
for (const [file, readVersion] of files) {
  let actual;
  try {
    actual = readVersion(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    continue;
  }
  if (actual !== version) failures.push(`${file}: expected ${version}, found ${actual ?? "missing"}`);
  else console.log(`[check-version] OK ${file}: ${version}`);
}
if (failures.length) {
  console.error(`[check-version] failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
