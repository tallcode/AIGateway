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

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

function normalizeReasoningEffort(effort: unknown): ReasoningEffort {
  if (effort === 'low')
    return 'low'
  if (effort === 'medium')
    return 'medium'
  if (effort === 'hight')
    return 'high'
  // 'high' (and any unknown value) becomes 'xhigh': the gateway's models are
  // tuned for maximum thinking on Claude Code's "high" setting.
  return 'xhigh'
}

function budgetForEffort(effort: ReasoningEffort): number {
  if (effort === 'low')
    return 1024
  if (effort === 'xhigh')
    return 16000
  return 4096
}

function rectifyThinkingRequestConfig(payload: Record<string, unknown>): boolean {
  let changed = false
  const thinking = asRecord(payload.thinking)
  const outputConfig = asRecord(payload.output_config)

  // Some upstream "always-thinking" models (e.g. glm-5.3) reject requests that
  // turn thinking off ("该模型始终思考，不支持关闭思考"), so both `adaptive` and
  // `disabled` are rewritten to `enabled`; budget_tokens is filled in below.
  if (thinking && (thinking.type === 'adaptive' || thinking.type === 'disabled')) {
    thinking.type = 'enabled'
    changed = true
  }

  let effort: ReasoningEffort
  if (payload.reasoning_effort !== undefined) {
    effort = normalizeReasoningEffort(payload.reasoning_effort)
  }
  else if (outputConfig && Object.hasOwn(outputConfig, 'effort') && outputConfig.effort !== undefined) {
    effort = normalizeReasoningEffort(outputConfig.effort)
    payload.reasoning_effort = effort
    changed = true
  }
  else {
    effort = 'low'
    payload.reasoning_effort = effort
    changed = true
  }

  if (thinking && thinking.budget_tokens === undefined) {
    thinking.budget_tokens = budgetForEffort(effort)
    changed = true
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
): AnthropicThinkingRectifierResult {
  const result: AnthropicThinkingRectifierResult = {
    changed: false,
  }
  if (!options.enabled)
    return result

  if (rectifyThinkingRequestConfig(payload))
    result.changed = true

  return result
}
