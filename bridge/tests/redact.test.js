import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretRedactor } from '../src/redact.js'

test('redactor masks vendor keys, bearer tokens, private keys and environment secrets', () => {
  const redact = createSecretRedactor({ SHIRO_BRIDGE_TOKEN: 'bridge-token-value-123456' })
  const value = redact({
    content: [
      { type: 'text', text: 'key sk-abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwxyz' },
      { type: 'text', text: 'bridge-token-value-123456' },
      { type: 'text', text: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----' },
    ],
  })
  assert.equal(value.content[0].text, 'key sk-*** and Bearer ***')
  assert.equal(value.content[1].text, '***')
  assert.equal(value.content[2].text, '***PRIVATE KEY BLOCK***')
})

test('redactor preserves ordinary code identifiers, git hashes and binary payload fields', () => {
  const redact = createSecretRedactor({})
  const value = redact({
    text: 'hindsight_search_knowledge_pages ca578248deeaaab94393cf4b9f20bbd5fc97c118',
    image: { type: 'image', data: 'data:image/png;base64,AbCdEf0123456789' },
    metadata: { data: 'sk-abcdefghijklmnop' },
  })
  assert.equal(value.text, 'hindsight_search_knowledge_pages ca578248deeaaab94393cf4b9f20bbd5fc97c118')
  assert.equal(value.image.data, 'data:image/png;base64,AbCdEf0123456789')
  assert.equal(value.metadata.data, 'sk-***')
})

test('redactor masks contextual key-value and credential-bearing URLs', () => {
  const redact = createSecretRedactor({})
  assert.equal(redact('password=correct-horse-battery'), 'password=***')
  assert.equal(redact('https://alice:correct-horse@example.com/api'), 'https://***@example.com/api')
})
