import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { EndpointManager } from './endpoint-manager.js'
import type { ProxyHandler } from './proxy.js'
import type { GatewayConfig } from './types.js'
import Fastify from 'fastify'

export function createServer(
  config: GatewayConfig,
  endpointManager: EndpointManager,
  proxyHandler: ProxyHandler,
): FastifyInstance {
  const app = Fastify({
    logger: false,
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
      console.log(`[${new Date().toISOString()}] >>> Downstream Request`)
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

      reply.raw.writeHead(result.status, result.headers)
      result.body.pipe(reply.raw, { end: true })
      result.body.on('error', () => {
        if (!reply.raw.writableEnded) {
          reply.raw.end()
        }
      })
    }
    catch (error) {
      const message = (error as Error).message

      if (message.includes('All endpoints')) {
        return reply.code(503).send({
          error: { message: 'Service unavailable: all endpoints are in cooldown' },
        })
      }

      return reply.code(502).send({
        error: { message: `Upstream error: ${message}` },
      })
    }
  })

  app.get('/health', async () => {
    return { status: 'ok' }
  })

  return app
}
