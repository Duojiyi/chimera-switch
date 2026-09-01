#!/usr/bin/env node
/**
 * Verify a release asset set, its Minisign updater signatures, and latest.json.
 *
 * Usage:
 *   node scripts/verify-release-assets.mjs <assets-dir> <tag> <owner/repo>
 *     [latest.json|-] [tauri-public-key-base64]
 *     [--unsigned] [--legacy] [--require-user-assets]
 *     [--expected-source-sha=<sha>] [--expected-tooling-sha=<sha>]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getReleaseAssetContract, releaseTagPattern } from "./release-asset-contract.mjs";

const args = process.argv.slice(2);
const [assetsDir, tag, repo, latestJsonArg, publicKeyBase64] = args;
const latestJsonPath = latestJsonArg === "-" ? undefined : latestJsonArg;
const unsignedMode = args.includes("--unsigned");
const legacyMode = args.includes("--legacy");
const requireUserAssets = args.includes("--require-user-assets");
const expectedSourceSha = args.find((arg) => arg.startsWith("--expected-source-sha="))?.split("=", 2)[1];
const expectedToolingSha = args.find((arg) => arg.startsWith("--expected-tooling-sha="))?.split("=", 2)[1];
const tagPattern = releaseTagPattern;
const shaPattern = /^[0-9a-f]{40}$/;
const githubRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;

if (!assetsDir || !tagPattern.test(tag ?? "") || !githubRepoPattern.test(repo ?? "")) {
  console.error("Usage: node scripts/verify-release-assets.mjs <assets-dir> <vX.Y.Z> <owner/repo> [latest.json|-] [tauri-public-key-base64] [--unsigned] [--legacy] [--require-user-assets] [--expected-source-sha=<sha>] [--expected-tooling-sha=<sha>]");
  process.exit(1);
}
if (expectedSourceSha && !shaPattern.test(expectedSourceSha)) {
  console.error(`Invalid expected source SHA: ${expectedSourceSha}`);
  process.exit(1);
}
if (expectedToolingSha && !shaPattern.test(expectedToolingSha)) {
  console.error(`Invalid expected tooling SHA: ${expectedToolingSha}`);
  process.exit(1);
}

const version = tag.slice(1);
const {
  updater,
  expectedPlatforms,
  requiredUpdater,
  expectedUserAssets,
  mandatoryUserAssets,
  signableAssets,
  expectedSignatures,
  provenanceName,
  provenanceSignatureName,
  latestAssetName,
} = getReleaseAssetContract(tag);
const failures = [];

const readRegularFile = (file, label) => {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) {
      failures.push(`${label}: empty or not a regular file`);
      return null;
    }
    return fs.readFileSync(file);
  } catch {
    failures.push(`${label}: missing`);
    return null;
  }
};

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const assetsRoot = path.resolve(assetsDir);
const assetsDirIsDirectory = fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory();
const assetsOnDisk = assetsDirIsDirectory ? fs.readdirSync(assetsDir).sort() : [];
if (!assetsDirIsDirectory) {
  failures.push(`${assetsDir}: asset directory is missing or not a directory`);
}
const latestAbsolutePath = latestJsonPath ? path.resolve(latestJsonPath) : undefined;
if (latestAbsolutePath && path.basename(latestAbsolutePath) !== latestAssetName) {
  failures.push(`${latestJsonPath}: output filename must be ${latestAssetName}`);
}
const latestPathIsInAssetsDir = latestAbsolutePath && path.dirname(latestAbsolutePath) === assetsRoot;

const allowed = new Set([...requiredUpdater, ...expectedUserAssets]);
if (requireUserAssets) {
  for (const name of mandatoryUserAssets) readRegularFile(path.join(assetsDir, name), name);
}
if (unsignedMode) {
  for (const name of assetsOnDisk) {
    if (!allowed.has(name)) failures.push(`unexpected release asset: ${name}`);
  }
} else {
  for (const name of expectedSignatures) allowed.add(name);
  allowed.add(provenanceName);
  allowed.add(provenanceSignatureName);
  if (latestJsonPath) allowed.add(latestAssetName);
  for (const name of assetsOnDisk) {
    if (!allowed.has(name)) failures.push(`unexpected release asset: ${name}`);
  }
}
if (!unsignedMode && assetsOnDisk.includes(latestAssetName) && !latestJsonPath) {
  failures.push(`${latestAssetName}: pass its path explicitly so it can be validated`);
}

const signatures = new Map();
for (const name of requiredUpdater) readRegularFile(path.join(assetsDir, name), name);
for (const name of signableAssets) {
  const assetExists = assetsOnDisk.includes(name);
  const signatureExists = assetsOnDisk.includes(`${name}.sig`);
  const requiredSignature = requiredUpdater.includes(name) || (requireUserAssets && mandatoryUserAssets.includes(name));
  if (unsignedMode) continue;
  if (requiredSignature || assetExists || signatureExists) {
    if (!assetExists) failures.push(`${name}: required signed asset is missing`);
    if (!signatureExists) {
      failures.push(`${name}.sig: required signature is missing`);
      continue;
    }
    const signature = readRegularFile(path.join(assetsDir, `${name}.sig`), `${name}.sig`);
    if (signature) {
      const text = signature.toString("utf8").trim();
      if (!text) failures.push(`${name}.sig: empty signature`);
      else signatures.set(name, text);
    }
  }
}

const decodeTauriEnvelope = (encoded, label, expectedPrefix) => {
  const compact = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    failures.push(`${label}: not canonical base64`);
    return null;
  }
  const decodedBytes = Buffer.from(compact, "base64");
  if (decodedBytes.toString("base64") !== compact) {
    failures.push(`${label}: not canonical base64`);
    return null;
  }
  const decoded = decodedBytes.toString("utf8");
  if (!decoded.startsWith(expectedPrefix) || decoded.includes("\0")) {
    failures.push(`${label}: decoded Minisign envelope has an unexpected format`);
    return null;
  }
  return decoded;
};

const parseBase64Line = (value, label) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    failures.push(`${label}: invalid base64 payload`);
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    failures.push(`${label}: non-canonical base64 payload`);
    return null;
  }
  return decoded;
};

const parseMinisignPublicKey = (encoded) => {
  const envelope = decodeTauriEnvelope(encoded, "updater public key", "untrusted comment: minisign public key:");
  if (!envelope) return null;
  const lines = envelope.replace(/\r/g, "").trimEnd().split("\n");
  if (lines.length < 2) {
    failures.push("updater public key: missing key payload");
    return null;
  }
  const packet = parseBase64Line(lines[1], "updater public key");
  if (!packet || packet.length !== 42 || packet.subarray(0, 2).toString("ascii") !== "Ed") {
    failures.push("updater public key: invalid Minisign Ed25519 packet");
    return null;
  }
  return { keyId: packet.subarray(2, 10), key: packet.subarray(10) };
};

const legacyTrustedNames = new Map([
  [updater.mac, [`Chimera Switch.app.tar.gz`]],
  [updater.windowsX64, [`Chimera Switch_${version}_x64_en-US.msi`]],
  [updater.windowsArm64, [`Chimera Switch_${version}_arm64_en-US.msi`]],
  [updater.linuxX64, [`Chimera Switch_${version}_amd64.AppImage`]],
  [updater.linuxArm64, [`Chimera Switch_${version}_aarch64.AppImage`]],
]);

const verifyMinisign = (assetPath, signatureText, publicKey) => {
  const name = path.basename(assetPath);
  const envelope = decodeTauriEnvelope(signatureText, `${name}.sig`, "untrusted comment: signature from tauri secret key");
  if (!envelope) return false;
  const lines = envelope.replace(/\r/g, "").trimEnd().split("\n");
  if (lines.length < 4 || !lines[2].startsWith("trusted comment:")) {
    failures.push(`${name}.sig: incomplete Minisign signature envelope`);
    return false;
  }
  const trustedComment = lines[2].slice("trusted comment:".length).trim();
  const fileComment = trustedComment.match(/(?:^|\t)file:([^\t]+)$/)?.[1];
  const acceptedNames = [name, ...(legacyMode ? legacyTrustedNames.get(name) ?? [] : [])];
  if (!acceptedNames.includes(fileComment)) {
    failures.push(`${name}.sig: trusted comment file does not match the asset name`);
    return false;
  }
  const packet = parseBase64Line(lines[1], `${name}.sig`);
  const globalSignature = parseBase64Line(lines[3], `${name}.sig global signature`);
  if (!packet || !globalSignature || packet.length !== 74 || globalSignature.length !== 64) return false;
  if (packet.subarray(0, 2).toString("ascii") !== "ED") {
    failures.push(`${name}.sig: unsupported Minisign algorithm`);
    return false;
  }
  if (!packet.subarray(2, 10).equals(publicKey.keyId)) {
    failures.push(`${name}.sig: key id does not match the configured updater public key`);
    return false;
  }

  let keyObject;
  try {
    keyObject = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.key]),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    failures.push(`updater public key: could not construct Ed25519 key (${error.message})`);
    return false;
  }
  const message = fs.readFileSync(assetPath);
  const fileDigest = crypto.createHash("blake2b512").update(message).digest();
  if (!crypto.verify(null, fileDigest, keyObject, packet.subarray(10))) {
    failures.push(`${name}: cryptographic signature verification failed`);
    return false;
  }
  const globalMessage = Buffer.concat([packet.subarray(10), Buffer.from(trustedComment)]);
  if (!crypto.verify(null, globalMessage, keyObject, globalSignature)) {
    failures.push(`${name}.sig: trusted-comment signature verification failed`);
    return false;
  }
  return true;
};

if (!unsignedMode) {
  if (!publicKeyBase64) {
    failures.push("updater public key is required in signed mode");
  } else {
    const publicKey = parseMinisignPublicKey(publicKeyBase64);
    if (publicKey) {
      for (const [name, signature] of signatures) {
        if (assetsOnDisk.includes(name)) verifyMinisign(path.join(assetsDir, name), signature, publicKey);
      }
      const provenanceFile = readRegularFile(path.join(assetsDir, provenanceName), provenanceName);
      const provenanceSignature = readRegularFile(path.join(assetsDir, provenanceSignatureName), provenanceSignatureName);
      if (provenanceFile && provenanceSignature) {
        verifyMinisign(path.join(assetsDir, provenanceName), provenanceSignature.toString("utf8").trim(), publicKey);
      }
    }
  }
}

const parseJsonFile = (file, label) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      failures.push(`${label}: JSON root must be a non-null object`);
      return null;
    }
    return value;
  } catch (error) {
    failures.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
};

if (!unsignedMode) {
  const provenance = parseJsonFile(path.join(assetsDir, provenanceName), provenanceName);
  if (provenance !== null) {
    if (provenance.schemaVersion !== 1) failures.push(`${provenanceName}: unsupported schemaVersion`);
    if (provenance.repository !== repo) failures.push(`${provenanceName}: repository is not ${repo}`);
    if (provenance.tag !== tag) failures.push(`${provenanceName}: tag is not ${tag}`);
    if (!shaPattern.test(provenance.sourceSha ?? "")) failures.push(`${provenanceName}: sourceSha is not an immutable commit SHA`);
    if (!shaPattern.test(provenance.toolingSha ?? "")) failures.push(`${provenanceName}: toolingSha is not an immutable commit SHA`);
    if (!Number.isSafeInteger(provenance.workflowRunId) || provenance.workflowRunId <= 0) failures.push(`${provenanceName}: workflowRunId is invalid`);
    if (provenance.workflowRunAttempt !== undefined && (!Number.isSafeInteger(provenance.workflowRunAttempt) || provenance.workflowRunAttempt <= 0)) failures.push(`${provenanceName}: workflowRunAttempt is invalid`);
    if (expectedSourceSha && provenance.sourceSha !== expectedSourceSha) failures.push(`${provenanceName}: sourceSha does not match the validated release tag`);
    if (expectedToolingSha && provenance.toolingSha !== expectedToolingSha) failures.push(`${provenanceName}: toolingSha does not match the reviewed tooling commit`);

    // latest.json is deterministically assembled from the immutable source commit
    // timestamp after signing. It is verified independently below, so it remains
    // intentionally outside the signer provenance checksum set.
    const actualChecksums = {};
    for (const name of assetsOnDisk) {
      if (name !== provenanceName && name !== provenanceSignatureName && name !== latestAssetName) {
        actualChecksums[name] = sha256(fs.readFileSync(path.join(assetsDir, name)));
      }
    }
    const expectedChecksums = provenance.assets;
    if (!expectedChecksums || typeof expectedChecksums !== "object" || Array.isArray(expectedChecksums)) {
      failures.push(`${provenanceName}: assets checksum map is missing`);
    } else {
      const actualNames = Object.keys(actualChecksums).sort();
      const expectedNames = Object.keys(expectedChecksums).sort();
      if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
        failures.push(`${provenanceName}: asset checksum map does not match the downloaded signed asset set`);
      }
      for (const name of expectedNames) {
        if (!shaPattern.test(expectedChecksums[name] ?? "") || expectedChecksums[name] !== actualChecksums[name]) {
          failures.push(`${provenanceName}: checksum mismatch for ${name}`);
        }
      }
    }
  }
}

if (latestJsonPath) {
  const downloadedLatestPath = path.join(assetsRoot, latestAssetName);
  if (!latestPathIsInAssetsDir && fs.existsSync(downloadedLatestPath)) {
    try {
      if (!fs.readFileSync(downloadedLatestPath).equals(fs.readFileSync(latestJsonPath))) {
        failures.push(`${latestJsonPath}: differs from downloaded ${latestAssetName}`);
      }
    } catch (error) {
      failures.push(`${latestJsonPath}: could not compare downloaded manifest (${error.message})`);
    }
  }
  const manifest = parseJsonFile(latestJsonPath, latestJsonPath);
  if (manifest !== null) {
    if (manifest.version !== version) failures.push(`${latestJsonPath}: version is not ${version}`);
    if (!manifest.platforms || typeof manifest.platforms !== "object" || Array.isArray(manifest.platforms)) {
      failures.push(`${latestJsonPath}: platforms object missing`);
    } else {
      const actualKeys = Object.keys(manifest.platforms).sort();
      const expectedKeys = Object.keys(expectedPlatforms).sort();
      if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        failures.push(`${latestJsonPath}: platforms must be exactly ${expectedKeys.join(", ")}`);
      }

      for (const [platform, fileName] of Object.entries(expectedPlatforms)) {
        const entry = manifest.platforms[platform];
        const expectedPath = `/${repo}/releases/download/${tag}/${encodeURIComponent(fileName)}`;
        if (!entry || typeof entry.url !== "string" || typeof entry.signature !== "string" || !entry.signature.trim()) {
          failures.push(`${latestJsonPath}: ${platform} is missing a non-empty url or signature`);
          continue;
        }
        try {
          const url = new URL(entry.url);
          if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) {
            failures.push(`${latestJsonPath}: ${platform} has an unexpected URL for ${fileName}`);
          }
        } catch (error) {
          failures.push(`${latestJsonPath}: ${platform} has an invalid URL (${error.message})`);
        }
        const expectedSignature = signatures.get(fileName);
        if (expectedSignature && entry.signature.trim() !== expectedSignature) {
          failures.push(`${latestJsonPath}: ${platform} signature does not match ${fileName}.sig`);
        }
      }
    }
  }
}

if (failures.length) {
  console.error(`[verify-release-assets] failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(unsignedMode
  ? `[verify-release-assets] OK: ${requiredUpdater.length} unsigned updater artifacts for ${tag}`
  : `[verify-release-assets] OK: ${requiredUpdater.length} updater artifacts, signatures, provenance, and platform mappings for ${tag}`);
