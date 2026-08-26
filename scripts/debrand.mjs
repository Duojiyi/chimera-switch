#!/usr/bin/env node
/**
 * debrand.mjs — 去广告 + 注入唯一供应商 ChimeraHub + 品牌改名（幂等）
 *
 * 用途：把 CC Switch 上游代码清理成 "Chimera Switch"：
 *   1. 每个 App 的供应商预设数组清空，只保留 ChimeraHub 一条。
 *   2. README 的赞助商/引流区块切除。
 *   3. 品牌字符串改名（Cargo / package / tauri / README / workflow / src）。
 *
 * 幂等：可对同一份代码重复运行，结果不变。首版发布与自动同步共用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RELAY = {
  name: "ChimeraHub",
  website: "https://chimerahub.org",
  base: "https://api.chimerahub.org/v1",
};

const log = (msg) => console.log(`[debrand] ${msg}`);

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}
function write(p, s) {
  fs.writeFileSync(path.join(ROOT, p), s);
}

/**
 * 从 src[openIdx]（一个 '['）开始，扫描到与之匹配的 ']' 的下标。
 * 跳过字符串字面量、模板字符串、行注释、块注释，正确计算嵌套数组深度。
 */
function findArrayEnd(src, openIdx) {
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

/**
 * 把文件中某个数组声明（regex 定位）的整体内容替换为 singleEntry。
 * 保留声明行与类型注解，只替换 '[' ... ']' 内部。
 */
function replaceArrayBody(relPath, declRe, singleEntry) {
  const file = path.join(ROOT, relPath);
  let src = fs.readFileSync(file, "utf8");
  const m = declRe.exec(src);
  if (!m) {
    log(`SKIP ${relPath}: 数组声明未找到`);
    return false;
  }
  const eq = src.indexOf("=", m.index);
  const open = src.indexOf("[", eq);
  if (open < 0) throw new Error(`${relPath}: 未找到 '['`);
  const close = findArrayEnd(src, open);
  if (close < 0) throw new Error(`${relPath}: 数组括号不匹配`);
  const body = singleEntry.trimEnd();
  src = src.slice(0, open + 1) + "\n" + body + "\n" + src.slice(close);
  fs.writeFileSync(file, src);
  log(`OK   ${relPath}`);
  return true;
}

/**
 * 判断一个数组条目是否为官方登录入口（决策 B：保留官方入口）。
 * 只保留 category === "official" 的官方预设（Claude/OpenAI/Google/xAI 等）。
 * 注意：cn_official 是带返佣/推广链接的赞助商条目（如 Kimi，含 ?aff=、partnerPromotionKey），
 * 属于「去广告」范围，必须移除。
 */
function isOfficialEntry(entry) {
  return (
    /category:\s*["']official["']/.test(entry) ||
    /isOfficial:\s*true/.test(entry)
  );
}

/** 把数组体按顶层对象拆成条目（跳过空白与注释）。 */
function splitTopLevelEntries(body) {
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
 * 决策 B 版数组处理：保留官方条目（category official / cn_official 或 isOfficial:true），
 * 删除第三方/赞助商条目，再追加唯一 ChimeraHub 条目。幂等。
 */
function replaceArrayKeepingOfficial(relPath, declRe, singleEntry) {
  const file = path.join(ROOT, relPath);
  let src = fs.readFileSync(file, "utf8");
  const m = declRe.exec(src);
  if (!m) {
    log(`SKIP ${relPath}: 数组声明未找到`);
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
// 1) 各 App 的 ChimeraHub 唯一预设条目
// ---------------------------------------------------------------------------

const codexConfig = (name, base, model) =>
  `\`model_provider = "custom"\nmodel = "${model}"\nmodel_reasoning_effort = "high"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = "${name}"\nwire_api = "responses"\nrequires_openai_auth = false\nbase_url = "${base}"\``;

const PRESETS = [
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
    config: ${codexConfig(RELAY.name, RELAY.base, "gpt-5.6-sol")},
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
        GEMINI_MODEL: "gemini-2.5-pro",
      },
    },
    baseURL: ${JSON.stringify(RELAY.base)},
    model: "gemini-2.5-pro",
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
    config: ${codexConfig(RELAY.name, RELAY.base, "grok-4.5")},
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
        "gpt-5.6-sol": { name: "GPT-5.6 SOL" },
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
        { id: "gpt-5.6-sol", name: "GPT-5.6 SOL", contextWindow: 200000 },
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
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 SOL" },
      ],
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
        piModel("anthropic/claude-sonnet-5", {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 SOL",
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
        model: "claude-sonnet-4-5",
        haikuModel: "claude-haiku-4-5",
        sonnetModel: "claude-sonnet-4-5",
        opusModel: "claude-opus-4-5",
      },
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      gemini: {
        model: "gemini-2.5-pro",
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
// 2) README 赞助商/引流区块切除
// ---------------------------------------------------------------------------
function stripReadmeSponsor(relPath) {
  const file = path.join(ROOT, relPath);
  let src = fs.readFileSync(file, "utf8");
  // 从 "## <Sponsor 标题>" 到下一个 "## " 标题之间整体删除。
  const re = /##[^\n]*(?:Sponsor|赞助|スポンサー|sponsor)[^\n]*\n[\s\S]*?(?=\n##\s)/i;
  const m = re.exec(src);
  if (!m) {
    log(`SKIP ${relPath}: 未发现赞助区块`);
    return;
  }
  src = src.slice(0, m.index) + src.slice(m.index + m[0].length);
  fs.writeFileSync(file, src);
  log(`OK   ${relPath} (赞助区块已移除)`);
}

// ---------------------------------------------------------------------------
// 2b) i18n 促销文案块 + 官方预设移除（幂等）
// ---------------------------------------------------------------------------

/** 与 findArrayEnd 同构，但匹配花括号 { ... }。 */
function findBraceEnd(src, openIdx) {
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

/** 移除 `export const X = {...};` 整块。幂等。 */
function removeExportBlock(relPath, declRe) {
  const file = path.join(ROOT, relPath);
  let src = fs.readFileSync(file, "utf8");
  const m = declRe.exec(src);
  if (!m) { log(`SKIP ${relPath}: 导出未找到`); return; }
  const eq = src.indexOf("=", m.index);
  const open = src.indexOf("{", eq);
  const close = findBraceEnd(src, open);
  if (close < 0) throw new Error(`${relPath}: 导出括号不匹配`);
  let end = close + 1;
  while (end < src.length && (src[end] === ";" || /\s/.test(src[end]))) end++;
  src = src.slice(0, m.index) + src.slice(end);
  fs.writeFileSync(file, src);
  log(`OK   ${relPath} (导出已移除)`);
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

function cleanupResiduals() {
  log("=== 2b) 移除 i18n 促销文案（保留官方预设） ===");
  for (const f of [
    "src/i18n/locales/en.json",
    "src/i18n/locales/zh.json",
    "src/i18n/locales/zh-TW.json",
    "src/i18n/locales/ja.json",
  ]) {
    removeJsonBlock(f, "partnerPromotion");
  }
  // 决策 B：保留官方登录入口（Claude/OpenAI/Google/xAI 一键切回官方）。
  // 以下 Grok 官方预设删除逻辑不再执行，保留 grokBuildOfficialPreset。
  return;
  // 移除 Grok 官方预设的导出、注释、表单引用与测试用例
  replaceIn(
    "src/config/grokBuildProviderPresets.ts",
    [
      "// 官方条目与后端 seed（providers_seed.rs 的 \"Grok Official\"）对应：\n// 空 config = 不写自定义模型表，Grok CLI 回落到自带的 xAI OAuth 登录。\n",
      "",
    ],
  );
  removeExportBlock(
    "src/config/grokBuildProviderPresets.ts",
    /export const grokBuildOfficialPreset/,
  );
  replaceIn(
    "src/components/providers/forms/GrokBuildProviderForm.tsx",
    ["  grokBuildOfficialPreset,\n", ""],
    [
      "  { id: GROKBUILD_OFFICIAL_PROVIDER_ID, preset: grokBuildOfficialPreset },\n",
      "",
    ],
    [
      'import { GROKBUILD_OFFICIAL_PROVIDER_ID } from "@/utils/providerCapabilities";\n',
      "",
    ],
    [
      `    if (presetId === GROKBUILD_OFFICIAL_PROVIDER_ID) {\n      // 官方登录：无 API Key / 地址 / 模型表可填，提交走 ensure seed 流程\n      form.setValue("name", grokBuildOfficialPreset.name);\n      form.setValue("websiteUrl", grokBuildOfficialPreset.websiteUrl);\n      form.setValue("icon", grokBuildOfficialPreset.icon ?? "");\n      form.setValue("iconColor", grokBuildOfficialPreset.iconColor ?? "");\n      setCategory("official");\n      setIsPartner(false);\n      setPartnerPromotionKey(undefined);\n      setPresetEndpoints([]);\n      setRawConfig("");\n      return;\n    }\n\n`,
      "",
    ],
  );
  replaceIn(
    "src/config/grokBuildProviderPresets.test.ts",
    ["  grokBuildOfficialPreset,\n", ""],
    [
      `\n  it("keeps the official preset as an empty-config seed entry", () => {\n    expect(grokBuildOfficialPreset.category).toBe("official");\n    expect(grokBuildOfficialPreset.isOfficial).toBe(true);\n    expect(grokBuildOfficialPreset.config).toBe("");\n    expect(grokBuildOfficialPreset.auth).toEqual({});\n  });\n`,
      "",
    ],
  );
}

// ---------------------------------------------------------------------------
// 3) 品牌改名（幂等字符串替换）
// ---------------------------------------------------------------------------
const REPLACEMENTS = [
  ["ccswitch.io", "chimerahub.org"],
  ["CC-Switch", "Chimera-Switch"],
  ["CC Switch", "Chimera Switch"],
  ["cc-switch", "chimera-switch"],
  ["cc_switch", "chimera_switch"],
  ["ccswitch", "chimeraswitch"],
  ["CCSwitch", "ChimeraSwitch"],
  ["farion1231", "Duojiyi"],
];

function rebrandFile(relPath) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  const before = src;
  for (const [from, to] of REPLACEMENTS) {
    src = src.split(from).join(to);
  }
  if (src !== before) {
    fs.writeFileSync(file, src);
    log(`OK   ${relPath} (品牌改名)`);
  }
}

function walk(dir, out = []) {
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
// 主流程
// ---------------------------------------------------------------------------
function main() {
  log("=== 1) 注入唯一供应商 ChimeraHub ===");
  for (const p of PRESETS) replaceArrayKeepingOfficial(p.file, p.decl, p.entry);

  log("=== 2) 切除 README 赞助区块 ===");
  for (const f of ["README.md", "README_ZH.md", "README_JA.md", "README_DE.md"]) {
    stripReadmeSponsor(f);
  }

  cleanupResiduals();

  log("=== 3) 品牌改名 ===");
  const targets = [
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "README.md",
    "README_ZH.md",
    "README_JA.md",
    "README_DE.md",
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, ".github", "workflows")),
  ].map((p) => path.relative(ROOT, p));
  for (const f of targets) rebrandFile(f);

  log("=== 完成 ===");
}

main();
