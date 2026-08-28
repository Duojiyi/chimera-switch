#!/usr/bin/env node
/**
 * debrand.mjs — 去广告 + 注入唯一供应商 ChimeraHub + 品牌改名（幂等）
 *
 * 用途：把 CC Switch 上游代码清理成 "Chimera Switch"：
 *   1. 每个 App 的供应商预设数组只保留官方登录入口，追加唯一 ChimeraHub 条目。
 *   2. README 的赞助商/引流区块切除；i18n 促销文案块（partnerPromotion）移除。
 *   3. 品牌字符串改名（Cargo / package / tauri / README / workflow / src）。
 *   4. src-tauri 定向品牌化：深链接 scheme 统一为 chimeraswitch://（与
 *      tauri.conf.json / Info.plist / 前端一致），用户可见 "CC Switch" 文案改名。
 *      数据兼容标记刻意保留（见 TAURI_PROTECTED 与文件底部说明）。
 *
 * 配置：中转站端点与默认模型由 scripts/chimerahub.config.json 统一提供。
 * 幂等：可对同一份代码重复运行，结果不变；输出符合 prettier 风格。
 *      首版发布与自动同步（sync-upstream.yml）共用。
 * 严格：任一预设文件缺失或数组声明未命中即以非零码退出，防止上游重构后
 *      赞助商条目静默漏网；发布前另有 scripts/check-debrand.mjs 做守门扫描。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "chimerahub.config.json"), "utf8"),
);
const RELAY = CONFIG.relay;
const MODELS = CONFIG.models;

const log = (msg) => console.log(`[debrand] ${msg}`);

/**
 * 从 src[openIdx]（一个 '['）开始，扫描到与之匹配的 ']' 的下标。
 * 跳过字符串字面量、模板字符串、行注释、块注释，正确计算嵌套数组深度。
 */
