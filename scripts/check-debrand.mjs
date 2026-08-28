#!/usr/bin/env node
/**
 * check-debrand.mjs — 去广告守门扫描（CI 与 sync-upstream 流水线共用）
 *
 * debrand.mjs 是「转换器」，本脚本是「校验器」：上游新增预设文件、新广告
 * 位或重构导出时转换器可能漏网，因此打 tag / 合 PR 之前必须通过本脚本的
 * 硬校验，任何命中即以非零码退出并列出明细。
 *
 * 校验内容：
 *   1. 预设数组只允许 官方登录条目 + ChimeraHub；
 *   2. src/config 无赞助商标记（isPartner/cn_official/utm/aff/推广 key）；
 *   3. i18n 无 partnerPromotion 促销块；README 无赞助标题；
 *   4. 深链接 scheme 无 ccswitch:// 残留（前后端一致性）；
 *   5. 身份字段与 identity 配置一致（identifier / scheme / 更新器端点与
 *      公钥 / 包名），防止上游合并把 fork 的更新链路"洗"回去。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  CONFIG,
  PRESETS,
  findArrayEnd,
  splitTopLevelEntries,
  isOfficialEntry,
  I18N_LOCALES,
} from "./debrand.mjs";

const problems = [];
const fail = (msg) => problems.push(msg);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function walk(dir, re, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "target", "dist", ".git"].includes(e.name)) continue;
      walk(rel, re, out);
    } else if (re.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) 预设数组：只允许官方条目 + ChimeraHub
// ---------------------------------------------------------------------------
const relayNameRe = new RegExp(
  `name:\\s*["']${CONFIG.relay.name}["']`,
);
for (const p of PRESETS) {
  if (!exists(p.file)) {
    fail(`${p.file}: 预设文件不存在`);
    continue;
  }
  const src = read(p.file);
  const m = p.decl.exec(src);
  if (!m) {
    fail(`${p.file}: 预设数组声明未找到（上游重构？需同步更新 debrand PRESETS）`);
    continue;
  }
  const open = src.indexOf("[", src.indexOf("=", m.index));
  const close = findArrayEnd(src, open);
  if (close < 0) {
    fail(`${p.file}: 数组括号不匹配`);
    continue;
  }
  const entries = splitTopLevelEntries(src.slice(open + 1, close));
  let hasRelay = false;
  for (const e of entries) {
    if (relayNameRe.test(e)) {
      hasRelay = true;
      continue;
    }
    if (!isOfficialEntry(e)) {
      const name = /name:\s*["']([^"']+)["']/.exec(e)?.[1] ?? "<unknown>";
      fail(`${p.file}: 存在非官方、非 ${CONFIG.relay.name} 的条目 "${name}"`);
    }
  }
  if (!hasRelay) fail(`${p.file}: 缺少 ${CONFIG.relay.name} 条目`);
}

// ---------------------------------------------------------------------------
// 2) src/config 赞助商标记扫描
// ---------------------------------------------------------------------------
const BANNED_IN_CONFIG = [
  [/utm_source=/g, "推广跟踪参数 utm_source"],
  [/[?&]aff=/g, "返佣参数 aff"],
  [/isPartner:\s*true/g, "合作伙伴标记 isPartner: true"],
  [/category:\s*["']cn_official["']/g, "赞助商类目 cn_official"],
  [/partnerPromotionKey:\s*["'](?!google-official["'])/g, "推广文案键 partnerPromotionKey"],
];
for (const f of walk("src/config", /\.tsx?$/)) {
  const src = read(f);
  for (const [re, label] of BANNED_IN_CONFIG) {
    re.lastIndex = 0;
    if (re.test(src)) fail(`${f}: 命中 ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 3) i18n 促销块与 README 赞助标题
// ---------------------------------------------------------------------------
for (const f of I18N_LOCALES) {
  if (exists(f) && /"partnerPromotion"\s*:/.test(read(f))) {
    fail(`${f}: 仍包含 partnerPromotion 促销文案块`);
  }
}
for (const f of ["README.md", "README_ZH.md", "README_JA.md", "README_DE.md"]) {
  if (exists(f) && /^##.*(sponsor|赞助|スポンサー)/im.test(read(f))) {
    fail(`${f}: 仍包含赞助商标题区块`);
  }
}

// ---------------------------------------------------------------------------
// 4) 深链接 scheme 一致性（Rust 侧回归即前后端断裂）
// ---------------------------------------------------------------------------
for (const f of [
  ...walk("src", /\.(ts|tsx)$/),
  ...walk("src-tauri/src", /\.rs$/),
  ...walk("src-tauri/tests", /\.rs$/),
]) {
  if (read(f).includes("ccswitch://")) {
    fail(`${f}: 残留旧深链接 scheme ccswitch://`);
  }
}
{
  const parser = "src-tauri/src/deeplink/parser.rs";
  if (exists(parser) && !read(parser).includes(`"${CONFIG.identity.scheme}"`)) {
    fail(`${parser}: 未接受 ${CONFIG.identity.scheme} scheme（debrand 替换失效？）`);
  }
}

// ---------------------------------------------------------------------------
// 5) 身份字段断言（identifier / scheme / 更新器 / 包名）
// ---------------------------------------------------------------------------
{
  const id = CONFIG.identity;
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  if (tauri.identifier !== id.identifier) {
    fail(`tauri.conf.json: identifier 应为 ${id.identifier}，实为 ${tauri.identifier}`);
  }
  const schemes = tauri.plugins?.["deep-link"]?.desktop?.schemes ?? [];
  if (!schemes.includes(id.scheme)) {
    fail(`tauri.conf.json: deep-link schemes 缺少 ${id.scheme}`);
  }
  const updater = tauri.plugins?.updater ?? {};
  if (updater.pubkey !== id.updaterPubkey) {
    fail("tauri.conf.json: updater.pubkey 与 identity 配置不一致（可能被上游合并覆盖）");
  }
  if (!(updater.endpoints ?? []).includes(id.updaterEndpoint)) {
    fail(`tauri.conf.json: updater.endpoints 缺少 ${id.updaterEndpoint}`);
  }
  const pkg = JSON.parse(read("package.json"));
  if (pkg.name !== id.packageName) {
    fail(`package.json: name 应为 ${id.packageName}，实为 ${pkg.name}`);
  }
  if (!new RegExp(`^name = "${id.packageName}"`, "m").test(read("src-tauri/Cargo.toml"))) {
    fail(`src-tauri/Cargo.toml: [package] name 应为 ${id.packageName}`);
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (problems.length) {
  console.error(`[check-debrand] 未通过，共 ${problems.length} 项：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("[check-debrand] 通过：预设、i18n、README、scheme、身份字段均干净。");
