import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai";
import { resolveMaxTokens } from "./common";
import type { StreamOptionsEx } from "./types";

type ReasoningInput = SimpleStreamOptions["reasoning"] | undefined;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export type AnthropicEffort = "low" | "medium" | "high" | "max" | "xhigh";
export type AnthropicThinkingMode = "disabled" | "adaptive" | "budget";
export type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  mode: AnthropicThinkingMode;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
  display?: "summarized";
  omitDisabledThinking?: boolean;
};

function anthropicCompat(model: Model<any>) {
  return (model as Model<"anthropic-messages">).compat;
}

// 目录内模型以 compat.forceAdaptiveThinking 为准（true/false 都是显式声明，
// 与 pi-ai streamAnthropic 内部判定同源）；自定义模型没有 compat，退回 id 启发式。
export function supportsAdaptiveAnthropicThinking(model: Model<any>) {
  const forced = anthropicCompat(model)?.forceAdaptiveThinking;
  if (typeof forced === "boolean") return forced;
  const id = model.id.toLowerCase();
  return (
    isAnthropicMythosPreview(id) ||
    isClaudeFamilyVersionAtLeast(id, "opus", 6) ||
    isClaudeFamilyVersionAtLeast(id, "sonnet", 6) ||
    isClaudeFamilyMajorVersionAtLeast(id, 5)
  );
}

export function isAnthropicMythosPreview(modelId: string) {
  return modelId.toLowerCase().includes("mythos-preview");
}

function isClaudeFamilyVersionAtLeast(
  normalizedModelId: string,
  family: "opus" | "sonnet",
  minimumMinor: number,
) {
  // minor 限定 1-2 位数字，避免把日期后缀（如 claude-sonnet-4-20250514）误读成小版本号。
  const match = normalizedModelId.match(new RegExp(`${family}[-.]4[-.](\\d{1,2})(?!\\d)`));
  if (!match) return false;
  const minor = Number(match[1]);
  return Number.isFinite(minor) && minor >= minimumMinor;
}

// Claude 5 起（sonnet-5 / fable-5 / mythos-5 等）整个家族都是 adaptive thinking 且支持 xhigh。
function isClaudeFamilyMajorVersionAtLeast(normalizedModelId: string, minimumMajor: number) {
  const match = normalizedModelId.match(/(?:opus|sonnet|haiku|fable|mythos)[-.](\d{1,2})(?!\d)/);
  if (!match) return false;
  const major = Number(match[1]);
  return Number.isFinite(major) && major >= minimumMajor;
}

function supportsXHighAnthropicEffort(model: Model<any>) {
  const id = model.id.toLowerCase();
  // xhigh：Opus 4.7+ 与 Claude 5 家族；Mythos Preview 只到 max（见 supportsMaxAnthropicEffort）。
  return isClaudeFamilyVersionAtLeast(id, "opus", 7) || isClaudeFamilyMajorVersionAtLeast(id, 5);
}

function supportsMaxAnthropicEffort(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    id.includes("mythos-preview") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

const ANTHROPIC_THINKING_BUDGETS: Record<NonNullable<SimpleStreamOptions["reasoning"]>, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
};

export function mapReasoningToAnthropicEffort(
  reasoning: ReasoningInput,
  model: Model<any>,
): AnthropicEffort {
  // 目录 thinkingLevelMap 显式声明的档位优先（如 opus-4-6 的 xhigh→max、fable-5 的 xhigh→xhigh），
  // 与 pi-ai streamSimpleAnthropic 同语义；未声明的档位按模型能力降级。
  const mapped = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicEffort;

  switch (reasoning) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      if (supportsXHighAnthropicEffort(model)) return "xhigh";
      return supportsMaxAnthropicEffort(model.id) ? "max" : "high";
    default:
      return "high";
  }
}

