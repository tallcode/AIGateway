import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { request } from 'undici'

interface GatewayConfig {
  port: number
  apiKey: string
  models: Record<string, { endpoints: unknown[] }>
}

async function main() {
  const configPath = resolve(process.cwd(), process.argv[2] ?? 'config.json')
  const config: GatewayConfig = JSON.parse(readFileSync(configPath, 'utf-8'))

  const baseUrl = `http://127.0.0.1:${config.port}`
  const models = Object.keys(config.models)

  console.log(`Testing gateway at ${baseUrl}`)
  console.log(`Models to test: ${models.join(', ')}\n`)

  let passed = 0
  let failed = 0

  for (const modelName of models) {
    try {
      const response = await request(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'hello' }],
          max_completion_tokens: 100,
        }),
      })

      const raw = await response.body.text()
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      }
      catch {
        // not JSON
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        console.log(`✅ ${modelName} - OK (${response.statusCode})`)
        passed++
      }
      else {
        console.log(`❌ ${modelName} - Failed (${response.statusCode})`)
        console.log(`   Response: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
        failed++
      }
    }
    catch (error) {
      console.log(`❌ ${modelName} - Error: ${(error as Error).message}`)
      failed++
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
