export interface EndpointConfig {
  url: string
  apiKey: string
  modelName: string
  cooldownSeconds: number
}

export interface ModelConfig {
  name: string
  endpoints: EndpointConfig[]
}

export interface GatewayConfig {
  port: number
  apiKey: string
  verbose: boolean
  models: Record<string, ModelConfig>
}
