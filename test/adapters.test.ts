import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { adapters } from '../src/adapters/index.js'

test('registers the expected adapters', () => {
  assert.deepEqual(
    Object.keys(adapters).sort(),
    ['common-anthropic', 'deepseek-anthropic', 'deepseek-openai', 'qwen-anthropic'],
  )
  for (const adapter of Object.values(adapters)) {
    assert.equal(adapters[adapter.name], adapter)
  }
  assert.equal(adapters['common-anthropic'].protocol, 'anthropic')
  assert.equal(adapters['deepseek-anthropic'].protocol, 'anthropic')
  assert.equal(adapters['deepseek-openai'].protocol, 'openai')
  assert.equal(adapters['qwen-anthropic'].protocol, 'anthropic')
})

test('deepseek-anthropic clamps the budget and drops unsupported blocks including images for text-only models', () => {
  const payload = {
    thinking: { type: 'enabled', budget_tokens: 300000 },
    messages: [{ role: 'user', content: [
      { type: 'image', source: {} },
      { type: 'document', source: {} },
      { type: 'text', text: 'keep me' },
    ] }],
  }
  const changed = adapters['deepseek-anthropic'].apply(payload, { architecture: { modality: 'text' }, endpoints: [] })
  assert.equal(changed, true)
  assert.deepEqual(payload.thinking, { type: 'enabled', budget_tokens: 260000 })
  assert.deepEqual(payload.messages, [{ role: 'user', content: [{ type: 'text', text: 'keep me' }] }])
})

test('deepseek-anthropic keeps images for models advertising image modality', () => {
  const payload = {
    messages: [{ role: 'user', content: [
      { type: 'image', source: {} },
      { type: 'mcp_tool_use', id: 'x' },
      { type: 'text', text: 'keep me' },
    ] }],
  }
  const changed = adapters['deepseek-anthropic'].apply(payload, { architecture: { modality: 'text+image' }, endpoints: [] })
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
  assert.equal(adapters['deepseek-anthropic'].apply(payload, { endpoints: [] }), false)
})

test('qwen-anthropic removes the budget but keeps the thinking type', () => {
  const payload = { thinking: { type: 'enabled', budget_tokens: 4096 } }
  assert.equal(adapters['qwen-anthropic'].apply(payload, { endpoints: [] }), true)
  assert.deepEqual(payload, { thinking: { type: 'enabled' } })
})

test('common-anthropic only clamps the budget', () => {
  const payload = { thinking: { type: 'enabled', budget_tokens: 300000 } }
  assert.equal(adapters['common-anthropic'].apply(payload, { endpoints: [] }), true)
  assert.equal(payload.thinking.budget_tokens, 260000)
})

// ---------------------------------------------------------------------------
// deepseek-openai: quirks of the DeepSeek native OpenAI API
// ---------------------------------------------------------------------------

const EMPTY_MODEL = { endpoints: [] }

test('deepseek-openai flattens text-only content arrays into strings', () => {
  const payload = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply a' }, { type: 'text', text: 'reply b' }] },
    ],
  }
  assert.equal(adapters['deepseek-openai'].apply(payload, EMPTY_MODEL), true)
  assert.equal(payload.messages[0].content, 'part one\npart two')
  assert.equal(payload.messages[1].content, 'reply areply b')
})

test('deepseek-openai leaves content arrays with image parts untouched', () => {
  const payload = {
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ] },
    ],
  }
  assert.equal(adapters['deepseek-openai'].apply(payload, EMPTY_MODEL), false)
  assert.equal(payload.messages[0].content.length, 2)
})

test('deepseek-openai fills empty content and tool_call indexes on assistant turns', () => {
  const payload = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }] },
    ],
  }
  assert.equal(adapters['deepseek-openai'].apply(payload, EMPTY_MODEL), true)
  assert.equal(payload.messages[0].content, '')
  assert.equal(payload.messages[0].tool_calls[0].index, 0)
  assert.equal(payload.messages[1].content, '')
  assert.equal(payload.messages[1].tool_calls[0].index, 0)
})

