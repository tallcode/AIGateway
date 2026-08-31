import type { ReasoningConfig } from '../types.js'

export interface AnthropicThinkingRectifierOptions {
  enabled: boolean
}

export interface AnthropicThinkingRectifierResult {
  changed: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none'

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none']

/** Claude Code's known effort spellings; `hight` is its historical typo for `high`. */
function normalizeReasoningEffort(effort: unknown): ReasoningEffort | undefined {
  if (typeof effort !== 'string')
    return undefined
  if (effort === 'hight')
    return 'high'
  if (EFFORTS.includes(effort as ReasoningEffort))
    return effort as ReasoningEffort
  return undefined
}

/**
 * Fit a requested effort into the model's supported set. The gateway prefers
 * more thinking than Claude's labels suggest for some settings (its models are
 * tuned that way), but never picks an effort the model does not support.
 * Falls back to the model's configured default effort when nothing matches.
 */
function fitEffort(requested: ReasoningEffort, supported: readonly string[], fallback: string | undefined): ReasoningEffort {
  const preferences: Partial<Record<ReasoningEffort, readonly ReasoningEffort[]>> = {
    high: ['xhigh', 'high', 'max'],
    xhigh: ['xhigh', 'max', 'high'],
    max: ['max', 'xhigh', 'high'],
    medium: ['medium', 'high', 'xhigh', 'max'],
    low: ['low', 'minimal', 'medium'],
    minimal: ['minimal', 'low'],
    none: ['none'],
  }
  for (const candidate of preferences[requested] ?? [requested]) {
    if (supported.includes(candidate))
      return candidate
  }
  const configured = normalizeReasoningEffort(fallback)
  if (configured && supported.includes(configured))
    return configured
  if (supported.includes('low'))
    return 'low'
  return (supported[0] ?? 'low') as ReasoningEffort
}

/** The model's configured default effort, validated against its supported set. */
function defaultEffort(reasoning: ReasoningConfig | undefined): ReasoningEffort {
  const configured = normalizeReasoningEffort(reasoning?.default_effort)
  const supported = reasoning?.supported_efforts
  if (configured && (!supported || supported.length === 0 || supported.includes(configured)))
    return configured
  if (supported && supported.length > 0)
    return (supported[0] ?? 'low') as ReasoningEffort
  return 'low'
}

/** Resolve a client-supplied effort value, honoring the model's reasoning config. */
function resolveEffort(requested: unknown, reasoning: ReasoningConfig | undefined): ReasoningEffort {
  const normalized = normalizeReasoningEffort(requested)

  // Per-model reasoning info (OpenRouter-style): validate against the
  // supported set; an unrecognized request falls back to the model default.
  if (reasoning?.supported_efforts && reasoning.supported_efforts.length > 0) {
    return normalized
      ? fitEffort(normalized, reasoning.supported_efforts, reasoning.default_effort)
      : defaultEffort(reasoning)
  }

  // Legacy behavior without per-model config: boost everything toward xhigh
  // (matches the pre-config rectifier semantics).
  return normalized === 'high' ? 'xhigh' : normalized ?? 'xhigh'
}

function budgetForEffort(effort: ReasoningEffort): number {
  if (effort === 'minimal' || effort === 'low')
    return 1024
  if (effort === 'medium' || effort === 'high')
    return 4096
  return 16000 // xhigh / max
}

function rectifyThinkingRequestConfig(payload: Record<string, unknown>, reasoning: ReasoningConfig | undefined): boolean {
  let changed = false
  const thinking = asRecord(payload.thinking)
  const outputConfig = asRecord(payload.output_config)

  // `adaptive` is Claude-native; this gateway's upstreams take the legacy
  // `enabled + budget_tokens` shape, so adaptive is always normalized.
  // `disabled` is only overridden when the model cannot turn thinking off
  // (`reasoning.mandatory`) or when no per-model info is configured (legacy
  // safety: some upstream "always-thinking" models, e.g. glm-5.3, reject
  // requests that turn thinking off — "该模型始终思考，不支持关闭思考").
  const mustThink = reasoning === undefined || reasoning.mandatory === true
  if (thinking && thinking.type === 'adaptive') {
    thinking.type = 'enabled'
    changed = true
  }
  else if (thinking && thinking.type === 'disabled' && mustThink) {
    thinking.type = 'enabled'
    changed = true
  }

  // When thinking stays disabled, effort and budget are meaningless — skip.
  const thinkingOff = thinking !== undefined && thinking.type === 'disabled'
  if (!thinkingOff) {
    let effort: ReasoningEffort
    if (payload.reasoning_effort !== undefined) {
      effort = resolveEffort(payload.reasoning_effort, reasoning)
    }
    else if (outputConfig && outputConfig.effort !== undefined) {
      effort = resolveEffort(outputConfig.effort, reasoning)
    }
    else {
      effort = defaultEffort(reasoning)
    }

    if (payload.reasoning_effort !== effort) {
      payload.reasoning_effort = effort
      changed = true
    }
    if (thinking && thinking.budget_tokens === undefined && effort !== 'none') {
      thinking.budget_tokens = budgetForEffort(effort)
      changed = true
    }
  }

  // `output_config` is a Claude-native field none of the gateway's upstreams
  // understand. Its `effort` was consumed above; drop the whole object so it
  // never leaks through to the provider (rig/rust-genai never emit it either).
  if (Object.hasOwn(payload, 'output_config')) {
    delete payload.output_config
    changed = true
  }

  return changed
}

export function rectifyAnthropicThinking(
  payload: Record<string, unknown>,
  options: AnthropicThinkingRectifierOptions,
  reasoning?: ReasoningConfig,
): AnthropicThinkingRectifierResult {
  const result: AnthropicThinkingRectifierResult = {
    changed: false,
  }
  if (!options.enabled)
    return result

  if (rectifyThinkingRequestConfig(payload, reasoning))
    result.changed = true

  return result
}
