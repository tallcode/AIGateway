import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import type { EndpointManager } from './endpoint-manager.js'
import type { UpstreamErrorResult } from './errors.js'
import type { EndpointConfig, Protocol, RequestRule } from './types.js'
import { Buffer } from 'node:buffer'
import { Readable as ReadableStream } from 'node:stream'
import { request } from 'undici'
import { AllEndpointsFailedError, AllEndpointsInCooldownError, ProtocolNotSupportedError, RequestAdaptationError } from './errors.js'

interface ProxyResult {
  status: number
  headers: IncomingHttpHeaders
  body: Readable
  errorBody?: string
}

export interface AnthropicForwardHeaders {
  anthropicVersion: string
  anthropicBeta?: string
}

function extractEndpointName(url: string): string {
  const host = new URL(url).hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return host.split('.').pop()!
  }
  const parts = host.split('.')
  return parts.length >= 2 ? parts[parts.length - 2] : host
}

function logTimestamp(): string {
  const d = new Date()
  const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  return `\x1B[90m[${ts}]\x1B[0m`
}

function logEndpoint(modelName: string, epName: string, status: number | string): void {
  const isError = status === 'ERR' || status === 'TIMEOUT' || (typeof status === 'number' && status >= 400)
  const color = isError ? '\x1B[31m' : '\x1B[32m'
  console.log(`${logTimestamp()} ${modelName}:${epName} ${color}${status}\x1B[0m`)
}

function isTimeoutError(err: Error & { code?: string }): boolean {
  if (err.code && /TIMEOUT/i.test(err.code))
    return true
  return /timeout/i.test(err.message)
}

const COOLDOWN_NETWORK_OR_5XX_SECONDS = 60
const COOLDOWN_STANDARD_4XX_SECONDS = 30
const MAX_FAILOVER_ATTEMPTS = 3
const RETRYABLE_4XX_STATUSES = new Set([400, 401, 403, 404, 422])

function shouldRetry(status: number): boolean {
  return status === 429
    || RETRYABLE_4XX_STATUSES.has(status)
    || status >= 500
}

function getCooldownSeconds(status: number, configuredCooldown: number): number {
  if (status >= 500)
    return COOLDOWN_NETWORK_OR_5XX_SECONDS
  if (status === 429)
    return configuredCooldown
  if (RETRYABLE_4XX_STATUSES.has(status))
    return COOLDOWN_STANDARD_4XX_SECONDS
  return configuredCooldown
}

export function resolveUpstreamPath(requestPath: string): string {
  return `/${requestPath.replace(/^\/+/, '')}`
}

interface FieldTarget {
  parent: Record<string, unknown> | unknown[]
  key: string | number
  value: unknown
}

function resolveFieldTargets(value: unknown, segments: string[], index = 0, parent?: Record<string, unknown> | unknown[], key?: string | number): FieldTarget[] {
  if (index === segments.length) {
    return parent === undefined || key === undefined ? [] : [{ parent, key, value }]
  }
  if (typeof value !== 'object' || value === null)
    return []

  const segment = segments[index]
  const entries: [string, unknown][] = (segment === '*'
    ? Object.entries(value)
    : Object.hasOwn(value, segment)
      ? [[segment, (value as Record<string, unknown>)[segment]]]
      : []) as [string, unknown][]
  const container = value as Record<string, unknown> | unknown[]
  return entries.flatMap(([childKey, childValue]) => {
    const resolvedKey = Array.isArray(container) ? Number(childKey) : childKey
    return resolveFieldTargets(childValue, segments, index + 1, container, resolvedKey)
  })
}

function matches(value: unknown, expected: Record<string, unknown>): boolean {
  if (typeof value !== 'object' || value === null)
    return false
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue = (value as Record<string, unknown>)[key]
    if (typeof expectedValue === 'object' && expectedValue !== null && !Array.isArray(expectedValue))
      return matches(actualValue, expectedValue as Record<string, unknown>)
    return Object.is(actualValue, expectedValue)
  })
}

function applyRule(payload: Record<string, unknown>, rule: RequestRule): boolean {
  const targets = resolveFieldTargets(payload, rule.field.split('.'))
  let applied = false
  for (const target of targets) {
    if (rule.match && !matches(target.value, rule.match))
      continue

    if (rule.action === 'clamp' && typeof target.value === 'number') {
      const [min, max] = rule.value!
      const replacement = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, target.value))
      if (replacement !== target.value) {
        if (Array.isArray(target.parent) && typeof target.key === 'number')
          target.parent[target.key] = replacement
        else if (!Array.isArray(target.parent) && typeof target.key === 'string')
          target.parent[target.key] = replacement
        applied = true
      }
    }
    else if (rule.action === 'drop') {
      if (Array.isArray(target.parent)) {
        const currentIndex = target.parent.indexOf(target.value)
        if (currentIndex !== -1) {
          target.parent.splice(currentIndex, 1)
          applied = true
        }
      }
      else if (Object.hasOwn(target.parent, target.key)) {
        delete target.parent[target.key]
        applied = true
      }
    }
  }
  return applied
}