test('deepseek-openai suppresses forced tool_choice while thinking is enabled', () => {
  const required = { tool_choice: 'required', thinking: { type: 'enabled' } }
  assert.equal(adapters['deepseek-openai'].apply(required, EMPTY_MODEL), true)
  assert.equal(required.tool_choice, null)

  const specific = { tool_choice: { type: 'function', function: { name: 'f' } } }
  assert.equal(adapters['deepseek-openai'].apply(specific, EMPTY_MODEL), true)
  assert.equal(specific.tool_choice, null)

  const disabled = { tool_choice: 'required', thinking: { type: 'disabled' } }
  assert.equal(adapters['deepseek-openai'].apply(disabled, EMPTY_MODEL), false)
  assert.equal(disabled.tool_choice, 'required')

  const auto = { tool_choice: 'auto', thinking: { type: 'enabled' } }
  assert.equal(adapters['deepseek-openai'].apply(auto, EMPTY_MODEL), false)
  assert.equal(auto.tool_choice, 'auto')
})

test('deepseek-openai reports no change on a clean payload', () => {
  const payload = {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c', index: 0 }] },
    ],
    tool_choice: 'auto',
  }
  assert.equal(adapters['deepseek-openai'].apply(payload, EMPTY_MODEL), false)
})

test('deepseek-anthropic drops Claude server-tool blocks (server_tool_use / web_search_tool_result)', () => {
  const payload = {
    messages: [
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: { query: 'x' } },
        { type: 'text', text: 'keep' },
      ] },
      { role: 'user', content: [
        { type: 'web_search_tool_result', tool_use_id: 'srv-1', content: [{ type: 'text', text: 'r' }] },
        { type: 'web_search_tool_result_error', tool_use_id: 'srv-1', content: 'err' },
        { type: 'text', text: 'keep too' },
      ] },
    ],
  }
  const changed = adapters['deepseek-anthropic'].apply(payload, { architecture: { modality: 'text+image' }, endpoints: [] })
  assert.equal(changed, true)
  assert.deepEqual(payload.messages[0].content, [{ type: 'text', text: 'keep' }])
  assert.deepEqual(payload.messages[1].content, [{ type: 'text', text: 'keep too' }])
})

test('deepseek-anthropic normalizes null tool_use input to an empty object', () => {
  const payload = {
    messages: [{ role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'f', input: null },
      { type: 'tool_use', id: 't2', name: 'g' },
      { type: 'tool_use', id: 't3', name: 'h', input: { a: 1 } },
    ] }],
  }
  const changed = adapters['deepseek-anthropic'].apply(payload, { endpoints: [] })
  assert.equal(changed, true)
  assert.deepEqual(payload.messages[0].content[0].input, {})
  assert.deepEqual(payload.messages[0].content[1].input, {})
  assert.deepEqual(payload.messages[0].content[2].input, { a: 1 })
})

test('deepseek-openai renames max_completion_tokens to max_tokens when max_tokens is absent', () => {
  const payload = { max_completion_tokens: 2048 }
  assert.equal(adapters['deepseek-openai'].apply(payload, EMPTY_MODEL), true)
  assert.equal(payload.max_tokens, 2048)
  assert.equal(payload.max_completion_tokens, undefined)

  const both = { max_tokens: 1024, max_completion_tokens: 4096 }
  assert.equal(adapters['deepseek-openai'].apply(both, EMPTY_MODEL), false)
  assert.equal(both.max_tokens, 1024)
  assert.equal(both.max_completion_tokens, 4096)
})

test('deepseek-anthropic drops bare thinking blocks from assistant history', () => {
  const payload = {
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'internal reasoning', signature: 'sig-1' },
      { type: 'thinking', encrypted_content: 'enc', signature: 'sig-2' },
      { type: 'redacted_thinking', data: '…' },
      { type: 'text', text: 'final answer' },
    ] }],
  }
  const changed = adapters['deepseek-anthropic'].apply(payload, { architecture: { modality: 'text+image' }, endpoints: [] })
  assert.equal(changed, true)
  assert.deepEqual(payload.messages[0].content, [{ type: 'text', text: 'final answer' }])
})

test('deepseek-anthropic prefers structured input_modalities over the modality string', () => {
  // Structured field says text-only even though the legacy string mentions image.
  const structured = { architecture: { modality: 'text+image', input_modalities: ['text'] }, endpoints: [] }
  const payload = { messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'keep' }] }] }
  assert.equal(adapters['deepseek-anthropic'].apply(payload, structured), true)
  assert.deepEqual(payload.messages[0].content, [{ type: 'text', text: 'keep' }])

  // Structured field advertises image support.
  const vision = { architecture: { modality: 'text', input_modalities: ['text', 'image'] }, endpoints: [] }
  const payload2 = { messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'keep' }] }] }
  assert.equal(adapters['deepseek-anthropic'].apply(payload2, vision), false)
  assert.equal(payload2.messages[0].content.length, 2)
})
