import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { IncomingHttpHeaders } from 'node:http'
import type { EndpointManager } from './endpoint-manager.js'
import type { AiProxyHandler, AnthropicForwardHeaders } from './proxy.js'
import type { GatewayConfig, Protocol } from './types.js'
import { Buffer } from 'node:buffer'
import Fastify from 'fastify'
import { AllEndpointsFailedError, AllEndpointsInCooldownError, ProtocolNotSupportedError, RequestAdaptationError } from './errors.js'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

function stripHopByHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connection = headers.connection
  const stripped: IncomingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower))
      continue
    stripped[key] = value
  }
  if (typeof connection === 'string') {
    const remove = connection.split(',').map(h => h.trim().toLowerCase())
    for (const key of Object.keys(stripped)) {
      if (remove.includes(key.toLowerCase()))
        delete stripped[key]
    }
  }
  return stripped
}

export function detectProtocol(request: Pick<FastifyRequest, 'url' | 'headers'>): Protocol {
  if (request.url.split('?', 1)[0] === '/v1/messages')
    return 'anthropic'
  if (request.headers['x-api-key'] || request.headers['anthropic-version']) {
    return 'anthropic'
  }
  return 'openai'
}

function extractAnthropicHeaders(request: FastifyRequest): AnthropicForwardHeaders | undefined {
  const version = request.headers['anthropic-version']
  if (!version || typeof version !== 'string')
    return undefined
  const beta = request.headers['anthropic-beta']
  return {
    anthropicVersion: version,
    anthropicBeta: typeof beta === 'string' ? beta : undefined,
  }
}

function formatErrorResponse(protocol: Protocol, status: number, message: string): object {
  if (protocol === 'anthropic') {
    const errorType = status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status === 503
            ? 'overloaded_error'
            : 'api_error'
    return {
      type: 'error',
      error: {
        type: errorType,
        message,
      },
    }
  }
  return {
    error: { message },
  }
}

function logTs(): string {
  const d = new Date()
  const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  return `\x1B[90m[${ts}]\x1B[0m`
}

function pipeProxyResult(
  reply: FastifyReply,
  result: { status: number, headers: IncomingHttpHeaders, body: NodeJS.ReadableStream },
  context?: { modelName?: string, requestPath?: string },
  verbose = false,
): void {
  reply.raw.writeHead(result.status, stripHopByHopHeaders(result.headers))

  const upstream = result.body as NodeJS.ReadableStream
  let upstreamEnded = false
  let clientClosed = false

  const tag = `${context?.modelName ?? '?'}${context?.requestPath ?? ''}`
  const startedAt = Date.now()
  let bytes = 0
  let chunks = 0
  let lastChunkAt = startedAt

  if (verbose) {
    upstream.on('data', (chunk: Buffer | string) => {
      chunks++
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      lastChunkAt = Date.now()
    })
  }

  upstream.on('end', () => {
    upstreamEnded = true
    if (verbose) {
      const total = Date.now() - startedAt
      console.log(`${logTs()} [stream] upstream END for ${tag} after ${total}ms (${bytes}B in ${chunks} chunks)`)
    }
  })

  upstream.on('error', (err: Error & { code?: string, cause?: unknown }) => {
    if (clientClosed && (err.code === 'UND_ERR_ABORTED' || err.name === 'AbortError'))
      return
    if (verbose) {
      const sinceLast = Date.now() - lastChunkAt
      const total = Date.now() - startedAt
      console.log(`${logTs()} [stream] upstream ERROR for ${tag} after ${total}ms (idle ${sinceLast}ms, ${bytes}B in ${chunks} chunks): ${err.name}: ${err.message}${err.code ? ` [${err.code}]` : ''}`)
      if (err.cause)
        console.log(`    cause: ${String(err.cause)}`)
    }
    if (!reply.raw.writableEnded)
      reply.raw.end()
  })

  upstream.on('close', () => {
    if (verbose && !upstreamEnded && !clientClosed) {
      const sinceLast = Date.now() - lastChunkAt
      const total = Date.now() - startedAt
      console.log(`${logTs()} [stream] upstream CLOSE (without end) for ${tag} after ${total}ms (idle ${sinceLast}ms, ${bytes}B in ${chunks} chunks)`)
    }
  })

  reply.raw.on('close', () => {
    if (!upstreamEnded) {
      clientClosed = true
      if (verbose) {
        const sinceLast = Date.now() - lastChunkAt
        const total = Date.now() - startedAt
        console.log(`${logTs()} [stream] CLIENT closed early for ${tag} after ${total}ms (idle ${sinceLast}ms, ${bytes}B in ${chunks} chunks); destroying upstream`)
      }
      const s = upstream as unknown as { destroy?: (e?: Error) => void }
      if (typeof s.destroy === 'function')
        s.destroy()
    }
  })

  reply.raw.on('error', (err: Error & { code?: string }) => {
    if (verbose) {
      const total = Date.now() - startedAt
      console.log(`${logTs()} [stream] downstream ERROR for ${tag} after ${total}ms (${bytes}B sent): ${err.name}: ${err.message}${err.code ? ` [${err.code}]` : ''}`)
    }
  })

  upstream.pipe(reply.raw, { end: true })
}

