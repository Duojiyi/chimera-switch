import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SYNC_TAG_MARKER,
  parseSyncTagObject,
  validateSyncTag,
} from "../../validate-sync-tag.mjs";

const TAG = "v3.20.2";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function git(cwd, args, input) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: BOT_NAME,
      GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_NAME: BOT_NAME,
      GIT_COMMITTER_EMAIL: BOT_EMAIL,
    },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function makeRepository() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "chimera-sync-tag-contract-"),
  );
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.name", BOT_NAME]);
  git(directory, ["config", "user.email", BOT_EMAIL]);

  fs.writeFileSync(path.join(directory, "state.txt"), "base\n");
  git(directory, ["add", "state.txt"]);
  git(directory, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(directory, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(directory, "state.txt"), "reviewed\n");
  git(directory, ["add", "state.txt"]);
  git(directory, ["commit", "--quiet", "-m", "reviewed squash candidate"]);
  const reviewedSha = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["branch", "-M", "main"]);

  git(directory, ["checkout", "--quiet", "-b", "unreviewed", baseSha]);
  fs.writeFileSync(path.join(directory, "state.txt"), "unreviewed\n");
  git(directory, ["add", "state.txt"]);
  git(directory, ["commit", "--quiet", "-m", "unreviewed candidate"]);
  const unreviewedSha = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["checkout", "--quiet", "main"]);

  const upstreamBlob = git(
    directory,
    ["hash-object", "-w", "--stdin"],
    "upstream\n",
  );
  const upstreamTree = git(
    directory,
    ["mktree"],
    `100644 blob ${upstreamBlob}\tupstream.txt\n`,
  );
  const upstreamSha = git(directory, [
    "commit-tree",
    upstreamTree,
    "-m",
    "upstream",
  ]);

  return {
    directory,
    baseSha,
    reviewedSha,
    unreviewedSha,
    upstreamSha,
  };
}

function tagProvenance({
  tag,
  upstreamSha,
  baseSha,
  candidateSha,
  mergedSha,
  mergedTree,
  syncPrNumber = 26,
  syncRunId = 12345,
  syncRunAttempt = 1,
}) {
  return {
    schemaVersion: 1,
    tag,
    upstreamSha,
    baseSha,
    candidateSha,
    candidateTree: mergedTree,
    mergedSha,
    mergedTree,
    syncPrNumber,
    syncRunId,
    syncRunAttempt,
  };
}

function createTag({
  directory,
  refName,
  tag,
  upstreamSha,
  baseSha,
  candidateSha,
  targetSha,
}) {
  const targetTree = git(directory, ["rev-parse", `${targetSha}^{tree}`]);
  const provenance = tagProvenance({
    tag,
    upstreamSha,
    baseSha,
    candidateSha,
    mergedSha: targetSha,
    mergedTree: targetTree,
  });
  const message = `Release ${tag}\n\n${SYNC_TAG_MARKER}\n${JSON.stringify(provenance)}`;
  git(directory, ["tag", "-a", refName, targetSha, "-m", message]);
  return {
    objectSha: git(directory, ["rev-parse", `refs/tags/${refName}`]),
    provenance,
  };
}

function withRepository(run) {
  const repository = makeRepository();
  try {
    return run(repository);
  } finally {
    fs.rmSync(repository.directory, { recursive: true, force: true });
  }
}

