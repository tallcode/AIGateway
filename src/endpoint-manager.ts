import type { EndpointConfig, ModelConfig } from './types.js'

interface EndpointState {
  config: EndpointConfig
  cooldownUntil: number
}

const EMPTY_SET: ReadonlySet<string> = new Set()

export class EndpointManager {
  private states: Map<string, EndpointState[]>
  private modelConfigs: Map<string, ModelConfig>

  constructor() {
    this.states = new Map()
    this.modelConfigs = new Map()
  }

  registerModel(modelKey: string, endpoints: EndpointConfig[], modelConfig: ModelConfig): void {
    this.states.set(
      modelKey,
      endpoints.map(config => ({ config, cooldownUntil: 0 })),
    )
    this.modelConfigs.set(modelKey, modelConfig)
  }

  getModelConfig(modelKey: string): ModelConfig | undefined {
    return this.modelConfigs.get(modelKey)
  }

  getModelKeys(): string[] {
    return [...this.states.keys()]
  }

  getAvailableEndpoint(modelName: string, excludeUrls: ReadonlySet<string> = EMPTY_SET): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const now = Date.now()
    const available = states.filter(s => now >= s.cooldownUntil && !excludeUrls.has(s.config.url))
    if (available.length === 0)
      return null

    let minPriority = Infinity
    for (const s of available) {
      if (s.config.priority < minPriority) {
        minPriority = s.config.priority
      }
    }

    const candidates = available.filter(s => s.config.priority === minPriority)
    return candidates[Math.floor(Math.random() * candidates.length)].config
  }

  getRandomEndpoint(modelName: string, excludeUrls: ReadonlySet<string> = EMPTY_SET): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const candidates = states.filter(s => !excludeUrls.has(s.config.url))
    if (candidates.length === 0)
      return null

    return candidates[Math.floor(Math.random() * candidates.length)].config
  }

  markCooldown(modelName: string, endpointUrl: string, cooldownSeconds: number): void {
    const states = this.states.get(modelName)
    if (!states)
      return

    const now = Date.now()

    for (const state of states) {
      if (state.config.url === endpointUrl) {
        state.cooldownUntil = now + cooldownSeconds * 1000
        break
      }
    }
  }

  getAllEndpoints(modelName: string): EndpointConfig[] {
    const states = this.states.get(modelName)
    if (!states)
      return []
    return states.map(s => s.config)
  }
}
