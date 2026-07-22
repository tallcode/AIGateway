const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

export function redactHeaders<T extends Record<string, unknown>>(headers: T): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '***' : value
  }
  return result
}

const MAX_INLINE_STRING = 80
const MAX_SUMMARY_DEPTH = 3

function summarizeValue(value: unknown, depth: number): string {
  if (value === null)
    return 'null'
  switch (typeof value) {
    case 'string':
      return value.length > MAX_INLINE_STRING ? `"<${value.length} chars>"` : JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value))
        return `[${value.length} items]`
      const keys = Object.keys(value as Record<string, unknown>)
      if (depth >= MAX_SUMMARY_DEPTH)
        return `{${keys.length} keys}`
      const entries = keys.map(key => `${key}:${summarizeValue((value as Record<string, unknown>)[key], depth + 1)}`)
      return `{${entries.join(',')}}`
    }
    default:
      return String(value)
  }
}

export function summarizeBody(body: unknown): string {
  if (body === null || typeof body !== 'object')
    return String(body)
  return summarizeValue(body, 0)
}
