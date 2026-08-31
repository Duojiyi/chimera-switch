#!/usr/bin/env node
// Rewrite the Tauri updater manifest so download URLs point at the R2 mirror.
// Minisign signatures cover file contents, not URLs, so the signatures remain
// valid and are preserved unchanged.
//
// Usage: node scripts/rewrite-updater-manifest.mjs <latest-json> <tag> <owner/repo> <base-url> [output]

import { readFileSync, writeFileSync } from "node:fs";

const [input, tag, repo, baseUrl, output = "latest-r2.json"] = process.argv.slice(2);
const tagPattern = /^v\d+\.\d+\.\d+$/;
const githubRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const expectedPlatforms = {
  "darwin-aarch64": `Chimera-Switch-${tag}-macOS.tar.gz`,
  "darwin-x86_64": `Chimera-Switch-${tag}-macOS.tar.gz`,
  "windows-x86_64": `Chimera-Switch-${tag}-Windows.msi`,
  "windows-aarch64": `Chimera-Switch-${tag}-Windows-arm64.msi`,
  "linux-x86_64": `Chimera-Switch-${tag}-Linux-x86_64.AppImage`,
  "linux-aarch64": `Chimera-Switch-${tag}-Linux-arm64.AppImage`,
};

const fail = (message) => {
  console.error(`[rewrite-updater-manifest] ${message}`);
  process.exit(1);
};

if (!input || !tagPattern.test(tag ?? "") || !githubRepoPattern.test(repo ?? "") || !baseUrl) {
  fail("Usage: node scripts/rewrite-updater-manifest.mjs <latest-json> <vX.Y.Z> <owner/repo> <https-base-url> [output]");
}

let normalizedBase;
try {
  const parsedBase = new URL(baseUrl);
  if (
    parsedBase.protocol !== "https:" ||
    parsedBase.hostname !== "dl.chimerahub.org" ||
    parsedBase.port ||
    parsedBase.username ||
    parsedBase.password ||
    parsedBase.search ||
    parsedBase.hash
  ) {
    fail("base-url must be https://dl.chimerahub.org with no credentials, non-default port, query, or fragment");
  }
  normalizedBase = `${parsedBase.origin}${parsedBase.pathname.replace(/\/+$/, "")}`;
} catch (error) {
  fail(`invalid base-url: ${error.message}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(input, "utf8"));
} catch (error) {
  fail(`invalid JSON in ${input}: ${error.message}`);
}

if (manifest?.version !== tag.slice(1)) {
  fail(`manifest version must be ${tag.slice(1)}`);
}
if (!manifest.platforms || typeof manifest.platforms !== "object" || Array.isArray(manifest.platforms)) {
  fail("manifest platforms object is missing");
}

const actualKeys = Object.keys(manifest.platforms).sort();
const expectedKeys = Object.keys(expectedPlatforms).sort();
if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
  fail(`manifest platforms must be exactly: ${expectedKeys.join(", ")}`);
}

for (const [platform, expectedName] of Object.entries(expectedPlatforms)) {
  const entry = manifest.platforms[platform];
  if (!entry || typeof entry.url !== "string" || typeof entry.signature !== "string" || !entry.signature.trim()) {
    fail(`platform ${platform} is missing a non-empty url or signature`);
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(entry.url);
  } catch (error) {
    fail(`platform ${platform} has an invalid URL: ${error.message}`);
  }
  const expectedPath = `/${repo}/releases/download/${tag}/${encodeURIComponent(expectedName)}`;
  if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "github.com" ||
      sourceUrl.port || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash || sourceUrl.pathname !== expectedPath) {
    fail(`platform ${platform} must point to the GitHub asset ${expectedName} for ${tag}`);
  }

  entry.url = `${normalizedBase}/${tag}/${encodeURIComponent(expectedName)}`;
}

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[rewrite-updater-manifest] wrote ${output} with ${expectedKeys.length} verified platforms`);
