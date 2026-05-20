import type { GatewayConfig } from './types.js'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const Ajv = require('ajv').default
const addFormats = require('ajv-formats').default

const defaultConfigPath = resolve(process.cwd(), 'config.json')

const configSchema = {
  type: 'object',
  required: ['port', 'apiKey', 'models'],
  additionalProperties: false,
  properties: {
    port: { type: 'number', minimum: 1 },
    apiKey: { type: 'string', minLength: 1 },
    verbose: { type: 'boolean', default: false },
    models: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        required: ['name', 'endpoints'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          endpoints: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['url', 'apiKey', 'modelName', 'cooldownSeconds'],
              additionalProperties: false,
              properties: {
                url: { type: 'string', pattern: '^https?://.+$' },
                apiKey: { type: 'string', minLength: 1 },
                modelName: { type: 'string', minLength: 1 },
                cooldownSeconds: { type: 'number', minimum: 1 },
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

  return config as GatewayConfig
}
