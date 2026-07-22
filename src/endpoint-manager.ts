import type { EndpointConfig, ModelConfig, Protocol } from './types.js'

interface EndpointState {
  config: EndpointConfig
  cooldownUntil: Record<Protocol, number>
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
      endpoints.map(config => ({ config, cooldownUntil: { openai: 0, anthropic: 0 } })),
    )
    this.modelConfigs.set(modelKey, modelConfig)
  }

  getModelConfig(modelKey: string): ModelConfig | undefined {
    return this.modelConfigs.get(modelKey)
  }

  getModelKeys(): string[] {
    return [...this.states.keys()]
  }

  endpointSupportsProtocol(config: EndpointConfig, protocol: Protocol): boolean {
    return config.urls[protocol] !== null
  }

  getResolvedUrl(config: EndpointConfig, protocol: Protocol): string | null {
    return config.urls[protocol]
  }

  getAvailableEndpoint(modelName: string, excludeUrls: ReadonlySet<string> = EMPTY_SET, requireResponseApi = false, protocol: Protocol = 'openai'): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const now = Date.now()
    const available = states.filter(s =>
      s.config.urls[protocol] !== null
      && now >= s.cooldownUntil[protocol]
      && !excludeUrls.has(s.config.urls[protocol]!)
      && (!requireResponseApi || s.config.responseApi !== false),
    )
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

  getRandomEndpoint(modelName: string, excludeUrls: ReadonlySet<string> = EMPTY_SET, requireResponseApi = false, protocol: Protocol = 'openai'): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const candidates = states.filter(s =>
      s.config.urls[protocol] !== null
      && !excludeUrls.has(s.config.urls[protocol]!)
      && (!requireResponseApi || s.config.responseApi !== false),
    )
    if (candidates.length === 0)
      return null

    return candidates[Math.floor(Math.random() * candidates.length)].config
  }

  markCooldown(modelName: string, resolvedUrl: string, cooldownSeconds: number, protocol: Protocol): void {
    const states = this.states.get(modelName)
    if (!states)
      return

    const now = Date.now()

    for (const state of states) {
      if (state.config.urls[protocol] === resolvedUrl) {
        state.cooldownUntil[protocol] = now + cooldownSeconds * 1000
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

  hasProtocolSupport(modelName: string, protocol: Protocol): boolean {
    const states = this.states.get(modelName)
    if (!states)
      return false
    return states.some(s => s.config.urls[protocol] !== null)
  }
}
