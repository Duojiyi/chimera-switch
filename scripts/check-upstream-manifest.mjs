#!/usr/bin/env node
/**
 * check-upstream-manifest.mjs — 根 manifest 归上游所有的硬约束
 *
 * sync-upstream 的冲突策略对 package.json / pnpm-lock.yaml 取 theirs（见
 * sync-upstream.yml 的冲突分类），因为它们属于上游控制的信任边界。而上游每次
 * 发版都会改 package.json 的 version 行，与 debrand 改写的 name/description
 * 位于同一个 hunk，因此这两处几乎必然冲突并被上游版本覆盖。
 *
 * 后果：fork 若往根 package.json 加自己的依赖，同步时该依赖会被静默删除，而
 * pnpm-lock.yaml 若本轮无冲突则保留 fork 版本，于是 `pnpm install
 * --frozen-lockfile` 以 ERR_PNPM_OUTDATED_LOCKFILE 失败 —— 每一次上游发版都会
 * 复发。2026-09 的 yaml@^2.9.0 就是这样连续挡住 v3.20.2 的自动发布。
 *
 * 因此本脚本断言：合并后的根依赖集合必须与上游 tag 完全一致。fork 专用工具依赖
 * 放到 fork 自有路径下的独立包（例如 scripts/workflow-contracts/），那里冲突
 * 时恒为 ours，且不受根 workspace 解析影响。
 *
 * 用法：node scripts/check-upstream-manifest.mjs <upstream-git-ref>
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
// debrand.mjs 有意重写的 fork 身份字段，不参与比对。
const FORK_OWNED_FIELDS = new Set(["name", "description", "version"]);

const upstreamRef = process.argv[2];
if (!upstreamRef) {
  console.error(
    "usage: node scripts/check-upstream-manifest.mjs <upstream-git-ref>",
  );
  process.exit(2);
}

const show = spawnSync("git", ["show", `${upstreamRef}:package.json`], {
  cwd: ROOT,
  encoding: "utf8",
});
if (show.status !== 0) {
  console.error(
    `::error::Cannot read package.json at ${upstreamRef}: ${(show.stderr || "").trim()}`,
  );
  process.exit(1);
}

const parse = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`::error::${label} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
};

const upstream = parse(show.stdout, `package.json at ${upstreamRef}`);
const local = parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  "package.json in the working tree",
);

const problems = [];

for (const field of DEPENDENCY_FIELDS) {
  const theirs = upstream[field] ?? {};
  const ours = local[field] ?? {};
  for (const name of Object.keys(ours)) {
    if (!(name in theirs)) {
      problems.push(
        `${field}.${name} exists only in the fork; move it to a fork-owned nested package (e.g. scripts/workflow-contracts/)`,
      );
    } else if (ours[name] !== theirs[name]) {
      problems.push(
        `${field}.${name} specifier differs from upstream (${ours[name]} != ${theirs[name]})`,
      );
    }
  }
  for (const name of Object.keys(theirs)) {
    if (!(name in ours)) {
      problems.push(
        `${field}.${name} was dropped from the fork manifest but exists upstream (${theirs[name]})`,
      );
    }
  }
}

// 依赖之外的键也必须与上游一致，否则同步会同样静默回滚它们。
const keysOf = (manifest) =>
  Object.keys(manifest).filter(
    (key) => !DEPENDENCY_FIELDS.includes(key) && !FORK_OWNED_FIELDS.has(key),
  );
for (const key of new Set([...keysOf(local), ...keysOf(upstream)])) {
  const ours = JSON.stringify(local[key]);
  const theirs = JSON.stringify(upstream[key]);
  if (ours !== theirs) {
    problems.push(
      `top-level "${key}" differs from upstream (${ours ?? "absent"} != ${theirs ?? "absent"})`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `::error::Root package.json must match ${upstreamRef} outside the debranded identity fields`,
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `[check-upstream-manifest] OK: root dependencies match ${upstreamRef}`,
);
