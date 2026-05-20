import type { ModelConfig } from './types.js'
import process from 'node:process'
import { loadConfig } from './config.js'
import { EndpointManager } from './endpoint-manager.js'
import { ProxyHandler } from './proxy.js'
import { createServer } from './server.js'

const configPath = process.argv[2]
const config = loadConfig(configPath)

const endpointManager = new EndpointManager()

for (const [modelName, modelConfig] of Object.entries(config.models) as [string, ModelConfig][]) {
  endpointManager.registerModel(modelName, modelConfig.name, modelConfig.endpoints)
}

const proxyHandler = new ProxyHandler(endpointManager, config.verbose)
const app = createServer(config, endpointManager, proxyHandler)

app.listen({ port: config.port, host: '0.0.0.0' }, (err: Error | null) => {
  if (err) {
    console.error(`Failed to start server: ${err.message}`)
    process.exit(1)
  }
  console.log(`AI Gateway running on port ${config.port}`)
  console.log(`Loaded models: ${Object.keys(config.models).join(', ')}`)
})
