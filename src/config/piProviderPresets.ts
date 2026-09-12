import type { ProviderCategory } from "@/types";
import type { PresetTheme } from "./claudeProviderPresets";
import {
  getPiModelCatalogReference,
  piModel,
  type PiCatalogModel,
} from "./piModelCatalog";
import {
  getPiThinkingProfile,
  resolvePiThinkingProfile,
  type PiThinkingLevelMap,
} from "./piThinkingProfiles";

export type PiApiFormat =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "bedrock-converse-stream";

export type PiPresetModel = PiCatalogModel & {
  thinkingLevelMap?: PiThinkingLevelMap;
  compat?: Record<string, unknown>;
};

export interface PiProviderPreset {
  name: string;
  nameKey?: string;
  providerKey: string;
  websiteUrl: string;
  apiKeyUrl?: string;
  settingsConfig: {
    name: string;
    baseUrl: string;
    api: PiApiFormat;
    apiKey: string;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
    models: PiPresetModel[];
  };
  category?: ProviderCategory;
  isPartner?: boolean;
  primePartner?: boolean;
  partnerPromotionKey?: string;
  theme?: PresetTheme;
  icon?: string;
  iconColor?: string;
}

export const OPENAI_COMPLETIONS_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const;

export const DEEPSEEK_THINKING_COMPAT = {
  ...OPENAI_COMPLETIONS_COMPAT,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
} as const;

// 1823/132248: thinking.type defaults to "enabled"; disabling requires an explicit
// {"type":"disabled"}. The same doc says reasoning_content need not be echoed back
// on multi-turn, so we don't reuse DEEPSEEK_THINKING_COMPAT wholesale.
export const TENCENT_DEEPSEEK_THINKING_COMPAT = {
  ...OPENAI_COMPLETIONS_COMPAT,
  thinkingFormat: "deepseek",
} as const;

export const XIAOMI_THINKING_COMPAT = {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
} as const;

// DashScope's /compatible-mode/v1 returns reasoning in Qwen's own envelope and
// rejects the `developer` role, so neither OpenAI nor DeepSeek thinking applies.
export const QWEN_THINKING_COMPAT = {
  thinkingFormat: "qwen",
  supportsDeveloperRole: false,
} as const;

export const KIMI_K3_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  thinkingFormat: "openai",
  requiresReasoningContentOnAssistantMessages: true,
  deferredToolsMode: "kimi",
} as const;

/**
 * Pi-native provider catalog.
 *
 * This list is independently maintained because provider protocol, endpoint
 * roots and model capabilities are application-specific. It was initially
 * aligned with the OpenCode catalog, but Pi does not import or derive from
 * another application's presets at runtime.
 */
export const piProviderPresetDefinitions: PiProviderPreset[] = [
  {
    name: "ChimeraHub",
    providerKey: "chimerahub",
    websiteUrl: "https://api.chimerahub.org",
    settingsConfig: {
      name: "ChimeraHub",
      baseUrl: "https://api.chimerahub.org/v1",
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
  },
];

export function materializeVerifiedThinkingProfiles(
  preset: PiProviderPreset,
): PiProviderPreset {
  return {
    ...preset,
    settingsConfig: {
      ...preset.settingsConfig,
      models: preset.settingsConfig.models.map((model) => {
        const reference = getPiModelCatalogReference(model);
        if (!reference) return model;
        const resolved = reference.presetThinkingProfileId
          ? getPiThinkingProfile(reference.presetThinkingProfileId)
          : resolvePiThinkingProfile({
              catalogKey: reference.catalogKey,
              api: preset.settingsConfig.api,
            });
        return {
          ...model,
          ...(model.reasoning ? { thinkingLevelMap: resolved?.map ?? {} } : {}),
          ...(resolved?.modelCompat
            ? {
                compat: {
                  ...model.compat,
                  ...resolved.modelCompat,
                },
              }
            : {}),
        };
      }),
    },
  };
}

export const piProviderPresets = piProviderPresetDefinitions.map(
  materializeVerifiedThinkingProfiles,
);
