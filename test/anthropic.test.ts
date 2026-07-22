import type { EndpointConfig } from '../src/types.js'
import assert from 'node:assert/strict'
// The project does not depend on Vitest; use Node's built-in test runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { EndpointManager } from '../src/endpoint-manager.js'
import { prepareRequestPayload, resolveUpstreamPath } from '../src/proxy.js'
import { detectProtocol } from '../src/server.js'

const endpoint: EndpointConfig = {
  urls: { openai: 'https://openai.example/v1', anthropic: 'https://anthropic.example/apps/anthropic/v1' },
  apiKey: 'test',
  modelName: 'upstream-model',
  cooldownSeconds: 60,
  priority: 1,
  tag: 'test',
  adapters: {
    anthropic: {
      protocol: 'anthropic',
      requestRules: [{ field: 'thinking.budget_tokens', action: 'clamp', value: [1, null] }],
    },
  },
}

test('uses the Anthropic message route even without Anthropic headers', () => {
  assert.equal(detectProtocol({ url: '/v1/messages', headers: {} }), 'anthropic')
  assert.equal(detectProtocol({ url: '/v1/chat/completions', headers: {} }), 'openai')
})

test('uses the endpoint URL as the full upstream base path', () => {
  assert.equal(resolveUpstreamPath('/messages'), '/messages')
})

test('applies reusable adapter rules without mutating the downstream request', () => {
  const request = { model: 'gateway-model', thinking: { type: 'enabled', budget_tokens: -1 } }
  const result = prepareRequestPayload(request, endpoint, 'anthropic')
  assert.deepEqual(result.payload, { model: 'upstream-model', thinking: { type: 'enabled', budget_tokens: 1 } })
  assert.deepEqual(result.appliedRules, ['anthropic:clamp:thinking.budget_tokens'])
  assert.equal(request.thinking.budget_tokens, -1)
})

test('drops matching content blocks and rejects an empty message', () => {
  const imageAdapter: EndpointConfig = {
    ...endpoint,
    adapters: {
      anthropic: {
        protocol: 'anthropic',
        requestRules: [{ field: 'messages.*.content.*', action: 'drop', match: { type: 'image' } }],
      },
    },
  }
  const result = prepareRequestPayload({ model: 'gateway-model', messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'hello' }] }] }, imageAdapter, 'anthropic')
  assert.deepEqual(result.payload, { model: 'upstream-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  assert.throws(() => prepareRequestPayload({ model: 'gateway-model', messages: [{ role: 'user', content: [{ type: 'image' }] }] }, imageAdapter, 'anthropic'), /removed all content/)
})

test('keeps OpenAI and Anthropic cooldowns independent', () => {
  const manager = new EndpointManager()
  manager.registerModel('model', [endpoint], { endpoints: [endpoint] })
  manager.markCooldown('model', endpoint.urls.anthropic!, 60, 'anthropic')
  assert.equal(manager.getAvailableEndpoint('model', new Set(), false, 'anthropic'), null)
  assert.equal(manager.getAvailableEndpoint('model', new Set(), false, 'openai'), endpoint)
})
