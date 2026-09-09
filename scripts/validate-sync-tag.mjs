#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SYNC_TAG_MARKER = "<!-- chimera-sync-provenance:v1 -->";

// Reserved exit code telling the caller that the tag was created before the
// provenance scheme existed and can only be validated against a record
// rebuilt from the GitHub API.
export const LEGACY_TAG_EXIT_CODE = 3;

// Thrown instead of a plain failure so the caller can tell "this tag predates
// provenance" apart from "this tag is malformed or forged".
export class LegacySyncTagError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegacySyncTagError";
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const REQUIRED_FIELDS = [
  "schemaVersion",
  "tag",
  "upstreamSha",
  "baseSha",
  "candidateSha",
  "candidateTree",
  "mergedSha",
  "mergedTree",
  "syncPrNumber",
  "syncRunId",
  "syncRunAttempt",
];
const BOT_TAGGER_PATTERN =
  /^github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com> [0-9]+ [+-][0-9]{4}$/;

function fail(message) {
  throw new Error(message);
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be an immutable 40-character commit SHA`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
}

function parseTagHeaders(raw) {
  const separator = raw.indexOf("\n\n");
  if (separator < 0) fail("annotated tag has no header/message separator");

  const headers = raw.slice(0, separator).split("\n");
  if (headers.length !== 4) {
    fail("annotated tag headers do not match the generated format");
  }

  const [objectLine, typeLine, tagLine, taggerLine] = headers;
  const objectSha = objectLine.startsWith("object ")
    ? objectLine.slice("object ".length)
    : "";
  const objectType = typeLine.startsWith("type ")
    ? typeLine.slice("type ".length)
    : "";
  const tag = tagLine.startsWith("tag ") ? tagLine.slice("tag ".length) : "";
  const tagger = taggerLine.startsWith("tagger ")
    ? taggerLine.slice("tagger ".length)
    : "";

  requireSha(objectSha, "annotated tag target");
  if (objectType !== "commit") fail("annotated tag target type must be commit");
  if (!TAG_PATTERN.test(tag))
    fail("annotated tag name is not a stable release tag");
  if (!BOT_TAGGER_PATTERN.test(tagger)) {
    fail("annotated tag was not created by the automation bot");
  }

  return {
    objectSha,
    tag,
    message: raw.slice(separator + 2),
  };
}

// Tags written before SYNC_TAG_MARKER existed carry exactly this message, so
// recognizing it cannot widen what counts as a valid provenance-carrying tag.
function classifyTagMessage(message, expectedTag) {
  const normalized = message.replaceAll("\r\n", "\n");
  if (normalized === `Release ${expectedTag}\n`) {
    return { kind: "legacy" };
  }

  const prefix = `Release ${expectedTag}\n\n${SYNC_TAG_MARKER}\n`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith("\n")) {
    fail("annotated tag message does not match the sync provenance format");
  }
  return { kind: "provenance", jsonText: normalized.slice(prefix.length, -1) };
}

function parseProvenanceJson(jsonText, expectedTag, expectedUpstreamSha) {
  if (!jsonText || jsonText.includes("\n")) {
    fail("sync provenance JSON must be one line");
  }

  let provenance;
  try {
    provenance = JSON.parse(jsonText);
  } catch (error) {
    fail(`sync provenance is not valid JSON: ${error.message}`);
  }
  return validateProvenanceRecord(provenance, expectedTag, expectedUpstreamSha);
}

export function validateProvenanceRecord(
  provenance,
  expectedTag,
  expectedUpstreamSha,
) {
  if (
    !provenance ||
    typeof provenance !== "object" ||
    Array.isArray(provenance)
  ) {
    fail("sync provenance must be a JSON object");
  }

  const actualFields = Object.keys(provenance).sort();
  const expectedFields = [...REQUIRED_FIELDS].sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) {
    fail("sync provenance fields do not match schemaVersion 1");
  }

  if (provenance.schemaVersion !== 1) {
    fail("sync provenance schemaVersion must be 1");
  }
  if (provenance.tag !== expectedTag) {
    fail("sync provenance tag does not match the requested release tag");
  }
  requireSha(expectedUpstreamSha, "expected upstream SHA");
  if (provenance.upstreamSha !== expectedUpstreamSha) {
    fail("sync provenance upstreamSha does not match the upstream release");
  }
  for (const field of [
    "upstreamSha",
    "baseSha",
    "candidateSha",
    "candidateTree",
    "mergedSha",
    "mergedTree",
  ]) {
    requireSha(provenance[field], `sync provenance ${field}`);
  }
  if (provenance.candidateTree !== provenance.mergedTree) {
    fail("sync provenance candidate and merged trees differ");
  }
  requirePositiveInteger(
    provenance.syncPrNumber,
    "sync provenance syncPrNumber",
  );
  requirePositiveInteger(provenance.syncRunId, "sync provenance syncRunId");
  requirePositiveInteger(
    provenance.syncRunAttempt,
    "sync provenance syncRunAttempt",
  );

  return provenance;
}

export function parseSyncTagObject({
  raw,
  expectedTag,
  expectedUpstreamSha,
  expectedTargetSha,
  legacyRecord,
}) {
  if (typeof raw !== "string") fail("annotated tag contents must be text");
  if (!TAG_PATTERN.test(expectedTag)) {
    fail("expected tag is not a stable release tag");
  }
  requireSha(expectedTargetSha, "expected annotated tag target");

  const headers = parseTagHeaders(raw);
  if (headers.tag !== expectedTag) {
    fail("annotated tag name does not match the requested release tag");
  }
  if (headers.objectSha !== expectedTargetSha) {
    fail("annotated tag target does not match the peeled tag commit");
  }

  const classified = classifyTagMessage(headers.message, expectedTag);
  let provenance;
  if (classified.kind === "legacy") {
    if (legacyRecord === undefined) {
      throw new LegacySyncTagError(
        "annotated tag predates sync provenance and needs a rebuilt record",
      );
    }
    provenance = validateProvenanceRecord(
      legacyRecord,
      expectedTag,
      expectedUpstreamSha,
    );
  } else {
    if (legacyRecord !== undefined) {
      fail(
        "annotated tag already carries provenance; refusing a rebuilt record",
      );
    }
    provenance = parseProvenanceJson(
      classified.jsonText,
      expectedTag,
      expectedUpstreamSha,
    );
  }
  if (provenance.mergedSha !== expectedTargetSha) {
    fail("sync provenance mergedSha does not match the tag target");
  }
  return provenance;
}

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function gitObjectExists(sha, cwd) {
  return (
    spawnSync("git", ["cat-file", "-e", sha], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    }).status === 0
  );
}
export function validateSyncTag({
  tagObjectSha,
  targetSha,
  expectedTag,
  expectedUpstreamSha,
  mainRef = "origin/main",
  cwd = process.cwd(),
  legacyRecord,
}) {
  requireSha(tagObjectSha, "annotated tag object SHA");
  requireSha(targetSha, "peeled tag commit SHA");
  if (typeof mainRef !== "string" || !mainRef || /[\r\n]/.test(mainRef)) {
    fail("protected main ref is invalid");
  }

  if (runGit(["cat-file", "-t", tagObjectSha], cwd).trim() !== "tag") {
    fail("sync release tag must be an annotated tag");
  }
  // A rebuilt record is only ever as trustworthy as the checks below, so the
  // git-structural rules stay identical for both provenance sources.
  const provenance = parseSyncTagObject({
    raw: runGit(["cat-file", "-p", tagObjectSha], cwd),
    expectedTag,
    expectedUpstreamSha,
    expectedTargetSha: targetSha,
    legacyRecord,
  });

  if (runGit(["cat-file", "-t", targetSha], cwd).trim() !== "commit") {
    fail("sync release tag target must be a commit");
  }
  const targetTree = runGit(["rev-parse", `${targetSha}^{tree}`], cwd).trim();
  if (targetTree !== provenance.mergedTree) {
    fail("sync provenance mergedTree does not match the tag target tree");
  }

  const parents = runGit(["rev-list", "--parents", "-n", "1", targetSha], cwd)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(1);
  if (parents.length !== 1 || parents[0] !== provenance.baseSha) {
    fail(
      "sync release tag target must be a squash commit based on provenance baseSha",
    );
  }

  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", targetSha, mainRef],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (ancestry.status !== 0) {
    fail("sync release tag target is not reachable from protected main");
  }

  if (gitObjectExists(`${provenance.candidateSha}^{commit}`, cwd)) {
    const candidateTree = runGit(
      ["rev-parse", `${provenance.candidateSha}^{tree}`],
      cwd,
    ).trim();
    if (candidateTree !== provenance.candidateTree) {
      fail("sync provenance candidateTree does not match candidateSha");
    }
  }

  return provenance;
}

const LEGACY_RECORD_FLAG = "--legacy-record=";

function main() {
  const positional = [];
  let legacyRecordPath;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith(LEGACY_RECORD_FLAG)) {
      legacyRecordPath = argument.slice(LEGACY_RECORD_FLAG.length);
      continue;
    }
    positional.push(argument);
  }

  const [
    expectedTag,
    expectedUpstreamSha,
    tagObjectSha,
    targetSha,
    mainRef = "origin/main",
  ] = positional;
  if (!expectedTag || !expectedUpstreamSha || !tagObjectSha || !targetSha) {
    fail(
      "usage: validate-sync-tag.mjs [--legacy-record=<path>] <tag> <upstream-sha> <tag-object-sha> <target-sha> [main-ref]",
    );
  }

  let legacyRecord;
  if (legacyRecordPath !== undefined) {
    if (!legacyRecordPath) fail("rebuilt sync record path is empty");
    try {
      legacyRecord = JSON.parse(readFileSync(legacyRecordPath, "utf8"));
    } catch (error) {
      fail(`rebuilt sync record is unreadable: ${error.message}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      validateSyncTag({
        tagObjectSha,
        targetSha,
        expectedTag,
        expectedUpstreamSha,
        mainRef,
        legacyRecord,
      }),
    )}\n`,
  );
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    const message = String(error?.message ?? error).replace(/[\r\n]+/g, " ");
    if (error instanceof LegacySyncTagError) {
      console.error(`::notice::${message}`);
      process.exitCode = LEGACY_TAG_EXIT_CODE;
    } else {
      console.error(`::error::${message}`);
      process.exitCode = 1;
    }
  }
}