describe("sync release tag provenance", () => {
  it("uses provenance instead of impossible upstream ancestry after squash", () => {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, ".github/workflows/sync-upstream.yml"),
      "utf8",
    );
    assert.match(workflow, /node scripts\/validate-sync-tag\.mjs/);
    assert.match(workflow, /chimera-sync-provenance:v1/);
    assert.match(workflow, /syncPrNumber/);
    assert.match(workflow, /Push candidate and create protected sync PR/);
    assert.doesNotMatch(
      workflow,
      /merge-base --is-ancestor "\$UPSTREAM_SHA" "\$origin_tag_sha"/,
    );
  });

  it("accepts a squash tag with valid provenance without upstream ancestry", () => {
    withRepository((repository) => {
      const tag = createTag({
        directory: repository.directory,
        refName: TAG,
        tag: TAG,
        upstreamSha: repository.upstreamSha,
        baseSha: repository.baseSha,
        candidateSha: repository.reviewedSha,
        targetSha: repository.reviewedSha,
      });
      const upstreamAncestry = spawnSync(
        "git",
        [
          "merge-base",
          "--is-ancestor",
          repository.upstreamSha,
          repository.reviewedSha,
        ],
        { cwd: repository.directory, stdio: "ignore" },
      );
      assert.notEqual(upstreamAncestry.status, 0);

      const result = validateSyncTag({
        tagObjectSha: tag.objectSha,
        targetSha: repository.reviewedSha,
        expectedTag: TAG,
        expectedUpstreamSha: repository.upstreamSha,
        mainRef: "refs/heads/main",
        cwd: repository.directory,
      });
      assert.deepEqual(result, tag.provenance);
    });
  });

  it("rejects provenance for a different upstream release commit", () => {
    withRepository((repository) => {
      const tag = createTag({
        directory: repository.directory,
        refName: TAG,
        tag: TAG,
        upstreamSha: repository.upstreamSha,
        baseSha: repository.baseSha,
        candidateSha: repository.reviewedSha,
        targetSha: repository.reviewedSha,
      });
      assert.throws(
        () =>
          validateSyncTag({
            tagObjectSha: tag.objectSha,
            targetSha: repository.reviewedSha,
            expectedTag: TAG,
            expectedUpstreamSha: "f".repeat(40),
            mainRef: "refs/heads/main",
            cwd: repository.directory,
          }),
        /upstreamSha does not match/,
      );
    });
  });

  it("rejects a validly shaped tag whose target is not on protected main", () => {
    withRepository((repository) => {
      const tag = createTag({
        directory: repository.directory,
        refName: "v3.20.3",
        tag: "v3.20.3",
        upstreamSha: repository.upstreamSha,
        baseSha: repository.baseSha,
        candidateSha: repository.unreviewedSha,
        targetSha: repository.unreviewedSha,
      });
      assert.throws(
        () =>
          validateSyncTag({
            tagObjectSha: tag.objectSha,
            targetSha: repository.unreviewedSha,
            expectedTag: "v3.20.3",
            expectedUpstreamSha: repository.upstreamSha,
            mainRef: "refs/heads/main",
            cwd: repository.directory,
          }),
        /not reachable from protected main/,
      );
    });
  });

  it("rejects lightweight and malformed automation tags", () => {
    withRepository((repository) => {
      git(repository.directory, [
        "tag",
        "lightweight-tag",
        repository.reviewedSha,
      ]);
      const lightweightSha = git(repository.directory, [
        "rev-parse",
        "refs/tags/lightweight-tag",
      ]);
      assert.throws(
        () =>
          validateSyncTag({
            tagObjectSha: lightweightSha,
            targetSha: repository.reviewedSha,
            expectedTag: TAG,
            expectedUpstreamSha: repository.upstreamSha,
            mainRef: "refs/heads/main",
            cwd: repository.directory,
          }),
        /must be an annotated tag/,
      );

      const targetTree = git(repository.directory, [
        "rev-parse",
        `${repository.reviewedSha}^{tree}`,
      ]);
      const malformed = [
        `object ${repository.reviewedSha}`,
        "type commit",
        `tag ${TAG}`,
        `tagger ${BOT_NAME} <${BOT_EMAIL}> 1700000000 +0000`,
        "",
        `Release ${TAG}`,
        "",
        "not-the-provenance-marker",
        JSON.stringify(
          tagProvenance({
            tag: TAG,
            upstreamSha: repository.upstreamSha,
            baseSha: repository.baseSha,
            candidateSha: repository.reviewedSha,
            mergedSha: repository.reviewedSha,
            mergedTree: targetTree,
          }),
        ),
        "",
      ].join("\n");
      assert.throws(
        () =>
          parseSyncTagObject({
            raw: malformed,
            expectedTag: TAG,
            expectedUpstreamSha: repository.upstreamSha,
            expectedTargetSha: repository.reviewedSha,
          }),
        /message does not match/,
      );
    });
  });
});
