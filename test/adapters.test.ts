import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { adapters } from '../src/adapters/index.js'

test('registers the expected adapters, all for the Anthropic protocol', () => {
  assert.deepEqual(
    Object.keys(adapters).sort(),
    ['common-anthropic', 'deepseek-anthropic', 'deepseek-anthropic-vision', 'qwen-anthropic'],
  )
  for (const adapter of Object.values(adapters)) {
    assert.equal(adapter.protocol, 'anthropic')
    assert.equal(adapters[adapter.name], adapter)
  }
})

test('deepseek-anthropic clamps the budget and drops unsupported blocks including images', () => {
  const payload = {
    thinking: { type: 'enabled', budget_tokens: 300000 },
    messages: [{ role: 'user', content: [
      { type: 'image', source: {} },
      { type: 'document', source: {} },
      { type: 'text', text: 'keep me' },
    ] }],
  }
  const changed = adapters['deepseek-anthropic'].apply(payload)
  assert.equal(changed, true)
  assert.deepEqual(payload.thinking, { type: 'enabled', budget_tokens: 260000 })
  assert.deepEqual(payload.messages, [{ role: 'user', content: [{ type: 'text', text: 'keep me' }] }])
})

test('deepseek-anthropic-vision keeps images but drops the other unsupported blocks', () => {
  const payload = {
    messages: [{ role: 'user', content: [
      { type: 'image', source: {} },
      { type: 'mcp_tool_use', id: 'x' },
      { type: 'text', text: 'keep me' },
    ] }],
  }
  const changed = adapters['deepseek-anthropic-vision'].apply(payload)
  assert.equal(changed, true)
  assert.deepEqual(payload.messages, [{ role: 'user', content: [
    { type: 'image', source: {} },
    { type: 'text', text: 'keep me' },
  ] }])
})

test('deepseek-anthropic reports no change when nothing needs fixing', () => {
  const payload = {
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }
  assert.equal(adapters['deepseek-anthropic'].apply(payload), false)
})

test('qwen-anthropic removes the budget but keeps the thinking type', () => {
  const payload = { thinking: { type: 'enabled', budget_tokens: 4096 } }
  assert.equal(adapters['qwen-anthropic'].apply(payload), true)
  assert.deepEqual(payload, { thinking: { type: 'enabled' } })
})

test('common-anthropic only clamps the budget', () => {
  const payload = { thinking: { type: 'enabled', budget_tokens: 300000 } }
  assert.equal(adapters['common-anthropic'].apply(payload), true)
  assert.equal(payload.thinking.budget_tokens, 260000)
})
