import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Sandbox } from '../src/sandbox.js'
import {
  DOCUMENT_LIMITS, DOCUMENT_TOOLS, extractDocxText, extractPdfText, extractXlsx, readZipEntry,
} from '../src/document-extract.js'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let crc = i
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
    table[i] = crc >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntries(files, { encrypted = false, uncompressedOverride } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const method = file.deflate === true ? 8 : 0
    const payload = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)
    const flags = encrypted ? 1 : 0
    const uncompressed = uncompressedOverride ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(uncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    const localFull = Buffer.concat([local, name, payload])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(uncompressed, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(localFull)
    centrals.push(Buffer.concat([central, name]))
    offset += localFull.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function sampleDocx(paragraphs) {
  const body = paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  return zipEntries([{ name: 'word/document.xml', data: xml, deflate: true }])
}

function sampleXlsx({ sheet = 'Sheet1', rows } = {}) {
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  const strings = []
  const sheetRows = rows.map((cells, index) => {
    const row = index + 1
    const xml = cells.map((cell, colIndex) => {
      const col = String.fromCharCode(65 + colIndex)
      if (typeof cell === 'number') return `<c r="${col}${row}" t="n"><v>${cell}</v></c>`
      if (typeof cell === 'boolean') return `<c r="${col}${row}" t="b"><v>${cell ? 1 : 0}</v></c>`
      strings.push(cell)
      return `<c r="${col}${row}" t="s"><v>${strings.length - 1}</v></c>`
    }).join('')
    return `<row r="${row}">${xml}</row>`
  }).join('')
  const sst = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(text => `<si><t>${text}</t></si>`).join('')}</sst>`
  const worksheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`
  return zipEntries([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: sst },
    { name: 'xl/worksheets/sheet1.xml', data: worksheet },
  ])
}

function samplePdf() {
  const bodies = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  const stream = 'BT /F1 24 Tf 20 40 Td (Shiro extract) Tj ET'
  let pdf = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    const number = index + 1
    pdf += body === null
      ? `${number} 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`
      : `${number} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function hasTool(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-docs-'))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('docx_extract_text returns paragraph text and refuses escapes', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'note.docx'), sampleDocx(['Hello Shiro', 'Second line']))
    const extracted = await extractDocxText(sandbox, { path: 'note.docx' })
    assert.equal(extracted.path, 'note.docx')
    assert.match(extracted.text, /Hello Shiro/)
    assert.match(extracted.text, /Second line/)
    assert.equal(extracted.truncated, false)
    assert.ok(extracted.paragraphs >= 2)

    await writeFile(join(root, 'tiny.docx'), sampleDocx(['abcdefghijklmnopqrstuvwxyz']))
    const clipped = await extractDocxText(sandbox, { path: 'tiny.docx', max_chars: 8 })
    assert.equal(clipped.text, 'abcdefgh')
    assert.equal(clipped.truncated, true)
    assert.equal(clipped.next_offset, 8)

    await rejects(extractDocxText(sandbox, { path: '../escape.docx' }), 'OUTSIDE_SANDBOX')
    await rejects(extractDocxText(sandbox, { path: 'missing.docx' }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('xlsx_extract is cell-addressed, range-limited, and truncated at max_cells', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'book.xlsx'), sampleXlsx({
      sheet: 'Data',
      rows: [
        ['hello', 42, true],
        ['world', 7, false],
      ],
    }))
    const all = await extractXlsx(sandbox, { path: 'book.xlsx' })
    assert.equal(all.sheet, 'Data')
    assert.equal(all.rows[0].cells[0].value, 'hello')
    assert.equal(all.rows[0].cells[1].value, 42)
    assert.equal(all.rows[0].cells[2].value, true)
    assert.equal(all.cell_count, 6)
    assert.equal(all.truncated, false)

    const ranged = await extractXlsx(sandbox, { path: 'book.xlsx', range: 'A1:B1' })
    assert.equal(ranged.cell_count, 2)
    assert.deepEqual(ranged.rows[0].cells.map(cell => cell.col), ['A', 'B'])

    const capped = await extractXlsx(sandbox, { path: 'book.xlsx', max_cells: 3 })
    assert.equal(capped.cell_count, 3)
    assert.equal(capped.truncated, true)

    const byIndex = await extractXlsx(sandbox, { path: 'book.xlsx', sheet: 1 })
    assert.equal(byIndex.sheet, 'Data')
    const byIndexString = await extractXlsx(sandbox, { path: 'book.xlsx', sheet: '1' })
    assert.equal(byIndexString.sheet, 'Data')
    await rejects(extractXlsx(sandbox, { path: 'book.xlsx', sheet: 'Nope' }), 'NOT_FOUND')
    await rejects(extractXlsx(sandbox, { path: 'book.xlsx', range: 'not-a-range' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('office extractors refuse zip bombs, encryption, and non-zip files', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'bomb.xlsx'), zipEntries(
      [{ name: 'xl/workbook.xml', data: '<workbook/>' }],
      { uncompressedOverride: DOCUMENT_LIMITS.zip_entry_max_bytes + 1 },
    ))
    await rejects(extractXlsx(sandbox, { path: 'bomb.xlsx' }), 'INVALID_ARGUMENT')

    await writeFile(join(root, 'locked.docx'), zipEntries(
      [{ name: 'word/document.xml', data: '<w:document/>' }],
      { encrypted: true },
    ))
    await rejects(extractDocxText(sandbox, { path: 'locked.docx' }), 'INVALID_ARGUMENT')

    await writeFile(join(root, 'plain.docx'), 'not a zip')
    await rejects(extractDocxText(sandbox, { path: 'plain.docx' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('zip slip names are not read even when they claim a document path', async () => {
  const payload = zipEntries([
    { name: '../word/document.xml', data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>escaped</w:t></w:r></w:p></w:body></w:document>' },
  ])
  assert.equal(readZipEntry(payload, 'word/document.xml'), null)
})

test('a symlink that leaves the workspace is refused before the file is parsed', async () => {
  const { root, sandbox, cleanup } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'shiro-docs-out-'))
  try {
    await writeFile(join(outside, 'secret.docx'), sampleDocx(['outside']))
    await symlink(join(outside, 'secret.docx'), join(root, 'link.docx'))
    await rejects(extractDocxText(sandbox, { path: 'link.docx' }), 'OUTSIDE_SANDBOX')
  } finally {
    await cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

test('pdf_extract_text uses pdftotext when present and reports a missing tool as UNSUPPORTED', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'doc.pdf'), samplePdf())
    await rejects(extractPdfText(sandbox, { path: 'doc.pdf' }, { tool: 'pdftotext-not-installed' }), 'UNSUPPORTED')
    if (hasTool('pdftotext')) {
      const extracted = await extractPdfText(sandbox, { path: 'doc.pdf', max_chars: 40 })
      assert.match(extracted.text, /Shiro extract/)
      assert.equal(extracted.path, 'doc.pdf')
    }
  } finally {
    await cleanup()
  }
})

test('DOCUMENT_TOOLS are the bounded extractors the Harness plugin registers', () => {
  assert.deepEqual(DOCUMENT_TOOLS.map(spec => spec.name), ['pdf_extract_text', 'docx_extract_text', 'xlsx_extract'])
  for (const spec of DOCUMENT_TOOLS) {
    assert.equal(spec.mutating, false)
    assert.equal(spec.parameters.path.required, true)
  }
})