export function findArrayEnd(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  let inStr = null; // '"' | "'" | null
  let inTpl = false;
  let inLine = false;
  let inBlock = false;
  for (; i < n; i++) {
    const c = src[i];
    const nx = src[i + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && nx === "/") { inBlock = false; i++; }
      continue;
    }
    if (inTpl) {
      if (c === "\\") { i++; continue; }
      if (c === "`") inTpl = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && nx === "/") { inLine = true; i++; continue; }
    if (c === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (c === "`") { inTpl = true; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 与 findArrayEnd 同构，但匹配花括号 { ... }。 */
export function findBraceEnd(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  let inStr = null;
  let inTpl = false;
  let inLine = false;
  let inBlock = false;
  for (; i < n; i++) {
    const c = src[i];
    const nx = src[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && nx === "/") { inBlock = false; i++; } continue; }
    if (inTpl) { if (c === "\\") { i++; continue; } if (c === "`") inTpl = false; continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "/" && nx === "/") { inLine = true; i++; continue; }
    if (c === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (c === "`") { inTpl = true; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 判断一个数组条目是否为官方登录入口（决策 B：保留官方入口）。
 * 只保留 category === "official" 的官方预设（Claude/OpenAI/Google/xAI 等）。
 * 注意：cn_official 是带返佣/推广链接的赞助商条目（如 Kimi，含 ?aff=、
 * partnerPromotionKey），属于「去广告」范围，必须移除。
 */
export function isOfficialEntry(entry) {
  return (
    /category:\s*["']official["']/.test(entry) ||
    /isOfficial:\s*true/.test(entry)
  );
}

/** 把数组体按顶层对象拆成条目（跳过空白与注释）。 */
export function splitTopLevelEntries(body) {
  const entries = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n) break;
    if (body[i] !== "{") {
      const next = body.indexOf("{", i);
      if (next < 0) break;
      i = next;
      continue;
    }
    const close = findBraceEnd(body, i);
    if (close < 0) break;
    let end = close + 1;
    while (end < n && /\s/.test(body[end])) end++;
    if (body[end] === ",") end++;
    entries.push(body.slice(i, end));
    i = end;
  }
  return entries;
}

/**
 * 决策 B 版数组处理：保留官方条目（category official / isOfficial:true），
 * 删除第三方/赞助商条目，再追加唯一 ChimeraHub 条目。幂等。
 * 返回 true 表示成功；false 表示声明未命中（由 main 汇总后非零退出）。
 */
function replaceArrayKeepingOfficial(relPath, declRe, singleEntry) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) {
    log(`FAIL ${relPath}: 文件不存在`);
    return false;
  }
  let src = fs.readFileSync(file, "utf8");
  const m = declRe.exec(src);
  if (!m) {
    log(`FAIL ${relPath}: 数组声明未找到（上游可能重构了导出，需人工更新 PRESETS）`);
    return false;
  }
  const eq = src.indexOf("=", m.index);
  const open = src.indexOf("[", eq);
  if (open < 0) throw new Error(`${relPath}: 未找到 '['`);
  const close = findArrayEnd(src, open);
  if (close < 0) throw new Error(`${relPath}: 数组括号不匹配`);
  const body = src.slice(open + 1, close);
  const official = splitTopLevelEntries(body)
    .filter(isOfficialEntry)
    .map((e) => "  " + e.trimEnd());
  const newBody =
    (official.length ? official.join("\n") + "\n" : "") +
    singleEntry.trimEnd() +
    "\n";
  src = src.slice(0, open + 1) + "\n" + newBody + src.slice(close);
  fs.writeFileSync(file, src);
  log(`OK   ${relPath} (保留官方条目 + ChimeraHub)`);
  return true;
}

// ---------------------------------------------------------------------------
// 1) 各 App 的 ChimeraHub 唯一预设条目（模板输出与 prettier 格式一致）
// ---------------------------------------------------------------------------

const codexConfig = (name, base, model) =>
  `\`model_provider = "custom"\nmodel = "${model}"\nmodel_reasoning_effort = "high"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = "${name}"\nwire_api = "responses"\nrequires_openai_auth = false\nbase_url = "${base}"\``;

export const PRESETS = [
  {
    file: "src/config/claudeProviderPresets.ts",
    decl: /export const providerPresets:\s*ProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: ${JSON.stringify(RELAY.base)},
        ANTHROPIC_AUTH_TOKEN: "",
      },
    },
    apiFormat: "openai_chat",
    category: "third_party",
    isCustomTemplate: true,
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/claudeDesktopProviderPresets.ts",
    decl: /export const claudeDesktopProviderPresets:\s*ClaudeDesktopProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    baseUrl: ${JSON.stringify(RELAY.base)},
    mode: "proxy",
    apiFormat: "openai_chat",
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/codexProviderPresets.ts",
    decl: /export const codexProviderPresets:\s*CodexProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    auth: { OPENAI_API_KEY: "" },
    config: ${codexConfig(RELAY.name, RELAY.base, MODELS.codex)},
    category: "third_party",
    isCustomTemplate: true,
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/geminiProviderPresets.ts",
    decl: /export const geminiProviderPresets:\s*GeminiProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    settingsConfig: {
      env: {
        GOOGLE_GEMINI_BASE_URL: ${JSON.stringify(RELAY.base)},
        GEMINI_API_KEY: "",
        GEMINI_MODEL: ${JSON.stringify(MODELS.gemini)},
      },
    },
    baseURL: ${JSON.stringify(RELAY.base)},
    model: ${JSON.stringify(MODELS.gemini)},
    description: ${JSON.stringify(RELAY.name + " 中转站")},
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/grokBuildProviderPresets.ts",
    decl: /export const grokBuildProviderPresets:\s*GrokBuildProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    auth: { OPENAI_API_KEY: "" },
    config: ${codexConfig(RELAY.name, RELAY.base, MODELS.grok)},
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/opencodeProviderPresets.ts",
    decl: /export const opencodeProviderPresets:\s*OpenCodeProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    settingsConfig: {
      npm: "@ai-sdk/openai-compatible",
      name: ${JSON.stringify(RELAY.name)},
      options: {
        baseURL: ${JSON.stringify(RELAY.base)},
        apiKey: "",
        setCacheKey: true,
      },
      models: {
        ${JSON.stringify(MODELS.openaiChat.id)}: { name: ${JSON.stringify(MODELS.openaiChat.label)} },
      },
    },
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/openclawProviderPresets.ts",
    decl: /export const openclawProviderPresets:\s*OpenClawProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    settingsConfig: {
      baseUrl: ${JSON.stringify(RELAY.base)},
      apiKey: "",
      api: "openai-completions",
      models: [
        { id: ${JSON.stringify(MODELS.openaiChat.id)}, name: ${JSON.stringify(MODELS.openaiChat.label)}, contextWindow: ${MODELS.openaiChat.contextWindow} },
      ],
    },
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/hermesProviderPresets.ts",
    decl: /export const hermesProviderPresets:\s*HermesProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    websiteUrl: ${JSON.stringify(RELAY.website)},
    settingsConfig: {
      name: "chimerahub",
      base_url: ${JSON.stringify(RELAY.base)},
      api_key: "",
      api_mode: "chat_completions",
      models: [{ id: ${JSON.stringify(MODELS.openaiChat.id)}, name: ${JSON.stringify(MODELS.openaiChat.label)} }],
    },
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/piProviderPresets.ts",
    decl: /const piProviderPresetDefinitions:\s*PiProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    providerKey: "chimerahub",
    websiteUrl: ${JSON.stringify(RELAY.website)},
    settingsConfig: {
      name: ${JSON.stringify(RELAY.name)},
      baseUrl: ${JSON.stringify(RELAY.base)},
      api: "openai-completions",
      apiKey: "",
      models: [
        piModel(${JSON.stringify(MODELS.piBase)}, {
          id: ${JSON.stringify(MODELS.openaiChat.id)},
          name: ${JSON.stringify(MODELS.openaiChat.label)},
        }),
      ],
    },
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },`,
  },
  {
    file: "src/config/universalProviderPresets.ts",
    decl: /export const universalProviderPresets:\s*UniversalProviderPreset\[\]\s*=\s*\[/,
    entry: `  {
    name: ${JSON.stringify(RELAY.name)},
    providerType: "newapi",
    defaultApps: {
      claude: true,
      codex: true,
      gemini: true,
    },
    defaultModels: {
      claude: {
        model: ${JSON.stringify(MODELS.claude.model)},
        haikuModel: ${JSON.stringify(MODELS.claude.haiku)},
        sonnetModel: ${JSON.stringify(MODELS.claude.sonnet)},
        opusModel: ${JSON.stringify(MODELS.claude.opus)},
      },
      codex: {
        model: ${JSON.stringify(MODELS.codex)},
        reasoningEffort: "high",
      },
      gemini: {
        model: ${JSON.stringify(MODELS.gemini)},
      },
    },
    websiteUrl: ${JSON.stringify(RELAY.website)},
    icon: "openai",
    iconColor: "#10B981",
    description: ${JSON.stringify(RELAY.name + " 中转站")},
  },`,
  },
];

// ---------------------------------------------------------------------------
// 2) README 赞助商/引流区块切除（循环剔除全部匹配块，支持文末区块）
// ---------------------------------------------------------------------------
function stripReadmeSponsor(relPath) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  // 从 "## <Sponsor 标题>" 到下一个 "## " 标题（或文件末尾）之间整体删除。
  const re = /##[^\n]*(?:Sponsor|赞助|スポンサー|sponsor)[^\n]*\n[\s\S]*?(?=\n##\s|$)/i;
  let removed = 0;
  let m;
  while ((m = re.exec(src))) {
    src = src.slice(0, m.index) + src.slice(m.index + m[0].length);
    removed++;
  }
  if (!removed) {
    log(`SKIP ${relPath}: 未发现赞助区块`);
    return;
  }
  fs.writeFileSync(file, src);
  log(`OK   ${relPath} (${removed} 个赞助区块已移除)`);
}

// ---------------------------------------------------------------------------
// 2b) i18n 促销文案块移除（幂等）
// ---------------------------------------------------------------------------

/** 移除 JSON/JS 文件中 `"key": { ... },` 整块（含尾随逗号）。幂等。 */
function removeJsonBlock(relPath, key) {
  const file = path.join(ROOT, relPath);
  let src = fs.readFileSync(file, "utf8");
  const re = new RegExp('"' + key + '"\\s*:\\s*\\{');
  const m = re.exec(src);
  if (!m) { log(`SKIP ${relPath}: "${key}" 未找到`); return; }
  const open = src.indexOf("{", m.index);
  const close = findBraceEnd(src, open);
  if (close < 0) throw new Error(`${relPath}: "${key}" 括号不匹配`);
  let end = close + 1;
  while (end < src.length && /\s/.test(src[end])) end++;
  if (src[end] === ",") end++;
  src = src.slice(0, m.index) + src.slice(end);
  fs.writeFileSync(file, src);
  log(`OK   ${relPath} ("${key}" 已移除)`);
}

/** 对文件做幂等精确字符串替换。 */
function replaceIn(relPath, ...pairs) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  for (const [from, to] of pairs) src = src.split(from).join(to);
  if (src !== before) {
    fs.writeFileSync(file, src);
    log(`OK   ${relPath} (文本替换)`);
  } else {
    log(`SKIP ${relPath} (无匹配文本)`);
  }
}

export const I18N_LOCALES = [
  "src/i18n/locales/en.json",
  "src/i18n/locales/zh.json",
  "src/i18n/locales/zh-TW.json",
  "src/i18n/locales/ja.json",
];

function cleanupI18n() {
  log("=== 2b) 移除 i18n 促销文案（保留官方预设） ===");
  for (const f of I18N_LOCALES) {
    removeJsonBlock(f, "partnerPromotion");
  }
}

// ---------------------------------------------------------------------------
// 3) 品牌改名（幂等字符串替换）
// ---------------------------------------------------------------------------
const REPLACEMENTS = [
  ["ccswitch.io", "api.chimerahub.org"],
  ["CC-Switch", "Chimera-Switch"],
  ["CC Switch", "Chimera Switch"],
  ["cc-switch", "chimera-switch"],
  ["cc_switch", "chimera_switch"],
  ["ccswitch", "chimeraswitch"],
  ["CCSwitch", "ChimeraSwitch"],
  ["farion1231", "Duojiyi"],
];

function applyPairs(relPath, pairs, label) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  for (const [from, to] of pairs) {
    src = src.split(from).join(to);
  }
  if (src !== before) {
    fs.writeFileSync(file, src);
    log(`OK   ${relPath} (${label})`);
  }
}

const rebrandFile = (relPath) => applyPairs(relPath, REPLACEMENTS, "品牌改名");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "target" || e.name === "dist") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|json|rs|toml|yml|yaml|md)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3b) src-tauri 定向品牌化
//
// Rust 后端不能套用上面的通用替换：大量 cc-switch 记号是持久化的数据兼容
// 标记，改名会破坏老用户数据/会话。刻意保留的有：
//   - 配置目录 ~/.cc-switch、数据库 cc-switch.db、WebDAV 目录 cc-switch-sync
//   - SQL 备份导出头 "-- CC Switch SQLite 导出"（导入校验 starts_with）
//   - 代理协议前缀 ccswitch-anthropic-thinking-v1: / ccswitch-openai-reasoning-v1:
//     （编码进会话历史，跨版本回放）
//   - Codex 历史迁移的 legacy provider id "ccswitch"
// 这里只做两类安全替换：深链接 scheme（功能修复）与用户可见品牌文案。
// ---------------------------------------------------------------------------
const TAURI_PROTECTED = [
  "-- CC Switch SQLite 导出", // SQL 备份导入校验头，改名会拒绝旧备份
];
const TAURI_PAIRS = [
  ["ccswitch://", "chimeraswitch://"], // 深链接 scheme（OS 注册与前端均为 chimeraswitch）
  ["CC Switch", "Chimera Switch"], // 注释、日志与用户可见文案
];

function rebrandTauriFile(relPath) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  // 先把受保护标记替换成占位符，做完品牌替换再还原
  const ph = (i) => `DEBRAND_KEEP_${i}`;
  TAURI_PROTECTED.forEach((token, i) => {
    src = src.split(token).join(ph(i));
  });
  for (const [from, to] of TAURI_PAIRS) {
    src = src.split(from).join(to);
  }
  TAURI_PROTECTED.forEach((token, i) => {
    src = src.split(ph(i)).join(token);
  });
  if (src !== before) {
    fs.writeFileSync(file, src);
    log(`OK   ${relPath} (tauri 定向品牌化)`);
  }
}

function rebrandTauri() {
  log("=== 3b) src-tauri 定向品牌化（深链接 scheme + 用户可见文案） ===");
  const targets = [
    ...walk(path.join(ROOT, "src-tauri", "src")),
    ...walk(path.join(ROOT, "src-tauri", "tests")),
  ].map((p) => path.relative(ROOT, p));
  for (const f of targets) rebrandTauriFile(f);
  rebrandTauriFile("src-tauri/Info.plist");
  // 深链接解析器的 scheme 比较与错误信息（裸 "ccswitch"，不能进通用替换，
  // 因为 codex_history_migration 等处的裸 "ccswitch" 是 legacy 数据标记）
  replaceIn(
    "src-tauri/src/deeplink/parser.rs",
    ['scheme != "ccswitch"', 'scheme != "chimeraswitch"'],
    ["expected 'ccswitch'", "expected 'chimeraswitch'"],
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const failures = [];

  log("=== 1) 注入唯一供应商 ChimeraHub ===");
  for (const p of PRESETS) {
    if (!replaceArrayKeepingOfficial(p.file, p.decl, p.entry)) {
      failures.push(p.file);
    }
  }

  log("=== 2) 切除 README 赞助区块 ===");
  for (const f of ["README.md", "README_ZH.md", "README_JA.md", "README_DE.md"]) {
    stripReadmeSponsor(f);
  }

  cleanupI18n();

  log("=== 3) 品牌改名 ===");
  const targets = [
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "README.md",
    "README_ZH.md",
    "README_JA.md",
    "README_DE.md",
    "deplink.html",
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, ".github", "workflows")),
  ]
    .map((p) => path.relative(ROOT, p))
    .filter((p) => !p.endsWith("sync-upstream.yml"));
  for (const f of targets) rebrandFile(f);

  rebrandTauri();

  if (failures.length) {
    log(`=== 失败：${failures.length} 个预设文件未完成注入 ===`);
    for (const f of failures) log(`  - ${f}`);
    log("上游可能重构了预设导出，请更新 PRESETS 表后重试。");
    process.exit(1);
  }
  log("=== 完成 ===");
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
