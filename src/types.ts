export type Protocol = 'openai' | 'anthropic'

export type RequestRuleAction = 'clamp' | 'drop'

export interface RequestRule {
  field: string
  action: RequestRuleAction
  value?: [number | null, number | null]
  match?: Record<string, unknown>
}

export interface AdapterConfig {
  protocol: Protocol
  requestRules: RequestRule[]
}

export interface ProviderUrlConfig {
  openai?: string
  anthropic?: string
}

export interface ProviderConfig {
  url: string | ProviderUrlConfig
  apiKey: string
  responseApi?: boolean
  cooldownSeconds?: number
  adapters?: Partial<Record<Protocol, string>>
}

export interface EndpointConfig {
  urls: { [K in Protocol]: string | null }
  apiKey: string
  modelName: string
  cooldownSeconds: number
  priority: number
  tag: string
  responseApi?: boolean
  adapters: Partial<Record<Protocol, AdapterConfig>>
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
  apiKey: string
  verbose: boolean
  adapters: Record<string, AdapterConfig>
  providers: Record<string, ProviderConfig>
  models: Record<string, ModelConfig>
}
