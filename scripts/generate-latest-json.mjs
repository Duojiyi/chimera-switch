#!/usr/bin/env node
/**
 * Generate the Tauri updater manifest from the release's signed artifacts.
 *
 * Usage: node scripts/generate-latest-json.mjs <assets-dir> <tag> <repo> [output] [pub-date]
 */
import fs from "node:fs";
import path from "node:path";

const [assetsDir, tag, repo, output = "latest.json", pubDateArg] = process.argv.slice(2);
const githubRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
if (!assetsDir || !/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !githubRepoPattern.test(repo ?? "")) {
  console.error("Usage: node scripts/generate-latest-json.mjs <assets-dir> <vX.Y.Z> <owner/repo> [output] [pub-date]");
  process.exit(1);
}
const pubDate = pubDateArg ? new Date(pubDateArg) : new Date();
if (Number.isNaN(pubDate.getTime())) {
  console.error(`Invalid pub-date: ${pubDateArg}`);
  process.exit(1);
}

const version = tag.slice(1);
const artifacts = {
  mac: `Chimera-Switch-${tag}-macOS.tar.gz`,
  windowsX64: `Chimera-Switch-${tag}-Windows.msi`,
  windowsArm64: `Chimera-Switch-${tag}-Windows-arm64.msi`,
  linuxX64: `Chimera-Switch-${tag}-Linux-x86_64.AppImage`,
  linuxArm64: `Chimera-Switch-${tag}-Linux-arm64.AppImage`,
};
const required = Object.values(artifacts);
const failures = [];
const signatures = new Map();
for (const name of required) {
  const artifactPath = path.join(assetsDir, name);
  const signaturePath = `${artifactPath}.sig`;
  if (!fs.existsSync(artifactPath) || fs.statSync(artifactPath).size === 0) failures.push(`${name}: missing or empty`);
  if (!fs.existsSync(signaturePath) || fs.statSync(signaturePath).size === 0) failures.push(`${name}.sig: missing or empty`);
  else signatures.set(name, fs.readFileSync(signaturePath, "utf8").trim());
}
if (failures.length) {
  console.error(`[generate-latest-json] required assets missing (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
const entry = (name) => ({
  signature: signatures.get(name),
  url: `${baseUrl}/${encodeURIComponent(name)}`,
});
const manifest = {
  version,
  notes: `Release ${tag}`,
  pub_date: pubDate.toISOString(),
  platforms: {
    "darwin-aarch64": entry(artifacts.mac),
    "darwin-x86_64": entry(artifacts.mac),
    "windows-x86_64": entry(artifacts.windowsX64),
    "windows-aarch64": entry(artifacts.windowsArm64),
    "linux-x86_64": entry(artifacts.linuxX64),
    "linux-aarch64": entry(artifacts.linuxArm64),
  },
};
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[generate-latest-json] wrote ${output} for ${tag}`);