export function createServer(
  config: GatewayConfig,
  endpointManager: EndpointManager,
  proxyHandler: AiProxyHandler,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 50 * 1024 * 1024,
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health')
      return

    const protocol = detectProtocol(request)

    if (protocol === 'anthropic') {
      const apiKey = request.headers['x-api-key']
      const authHeader = request.headers.authorization
      const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined
      if (apiKey !== config.apiKey && bearerToken !== config.apiKey) {
        return reply.code(401).send(formatErrorResponse('anthropic', 401, 'Invalid or missing API key'))
      }
    }
    else {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send(formatErrorResponse('openai', 401, 'Missing or invalid Authorization header'))
      }
      const token = authHeader.slice(7)
      if (token !== config.apiKey) {
        return reply.code(403).send(formatErrorResponse('openai', 403, 'Invalid API key'))
      }
    }
  })

  app.get('/v1/models', async (_request, reply) => {
    const modelKeys = endpointManager.getModelKeys()
    const data = modelKeys.map((m) => {
      const meta = endpointManager.getModelConfig(m)
      const entry: Record<string, unknown> = {
        id: m,
        object: 'model',
        created: 1779235200,
        owned_by: 'system',
      }
      if (meta) {
        if (meta.name !== undefined)
          entry.name = meta.name
        if (meta.contextLength !== undefined)
          entry.context_length = meta.contextLength
        if (meta.features !== undefined)
          entry.features = meta.features
        if (meta.architecture !== undefined)
          entry.architecture = meta.architecture
      }
      return entry
    })
    return reply.send({ object: 'list', data })
  })

  app.post('/v1/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | undefined
    const modelName = body?.model as string | undefined
    const protocol = detectProtocol(request)
    const anthropicHeaders = protocol === 'anthropic' ? extractAnthropicHeaders(request) : undefined

    if (config.verbose) {
      console.log(`>>> Downstream Request [${protocol}]`)
      console.log(`    Path: ${request.url}`)
      console.log(`    Headers: ${JSON.stringify(request.headers)}`)
      console.log(`    Body: ${JSON.stringify(body)}`)
    }

    if (!modelName) {
      const status = protocol === 'anthropic' ? 400 : 400
      return reply.code(status).send(formatErrorResponse(protocol, status, 'Missing "model" field in request body'))
    }

    if (!config.models[modelName]) {
      return reply.code(404).send(formatErrorResponse(protocol, 404, `Model not found: ${modelName}`))
    }

    const requestPath = `/${(request.params as Record<string, string>)['*']}`
    const userAgent = request.headers['user-agent']

    const ctx = { modelName, requestPath }

    try {
      const result = await proxyHandler.forwardRequest(modelName, body, requestPath, userAgent, protocol, anthropicHeaders)
      pipeProxyResult(reply, result, ctx, config.verbose)
    }
    catch (error) {
      if (error instanceof ProtocolNotSupportedError) {
        return reply.code(503).send(formatErrorResponse(protocol, 503, `No endpoints support ${error.protocol} protocol for model: ${error.modelName}`))
      }

      if (error instanceof AllEndpointsInCooldownError) {
        return reply.code(503).send(formatErrorResponse(protocol, 503, 'Service unavailable: all endpoints are in cooldown'))
      }

      if (error instanceof RequestAdaptationError) {
        return reply.code(400).send(formatErrorResponse(protocol, 400, error.message))
      }

      if (error instanceof Error && error.message.includes('serialize')) {
        return reply.code(400).send(formatErrorResponse(protocol, 400, error.message))
      }

      if (error instanceof AllEndpointsFailedError) {
        if (error.lastUpstreamResult) {
          pipeProxyResult(reply, error.lastUpstreamResult, ctx, config.verbose)
          return
        }

        const message = error.lastNetworkError?.message ?? error.message
        return reply.code(502).send(formatErrorResponse(protocol, 502, `Upstream error: ${message}`))
      }

      return reply.code(502).send(formatErrorResponse(protocol, 502, `Upstream error: ${(error as Error).message}`))
    }
  })

  app.get('/health', async () => {
    return { status: 'ok' }
  })

  return app
}
