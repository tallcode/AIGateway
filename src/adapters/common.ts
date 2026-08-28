import type { Adapter } from '../types.js'
import { clampBudgetTokens } from './shared.js'

/**
 * Reserved general-purpose adapter (previously used by the removed ark
 * provider): only clamps the thinking budget. Kept so future providers can
 * reference it without writing new code.
 */
export const commonAnthropic: Adapter = {
  name: 'common-anthropic',
  protocol: 'anthropic',
  apply: payload => clampBudgetTokens(payload, 0, 260000),
}
