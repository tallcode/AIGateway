import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import type { EndpointManager } from './endpoint-manager.js'
import type { UpstreamErrorResult } from './errors.js'
import type { EndpointConfig } from './types.js'
import { Buffer } from 'node:buffer'
import { Readable as ReadableStream } from 'node:stream'
import { request } from 'undici'
import { AllEndpointsFailedError, AllEndpointsInCooldownError } from './errors.js'

interface ProxyResult {
  status: number
  headers: IncomingHttpHeaders
  body: Readable
  errorBody?: string
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
  const color = status === 'ERR' || (typeof status === 'number' && status >= 400) ? '\x1B[31m' : '\x1B[32m'
  console.log(`${logTimestamp()} ${modelName}:${epName} ${color}${status}\x1B[0m`)
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

export class ProxyHandler {
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
  ): Promise<ProxyResult> {
    const allEndpoints = this.endpointManager.getAllEndpoints(modelName)
    if (allEndpoints.length === 0) {
      throw new Error(`No endpoints configured for model: ${modelName}`)
    }

    let lastNetworkError: Error | null = null
    let lastUpstreamResult: UpstreamErrorResult | null = null
    const triedUrls = new Set<string>()

    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      let endpoint = this.endpointManager.getAvailableEndpoint(modelName, triedUrls)

      if (!endpoint) {
        endpoint = this.endpointManager.getRandomEndpoint(modelName, triedUrls)
        if (endpoint) {
          console.log(`${logTimestamp()} All endpoints in cooldown for ${modelName}, randomly trying ${endpoint.url}`)
        }
      }

      if (!endpoint)
        throw new AllEndpointsInCooldownError(modelName)

      triedUrls.add(endpoint.url)

      try {
        const result = await this.sendToEndpoint(endpoint, requestBody, requestPath, userAgent)
        const epName = endpoint.tag || extractEndpointName(endpoint.url)

        if (shouldRetry(result.status)) {
          const cooldown = getCooldownSeconds(result.status, endpoint.cooldownSeconds)
          logEndpoint(modelName, epName, result.status)
          console.log(`${logTimestamp()} HTTP ${result.status} from ${endpoint.url}, cooldown ${cooldown}s, switching endpoint`)
          if (result.errorBody) {
            console.log(`    Response body: ${truncateForLog(result.errorBody)}`)
          }
          lastUpstreamResult = {
            status: result.status,
            headers: result.headers,
            body: ReadableStream.from(result.errorBody!),
          }
          await drainStream(result.body)
          this.endpointManager.markCooldown(modelName, endpoint.url, cooldown)
          continue
        }

        logEndpoint(modelName, epName, result.status)
        return result
      }
      catch (error) {
        const err = error as Error
        const epName = endpoint.tag || extractEndpointName(endpoint.url)
        logEndpoint(modelName, epName, 'ERR')

        if (err.message.includes('serialize'))
          throw err

        lastNetworkError = err
        console.log(`${logTimestamp()} Network error from ${endpoint.url}, cooldown ${COOLDOWN_NETWORK_OR_5XX_SECONDS}s, switching endpoint`)
        console.log(`    Error: ${err.message}`)
        if (err.cause)
          console.log(`    Cause: ${String(err.cause)}`)
        this.endpointManager.markCooldown(modelName, endpoint.url, COOLDOWN_NETWORK_OR_5XX_SECONDS)
      }
    }

    throw new AllEndpointsFailedError(lastUpstreamResult, lastNetworkError)
  }

  private async sendToEndpoint(
    endpoint: EndpointConfig,
    requestBody: unknown,
    requestPath: string,
    userAgent?: string,
  ): Promise<ProxyResult> {
    const baseUrl = endpoint.url.endsWith('/') ? endpoint.url : `${endpoint.url}/`
    const url = new URL(requestPath.replace(/^\//, ''), baseUrl)

    const payload = typeof requestBody === 'object' && requestBody !== null
      ? { ...(requestBody as Record<string, unknown>), model: endpoint.modelName }
      : requestBody
    let reqBodyStr: string
    try {
      reqBodyStr = JSON.stringify(payload)
    }
    catch {
      throw new Error('Failed to serialize request body')
    }

    // Use client's UA; fall back to claude-code default (some upstreams require a recognized UA)
    const ua = userAgent || 'claude-code/2.1.137'

    if (this.verbose) {
      console.log(`${logTimestamp()} >>> Upstream Request`)
      console.log(`    URL: ${url.toString()}`)
      console.log(`    Headers: ${JSON.stringify({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ***', 'User-Agent': ua })}`)
      console.log(`    Body: ${reqBodyStr}`)
    }

    const response = await request(url.toString(), {
      method: 'POST',
      headersTimeout: 120_000,
      bodyTimeout: 360_000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${endpoint.apiKey}`,
        'User-Agent': ua,
      },
      body: reqBodyStr,
    })

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
