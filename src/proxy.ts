import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import type { EndpointManager } from './endpoint-manager.js'
import type { EndpointConfig } from './types.js'
import { Buffer } from 'node:buffer'
import { Readable as ReadableStream } from 'node:stream'
import { request } from 'undici'

interface ProxyResult {
  status: number
  headers: IncomingHttpHeaders
  body: Readable
}

function extractEndpointName(url: string): string {
  const host = new URL(url).hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return host.split('.').pop()!
  }
  const parts = host.split('.')
  return parts.length >= 2 ? parts[parts.length - 2] : host
}

function shouldRetry(status: number): boolean {
  return status === 429
    || status === 401
    || status === 403
    || status >= 500
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

    let lastError: Error | null = null

    for (let attempt = 0; attempt < allEndpoints.length; attempt++) {
      const endpoint = this.endpointManager.getAvailableEndpoint(modelName)

      if (!endpoint) {
        console.log(
          `[${new Date().toISOString()}] All endpoints in cooldown for model: ${modelName}`,
        )
        throw new Error('All endpoints are currently in cooldown')
      }

      try {
        const result = await this.sendToEndpoint(endpoint, requestBody, requestPath, userAgent)
        const epName = extractEndpointName(endpoint.url)

        if (shouldRetry(result.status)) {
          console.log(`${modelName}:${epName}:${result.status}`)
          console.log(
            `[${new Date().toISOString()}] ${result.status} received from ${endpoint.url}, switching endpoint`,
          )
          await drainStream(result.body)
          this.endpointManager.markCooldown(modelName, endpoint.url)
          continue
        }

        console.log(`${modelName}:${epName}:${result.status}`)
        return result
      }
      catch (error) {
        const err = error as Error
        const epName = extractEndpointName(endpoint.url)
        console.log(`${modelName}:${epName}:ERR`)
        lastError = err
        console.log(
          `[${new Date().toISOString()}] Network error from ${endpoint.url}: ${err.message}, switching endpoint`,
        )
        this.endpointManager.markCooldown(modelName, endpoint.url)
      }
    }

    throw lastError ?? new Error('All endpoints failed')
  }

  private async sendToEndpoint(
    endpoint: EndpointConfig,
    requestBody: unknown,
    requestPath: string,
    userAgent?: string,
  ): Promise<ProxyResult> {
    const baseUrl = endpoint.url.endsWith('/') ? endpoint.url : `${endpoint.url}/`
    const url = new URL(requestPath.replace(/^\//, ''), baseUrl)

    const reqBodyStr = JSON.stringify(requestBody)

    // Use client's UA; fall back to claude-code default (some upstreams require a recognized UA)
    const ua = userAgent || 'claude-code/2.1.137'

    if (this.verbose) {
      console.log(`[${new Date().toISOString()}] >>> Upstream Request`)
      console.log(`    URL: ${url.toString()}`)
      console.log(`    Headers: ${JSON.stringify({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ***', 'User-Agent': ua })}`)
      console.log(`    Body: ${reqBodyStr}`)
    }

    const response = await request(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${endpoint.apiKey}`,
        'User-Agent': ua,
      },
      body: reqBodyStr,
    })

    if (response.statusCode !== 200) {
      const bodyText = await streamToText(response.body as Readable)
      if (this.verbose) {
        console.log(`[${new Date().toISOString()}] <<< Upstream Response (${response.statusCode})`)
        console.log(`    Headers: ${JSON.stringify(response.headers)}`)
        console.log(`    Body: ${bodyText}`)
      }

      return {
        status: response.statusCode,
        headers: response.headers as IncomingHttpHeaders,
        body: ReadableStream.from(bodyText),
      }
    }

    return {
      status: response.statusCode,
      headers: response.headers as IncomingHttpHeaders,
      body: response.body as Readable,
    }
  }
}