function validateAdaptedAnthropicPayload(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages))
    return
  for (const [index, message] of payload.messages.entries()) {
    const content = typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>).content
      : undefined
    if (Array.isArray(content) && content.length === 0) {
      throw new RequestAdaptationError(`Adapter removed all content from messages[${index}]`)
    }
  }
}

export function prepareRequestPayload(requestBody: unknown, endpoint: EndpointConfig, protocol: Protocol): { payload: unknown, appliedRules: string[] } {
  if (typeof requestBody !== 'object' || requestBody === null)
    return { payload: requestBody, appliedRules: [] }

  const payload = structuredClone(requestBody) as Record<string, unknown>
  payload.model = endpoint.modelName
  const adapter = endpoint.adapters[protocol]
  const appliedRules = adapter?.requestRules
    .filter(rule => applyRule(payload, rule))
    .map(rule => `${adapter.protocol}:${rule.action}:${rule.field}`)
    ?? []
  if (protocol === 'anthropic' && appliedRules.length > 0)
    validateAdaptedAnthropicPayload(payload)
  return { payload, appliedRules }
}

function truncateForLog(text: string, maxLen = 2000): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxLen)
    return trimmed
  return `${trimmed.slice(0, maxLen)}... (truncated, ${trimmed.length} chars total)`
}

async function drainStream(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.resume()
    stream.on('end', resolve)
    stream.on('error', resolve)
  })
}

async function streamToText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

export class AiProxyHandler {
  private endpointManager: EndpointManager
  private verbose: boolean

  constructor(endpointManager: EndpointManager, verbose = false) {
    this.endpointManager = endpointManager
    this.verbose = verbose
  }

  async forwardRequest(
    modelName: string,
    requestBody: unknown,
    requestPath: string,
    userAgent?: string,
    protocol: Protocol = 'openai',
    anthropicHeaders?: AnthropicForwardHeaders,
  ): Promise<ProxyResult> {
    const allEndpoints = this.endpointManager.getAllEndpoints(modelName)
    if (allEndpoints.length === 0) {
      throw new Error(`No endpoints configured for model: ${modelName}`)
    }

    if (!this.endpointManager.hasProtocolSupport(modelName, protocol)) {
      throw new ProtocolNotSupportedError(modelName, protocol)
    }

    const requireResponseApi = protocol === 'openai' && /\/responses\/?$/.test(requestPath)

    let lastNetworkError: Error | null = null
    let lastUpstreamResult: UpstreamErrorResult | null = null
    const triedUrls = new Set<string>()

    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      let endpoint = this.endpointManager.getAvailableEndpoint(modelName, triedUrls, requireResponseApi, protocol)

      if (!endpoint) {
        endpoint = this.endpointManager.getRandomEndpoint(modelName, triedUrls, requireResponseApi, protocol)
        if (endpoint && this.verbose) {
          console.log(`${logTimestamp()} All endpoints in cooldown for ${modelName}, randomly try ${endpoint.urls[protocol]}`)
        }
      }

      if (!endpoint)
        throw new AllEndpointsInCooldownError(modelName)

      const resolvedUrl = endpoint.urls[protocol]!
      triedUrls.add(resolvedUrl)

      try {
        const result = await this.sendToEndpoint(endpoint, requestBody, requestPath, userAgent, protocol, anthropicHeaders)
        const epName = endpoint.tag || extractEndpointName(resolvedUrl)

        if (shouldRetry(result.status)) {
          const cooldown = getCooldownSeconds(result.status, endpoint.cooldownSeconds)
          logEndpoint(modelName, epName, result.status)
          if (this.verbose) {
            console.log(`${logTimestamp()} HTTP ${result.status} from ${resolvedUrl}, cooldown ${cooldown}s, switching endpoint`)
            if (result.errorBody) {
              console.log(`    Response body: ${truncateForLog(result.errorBody)}`)
            }
          }
          lastUpstreamResult = {
            status: result.status,
            headers: result.headers,
            body: ReadableStream.from(result.errorBody!),
          }
          await drainStream(result.body)
          if (cooldown > 0)
            this.endpointManager.markCooldown(modelName, resolvedUrl, cooldown, protocol)
          continue
        }

        logEndpoint(modelName, epName, result.status)
        return result
      }
      catch (error) {
        if (error instanceof RequestAdaptationError)
          throw error
        const err = error as Error & { code?: string, cause?: unknown }
        const epName = endpoint.tag || extractEndpointName(resolvedUrl)
        logEndpoint(modelName, epName, isTimeoutError(err) ? 'TIMEOUT' : 'ERR')

        if (err.message.includes('serialize'))
          throw err

        lastNetworkError = err
        if (this.verbose) {
          console.log(`${logTimestamp()} Network error from ${resolvedUrl}, cooldown ${COOLDOWN_NETWORK_OR_5XX_SECONDS}s, switching endpoint`)
          console.log(`    Error: ${err.message}`)
          if (err.cause)
            console.log(`    Cause: ${String(err.cause)}`)
        }
        this.endpointManager.markCooldown(modelName, resolvedUrl, COOLDOWN_NETWORK_OR_5XX_SECONDS, protocol)
      }
    }

