import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReleaseAssetContract,
  gitCommitShaPattern,
  sha256DigestPattern,
} from "../../scripts/release-asset-contract.mjs";

const tag = "v1.2.3";
const repository = "owner/repository";
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const temporaryDirectories = [];

const encodeEnvelope = (text) => Buffer.from(text, "utf8").toString("base64");
const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createSigningFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "release-provenance-"),
  );
  temporaryDirectories.push(directory);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const keyId = crypto.randomBytes(8);
  const publicPacket = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]);
  const encodedPublicKey = encodeEnvelope(
    `untrusted comment: minisign public key: test\n${publicPacket.toString("base64")}\n`,
  );

  const signFile = (name) => {
    const file = path.join(directory, name);
    const fileDigest = crypto
      .createHash("blake2b512")
      .update(fs.readFileSync(file))
      .digest();
    const signature = crypto.sign(null, fileDigest, privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), keyId, signature]);
    const trustedComment = `timestamp:0\tfile:${name}`;
    const globalSignature = crypto.sign(
      null,
      Buffer.concat([packet.subarray(10), Buffer.from(trustedComment)]),
      privateKey,
    );
    const envelope = [
      "untrusted comment: signature from tauri secret key",
      packet.toString("base64"),
      `trusted comment: ${trustedComment}`,
      globalSignature.toString("base64"),
      "",
    ].join("\n");
    fs.writeFileSync(`${file}.sig`, encodeEnvelope(envelope));
  };

  const contract = getReleaseAssetContract(tag);
  for (const name of contract.signableAssets) {
    fs.writeFileSync(path.join(directory, name), `fixture:${name}\n`);
    signFile(name);
  }

  const writeProvenance = (mutate = (assets) => assets) => {
    const assets = Object.fromEntries(
      contract.provenanceAssetNames.map((name) => [
        name,
        sha256File(path.join(directory, name)),
      ]),
    );
    const provenance = {
      schemaVersion: 1,
      repository,
      tag,
      sourceSha,
      toolingSha,
      workflowRunId: 1,
      workflowRunAttempt: 1,
      assets: mutate(assets),
    };
    fs.writeFileSync(
      path.join(directory, contract.provenanceName),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    signFile(contract.provenanceName);
  };

  return { contract, directory, encodedPublicKey, writeProvenance };
}

function verifyFixture(directory, encodedPublicKey) {
  return execFileSync(
    process.execPath,
    [
      path.resolve("scripts/verify-release-assets.mjs"),
      directory,
      tag,
      repository,
      "-",
      encodedPublicKey,
      "--require-user-assets",
      `--expected-source-sha=${sourceSha}`,
      `--expected-tooling-sha=${toolingSha}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe("release provenance contract", () => {
  it("keeps commit identifiers and SHA-256 digests as distinct formats", () => {
    expect(gitCommitShaPattern.test("a".repeat(40))).toBe(true);
    expect(gitCommitShaPattern.test("a".repeat(64))).toBe(false);
    expect(sha256DigestPattern.test("a".repeat(64))).toBe(true);
    expect(sha256DigestPattern.test("a".repeat(40))).toBe(false);
  });

  it("accepts the exact signed asset set with valid 64-character SHA-256 digests", () => {
    const { contract, directory, encodedPublicKey, writeProvenance } =
      createSigningFixture();
    expect(contract.signableAssets).toHaveLength(13);
    expect(contract.provenanceAssetNames).toHaveLength(26);
    writeProvenance();

    expect(verifyFixture(directory, encodedPublicKey)).toContain(
      "5 updater artifacts, signatures, provenance, and platform mappings",
    );
  });

  it("rejects a well-formed but incorrect provenance digest", () => {
    const { contract, directory, encodedPublicKey, writeProvenance } =
      createSigningFixture();
    writeProvenance((assets) => ({
      ...assets,
      [contract.provenanceAssetNames[0]]: "0".repeat(64),
    }));

    expect(() => verifyFixture(directory, encodedPublicKey)).toThrow(
      /checksum mismatch/,
    );
  });
});
