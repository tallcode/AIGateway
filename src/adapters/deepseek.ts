import type { Adapter } from '../types.js'
import { clampBudgetTokens, dropContentBlockTypes } from './shared.js'

// Content block types the DeepSeek Anthropic endpoint does not understand.
const UNSUPPORTED_BLOCK_TYPES = new Set([
  'document',
  'search_result',
  'redacted_thinking',
  'code_execution_tool_result',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
])

// Older DeepSeek models also reject images.
const TEXT_ONLY_BLOCK_TYPES = new Set([...UNSUPPORTED_BLOCK_TYPES, 'image'])

/** For text-only DeepSeek models: clamp the thinking budget and strip unsupported blocks (images included). */
export const deepseekAnthropic: Adapter = {
  name: 'deepseek-anthropic',
  protocol: 'anthropic',
  apply(payload) {
    const clamped = clampBudgetTokens(payload, 0, 260000)
    const dropped = dropContentBlockTypes(payload, TEXT_ONLY_BLOCK_TYPES)
    return clamped || dropped
  },
}

/** For deepseek-v4-flash-vision-exp: same cleanup, but images are kept (the new vision model accepts them). */
export const deepseekAnthropicVision: Adapter = {
  name: 'deepseek-anthropic-vision',
  protocol: 'anthropic',
  apply(payload) {
    const clamped = clampBudgetTokens(payload, 0, 260000)
    const dropped = dropContentBlockTypes(payload, UNSUPPORTED_BLOCK_TYPES)
    return clamped || dropped
  },
}
