#!/usr/bin/env node
/**
 * align-version.mjs <version> — 把版本号统一对齐为上游 release 版本（幂等）
 *
 * 覆盖四处：package.json / src-tauri/tauri.conf.json /
 *          src-tauri/Cargo.toml / src-tauri/Cargo.lock。
 * sync-upstream 合并上游 tag 后调用（版本文件冲突按既定策略解决后，
 * 版本号可能停留在任一侧，这里统一收口）。任何一处未命中即非零退出。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`[align-version] 用法：node scripts/align-version.mjs <x.y.z>（收到 "${version}"）`);
  process.exit(1);
}

let failed = false;

function align(relPath, re, replacement) {
  const file = path.join(ROOT, relPath);
  const src = fs.readFileSync(file, "utf8");
  if (!re.test(src)) {
    console.error(`[align-version] ✗ ${relPath}: 未找到版本字段（${re}）`);
    failed = true;
    return;
  }
  const next = src.replace(re, replacement);
  if (next !== src) {
    fs.writeFileSync(file, next);
    console.log(`[align-version] OK   ${relPath} -> ${version}`);
  } else {
    console.log(`[align-version] SKIP ${relPath}（已是 ${version}）`);
  }
}

align("package.json", /("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
align("src-tauri/tauri.conf.json", /("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
align("src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
// Cargo.lock 只对齐本包（chimera-switch）条目；依赖版本保持上游锁定值
align(
  "src-tauri/Cargo.lock",
  /(name = "chimera-switch"\r?\nversion = ")[^"]+(")/,
  `$1${version}$2`,
);

process.exit(failed ? 1 : 0);
