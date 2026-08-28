import { rectifyAnthropicThinking } from './anthropic-thinking.js'

export { rectifyAnthropicThinking } from './anthropic-thinking.js'
export type { AnthropicThinkingRectifierOptions, AnthropicThinkingRectifierResult } from './anthropic-thinking.js'

/** Rectifier registry: config `rectifiers` keys must match these names; unknown names fail config loading. */
export const rectifiers = {
  anthropicThinking: rectifyAnthropicThinking,
}
