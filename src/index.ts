import type { ModelConfig } from './types.js'
import process from 'node:process'
import { adapters } from './adapters/index.js'
import { loadConfig } from './config.js'
import { EndpointManager } from './endpoint-manager.js'
import { AiProxyHandler } from './proxy.js'
import { rectifiers } from './rectifiers/index.js'
import { createServer } from './server.js'

// Log and exit on fatal errors: staying alive with a possibly corrupted state is
// worse than restarting. PM2 (autorestart: true) brings the process back up.
process.on('uncaughtException', (err: Error & { code?: string }) => {
  console.error(`[FATAL] uncaughtException: ${err.name}: ${err.message}${err.code ? ` [${err.code}]` : ''}`)
  if (err.stack)
    console.error(err.stack)
  process.exit(1)
})

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`[FATAL] unhandledRejection:`, reason)
  process.exit(1)
})

const args = process.argv.slice(2)
const verboseFlag = args.includes('-v') || args.includes('--verbose')
const configPath = args.find(a => !a.startsWith('-'))
const config = loadConfig(configPath)
if (verboseFlag)
  config.verbose = true

const endpointManager = new EndpointManager()

for (const [modelName, modelConfig] of Object.entries(config.models) as [string, ModelConfig][]) {
  endpointManager.registerModel(modelName, modelConfig.endpoints, modelConfig)
}

const proxyHandler = new AiProxyHandler(endpointManager, config.verbose, config.rectifiers)
const app = createServer(config, endpointManager, proxyHandler)

app.listen({ port: config.port, host: '0.0.0.0' }, (err: Error | null) => {
  if (err) {
    console.error(`Failed to start server: ${err.message}`)
    process.exit(1)
  }
  console.log(`AI Gateway running on port ${config.port}`)
  console.log(`Registered adapters: ${Object.keys(adapters).join(', ')}`)
  console.log(`Registered rectifiers: ${Object.keys(rectifiers).join(', ')}`)
  console.log(`Loaded models: ${Object.keys(config.models).join(', ')}`)
})

function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`)
  app.close().then(() => {
    console.log('Server closed')
    process.exit(0)
  }).catch((err) => {
    console.error(`Error during shutdown: ${(err as Error).message}`)
    process.exit(1)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
