import assert from 'node:assert/strict'
import test from 'node:test'
import * as hostTool from '../src/host-tool.js'
import { HOST_TOOLS } from '../src/host-info.js'

test('host tool preserves injection metadata through its namespace export', () => {
  assert.equal('default' in hostTool, false)
  assert.equal(hostTool.name, 'shiro-host-tool')
  assert.deepEqual(hostTool.inject, ['tools'])
  assert.equal(typeof hostTool.apply, 'function')
})

test('apply registers the read-only host tools and execute never mutates', async () => {
  const registered = []
  const ctx = { tools: { register(value) { registered.push(value); return () => {} } } }
  hostTool.apply(ctx)
  assert.deepEqual(registered.map(tool => tool.name), HOST_TOOLS.map(spec => spec.name))
  const info = await registered[0].execute({})
  assert.equal(info.self.pid, process.pid)
  assert.equal(info.env, undefined)
  if (process.platform === 'linux') {
    const listed = await registered[1].execute({ pid: process.pid, limit: 1 })
    assert.equal(listed.processes[0].pid, process.pid)
  }
})
