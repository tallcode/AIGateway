import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { loadConfig, normalizeApiKeys } from '../src/config.js'

test('normalizeApiKeys inverts the id -> key map into key -> id', () => {
  assert.deepEqual(normalizeApiKeys({ alice: 'sk-a', bob: 'sk-b' }), { 'sk-a': 'alice', 'sk-b': 'bob' })
})

test('normalizeApiKeys rejects the same key under two ids', () => {
  assert.throws(() => normalizeApiKeys({ alice: 'sk-a', bob: 'sk-a' }), /Duplicate apiKey/)
})

const minimalConfig = {
  port: 1,
  verbose: false,
  apiKeys: { alice: 'sk-a' },
  providers: {
    p: { url: { openai: 'https://example.com/v1' }, apiKey: 'sk-upstream' },
  },
  models: {
    m: { endpoints: [{ provider: 'p', priority: 1 }] },
  },
}

test('loadConfig normalizes id -> key apiKeys into key -> id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aigateway-test-'))
  try {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ ...minimalConfig, apiKeys: { alice: 'sk-a', bob: 'sk-b' } }))
    const config = loadConfig(path)
    assert.deepEqual(config.apiKeys, { 'sk-a': 'alice', 'sk-b': 'bob' })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig rejects an empty apiKeys object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aigateway-test-'))
  try {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ ...minimalConfig, apiKeys: {} }))
    assert.throws(() => loadConfig(path), /Invalid config/)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig rejects a plain-string apiKeys (old apiKey format)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aigateway-test-'))
  try {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ ...minimalConfig, apiKeys: 'sk-single' }))
    assert.throws(() => loadConfig(path), /Invalid config/)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig rejects references to adapters that are not in the code registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aigateway-test-'))
  try {
    const path = join(dir, 'config.json')
    const config = {
      ...minimalConfig,
      providers: {
        p: {
          ...minimalConfig.providers.p,
          adapters: { anthropic: 'no-such-adapter' },
        },
      },
    }
    writeFileSync(path, JSON.stringify(config))
    assert.throws(() => loadConfig(path), /unknown anthropic adapter "no-such-adapter"/i)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
