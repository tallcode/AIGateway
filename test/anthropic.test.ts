import type { Adapter, EndpointConfig } from '../src/types.js'
import assert from 'node:assert/strict'
// The project does not depend on Vitest; use Node's built-in test runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { clampBudgetTokens, dropContentBlockTypes } from '../src/adapters/shared.js'
import { EndpointManager } from '../src/endpoint-manager.js'
import { prepareRequestPayload, resolveUpstreamPath } from '../src/proxy.js'
import { rectifyAnthropicThinking } from '../src/rectifiers/index.js'
import { detectProtocol, extractAnthropicHeaders } from '../src/server.js'

const clampAdapter: Adapter = {
  name: 'test-clamp-budget',
  protocol: 'anthropic',
  apply: payload => clampBudgetTokens(payload, 1, Number.POSITIVE_INFINITY),
}

const dropImageAdapter: Adapter = {
  name: 'test-drop-images',
  protocol: 'anthropic',
  apply: payload => dropContentBlockTypes(payload, new Set(['image'])),
}

const endpoint: EndpointConfig = {
  urls: { openai: 'https://openai.example/v1', anthropic: 'https://anthropic.example/apps/anthropic/v1', response: null },
  apiKey: 'test',
  modelName: 'upstream-model',
  cooldownSeconds: 60,
  priority: 1,
  tag: 'test',
  adapters: { anthropic: clampAdapter },
}

test('uses the Anthropic message route even without Anthropic headers', () => {
  assert.equal(detectProtocol({ url: '/v1/messages', headers: {} }), 'anthropic')
  assert.equal(detectProtocol({ url: '/v1/messages/count_tokens', headers: {} }), 'anthropic')
  assert.equal(detectProtocol({ url: '/v1/chat/completions', headers: {} }), 'openai')
  assert.equal(detectProtocol({ url: '/v1/responses', headers: {} }), 'openai')
  // OpenAI paths stay OpenAI even when the client sends Anthropic-style headers.
  assert.equal(detectProtocol({ url: '/v1/chat/completions', headers: { 'x-api-key': 'sk-test' } }), 'openai')
})

test('fills in the required anthropic-version header when the client omits it', () => {
  const missing = extractAnthropicHeaders({ headers: {} })
  assert.equal(missing.anthropicVersion, '2023-06-01')
  assert.equal(missing.anthropicBeta, undefined)

  const provided = extractAnthropicHeaders({ headers: { 'anthropic-version': '2023-01-01', 'anthropic-beta': 'prompt-caching-2024-07-31' } })
  assert.equal(provided.anthropicVersion, '2023-01-01')
  assert.equal(provided.anthropicBeta, 'prompt-caching-2024-07-31')
})

test('uses the endpoint URL as the full upstream base path', () => {
  assert.equal(resolveUpstreamPath('/messages'), '/messages')
})

test('applies code adapters without mutating the downstream request', () => {
  const request = { model: 'gateway-model', thinking: { type: 'enabled', budget_tokens: -1 } }
  const result = prepareRequestPayload(request, endpoint, 'anthropic')
  assert.deepEqual(result.payload, { model: 'upstream-model', thinking: { type: 'enabled', budget_tokens: 1 } })
  assert.deepEqual(result.appliedRules, ['adapter:test-clamp-budget'])
  assert.equal(request.thinking.budget_tokens, -1)
})

test('drops matching content blocks and rejects an empty message', () => {
  const imageAdapter: EndpointConfig = {
    ...endpoint,
    adapters: { anthropic: dropImageAdapter },
  }
  const result = prepareRequestPayload({ model: 'gateway-model', messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'hello' }] }] }, imageAdapter, 'anthropic')
  assert.deepEqual(result.payload, { model: 'upstream-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  assert.throws(() => prepareRequestPayload({ model: 'gateway-model', messages: [{ role: 'user', content: [{ type: 'image' }] }] }, imageAdapter, 'anthropic'), /removed all content/)
})

test('keeps OpenAI and Anthropic cooldowns independent', () => {
  const manager = new EndpointManager()
  manager.registerModel('model', [endpoint], { endpoints: [endpoint] })
  manager.markCooldown('model', endpoint, 60, 'anthropic')
  assert.equal(manager.getAvailableEndpoint('model', new Set(), false, 'anthropic'), null)
  assert.equal(manager.getAvailableEndpoint('model', new Set(), false, 'openai'), endpoint)
})

