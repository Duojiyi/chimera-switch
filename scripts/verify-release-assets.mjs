#!/usr/bin/env node
/**
 * Verify the signed updater assets and latest.json for a release.
 *
 * Usage: node scripts/verify-release-assets.mjs <assets-dir> <tag> <owner/repo> [latest.json|-] [tauri-public-key-base64] [--unsigned]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [assetsDir, tag, repo, latestJsonArg, publicKeyBase64, verificationMode] = process.argv.slice(2);
const latestJsonPath = latestJsonArg === "-" ? undefined : latestJsonArg;
const unsignedMode = verificationMode === "--unsigned";
const tagPattern = /^v\d+\.\d+\.\d+$/;
const githubRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
if (!assetsDir || !tagPattern.test(tag ?? "") || !githubRepoPattern.test(repo ?? "")) {
  console.error("Usage: node scripts/verify-release-assets.mjs <assets-dir> <vX.Y.Z> <owner/repo> [latest.json|-] [tauri-public-key-base64] [--unsigned]");
  process.exit(1);
}

const version = tag.slice(1);
const required = {
  mac: `Chimera-Switch-${tag}-macOS.tar.gz`,
  windowsX64: `Chimera-Switch-${tag}-Windows.msi`,
  windowsArm64: `Chimera-Switch-${tag}-Windows-arm64.msi`,
  linuxX64: `Chimera-Switch-${tag}-Linux-x86_64.AppImage`,
  linuxArm64: `Chimera-Switch-${tag}-Linux-arm64.AppImage`,
};
const expectedPlatforms = {
  "darwin-aarch64": required.mac,
  "darwin-x86_64": required.mac,
  "windows-x86_64": required.windowsX64,
  "windows-aarch64": required.windowsArm64,
  "linux-x86_64": required.linuxX64,
  "linux-aarch64": required.linuxArm64,
};
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

const signatures = new Map();
for (const name of Object.values(required)) {
  readRegularFile(path.join(assetsDir, name), name);
  if (!unsignedMode) {
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
  const decoded = Buffer.from(compact, "base64").toString("utf8");
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
  return Buffer.from(value, "base64");
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
  return {
    keyId: packet.subarray(2, 10),
    key: packet.subarray(10),
  };
};

const verifyMinisign = (assetPath, signatureText, publicKey) => {
  const envelope = decodeTauriEnvelope(
    signatureText,
    `${path.basename(assetPath)}.sig`,
    "untrusted comment: signature from tauri secret key",
  );
  if (!envelope) return false;
  const lines = envelope.replace(/\r/g, "").trimEnd().split("\n");
  if (lines.length < 4 || !lines[2].startsWith("trusted comment:")) {
    failures.push(`${path.basename(assetPath)}.sig: incomplete Minisign signature envelope`);
    return false;
  }
  const trustedComment = lines[2].slice("trusted comment:".length).trim();
  const fileComment = trustedComment.match(/(?:^|\t)file:([^\t]+)$/)?.[1];
  if (fileComment !== path.basename(assetPath)) {
    failures.push(`${path.basename(assetPath)}.sig: trusted comment file does not match the asset name`);
    return false;
  }
  const packet = parseBase64Line(lines[1], `${path.basename(assetPath)}.sig`);
  const globalSignature = parseBase64Line(lines[3], `${path.basename(assetPath)}.sig global signature`);
  if (!packet || !globalSignature || packet.length !== 74 || globalSignature.length !== 64) return false;
  if (packet.subarray(0, 2).toString("ascii") !== "ED") {
    failures.push(`${path.basename(assetPath)}.sig: unsupported Minisign algorithm`);
    return false;
  }
  if (!packet.subarray(2, 10).equals(publicKey.keyId)) {
    failures.push(`${path.basename(assetPath)}.sig: key id does not match the configured updater public key`);
    return false;
  }
  let keyObject;
  try {
    // RFC 8410 SubjectPublicKeyInfo wrapper for a raw Ed25519 public key.
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
  // Tauri's `ED` Minisign signatures use the standard pre-hashed mode:
  // Ed25519 verifies the 64-byte BLAKE2b-512 digest, not the file bytes.
  const fileDigest = crypto.createHash("blake2b512").update(message).digest();
  if (!crypto.verify(null, fileDigest, keyObject, packet.subarray(10))) {
    failures.push(`${path.basename(assetPath)}: cryptographic signature verification failed`);
    return false;
  }
  // The trusted comment is authenticated by the global signature. Minisign
  // signs the raw file signature followed by the comment content (without the
  // `trusted comment: ` prefix or the envelope newline).
  const globalMessage = Buffer.concat([packet.subarray(10), Buffer.from(trustedComment)]);
  if (!crypto.verify(null, globalMessage, keyObject, globalSignature)) {
    failures.push(`${path.basename(assetPath)}.sig: trusted-comment signature verification failed`);
    return false;
  }
  return true;
};

if (publicKeyBase64 && !unsignedMode) {
  const publicKey = parseMinisignPublicKey(publicKeyBase64);
  if (publicKey) {
    for (const name of Object.values(required)) {
      const signature = signatures.get(name);
      if (signature) verifyMinisign(path.join(assetsDir, name), signature, publicKey);
    }
  }
}

if (latestJsonPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(latestJsonPath, "utf8"));
  } catch (error) {
    failures.push(`${latestJsonPath}: invalid JSON (${error.message})`);
  }

  if (manifest) {
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
console.log(
  unsignedMode
    ? `[verify-release-assets] OK: ${Object.values(required).length} unsigned updater artifacts for ${tag}`
    : `[verify-release-assets] OK: ${Object.values(required).length} updater artifacts, signatures, and six platform mappings for ${tag}`,
);