    throw new AllEndpointsFailedError(lastUpstreamResult, lastNetworkError)
  }

  private async sendToEndpoint(
    endpoint: EndpointConfig,
    requestBody: unknown,
    requestPath: string,
    userAgent?: string,
    protocol: Protocol = 'openai',
    anthropicHeaders?: AnthropicForwardHeaders,
  ): Promise<ProxyResult> {
    const baseUrl = endpoint.urls[protocol]!
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const url = new URL(resolveUpstreamPath(requestPath).replace(/^\//, ''), normalizedBase)

    const { payload, appliedRules } = prepareRequestPayload(requestBody, endpoint, protocol)
    let reqBodyStr: string
    try {
      reqBodyStr = JSON.stringify(payload)
    }
    catch {
      throw new Error('Failed to serialize request body')
    }

    const ua = userAgent || 'claude-code/2.1.137'

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': ua,
    }

    if (protocol === 'anthropic') {
      reqHeaders['x-api-key'] = endpoint.apiKey
      if (anthropicHeaders?.anthropicVersion) {
        reqHeaders['anthropic-version'] = anthropicHeaders.anthropicVersion
      }
      if (anthropicHeaders?.anthropicBeta) {
        reqHeaders['anthropic-beta'] = anthropicHeaders.anthropicBeta
      }
    }
    else {
      reqHeaders.Authorization = `Bearer ${endpoint.apiKey}`
    }

    if (this.verbose) {
      const logHeaders = { ...reqHeaders }
      if (logHeaders.Authorization)
        logHeaders.Authorization = 'Bearer ***'
      if (logHeaders['x-api-key'])
        logHeaders['x-api-key'] = '***'
      console.log(`${logTimestamp()} >>> Upstream Request [${protocol}]`)
      if (appliedRules.length > 0)
        console.log(`    Adapter rules: ${appliedRules.join(', ')}`)
      console.log(`    URL: ${url.toString()}`)
      console.log(`    Headers: ${JSON.stringify(logHeaders)}`)
      console.log(`    Body: ${reqBodyStr}`)
    }

    const reqStart = Date.now()
    let response: Awaited<ReturnType<typeof request>>
    try {
      response = await request(url.toString(), {
        method: 'POST',
        headersTimeout: 120_000,
        bodyTimeout: 360_000,
        headers: reqHeaders,
        body: reqBodyStr,
      })
    }
    catch (err) {
      if (this.verbose) {
        const elapsed = Date.now() - reqStart
        const e = err as Error & { code?: string, cause?: unknown }
        console.log(`${logTimestamp()} [undici] request FAILED after ${elapsed}ms to ${url.toString()}: ${e.name}: ${e.message}${e.code ? ` [${e.code}]` : ''}`)
        if (e.cause)
          console.log(`    cause: ${String(e.cause)}`)
      }
      throw err
    }

    const ttfb = Date.now() - reqStart
    if (this.verbose) {
      console.log(`${logTimestamp()} [undici] got ${response.statusCode} from ${url.toString()} in ${ttfb}ms`)
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const bodyText = await streamToText(response.body as Readable)
      if (this.verbose) {
        console.log(`${logTimestamp()} <<< Upstream Response (${response.statusCode})`)
        console.log(`    Headers: ${JSON.stringify(response.headers)}`)
        console.log(`    Body: ${bodyText}`)
      }

      return {
        status: response.statusCode,
        headers: response.headers as IncomingHttpHeaders,
        body: ReadableStream.from(bodyText),
        errorBody: bodyText,
      }
    }

    return {
      status: response.statusCode,
      headers: response.headers as IncomingHttpHeaders,
      body: response.body as Readable,
    }
  }
}
