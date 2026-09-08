#!/usr/bin/env node
// Runs the fork's release workflow contract suites.
//
// The suite filenames deliberately avoid the `*.test.*` convention: the root
// vitest run is driven by the upstream-owned vitest.config.ts, which would
// otherwise collect these node:test suites and fail. Excluding them there
// would put the fix in a file that upstream merges overwrite, so discovery is
// explicit here instead — and a missing suite fails loudly rather than
// silently reporting zero tests.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.join(here, "suites");
const suites = fs
  .readdirSync(suiteDir)
  .filter((entry) => entry.endsWith(".mjs"))
  .sort();

const EXPECTED_SUITES = 2;
if (suites.length < EXPECTED_SUITES) {
  console.error(
    `::error::expected at least ${EXPECTED_SUITES} contract suites in ${suiteDir}, found ${suites.length}`,
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", ...suites.map((suite) => path.join(suiteDir, suite))],
  { cwd: here, stdio: "inherit" },
);
process.exit(result.status ?? 1);
