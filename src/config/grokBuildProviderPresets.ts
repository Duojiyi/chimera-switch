/**
 * Grok Build (Grok CLI) 预设供应商配置模板
 *
 * 独立维护，与 codexProviderPresets.ts 无数据联动（Jason 2026-07-21 定）。
 * 初始条目取自当时的 Codex 预设快照，此后两边各自演进：
 * 合作伙伴链接 / 图标 / endpoint 变更需要在本文件单独修改。
 *
 * 收录规则：
 * - 不含官方 / 托管 OAuth 预设：Grok CLI 自带 xAI 订阅登录，官方态走
 *   独立的 "Grok Official" 条目（对应 providers_seed.rs 的 seed，
 *   空 config = 不写自定义模型表）。
 * - 不含国产模型官方直连（cn_official）与纯开源模型托管站
 *   （SiliconFlow / ModelScope / Novita / Nvidia / AtlasCloud）：
 *   这些上游没有 Grok 模型，无法在 Grok CLI 中使用。
 * - OpenCode Go 上游自 2026-08 起已提供 grok-4.5，但暂仍不收录：
 *   订阅制网关是否纳入 Grok 预设属产品决策，收录前需单独评估。
 * - 只收聚合站与第三方中转站，默认模型统一为 grok-4.5；
 *   OpenRouter 系命名空间的路由站用 "x-ai/grok-4.5"。
 *
 * config 字段沿用 Codex 风格 TOML 作为载体：Grok 表单只从中提取
 * base_url / model / wire_api 三个字段（extractCodex* 工具），再重建
 * Grok CLI 自己的 config.toml。
 */
import type { ProviderCategory } from "../types";
import type { CodexApiFormat } from "../types";
import { GROK_BUILD_DEFAULT_MODEL } from "../utils/grokBuildConfig";

export interface GrokBuildProviderPreset {
  name: string;
  nameKey?: string; // i18n key for localized display name
  websiteUrl: string;
  apiKeyUrl?: string;
  auth: Record<string, any>;
  config: string; // Codex 风格 TOML 载体（只消费 base_url / model / wire_api）
  isOfficial?: boolean;
  isPartner?: boolean;
  partnerPromotionKey?: string;
  category?: ProviderCategory;
  endpointCandidates?: string[];
  icon?: string;
  iconColor?: string;
  apiFormat?: CodexApiFormat;
}

// 官方条目与后端 seed（providers_seed.rs 的 "Grok Official"）对应：
// 空 config = 不写自定义模型表，Grok CLI 回落到自带的 xAI OAuth 登录。
// 预设 id 复用固定 provider id，AddProviderDialog 据此走 ensure seed 流程。
export const grokBuildOfficialPreset: GrokBuildProviderPreset = {
  name: "Grok Official",
  websiteUrl: "https://x.ai/grok",
  isOfficial: true,
  category: "official",
  auth: {},
  config: "",
  icon: "grok",
  iconColor: "currentColor",
};

/** OpenRouter 系命名空间路由站的 Grok 模型 id */
const OPENROUTER_STYLE_GROK_MODEL = "x-ai/grok-4.5";

const grokAuth = (): Record<string, any> => ({ OPENAI_API_KEY: "" });

function grokPresetConfig(
  providerName: string,
  baseUrl: string,
  model = GROK_BUILD_DEFAULT_MODEL,
): string {
  const tomlString = (value: string) => JSON.stringify(value);

  return `model_provider = "custom"
model = ${tomlString(model)}

[model_providers.custom]
name = ${tomlString(providerName)}
base_url = ${tomlString(baseUrl)}
wire_api = "responses"
requires_openai_auth = true`;
}

export const grokBuildProviderPresets: GrokBuildProviderPreset[] = [
  {
    name: "ChimeraHub",
    websiteUrl: "https://api.chimerahub.org",
    auth: { OPENAI_API_KEY: "" },
    config: `model_provider = "custom"
model = "grok-4.5"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "ChimeraHub"
wire_api = "responses"
requires_openai_auth = false
base_url = "https://api.chimerahub.org/v1"`,
    category: "third_party",
    icon: "openai",
    iconColor: "#10B981",
  },
];
