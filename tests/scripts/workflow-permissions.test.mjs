import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readWorkflow = (name) =>
  fs.readFileSync(path.resolve(".github/workflows", name), "utf8");

function getTopLevelBlock(document, key) {
  const marker = `  ${key}:`;
  const start = document.indexOf(marker);
  if (start === -1) throw new Error(`Missing top-level block: ${key}`);

  const remainder = document.slice(start + marker.length);
  const next = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next === -1
    ? document.slice(start)
    : document.slice(start, start + marker.length + next);
}

function expectReadPermission(block, permission) {
  expect(block).toMatch(
    new RegExp(
      `^    permissions:\\r?\\n(?:^      [^\\r\\n]+\\r?\\n)*^      ${permission}: read\\s*$`,
      "m",
    ),
  );
}

describe("reusable release workflow permissions", () => {
  it("grants the R2 caller every read permission requested by the callee", () => {
    const caller = getTopLevelBlock(
      readWorkflow("promote-release.yml"),
      "sync-r2",
    );
    const callee = readWorkflow("sync-r2.yml");

    expect(caller).toContain("uses: ./.github/workflows/sync-r2.yml");
    expectReadPermission(caller, "contents");
    expectReadPermission(caller, "actions");
    expect(callee).toMatch(
      /^permissions:\r?\n  contents: read\r?\n  actions: read\s*$/m,
    );
  });
});