test('keeps endpoints that share a URL but use different keys independent', () => {
  const sameUrlDifferentKey: EndpointConfig = {
    ...endpoint,
    apiKey: 'other-key',
  }
  const manager = new EndpointManager()
  manager.registerModel('model', [endpoint, sameUrlDifferentKey], { endpoints: [endpoint, sameUrlDifferentKey] })

  // Excluding one endpoint must not exclude the other just because URLs match.
  assert.equal(manager.getAvailableEndpoint('model', new Set([endpoint]), false, 'anthropic'), sameUrlDifferentKey)

  // Cooling down one endpoint must not cool down the other.
  manager.markCooldown('model', endpoint, 60, 'anthropic')
  assert.equal(manager.getAvailableEndpoint('model', new Set(), false, 'anthropic'), sameUrlDifferentKey)
})

test('routes Responses API requests to endpoints with a declared response URL', () => {
  const responseOnly: EndpointConfig = {
    ...endpoint,
    urls: { openai: null, anthropic: null, response: 'https://response.example/v1' },
  }
  const manager = new EndpointManager()
  manager.registerModel('model', [responseOnly], { endpoints: [responseOnly] })
  assert.equal(manager.getAvailableEndpoint('model', new Set(), true, 'openai'), responseOnly)
  assert.equal(manager.getAvailableEndpoint('model', new Set(), false, 'openai'), null)
  assert.equal(manager.hasProtocolSupport('model', 'response'), true)
  assert.equal(manager.hasProtocolSupport('model', 'openai'), false)
})

test('can disable the Anthropic thinking rectifier', () => {
  const disabledPayload = { thinking: { type: 'adaptive' } }
  const disabledResult = rectifyAnthropicThinking(disabledPayload, { enabled: false })
  assert.equal(disabledResult.changed, false)
  assert.deepEqual(disabledPayload.thinking, { type: 'adaptive' })

  const result = prepareRequestPayload(
    { model: 'gateway-model', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'valid' }, { type: 'text', text: 'answer' }] }] },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: true } },
  )
  assert.deepEqual(result.payload, {
    model: 'upstream-model',
    reasoning_effort: 'low',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'valid' }, { type: 'text', text: 'answer' }] }],
  })
  assert.deepEqual(result.appliedRules, ['rectifier:anthropic-thinking'])
})

test('does not run the Anthropic rectifier for OpenAI requests', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'leave unchanged' }] }] },
    endpoint,
    'openai',
    { anthropicThinking: { enabled: true } },
  )
  assert.deepEqual(result.payload, {
    model: 'upstream-model',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'leave unchanged' }] }],
  })
  assert.deepEqual(result.appliedRules, [])
})

test('rewrites disabled thinking to enabled for always-thinking upstreams', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', thinking: { type: 'disabled' } },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: true } },
  )
  assert.deepEqual(result.payload, {
    model: 'upstream-model',
    reasoning_effort: 'low',
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })
  assert.deepEqual(result.appliedRules, ['rectifier:anthropic-thinking'])
})

test('normalizes adaptive thinking options from Claude requests', () => {
  const cases = [
    { input: 'low', expectedEffort: 'low', expectedBudget: 1024 },
    { input: 'medium', expectedEffort: 'medium', expectedBudget: 4096 },
    { input: 'high', expectedEffort: 'xhigh', expectedBudget: 16000 },
  ] as const

  for (const testCase of cases) {
    const result = prepareRequestPayload(
      {
        model: 'gateway-model',
        output_config: { effort: testCase.input },
        thinking: { type: 'adaptive' },
      },
      endpoint,
      'anthropic',
      { anthropicThinking: { enabled: true } },
    )
    assert.deepEqual(result.payload, {
      model: 'upstream-model',
      reasoning_effort: testCase.expectedEffort,
      thinking: { type: 'enabled', budget_tokens: testCase.expectedBudget },
    })
    assert.deepEqual(result.appliedRules, ['rectifier:anthropic-thinking'])
  }
})

