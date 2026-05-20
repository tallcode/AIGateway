import type { EndpointConfig } from './types.js'

interface EndpointState {
  config: EndpointConfig
  cooldownUntil: number
}

export class EndpointManager {
  private states: Map<string, EndpointState[]>
  private names: Map<string, string>

  constructor() {
    this.states = new Map()
    this.names = new Map()
  }

  registerModel(modelKey: string, displayName: string, endpoints: EndpointConfig[]): void {
    this.states.set(
      modelKey,
      endpoints.map(config => ({ config, cooldownUntil: 0 })),
    )
    this.names.set(modelKey, displayName)
  }

  getAvailableEndpoint(modelName: string): EndpointConfig | null {
    const states = this.states.get(modelName)
    if (!states)
      return null

    const now = Date.now()

    for (const state of states) {
      if (now >= state.cooldownUntil) {
        return state.config
      }
    }

    return null
  }

  markCooldown(modelName: string, endpointUrl: string): void {
    const states = this.states.get(modelName)
    if (!states)
      return

    const now = Date.now()

    for (const state of states) {
      if (state.config.url === endpointUrl) {
        state.cooldownUntil = now + state.config.cooldownSeconds * 1000
        console.log(
          `[${new Date().toISOString()}] Endpoint cooldown: ${endpointUrl} for ${state.config.cooldownSeconds}s`,
        )
        break
      }
    }
  }

  getModelKeys(): string[] {
    return [...this.states.keys()]
  }

  getModelDisplayName(modelKey: string): string | undefined {
    return this.names.get(modelKey)
  }

  getAllEndpoints(modelName: string): EndpointConfig[] {
    const states = this.states.get(modelName)
    if (!states)
      return []
    return states.map(s => s.config)
  }

  
}
