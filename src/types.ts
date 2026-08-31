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
  /**
   * Mutates the cloned payload and reports whether anything changed.
   * `model` is the model's config (`models.<key>`), with `endpoints` trimmed
   * down to only the endpoint currently being targeted.
   */
  apply: (payload: Record<string, unknown>, model: ModelConfig) => boolean
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

/**
 * Per-model reasoning capabilities, mirroring OpenRouter's `reasoning` block
 * verbatim (snake_case so values can be copied straight from OpenRouter's
 * model list). Drives the Anthropic thinking rectifier and is exposed to
 * downstream clients via /v1/models.
 */
export interface ReasoningConfig {
  mandatory?: boolean
  default_enabled?: boolean
  supports_max_tokens?: boolean
  supported_efforts?: string[]
  default_effort?: string
}

export interface ModelConfig {
  name?: string
  contextLength?: number
  features?: Record<string, unknown>
  /**
   * Model architecture metadata. May carry OpenRouter-style structured fields
   * (`modality`, `input_modalities`, `output_modalities`) or just a plain
   * `modality` string.
   */
  architecture?: Record<string, unknown>
  /**
   * Output-token cap for this model. When set, the gateway clamps the
   * request's output limit (max_tokens / max_completion_tokens /
   * max_output_tokens) to this value, and fills it in for Anthropic requests
   * where the field is protocol-required.
   */
  maxOutputTokens?: number
  /** Per-model reasoning capabilities (see ReasoningConfig). */
  reasoning?: ReasoningConfig
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
