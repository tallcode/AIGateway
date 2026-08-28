function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Clamp `thinking.budget_tokens` into [min, max]; reports whether it changed. */
export function clampBudgetTokens(payload: Record<string, unknown>, min: number, max: number): boolean {
  const thinking = asRecord(payload.thinking)
  if (!thinking || typeof thinking.budget_tokens !== 'number')
    return false
  const clamped = Math.min(max, Math.max(min, thinking.budget_tokens))
  if (clamped === thinking.budget_tokens)
    return false
  thinking.budget_tokens = clamped
  return true
}

/** Delete `thinking.budget_tokens` while leaving the rest of `thinking` intact. */
export function deleteBudgetTokens(payload: Record<string, unknown>): boolean {
  const thinking = asRecord(payload.thinking)
  if (!thinking || !Object.hasOwn(thinking, 'budget_tokens'))
    return false
  delete thinking.budget_tokens
  return true
}

/** Remove content blocks whose `type` is in `types`, across all messages. */
export function dropContentBlockTypes(payload: Record<string, unknown>, types: ReadonlySet<string>): boolean {
  const messages = payload.messages
  if (!Array.isArray(messages))
    return false

  let changed = false
  for (const message of messages) {
    const content = asRecord(message)?.content
    if (!Array.isArray(content))
      continue
    for (let index = content.length - 1; index >= 0; index--) {
      const block = asRecord(content[index])
      if (block && typeof block.type === 'string' && types.has(block.type)) {
        content.splice(index, 1)
        changed = true
      }
    }
  }
  return changed
}
