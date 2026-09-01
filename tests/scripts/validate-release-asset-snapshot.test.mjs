import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getReleaseAssetContract } from "../../scripts/release-asset-contract.mjs";

const tag = "v3.20.1";
const { publicAssetNames } = getReleaseAssetContract(tag);
const validatorPath = path.resolve(
  "scripts/validate-release-asset-snapshot.mjs",
);
const maxAssetBytes = 256 * 1024 * 1024;
const maxReleaseBytes = 1024 * 1024 * 1024;

function createSnapshot(sizes) {
  expect(sizes).toHaveLength(publicAssetNames.length);
  return publicAssetNames.map((name, index) => ({
    digest: `sha256:${"0".repeat(64)}`,
    id: index + 1,
    name,
    size: sizes[index],
    state: "uploaded",
  }));
}

function runValidator(sizes) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "release-asset-validator-"),
  );
  const snapshotPath = path.join(tempDir, "snapshot.json");
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(createSnapshot(sizes)));
    return spawnSync(process.execPath, [validatorPath, snapshotPath, tag], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function minimalSizes() {
  return Array(publicAssetNames.length).fill(1);
}

function exactReleaseLimitSizes() {
  const sizes = minimalSizes();
  sizes[0] = maxAssetBytes;
  sizes[1] = maxAssetBytes;
  sizes[2] = maxAssetBytes;
  sizes[3] = maxAssetBytes - (publicAssetNames.length - 4);
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(maxReleaseBytes);
  return sizes;
}

describe("release asset snapshot size limits", () => {
  it("accepts an asset exactly at the 256 MiB per-file limit", () => {
    const sizes = minimalSizes();
    sizes[0] = maxAssetBytes;

    const result = runValidator(sizes);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[validate-release-asset-snapshot] OK");
  });

  it("rejects an asset one byte over the 256 MiB per-file limit", () => {
    const sizes = minimalSizes();
    sizes[0] = maxAssetBytes + 1;

    const result = runValidator(sizes);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("size exceeds the 256 MiB per-file limit");
  });

  it("accepts a release exactly at the 1 GiB total limit", () => {
    const result = runValidator(exactReleaseLimitSizes());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[validate-release-asset-snapshot] OK");
  });

  it("rejects a release one byte over the 1 GiB total limit", () => {
    const sizes = exactReleaseLimitSizes();
    sizes[3] += 1;

    const result = runValidator(sizes);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "total asset size exceeds the 1 GiB release limit",
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["larger than Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s asset size", (_label, invalidSize) => {
    const sizes = minimalSizes();
    sizes[0] = invalidSize;

    const result = runValidator(sizes);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("size must be a positive safe integer");
  });
});
