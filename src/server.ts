import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { IncomingHttpHeaders } from 'node:http'
import type { EndpointManager } from './endpoint-manager.js'
import type { ProxyHandler } from './proxy.js'
import type { GatewayConfig } from './types.js'
import Fastify from 'fastify'
import { AllEndpointsFailedError, AllEndpointsInCooldownError } from './errors.js'

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

function pipeProxyResult(
  reply: FastifyReply,
  result: { status: number, headers: IncomingHttpHeaders, body: NodeJS.ReadableStream },
): void {
  reply.raw.writeHead(result.status, stripHopByHopHeaders(result.headers))
  result.body.on('error', () => {
    if (!reply.raw.writableEnded) {
      reply.raw.end()
    }
  })
  result.body.pipe(reply.raw, { end: true })
}

export function createServer(
  config: GatewayConfig,
  endpointManager: EndpointManager,
  proxyHandler: ProxyHandler,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 50 * 1024 * 1024,
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health')
      return

    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { message: 'Missing or invalid Authorization header' } })
    }

    const token = authHeader.slice(7)
    if (token !== config.apiKey) {
      return reply.code(403).send({ error: { message: 'Invalid API key' } })
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

    if (config.verbose) {
      console.log(`>>> Downstream Request`)
      console.log(`    Path: ${request.url}`)
      console.log(`    Headers: ${JSON.stringify(request.headers)}`)
      console.log(`    Body: ${JSON.stringify(body)}`)
    }

    if (!modelName) {
      return reply.code(400).send({
        error: { message: 'Missing "model" field in request body' },
      })
    }

    if (!config.models[modelName]) {
      return reply.code(404).send({
        error: { message: `Model not found: ${modelName}` },
      })
    }

    const requestPath = `/${(request.params as Record<string, string>)['*']}`
    const userAgent = request.headers['user-agent']

    try {
      const result = await proxyHandler.forwardRequest(modelName, body, requestPath, userAgent)
      pipeProxyResult(reply, result)
    }
    catch (error) {
      if (error instanceof AllEndpointsInCooldownError) {
        return reply.code(503).send({
          error: { message: 'Service unavailable: all endpoints are in cooldown' },
        })
      }

      if (error instanceof Error && error.message.includes('serialize')) {
        return reply.code(400).send({
          error: { message: error.message },
        })
      }

      if (error instanceof AllEndpointsFailedError) {
        if (error.lastUpstreamResult) {
          pipeProxyResult(reply, error.lastUpstreamResult)
          return
        }

        const message = error.lastNetworkError?.message ?? error.message
        return reply.code(502).send({
          error: { message: `Upstream error: ${message}` },
        })
      }

      return reply.code(502).send({
        error: { message: `Upstream error: ${(error as Error).message}` },
      })
    }
  })

  app.get('/health', async () => {
    return { status: 'ok' }
  })

  return app
}