test('drops Claude output_config after consuming its effort', () => {
  const result = prepareRequestPayload(
    {
      model: 'gateway-model',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      thinking: { type: 'enabled', budget_tokens: 4096 },
    },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: true } },
  )
  assert.equal(result.payload.output_config, undefined)
  assert.equal(result.payload.reasoning_effort, 'medium')
  assert.deepEqual(result.payload.thinking, { type: 'enabled', budget_tokens: 4096 })
  assert.deepEqual(result.appliedRules, ['rectifier:anthropic-thinking'])
})

test('keeps output_config when the thinking rectifier is disabled', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', output_config: { effort: 'medium' } },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: false } },
  )
  assert.equal(result.payload.output_config.effort, 'medium')
  assert.deepEqual(result.appliedRules, [])
})

test('preserves explicit thinking budgets and supports existing reasoning_effort', () => {
  const explicitBudget = prepareRequestPayload(
    {
      model: 'gateway-model',
      output_config: { effort: 'medium' },
      reasoning_effort: 'low',
      thinking: { type: 'enabled', budget_tokens: 7777 },
    },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: true } },
  )
  assert.deepEqual(explicitBudget.payload, {
    model: 'upstream-model',
    reasoning_effort: 'low',
    thinking: { type: 'enabled', budget_tokens: 7777 },
  })

  const existingEffort = prepareRequestPayload(
    { model: 'gateway-model', reasoning_effort: 'xhigh', thinking: { type: 'enabled' } },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: true } },
  )
  assert.deepEqual(existingEffort.payload, {
    model: 'upstream-model',
    reasoning_effort: 'xhigh',
    thinking: { type: 'enabled', budget_tokens: 16000 },
  })

  const defaultEffort = prepareRequestPayload(
    { model: 'gateway-model', thinking: { type: 'enabled' } },
    endpoint,
    'anthropic',
    { anthropicThinking: { enabled: true } },
  )
  assert.deepEqual(defaultEffort.payload, {
    model: 'upstream-model',
    reasoning_effort: 'low',
    thinking: { type: 'enabled', budget_tokens: 1024 },
  })
})

const cappedModel = { maxOutputTokens: 16000, endpoints: [endpoint] }

test('clamps Anthropic max_tokens to the model maxOutputTokens cap', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', max_tokens: 64000, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    endpoint,
    'anthropic',
    undefined,
    cappedModel,
  )
  assert.equal(result.payload.max_tokens, 16000)
  assert.deepEqual(result.appliedRules, ['model:max-output-tokens'])
})

test('fills Anthropic max_tokens with the cap when the client sends none', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    endpoint,
    'anthropic',
    undefined,
    cappedModel,
  )
  assert.equal(result.payload.max_tokens, 16000)
  assert.deepEqual(result.appliedRules, ['model:max-output-tokens'])
})

test('never leaves Anthropic max_tokens at or below the thinking budget', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 1024 } },
    endpoint,
    'anthropic',
    undefined,
    cappedModel,
  )
  assert.equal(result.payload.max_tokens, 1025)
})

test('clamps OpenAI output-limit fields without adding one when absent', () => {
  const clamped = prepareRequestPayload(
    { model: 'gateway-model', max_completion_tokens: 64000 },
    endpoint,
    'openai',
    undefined,
    cappedModel,
  )
  assert.equal(clamped.payload.max_completion_tokens, 16000)
  assert.deepEqual(clamped.appliedRules, ['model:max-output-tokens'])

  const untouched = prepareRequestPayload(
    { model: 'gateway-model', messages: [] },
    endpoint,
    'openai',
    undefined,
    cappedModel,
  )
  assert.equal(untouched.payload.max_tokens, undefined)
  assert.equal(untouched.payload.max_completion_tokens, undefined)
  assert.equal(untouched.payload.max_output_tokens, undefined)
  assert.deepEqual(untouched.appliedRules, [])
})

test('leaves output limits alone when the model has no maxOutputTokens', () => {
  const result = prepareRequestPayload(
    { model: 'gateway-model', max_tokens: 64000 },
    endpoint,
    'anthropic',
  )
  assert.equal(result.payload.max_tokens, 64000)
  assert.deepEqual(result.appliedRules, [])
})
