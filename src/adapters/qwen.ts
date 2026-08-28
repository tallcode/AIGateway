import type { Adapter } from '../types.js'
import { deleteBudgetTokens } from './shared.js'

/** Qwen (dashscope) rejects explicit budgets; keep `thinking.type` but drop `budget_tokens`. */
export const qwenAnthropic: Adapter = {
  name: 'qwen-anthropic',
  protocol: 'anthropic',
  apply: deleteBudgetTokens,
}
