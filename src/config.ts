import type { EndpointConfig, GatewayConfig, Protocol, ProviderConfig, ProviderUrlConfig, RectifiersConfig, UrlProtocol } from './types.js'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'
import { adapters as builtinAdapters } from './adapters/index.js'
import { rectifiers as rectifierRegistry } from './rectifiers/index.js'

const require = createRequire(import.meta.url)
const { default: Ajv } = require('ajv')
const { default: addFormats } = require('ajv-formats')

const defaultConfigPath = resolve(process.cwd(), 'config.json')

const urlSchema = {
  type: 'object',
  properties: {
    openai: { type: 'string', pattern: '^https?://.+$' },
    anthropic: { type: 'string', pattern: '^https?://.+$' },
    response: { type: 'string', pattern: '^https?://.+$' },
  },
  additionalProperties: false,
  minProperties: 1,
} as const

const configSchema = {
  type: 'object',
  required: ['port', 'apiKeys', 'providers', 'models'],
  additionalProperties: false,
  properties: {
    port: { type: 'number', minimum: 1 },
    apiKeys: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 1 },
    },
    verbose: { type: 'boolean', default: false },
    rectifiers: {
      type: 'object',
      required: ['anthropicThinking'],
      additionalProperties: false,
      properties: {
        anthropicThinking: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
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
  apiKeys: Record<string, string>
  verbose: boolean
  rectifiers?: RectifiersConfig
  providers: Record<string, ProviderConfig>
  models: Record<string, RawModel>
}

/**
 * Normalize the `apiKeys` config (`caller id -> key`) into `key -> caller id`
 * so auth lookups and log attribution work off the key directly.
 */
export function normalizeApiKeys(raw: Record<string, string>): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const [id, key] of Object.entries(raw)) {
    if (Object.hasOwn(keys, key))
      throw new Error(`Duplicate apiKey value configured for ids "${keys[key]}" and "${id}"`)
    keys[key] = id
  }
  return keys
}

function validateRectifierNames(rectifiers: RectifiersConfig | undefined): void {
  for (const name of Object.keys(rectifiers ?? {})) {
    if (!Object.hasOwn(rectifierRegistry, name)) {
      throw new Error(`Unknown rectifier "${name}" (available: ${Object.keys(rectifierRegistry).join(', ')})`)
    }
  }
}

function resolveProtocolUrls(url: ProviderUrlConfig): { [K in UrlProtocol]: string | null } {
  return {
    openai: url.openai ?? null,
    anthropic: url.anthropic ?? null,
    response: url.response ?? null,
  }
}

function resolveEndpoints(
  providers: Record<string, ProviderConfig>,
  models: Record<string, RawModel>,
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
          const adapter = builtinAdapters[adapterName]
          if (!adapter) {
            throw new Error(
              `Provider "${ep.provider}" references unknown ${protocol} adapter "${adapterName}"`
              + ` (available: ${Object.keys(builtinAdapters).join(', ')})`,
            )
          }
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
  validateRectifierNames(rawConfig.rectifiers)
  const resolved = resolveEndpoints(rawConfig.providers, rawConfig.models)

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
    apiKeys: normalizeApiKeys(rawConfig.apiKeys),
    verbose: rawConfig.verbose,
    rectifiers: rawConfig.rectifiers ?? {
      anthropicThinking: { enabled: false },
    },
    providers: rawConfig.providers,
    models,
  }
}
