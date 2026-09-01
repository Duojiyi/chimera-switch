#!/usr/bin/env node
/**
 * Validate the exact GitHub Release asset metadata contract and, optionally,
 * compare every downloaded file with the API-reported size and SHA-256 digest.
 *
 * Usage:
 *   node scripts/validate-release-asset-snapshot.mjs <snapshot.json> <vX.Y.Z> [assets-dir]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getReleaseAssetContract, releaseTagPattern } from "./release-asset-contract.mjs";

const [snapshotPath, tag, assetsDir] = process.argv.slice(2);
if (!snapshotPath || !releaseTagPattern.test(tag ?? "")) {
  console.error("Usage: node scripts/validate-release-asset-snapshot.mjs <snapshot.json> <vX.Y.Z> [assets-dir]");
  process.exit(1);
}

const failures = [];
let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
} catch (error) {
  failures.push(`${snapshotPath}: invalid JSON (${error.message})`);
}
if (!Array.isArray(snapshot)) {
  failures.push(`${snapshotPath}: root must be an array`);
  snapshot = [];
}

const { publicAssetNames } = getReleaseAssetContract(tag);
const expectedKeys = ["digest", "id", "name", "size", "state"];
const names = [];
const ids = new Set();
for (const [index, asset] of snapshot.entries()) {
  const label = `${snapshotPath}[${index}]`;
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    failures.push(`${label}: asset must be an object`);
    continue;
  }
  const keys = Object.keys(asset).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
    failures.push(`${label}: fields must be exactly ${expectedKeys.join(", ")}`);
  }
  if (typeof asset.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(asset.name)) {
    failures.push(`${label}: unsafe or invalid asset name`);
  } else {
    names.push(asset.name);
  }
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
    failures.push(`${label}: id must be a positive safe integer`);
  } else if (ids.has(asset.id)) {
    failures.push(`${label}: duplicate asset id ${asset.id}`);
  } else {
    ids.add(asset.id);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    failures.push(`${label}: size must be a positive safe integer`);
  }
  if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) {
    failures.push(`${label}: digest must be sha256:<64 lowercase hex>`);
  }
  if (asset.state !== "uploaded") {
    failures.push(`${label}: state must be uploaded`);
  }
}

if (names.length !== new Set(names).size) failures.push(`${snapshotPath}: asset names are not unique`);
if (names.length !== publicAssetNames.length || names.some((name, index) => name !== publicAssetNames[index])) {
  failures.push(`${snapshotPath}: assets must be exactly the ${publicAssetNames.length} contract names in lexical order`);
  const missing = publicAssetNames.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !publicAssetNames.includes(name));
  if (missing.length) failures.push(`${snapshotPath}: missing ${missing.join(", ")}`);
  if (extra.length) failures.push(`${snapshotPath}: unexpected ${extra.join(", ")}`);
}

if (assetsDir) {
  let diskNames = [];
  try {
    const stat = fs.statSync(assetsDir);
    if (!stat.isDirectory()) throw new Error("not a directory");
    diskNames = fs.readdirSync(assetsDir).sort();
  } catch (error) {
    failures.push(`${assetsDir}: could not read asset directory (${error.message})`);
  }
  if (diskNames.length !== publicAssetNames.length || diskNames.some((name, index) => name !== publicAssetNames[index])) {
    failures.push(`${assetsDir}: downloaded files do not exactly match the release asset contract`);
  }
  for (const asset of snapshot) {
    if (!asset || typeof asset.name !== "string" || !publicAssetNames.includes(asset.name)) continue;
    const file = path.join(assetsDir, asset.name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error("not a regular file");
      if (stat.size !== asset.size) failures.push(`${asset.name}: downloaded size ${stat.size} differs from API size ${asset.size}`);
      const digest = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
      if (digest !== asset.digest) failures.push(`${asset.name}: downloaded SHA-256 differs from API digest`);
    } catch (error) {
      failures.push(`${asset.name}: could not verify downloaded file (${error.message})`);
    }
  }
}

if (failures.length) {
  console.error(`[validate-release-asset-snapshot] failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`[validate-release-asset-snapshot] OK: ${publicAssetNames.length} immutable release assets for ${tag}${assetsDir ? " match downloaded bytes" : ""}`);
