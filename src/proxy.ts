import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import type { EndpointManager } from './endpoint-manager.js'
import type { UpstreamErrorResult } from './errors.js'
import type { EndpointConfig, ModelConfig, Protocol, RectifiersConfig, UrlProtocol } from './types.js'
import { Buffer } from 'node:buffer'
import { Readable as ReadableStream } from 'node:stream'
import { request } from 'undici'
import { urlKeyFor } from './endpoint-manager.js'
import { AllEndpointsFailedError, AllEndpointsInCooldownError, ProtocolNotSupportedError, RequestAdaptationError } from './errors.js'
import { redactHeaders, summarizeBody } from './log-utils.js'
import { rectifyAnthropicThinking } from './rectifiers/index.js'

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

// One line per upstream call. BY DESIGN the model field is the upstream model name
// (endpoint.modelName), not the gateway model key: the log should show the model that
// was actually called upstream, even when the request failed over to another endpoint.
// callerId is the downstream API key's configured id (from `apiKeys`), so multi-key
// setups can see who is calling; it is omitted when unavailable.
function logEndpoint(callerId: string | undefined, modelName: string, epName: string, status: number | string): void {
  const isError = status === 'ERR' || status === 'TIMEOUT' || (typeof status === 'number' && status >= 400)
  const color = isError ? '\x1B[31m' : '\x1B[32m'
  const who = callerId ? `[${callerId}] ` : ''
  console.log(`${logTimestamp()} ${who}${modelName}:${epName} ${color}${status}\x1B[0m`)
}

function isTimeoutError(err: Error & { code?: string }): boolean {
  if (err.code && /TIMEOUT/i.test(err.code))
    return true
  return /timeout/i.test(err.message)
}

const COOLDOWN_NETWORK_OR_5XX_SECONDS = 120
const COOLDOWN_AUTH_OR_NOT_FOUND_SECONDS = 900
const COOLDOWN_STANDARD_4XX_SECONDS = 30
// Failover attempt cap per request. Each attempt picks the best-priority endpoint
// that is not in cooldown and not tried yet, so when a higher-priority endpoint is
// cooling down, lower-priority ones get their turn. Current configs have at most 3
// endpoints per model, which this cap covers; raise it if a model ever gets more
// endpoints, otherwise the extra ones would never be tried.
const MAX_FAILOVER_ATTEMPTS = 3
const RETRYABLE_4XX_STATUSES = new Set([400, 401, 403, 404, 422])

// 400/401/403/404/422 are retried on other endpoints BY DESIGN: providers validate
// parameters differently, so a request rejected by one may succeed on another.
function shouldRetry(status: number): boolean {
  return status === 429
    || RETRYABLE_4XX_STATUSES.has(status)
    || status >= 500
}

// Cooldown policy:
// - 429      -> endpoint-configured cooldownSeconds (the only status tied to the config;
//               it reflects the provider's own rate limiting).
// - 5xx/network -> COOLDOWN_NETWORK_OR_5XX_SECONDS (120s): server jitter, restarts or
//                 redeploys that usually recover, but not within seconds.
// - 401/404  -> COOLDOWN_AUTH_OR_NOT_FOUND_SECONDS (hardcoded 900s): a bad key or a
//               wrong route is a config issue that won't self-fix quickly.
// - 400      -> 0 (no cooldown): the next request may well have fixed the params, so
//               the endpoint must not be sidelined.
// - 403/422  -> COOLDOWN_STANDARD_4XX_SECONDS (30s): parameter/validation differences
//               across providers; keep healthy endpoints around.
function getCooldownSeconds(status: number, configuredCooldown: number): number {
  if (status === 429)
    return configuredCooldown
  if (status >= 500)
    return COOLDOWN_NETWORK_OR_5XX_SECONDS
  if (status === 401 || status === 404)
    return COOLDOWN_AUTH_OR_NOT_FOUND_SECONDS
  if (status === 400)
    return 0
  return COOLDOWN_STANDARD_4XX_SECONDS
}

export function resolveUpstreamPath(requestPath: string): string {
  return `/${requestPath.replace(/^\/+/, '')}`
}

/**
 * Build the model config passed to adapters: the model's `models.<key>` entry,
 * but with `endpoints` trimmed down to only the endpoint currently being used.
 */
function modelConfigForEndpoint(model: ModelConfig | undefined, endpoint: EndpointConfig): ModelConfig {
  return model
    ? { ...model, endpoints: model.endpoints.filter(e => e === endpoint) }
    : { endpoints: [endpoint] }
}

