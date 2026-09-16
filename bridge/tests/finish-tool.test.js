import assert from 'node:assert/strict'
import test from 'node:test'
import * as finishTool from '../src/finish-tool.js'

const { registerFinishTool } = finishTool

test('finish tool preserves injection metadata through its namespace export', () => {
  assert.equal('default' in finishTool, false)
  assert.equal(finishTool.name, 'shiro-finish-tool')
  assert.deepEqual(finishTool.inject, ['tools'])
  assert.equal(typeof finishTool.apply, 'function')
})

test('submit_final concludes the current turn and returns exact text', async () => {
  let definition
  const ctx = {
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
    },
  }
  registerFinishTool(ctx)
  assert.equal(definition.name, 'submit_final')
  let concluded = 0
  const value = await definition.execute({ text: 'version=0.2.0 lines=2750' }, {
    concludeTurn() { concluded += 1 },
  })
  assert.equal(value, 'version=0.2.0 lines=2750')
  assert.equal(concluded, 1)
  assert.deepEqual(definition.output.render({}, value), [{ type: 'text', text: 'version=0.2.0 lines=2750' }])
})

test('submit_final refuses empty text without concluding the turn', async () => {
  let definition
  const ctx = { tools: { register(value) { definition = value; return () => {} } } }
  registerFinishTool(ctx)
  let concluded = false
  await assert.rejects(definition.execute({ text: '   ' }, { concludeTurn() { concluded = true } }), /text is required/)
  assert.equal(concluded, false)
})
