export type Protocol = 'openai' | 'anthropic'

export type UrlProtocol = Protocol | 'response'

/**
 * Code-defined request adapter (see src/adapters/). Referenced by name from
 * provider/endpoint config; `apply` mutates the cloned payload and reports
 * whether anything changed.
 */
export interface Adapter {
  readonly name: string
  readonly protocol: Protocol
  apply: (payload: Record<string, unknown>) => boolean
}

export interface RectifiersConfig {
  anthropicThinking: {
    enabled: boolean
  }
}

export interface ProviderUrlConfig {
  openai?: string
  anthropic?: string
  response?: string
}

export interface ProviderConfig {
  url: ProviderUrlConfig
  apiKey: string
  cooldownSeconds?: number
  adapters?: Partial<Record<Protocol, string>>
}

export interface EndpointConfig {
  urls: { [K in UrlProtocol]: string | null }
  apiKey: string
  modelName: string
  cooldownSeconds: number
  priority: number
  tag: string
  adapters: Partial<Record<Protocol, Adapter>>
}

export interface ModelConfig {
  name?: string
  contextLength?: number
  features?: Record<string, unknown>
  architecture?: Record<string, unknown>
  endpoints: EndpointConfig[]
}

export interface GatewayConfig {
  port: number
  /**
   * Downstream auth keys, normalized at load time to `upstream key -> caller id`.
   * Config accepts `{ callerId: key }` entries; see normalizeApiKeys in config.ts.
   */
  apiKeys: Record<string, string>
  verbose: boolean
  rectifiers: RectifiersConfig
  providers: Record<string, ProviderConfig>
  models: Record<string, ModelConfig>
}
