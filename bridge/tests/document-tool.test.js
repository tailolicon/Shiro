import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as documentTool from '../src/document-tool.js'
import { DOCUMENT_TOOLS } from '../src/document-extract.js'

function zipStore(name, xml) {
  const data = Buffer.from(xml)
  const fileName = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  const localFull = Buffer.concat([local, fileName, data])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  const cd = Buffer.concat([central, fileName])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(localFull.length, 16)
  return Buffer.concat([localFull, cd, eocd])
}

function sampleDocx(text) {
  return zipStore('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
}

test('document tool preserves injection metadata through its namespace export', () => {
  assert.equal('default' in documentTool, false)
  assert.equal(documentTool.name, 'shiro-document-tool')
  assert.deepEqual(documentTool.inject, ['tools'])
  assert.equal(typeof documentTool.apply, 'function')
  assert.throws(() => documentTool.apply({ tools: { register() {} } }, {}), /workspaceRoot/)
})

test('document tools follow the session cwd, not the plugin apply() root', async () => {
  const configured = await mkdtemp(join(tmpdir(), 'shiro-doc-cfg-'))
  const session = await mkdtemp(join(tmpdir(), 'shiro-doc-sess-'))
  try {
    await writeFile(join(configured, 'wrong.docx'), sampleDocx('configured-root'))
    await writeFile(join(session, 'note.docx'), sampleDocx('session-root'))
    const registered = new Map()
    const ctx = { tools: { register(value) { registered.set(value.name, value); return () => {} } } }
    documentTool.apply(ctx, { workspaceRoot: configured })
    assert.deepEqual([...registered.keys()], DOCUMENT_TOOLS.map(spec => spec.name))

    const exec = { agent: { session: { header: { cwd: session } } } }
    const extracted = await registered.get('docx_extract_text').execute({ path: 'note.docx' }, exec)
    assert.match(extracted.text, /session-root/)

    await assert.rejects(registered.get('docx_extract_text').execute({ path: 'wrong.docx' }, exec), error => {
      assert.equal(error.code, 'NOT_FOUND')
      return true
    })
    await assert.rejects(registered.get('docx_extract_text').execute({ path: '../escape.docx' }, exec), error => {
      assert.equal(error.code, 'OUTSIDE_SANDBOX')
      return true
    })
  } finally {
    await rm(configured, { recursive: true, force: true })
    await rm(session, { recursive: true, force: true })
  }
})