export function resolveAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const maxTokens = resolveMaxTokens(options.maxTokens, model.maxTokens);
  if (!options.reasoning) {
    return {
      thinkingEnabled: false,
      mode: "disabled",
      maxTokens,
      omitDisabledThinking: isAnthropicMythosPreview(model.id),
    };
  }

  if (supportsAdaptiveAnthropicThinking(model)) {
    return {
      thinkingEnabled: true,
      mode: "adaptive",
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model),
      display: "summarized",
    };
  }

  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
    mode: "budget",
    maxTokens: adjustedMaxTokens,
    thinkingBudgetTokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI（codex 供应商的两种请求格式共用）
// ---------------------------------------------------------------------------

// OpenAI 官方模型的 reasoning effort 支持矩阵（2026-07 文档口径）：
// - xhigh 仅 gpt-5.1-codex-max 与 gpt-5.2 及更新型号接受；
// - minimal 不被 gpt-5-codex、gpt-5.1-codex-max 与 o 系列接受；
// 非 gpt/o 系列 id（qwen/glm/deepseek 等第三方兼容端点）原样透传，由各自适配层处理。
export function clampOpenAIReasoningEffort(
  modelId: string,
  reasoning: ReasoningInput,
): ReasoningInput {
  if (!reasoning) return undefined;
  const id = modelId.trim().toLowerCase();
  if (!isOpenAIReasoningFamilyModel(id)) return reasoning;
  if (reasoning === "xhigh" && !supportsXHighOpenAIEffort(id)) return "high";
  if (reasoning === "minimal" && !supportsMinimalOpenAIEffort(id)) return "low";
  return reasoning;
}

function isOpenAIReasoningFamilyModel(id: string) {
  return /^gpt-\d/.test(id) || /^o[134](?:-|$)/.test(id);
}

function isGptVersionAtLeast(id: string, major: number, minor: number) {
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2] ?? "0");
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function supportsXHighOpenAIEffort(id: string) {
  return id.includes("codex-max") || isGptVersionAtLeast(id, 5, 2);
}

function supportsMinimalOpenAIEffort(id: string) {
  if (/^o[134](?:-|$)/.test(id)) return false;
  if (id.startsWith("gpt-5-codex")) return false;
  if (id.includes("codex-max") && !isGptVersionAtLeast(id, 5, 2)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GeminiReasoningLevel = Exclude<NonNullable<StreamOptionsEx["reasoning"]>, "xhigh">;

function normalizeGeminiReasoning(reasoning: ReasoningInput): GeminiReasoningLevel | undefined {
  if (reasoning === "xhigh") return "high";
  return reasoning;
}

function isGemini3ProModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

// Gemini 3 Pro 只有 LOW/HIGH 两档；3.1 起 Pro 增加 MEDIUM 三档。
function isGeminiThreeTierProModel(modelId: string) {
  const match = modelId.toLowerCase().match(/gemini-3(?:\.(\d+))?-pro/);
  if (!match) return false;
  return Number(match[1] ?? "0") >= 1;
}

export function mapGeminiThinkingLevel(
  modelId: string,
  reasoning: GeminiReasoningLevel,
): GeminiThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    if (reasoning === "minimal" || reasoning === "low") return "LOW";
    if (reasoning === "medium") {
      return isGeminiThreeTierProModel(modelId) ? "MEDIUM" : "HIGH";
    }
    return "HIGH";
  }

  switch (reasoning) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

function mapGeminiThinkingBudget(modelId: string, reasoning: GeminiReasoningLevel) {
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedModelId.includes("2.5-pro")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 32_768,
    }[reasoning];
  }
  if (normalizedModelId.includes("2.5-flash")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 24_576,
    }[reasoning];
  }
  return -1;
}

export function resolveGeminiThinkingRuntime(
  model: Model<any>,
  reasoning: ReasoningInput,
): GoogleOptions["thinking"] {
  const normalizedReasoning = normalizeGeminiReasoning(reasoning);
  if (!normalizedReasoning) {
    return { enabled: false };
  }

  if (isGemini3ProModel(model.id) || isGemini3FlashModel(model.id)) {
    return {
      enabled: true,
      level: mapGeminiThinkingLevel(model.id, normalizedReasoning),
    };
  }

  return {
    enabled: true,
    budgetTokens: mapGeminiThinkingBudget(model.id, normalizedReasoning),
  };
}
