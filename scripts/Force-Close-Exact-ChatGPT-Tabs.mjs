#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(here, '..', '..', '.ShiroRuntime', 'state', 'chatgpt-relay.env')
const text = await fs.readFile(envPath, 'utf8')
const env = Object.fromEntries(text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => {
  const i = line.indexOf('=')
  return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]
}))
const base = `http://127.0.0.1:${env.PORT || 23158}`
const headers = { Authorization: `Bearer ${env.API_TOKEN}`, 'Content-Type': 'application/json' }
const ids = new Set(process.argv.slice(2).map(Number).filter(Number.isInteger))
if (!ids.size) throw new Error('Pass exact numeric tab ids')
const response = await fetch(`${base}/browser/clients`, { headers })
if (!response.ok) throw new Error(`clients HTTP ${response.status}: ${await response.text()}`)
const clients = (await response.json()).clients || []
for (const tabId of ids) {
  const client = clients.find(c => c.browserTabId === tabId)
  if (!client) { console.log(`ALREADY_GONE ${tabId}`); continue }
  const url = String(client.url || '')
  if (!/^https:\/\/chatgpt\.com\/\?temporary-chat=true(?:[&#].*)?$/.test(url)) {
    console.log(`REFUSE_URL ${tabId} ${url}`)
    continue
  }
  const close = await fetch(`${base}/browser/tabs/close`, {
    method: 'POST', headers,
    body: JSON.stringify({ sourceClientId: client.id, expectedUrl: url, timeoutMs: 10000 }),
  })
  const body = await close.text()
  if (!close.ok) console.log(`CLOSE_FAIL ${tabId} HTTP_${close.status} ${body}`)
  else console.log(`CLOSED ${tabId}`)
}
