export interface EndpointConfig {
  url: string
  apiKey: string
  modelName: string
  cooldownSeconds: number
  priority: number
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
  models: Record<string, ModelConfig>
}
