import type { AdapterConfig, EndpointConfig, GatewayConfig, Protocol, ProviderConfig, ProviderUrlConfig, RequestRule } from './types.js'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const { default: Ajv } = require('ajv')
const { default: addFormats } = require('ajv-formats')

const defaultConfigPath = resolve(process.cwd(), 'config.json')

const urlSchema = {
  anyOf: [
    { type: 'string', pattern: '^https?://.+$' },
    {
      type: 'object',
      properties: {
        openai: { type: 'string', pattern: '^https?://.+$' },
        anthropic: { type: 'string', pattern: '^https?://.+$' },
      },
      additionalProperties: false,
      minProperties: 1,
    },
  ],
} as const

const configSchema = {
  type: 'object',
  required: ['port', 'apiKey', 'providers', 'models'],
  additionalProperties: false,
  properties: {
    port: { type: 'number', minimum: 1 },
    apiKey: { type: 'string', minLength: 1 },
    verbose: { type: 'boolean', default: false },
    adapters: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['protocol', 'requestRules'],
        additionalProperties: false,
        properties: {
          protocol: { enum: ['openai', 'anthropic'] },
          requestRules: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'action'],
              additionalProperties: false,
              properties: {
                field: { type: 'string', minLength: 1 },
                action: { enum: ['clamp', 'drop'] },
                value: { type: 'array', minItems: 2, maxItems: 2 },
                match: { type: 'object' },
              },
            },
          },
        },
      },
    },
    providers: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        required: ['url', 'apiKey'],
        additionalProperties: false,
        properties: {
          url: urlSchema,
          apiKey: { type: 'string', minLength: 0 },
          responseApi: { type: 'boolean' },
          cooldownSeconds: { type: 'number', minimum: 0 },
          adapters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              openai: { type: 'string', minLength: 1 },
              anthropic: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
    models: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        required: ['endpoints'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          contextLength: { type: 'number', minimum: 1 },
          features: { type: 'object' },
          architecture: { type: 'object' },
          endpoints: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['provider', 'priority'],
              additionalProperties: false,
              properties: {
                provider: { type: 'string', minLength: 1 },
                modelName: { type: 'string', minLength: 1 },
                cooldownSeconds: { type: 'number', minimum: 0 },
                priority: { type: 'number', minimum: 0 },
                adapters: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    openai: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
                    anthropic: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)
const validate = ajv.compile(configSchema)

interface RawEndpoint {
  provider: string
  modelName?: string
  cooldownSeconds?: number
  priority: number
  adapters?: Partial<Record<Protocol, string | null>>
}

interface RawModel {
  name?: string
  contextLength?: number
  features?: Record<string, unknown>
  architecture?: Record<string, unknown>
  endpoints: RawEndpoint[]
}

interface RawConfig {
  port: number
  apiKey: string
  verbose: boolean
  adapters?: Record<string, AdapterConfig>
  providers: Record<string, ProviderConfig>
  models: Record<string, RawModel>
}

const FIELD_PATH_SEGMENT = /^(?:[a-z_]\w*|\*)$/i

function validateRequestRule(adapterName: string, rule: RequestRule, index: number): void {
  const ruleName = `Adapter "${adapterName}" rule ${index + 1}`
  if (!rule.field.split('.').every(segment => FIELD_PATH_SEGMENT.test(segment)))
    throw new Error(`${ruleName} has invalid field path "${rule.field}"`)

  if (rule.action === 'clamp') {
    if (!Array.isArray(rule.value) || rule.value.length !== 2)
      throw new Error(`${ruleName} with action "clamp" requires value [min, max]`)
    const [min, max] = rule.value
    if ((min !== null && typeof min !== 'number') || (max !== null && typeof max !== 'number'))
      throw new Error(`${ruleName} clamp bounds must be numbers or null`)
    if (min === null && max === null)
      throw new Error(`${ruleName} clamp requires at least one bound`)
    if (min !== null && max !== null && min > max)
      throw new Error(`${ruleName} clamp minimum cannot exceed maximum`)
  }
}

function validateAdapters(adapters: Record<string, AdapterConfig>): void {
  for (const [name, adapter] of Object.entries(adapters)) {
    adapter.requestRules.forEach((rule, index) => validateRequestRule(name, rule, index))
  }
}

function resolveProtocolUrls(url: string | ProviderUrlConfig): { [K in Protocol]: string | null } {
  if (typeof url === 'string') {
    return { openai: url, anthropic: url }
  }
  return {
    openai: url.openai ?? null,
    anthropic: url.anthropic ?? null,
  }
}

function resolveEndpoints(
  providers: Record<string, ProviderConfig>,
  models: Record<string, RawModel>,
  adapters: Record<string, AdapterConfig>,
): Record<string, { endpoints: EndpointConfig[] }> {
  const resolved: Record<string, { endpoints: EndpointConfig[] }> = {}

  for (const [modelKey, model] of Object.entries(models)) {
    resolved[modelKey] = {
      endpoints: model.endpoints.map((ep) => {
        const provider = providers[ep.provider]
        if (!provider) {
          throw new Error(`Model "${modelKey}" endpoint references unknown provider "${ep.provider}"`)
        }
        const endpointAdapters: EndpointConfig['adapters'] = {}
        for (const protocol of ['openai', 'anthropic'] as const) {
          const hasEndpointOverride = ep.adapters !== undefined && Object.hasOwn(ep.adapters, protocol)
          const adapterName = hasEndpointOverride ? ep.adapters![protocol] : provider.adapters?.[protocol]
          if (!adapterName)
            continue
          const adapter = adapters[adapterName]
          if (!adapter)
            throw new Error(`Provider "${ep.provider}" references unknown ${protocol} adapter "${adapterName}"`)
          if (adapter.protocol !== protocol)
            throw new Error(`Provider "${ep.provider}" references ${protocol} adapter "${adapterName}" declared for ${adapter.protocol}`)
          endpointAdapters[protocol] = adapter
        }
        return {
          urls: resolveProtocolUrls(provider.url),
          apiKey: provider.apiKey,
          modelName: ep.modelName ?? modelKey,
          cooldownSeconds: ep.cooldownSeconds ?? provider.cooldownSeconds ?? 900,
          priority: ep.priority,
          tag: ep.provider,
          responseApi: provider.responseApi,
          adapters: endpointAdapters,
        }
      }),
    }
  }

  return resolved
}

export function loadConfig(configPath?: string): GatewayConfig {
  const path = configPath ?? defaultConfigPath

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`)
  }

  const raw = readFileSync(path, 'utf-8')
  const config: unknown = JSON.parse(raw)

  if (!validate(config)) {
    const errors = validate.errors!.map((e: { instancePath: string, message: string | null }) => {
      const path = e.instancePath || '/'
      return `${path} ${e.message}`
    }).join('; ')
    throw new Error(`Invalid config: ${errors}`)
  }

  const rawConfig = config as RawConfig
  const adapters = rawConfig.adapters ?? {}
  validateAdapters(adapters)
  const resolved = resolveEndpoints(rawConfig.providers, rawConfig.models, adapters)

  const models: GatewayConfig['models'] = {}
  for (const [modelKey, rawModel] of Object.entries(rawConfig.models)) {
    models[modelKey] = {
      name: rawModel.name,
      contextLength: rawModel.contextLength,
      features: rawModel.features,
      architecture: rawModel.architecture,
      endpoints: resolved[modelKey].endpoints,
    }
  }

  return {
    port: rawConfig.port,
    apiKey: rawConfig.apiKey,
    verbose: rawConfig.verbose,
    adapters,
    providers: rawConfig.providers,
    models,
  }
}
