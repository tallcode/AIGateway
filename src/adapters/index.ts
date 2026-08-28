import type { Adapter } from '../types.js'
import { commonAnthropic } from './common.js'
import { deepseekAnthropic, deepseekAnthropicVision } from './deepseek.js'
import { qwenAnthropic } from './qwen.js'

/** Adapter registry: config references adapters by these names; unknown names fail config loading. */
export const adapters: Record<string, Adapter> = Object.fromEntries(
  [commonAnthropic, deepseekAnthropic, deepseekAnthropicVision, qwenAnthropic].map(adapter => [adapter.name, adapter]),
)
