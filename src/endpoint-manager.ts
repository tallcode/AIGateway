import type { EndpointConfig, ModelConfig, Protocol, UrlProtocol } from './types.js'

interface EndpointState {
  config: EndpointConfig
  cooldownUntil: Record<UrlProtocol, number>
}

const EMPTY_SET: ReadonlySet<EndpointConfig> = new Set()

export function urlKeyFor(protocol: Protocol, requireResponseApi: boolean): UrlProtocol {
  return requireResponseApi && protocol === 'openai' ? 'response' : protocol
}

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
      endpoints.map(config => ({ config, cooldownUntil: { openai: 0, anthropic: 0, response: 0 } })),
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

  getAvailableEndpoint(modelName: string, excludeEndpoints: ReadonlySet<EndpointConfig> = EMPTY_SET, requireResponseApi = false, protocol: Protocol = 'openai'): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const urlKey = urlKeyFor(protocol, requireResponseApi)
    const now = Date.now()
    const available = states.filter(s =>
      s.config.urls[urlKey] !== null
      && now >= s.cooldownUntil[urlKey]
      // Exclude by endpoint identity, not URL: endpoints may share a URL while
      // using different API keys and must stay independently selectable.
      && !excludeEndpoints.has(s.config),
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

  getRandomEndpoint(modelName: string, excludeEndpoints: ReadonlySet<EndpointConfig> = EMPTY_SET, requireResponseApi = false, protocol: Protocol = 'openai'): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const urlKey = urlKeyFor(protocol, requireResponseApi)
    const candidates = states.filter(s =>
      s.config.urls[urlKey] !== null
      && !excludeEndpoints.has(s.config),
    )
    if (candidates.length === 0)
      return null

    return candidates[Math.floor(Math.random() * candidates.length)].config
  }

  markCooldown(modelName: string, endpoint: EndpointConfig, cooldownSeconds: number, urlKey: UrlProtocol): void {
    const states = this.states.get(modelName)
    if (!states)
      return

    const now = Date.now()

    // Match by endpoint identity (not URL) so endpoints sharing a URL but using
    // different API keys keep independent cooldown state.
    for (const state of states) {
      if (state.config === endpoint) {
        state.cooldownUntil[urlKey] = now + cooldownSeconds * 1000
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

  hasProtocolSupport(modelName: string, urlKey: UrlProtocol): boolean {
    const states = this.states.get(modelName)
    if (!states)
      return false
    return states.some(s => s.config.urls[urlKey] !== null)
  }
}