function validateTransformedAnthropicPayload(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages))
    return
  if (payload.messages.length === 0)
    throw new RequestAdaptationError('Request transform removed all messages')
  for (const [index, message] of payload.messages.entries()) {
    const content = typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>).content
      : undefined
    if (Array.isArray(content) && content.length === 0) {
      throw new RequestAdaptationError(`Request transform removed all content from messages[${index}]`)
    }
  }
}

// Output-limit fields by protocol. OpenAI speaks all three depending on API
// generation (legacy chat / o-series chat / responses); Anthropic only max_tokens.
const OPENAI_MAX_OUTPUT_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Enforce the model's configured `maxOutputTokens` cap.
 * - Anthropic: `max_tokens` is protocol-required, so a missing value is filled
 *   with the cap (same policy as rig/rust-genai), and the result is never left
 *   at or below `thinking.budget_tokens` (Anthropic rejects that).
 * - OpenAI: clamps whichever of the three output-limit fields is present;
 *   nothing is added when the client sent none (upstream defaults apply).
 */
function applyMaxOutputTokens(payload: Record<string, unknown>, model: ModelConfig, protocol: Protocol): boolean {
  const cap = model.maxOutputTokens
  if (typeof cap !== 'number' || cap < 1)
    return false

  let changed = false
  if (protocol === 'anthropic') {
    const budget = asRecord(payload.thinking)?.budget_tokens
    const current = typeof payload.max_tokens === 'number' && payload.max_tokens > 0
      ? payload.max_tokens
      : undefined
    let target = current !== undefined ? Math.min(current, cap) : cap
    if (typeof budget === 'number' && target <= budget)
      target = Math.min(cap, budget + 1)
    if (payload.max_tokens !== target) {
      payload.max_tokens = target
      changed = true
    }
  }
  else {
    for (const field of OPENAI_MAX_OUTPUT_FIELDS) {
      if (typeof payload[field] === 'number' && payload[field] > cap) {
        payload[field] = cap
        changed = true
      }
    }
  }
  return changed
}

export function prepareRequestPayload(
  requestBody: unknown,
  endpoint: EndpointConfig,
  protocol: Protocol,
  rectifiers?: RectifiersConfig,
  modelConfig?: ModelConfig,
): { payload: unknown, appliedRules: string[] } {
  if (typeof requestBody !== 'object' || requestBody === null)
    return { payload: requestBody, appliedRules: [] }

  const payload = structuredClone(requestBody) as Record<string, unknown>
  payload.model = endpoint.modelName
  const model = modelConfigForEndpoint(modelConfig, endpoint)
  const appliedRules: string[] = []
  if (protocol === 'anthropic' && rectifiers && rectifyAnthropicThinking(payload, rectifiers.anthropicThinking).changed) {
    appliedRules.push('rectifier:anthropic-thinking')
  }
  const adapter = endpoint.adapters[protocol]
  if (adapter && adapter.apply(payload, model)) {
    appliedRules.push(`adapter:${adapter.name}`)
  }
  if (applyMaxOutputTokens(payload, model, protocol)) {
    appliedRules.push('model:max-output-tokens')
  }
  if (protocol === 'anthropic' && appliedRules.length > 0)
    validateTransformedAnthropicPayload(payload)
  return { payload, appliedRules }
}

