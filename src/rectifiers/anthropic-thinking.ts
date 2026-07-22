export interface AnthropicThinkingRectifierOptions {
  enabled: boolean
}

export interface AnthropicThinkingRectifierResult {
  changed: boolean
  droppedBlocks: number
  strippedSignatures: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

type ReasoningEffort = 'low' | 'high' | 'xhigh'

function normalizeReasoningEffort(effort: unknown): ReasoningEffort {
  if (effort === 'low')
    return 'low'
  if (effort === 'medium' || effort === 'hight')
    return 'high'
  return 'xhigh'
}

function budgetForEffort(effort: ReasoningEffort): number {
  if (effort === 'low')
    return 1024
  if (effort === 'high')
    return 4096
  return 16000
}

function rectifyThinkingRequestConfig(payload: Record<string, unknown>): boolean {
  let changed = false
  const thinking = asRecord(payload.thinking)
  const outputConfig = asRecord(payload.output_config)

  if (thinking?.type === 'adaptive') {
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
  return changed
}

export function rectifyAnthropicThinking(
  payload: Record<string, unknown>,
  options: AnthropicThinkingRectifierOptions,
): AnthropicThinkingRectifierResult {
  const result: AnthropicThinkingRectifierResult = {
    changed: false,
    droppedBlocks: 0,
    strippedSignatures: 0,
  }
  if (!options.enabled)
    return result

  if (rectifyThinkingRequestConfig(payload))
    result.changed = true

  if (!Array.isArray(payload.messages))
    return result

  for (const messageValue of payload.messages) {
    const message = asRecord(messageValue)
    if (!message || !Array.isArray(message.content))
      continue

    const content: unknown[] = []
    for (const blockValue of message.content) {
      const block = asRecord(blockValue)
      if (!block || block.type !== 'thinking') {
        content.push(blockValue)
        continue
      }

      if (typeof block.thinking !== 'string' || block.thinking.length === 0) {
        result.changed = true
        result.droppedBlocks++
        continue
      }

      if (block.signature === '') {
        delete block.signature
        result.changed = true
        result.strippedSignatures++
      }
      content.push(block)
    }

    message.content = content
  }
  return result
}