function extractUpstreamErrorMessage(body: string): string | undefined {
  const candidates = [body]
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim()
      if (data)
        candidates.push(data)
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const error = parsed?.error
      if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string')
        return (error as Record<string, unknown>).message as string
      if (typeof error === 'string')
        return error
      if (typeof parsed?.message === 'string')
        return parsed.message as string
      if (typeof parsed?.errorMessage === 'string')
        return parsed.errorMessage as string
    }
    catch {
      // not JSON, try next candidate
    }
  }
  return undefined
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
  private rectifiers: RectifiersConfig

  constructor(endpointManager: EndpointManager, verbose = false, rectifiers?: RectifiersConfig) {
    this.endpointManager = endpointManager
    this.verbose = verbose
    this.rectifiers = rectifiers ?? {
      anthropicThinking: { enabled: false },
    }
  }

  async forwardRequest(
    modelName: string,
    requestBody: unknown,
    requestPath: string,
    userAgent?: string,
    protocol: Protocol = 'openai',
    anthropicHeaders?: AnthropicForwardHeaders,
    callerId?: string,
  ): Promise<ProxyResult> {
    const allEndpoints = this.endpointManager.getAllEndpoints(modelName)
    if (allEndpoints.length === 0) {
      throw new Error(`No endpoints configured for model: ${modelName}`)
    }
    const fullModelConfig = this.endpointManager.getModelConfig(modelName)

    const requireResponseApi = protocol === 'openai' && /\/responses\/?$/.test(requestPath)
    const urlKey = urlKeyFor(protocol, requireResponseApi)

    if (!this.endpointManager.hasProtocolSupport(modelName, urlKey)) {
      throw new ProtocolNotSupportedError(modelName, protocol)
    }

    let lastNetworkError: Error | null = null
    let lastUpstreamResult: UpstreamErrorResult | null = null
    // Exclude by endpoint identity, not URL: two providers may share the same URL
    // with different API keys, and they must be treated as distinct endpoints.
    const triedEndpoints = new Set<EndpointConfig>()

    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      let endpoint = this.endpointManager.getAvailableEndpoint(modelName, triedEndpoints, requireResponseApi, protocol)

      if (!endpoint) {
        endpoint = this.endpointManager.getRandomEndpoint(modelName, triedEndpoints, requireResponseApi, protocol)
        if (endpoint && this.verbose) {
          console.log(`${logTimestamp()} All endpoints in cooldown for ${modelName}, randomly try ${endpoint.urls[urlKey]}`)
        }
      }

      if (!endpoint)
        throw new AllEndpointsInCooldownError(modelName)

      const resolvedUrl = endpoint.urls[urlKey]!
      triedEndpoints.add(endpoint)
      const modelConfig = modelConfigForEndpoint(fullModelConfig, endpoint)

      try {
        const result = await this.sendToEndpoint(endpoint, requestBody, requestPath, userAgent, protocol, anthropicHeaders, urlKey, modelConfig)
        const epName = endpoint.tag || extractEndpointName(resolvedUrl)

        if (shouldRetry(result.status)) {
          const cooldown = getCooldownSeconds(result.status, endpoint.cooldownSeconds)
          logEndpoint(callerId, endpoint.modelName, epName, result.status)
          if ([400, 401, 403].includes(result.status)) {
            const errorMessage = result.errorBody ? extractUpstreamErrorMessage(result.errorBody) : undefined
            if (errorMessage) {
              console.log(`${logTimestamp()} HTTP ${result.status} from ${resolvedUrl}: ${errorMessage}`)
            }
            else if (result.errorBody) {
              console.log(`${logTimestamp()} HTTP ${result.status} from ${resolvedUrl} (no error message parsed): ${truncateForLog(result.errorBody)}`)
            }
            else {
              console.log(`${logTimestamp()} HTTP ${result.status} from ${resolvedUrl} (empty response body)`)
            }
          }
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
            this.endpointManager.markCooldown(modelName, endpoint, cooldown, urlKey)
          continue
        }

        logEndpoint(callerId, endpoint.modelName, epName, result.status)
        return result
      }
      catch (error) {
        if (error instanceof RequestAdaptationError)
          throw error
        const err = error as Error & { code?: string, cause?: unknown }
        const epName = endpoint.tag || extractEndpointName(resolvedUrl)
        logEndpoint(callerId, endpoint.modelName, epName, isTimeoutError(err) ? 'TIMEOUT' : 'ERR')

        if (err.message.includes('serialize'))
          throw err

        lastNetworkError = err
        if (this.verbose) {
          console.log(`${logTimestamp()} Network error from ${resolvedUrl}, cooldown ${COOLDOWN_NETWORK_OR_5XX_SECONDS}s, switching endpoint`)
          console.log(`    Error: ${err.message}`)
          if (err.cause)
            console.log(`    Cause: ${String(err.cause)}`)
        }
        this.endpointManager.markCooldown(modelName, endpoint, COOLDOWN_NETWORK_OR_5XX_SECONDS, urlKey)
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
    urlKey: UrlProtocol = 'openai',
    modelConfig?: ModelConfig,
  ): Promise<ProxyResult> {
    const baseUrl = endpoint.urls[urlKey]!
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const url = new URL(resolveUpstreamPath(requestPath).replace(/^\//, ''), normalizedBase)

    const { payload, appliedRules } = prepareRequestPayload(requestBody, endpoint, protocol, this.rectifiers, modelConfig)
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
      console.log(`${logTimestamp()} >>> Upstream Request [${protocol}]`)
      if (appliedRules.length > 0)
        console.log(`    Request transforms: ${appliedRules.join(', ')}`)
      console.log(`    URL: ${url.toString()}`)
      console.log(`    Headers: ${JSON.stringify(redactHeaders(reqHeaders))}`)
    }

    const reqStart = Date.now()
    let response: Awaited<ReturnType<typeof request>>
    try {
      response = await request(url.toString(), {
        method: 'POST',
        headersTimeout: 60_000,
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
        console.log(`    Headers: ${JSON.stringify(redactHeaders(response.headers as Record<string, unknown>))}`)
        console.log(`    Request Body: ${summarizeBody(payload)}`)
        console.log(`    Response Body: ${truncateForLog(bodyText)}`)
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
