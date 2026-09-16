import { spawn } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { readFile, stat } from 'node:fs/promises'
import { ActionError, fail, guard } from './action-errors.js'

// Bounded, sandbox-confined extractors for PDF / DOCX / XLSX.
//
// PDF shells out to poppler pdftotext (same optional dependency as pdf_info).
// DOCX/XLSX are ZIP+XML and are parsed in-process with a zip-bomb ceiling,
// no extra package, and no write of extracted members to disk.

export const DOCUMENT_LIMITS = Object.freeze({
  file_max_bytes: 8_000_000,
  zip_entry_max_bytes: 4_000_000,
  zip_entries_max: 512,
  text_default_chars: 100_000,
  text_max_chars: 500_000,
  pdf_timeout_ms: 30_000,
  pdf_max_page: 5000,
  xlsx_max_cells: 10_000,
  xlsx_default_cells: 2_000,
  xlsx_max_rows: 2_000,
  xlsx_default_rows: 200,
  xlsx_max_cols: 256,
  xlsx_default_cols: 50,
})

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

async function readBoundedFile(sandbox, path, what) {
  const resolved = await sandbox.resolveExisting(path)
  const info = await guard(() => stat(resolved.absolute), { prefix: `reading ${resolved.relative}` })
  if (!info.isFile()) fail('INVALID_ARGUMENT', `${resolved.relative} is not a regular file`)
  if (info.size > DOCUMENT_LIMITS.file_max_bytes) {
    fail('INVALID_ARGUMENT', `${resolved.relative} is ${info.size} bytes; ${what} is limited to ${DOCUMENT_LIMITS.file_max_bytes}`)
  }
  const data = await guard(() => readFile(resolved.absolute), { prefix: `reading ${resolved.relative}` })
  if (data.length > DOCUMENT_LIMITS.file_max_bytes) {
    fail('INVALID_ARGUMENT', `${resolved.relative} is ${data.length} bytes; ${what} is limited to ${DOCUMENT_LIMITS.file_max_bytes}`)
  }
  return { resolved, info, data }
}

function readU16(buffer, offset) { return buffer.readUInt16LE(offset) }
function readU32(buffer, offset) { return buffer.readUInt32LE(offset) }

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (readU32(buffer, offset) === 0x06054b50) return offset
  }
  return -1
}

function zipPathOk(name) {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) return false
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(name)) return false
  const parts = name.replaceAll('\\', '/').split('/')
  return parts.every(part => part !== '' && part !== '.' && part !== '..')
}

function inflateEntry(payload, method, uncompressed) {
  if (uncompressed > DOCUMENT_LIMITS.zip_entry_max_bytes) {
    fail('INVALID_ARGUMENT', `zip entry uncompressed size ${uncompressed} exceeds ${DOCUMENT_LIMITS.zip_entry_max_bytes}`)
  }
  if (method === 0) {
    if (payload.length > DOCUMENT_LIMITS.zip_entry_max_bytes) {
      fail('INVALID_ARGUMENT', `zip stored entry is larger than ${DOCUMENT_LIMITS.zip_entry_max_bytes}`)
    }
    return payload.subarray(0, uncompressed === 0 ? payload.length : Math.min(uncompressed, payload.length))
  }
  if (method !== 8) fail('INVALID_ARGUMENT', `unsupported zip compression method ${method}`)
  try {
    return inflateRawSync(payload, { maxOutputLength: DOCUMENT_LIMITS.zip_entry_max_bytes })
  } catch (error) {
    fail('INVALID_ARGUMENT', `zip entry could not be inflated: ${error.message}`)
  }
}

/** Read one named member from an OOXML zip. Returns null when absent. */
export function readZipEntry(buffer, wanted) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null
  const eocd = findEocd(buffer)
  if (eocd === -1) return null
  if (readU16(buffer, eocd + 4) !== 0 || readU16(buffer, eocd + 6) !== 0) return null
  const count = readU16(buffer, eocd + 10)
  const cdSize = readU32(buffer, eocd + 12)
  const cdOffset = readU32(buffer, eocd + 16)
  if (count > DOCUMENT_LIMITS.zip_entries_max) fail('INVALID_ARGUMENT', `zip has ${count} entries; limit is ${DOCUMENT_LIMITS.zip_entries_max}`)
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) fail('INVALID_ARGUMENT', 'ZIP64 archives are not supported')
  if (cdOffset + cdSize > buffer.length) fail('INVALID_ARGUMENT', 'zip central directory is truncated')
  let cursor = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || readU32(buffer, cursor) !== 0x02014b50) fail('INVALID_ARGUMENT', 'zip central directory is corrupt')
    const flags = readU16(buffer, cursor + 8)
    const method = readU16(buffer, cursor + 10)
    const compressed = readU32(buffer, cursor + 20)
    const uncompressed = readU32(buffer, cursor + 24)
    const nameLen = readU16(buffer, cursor + 28)
    const extraLen = readU16(buffer, cursor + 30)
    const commentLen = readU16(buffer, cursor + 32)
    const localOffset = readU32(buffer, cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen
    if (name.replaceAll('\\', '/') !== wanted) continue
    if (!zipPathOk(name)) return null
    if (flags & 0x0001) fail('INVALID_ARGUMENT', 'encrypted office files are not readable')
    if (uncompressed > DOCUMENT_LIMITS.zip_entry_max_bytes) {
      fail('INVALID_ARGUMENT', `zip entry uncompressed size ${uncompressed} exceeds ${DOCUMENT_LIMITS.zip_entry_max_bytes}`)
    }
    if (localOffset + 30 > buffer.length || readU32(buffer, localOffset) !== 0x04034b50) fail('INVALID_ARGUMENT', 'zip local header is corrupt')
    const localNameLen = readU16(buffer, localOffset + 26)
    const localExtraLen = readU16(buffer, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compressed > buffer.length) fail('INVALID_ARGUMENT', 'zip entry data is truncated')
    return inflateEntry(buffer.subarray(dataStart, dataStart + compressed), method, uncompressed)
  }
  return null
}

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlLocalText(xml, localName) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, 'g')
  const values = []
  for (const match of xml.matchAll(pattern)) values.push(decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')))
  return values
}

function xmlAttrs(tag) {
  const attrs = {}
  for (const match of tag.matchAll(/([:@\w.-]+)=["']([^"']*)["']/g)) attrs[match[1]] = match[2]
  return attrs
}

function clipText(text, maxChars, offset = 0) {
  const start = Math.max(0, offset)
  const slice = text.slice(start, start + maxChars)
  const truncated = start + slice.length < text.length
  return { text: slice, truncated, next_offset: truncated ? start + slice.length : undefined, offset: start, chars: text.length }
}

function runTool(command, argv, { timeoutMs, maxBytes = DOCUMENT_LIMITS.zip_entry_max_bytes }) {
  return new Promise((resolveRun, rejectRun) => {
    let child
    try {
      child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      rejectRun(new ActionError('UNSUPPORTED', `${command} is not available on this host: ${error.message}`))
      return
    }
    const out = []
    const err = []
    let bytes = 0
    let errBytes = 0
    let overflow = false
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      out.push(chunk)
    })
    child.stderr.on('data', chunk => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const remaining = 65_536 - errBytes
      if (remaining <= 0) return
      err.push(value.subarray(0, remaining))
      errBytes += Math.min(value.length, remaining)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    timer.unref?.()
    child.once('error', error => {
      clearTimeout(timer)
      rejectRun(error?.code === 'ENOENT'
        ? new ActionError('UNSUPPORTED', `${command} is not installed on this host, so this action is unavailable (install poppler-utils to enable it)`)
        : new ActionError('PROCESS_FAILED', `${command} failed: ${error.message}`))
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (overflow) {
        rejectRun(new ActionError('INVALID_ARGUMENT', `${command} produced more than ${maxBytes} bytes; lower max_chars or the page range`))
        return
      }
      resolveRun({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

export async function extractPdfText(sandbox, args = {}, { tool = 'pdftotext' } = {}) {
  const { resolved } = await readBoundedFile(sandbox, args.path, 'pdf_extract_text')
  const first = clampInteger(args.first_page, { min: 1, max: DOCUMENT_LIMITS.pdf_max_page, fallback: 1, label: 'first_page' })
  const last = clampInteger(args.last_page, { min: first, max: DOCUMENT_LIMITS.pdf_max_page, fallback: DOCUMENT_LIMITS.pdf_max_page, label: 'last_page' })
  const maxChars = clampInteger(args.max_chars, { min: 1, max: DOCUMENT_LIMITS.text_max_chars, fallback: DOCUMENT_LIMITS.text_default_chars, label: 'max_chars' })
  const argv = ['-f', String(first), '-l', String(last), '-enc', 'UTF-8', '-nopgbrk']
  if (args.layout === true) argv.push('-layout')
  argv.push(resolved.absolute, '-')
  const result = await runTool(tool, argv, { timeoutMs: DOCUMENT_LIMITS.pdf_timeout_ms })
  if (result.code !== 0) {
    fail('INVALID_ARGUMENT', `${resolved.relative} could not be read as a PDF: ${result.stderr.trim() || `${tool} exited ${result.code}`}`)
  }
  const clipped = clipText(result.stdout.toString('utf8').replace(/\r\n/g, '\n'), maxChars, args.offset ?? 0)
  return {
    path: resolved.relative,
    first_page: first,
    last_page: last,
    text: clipped.text,
    truncated: clipped.truncated,
    offset: clipped.offset,
    chars: clipped.chars,
    ...(clipped.next_offset === undefined ? {} : { next_offset: clipped.next_offset }),
  }
}

export async function extractDocxText(sandbox, args = {}) {
  const { resolved, data } = await readBoundedFile(sandbox, args.path, 'docx_extract_text')
  const xml = readZipEntry(data, 'word/document.xml')
  if (xml === null) fail('INVALID_ARGUMENT', `${resolved.relative} is not a DOCX file (missing word/document.xml)`)
  const document = xml.toString('utf8')
  const paragraphs = document.split(/<\/(?:[\w.-]+:)?p>/).map(block => xmlLocalText(block, 't').join('').trim()).filter(text => text !== '')
  const maxChars = clampInteger(args.max_chars, { min: 1, max: DOCUMENT_LIMITS.text_max_chars, fallback: DOCUMENT_LIMITS.text_default_chars, label: 'max_chars' })
  const clipped = clipText(paragraphs.join('\n'), maxChars, args.offset ?? 0)
  return {
    path: resolved.relative,
    paragraphs: paragraphs.length,
    text: clipped.text,
    truncated: clipped.truncated,
    offset: clipped.offset,
    chars: clipped.chars,
    ...(clipped.next_offset === undefined ? {} : { next_offset: clipped.next_offset }),
  }
}

function colToIndex(col) {
  let n = 0
  for (const char of col.toUpperCase()) {
    if (char < 'A' || char > 'Z') return NaN
    n = n * 26 + (char.charCodeAt(0) - 64)
  }
  return n
}

function parseCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(String(ref ?? ''))
  if (!match) return null
  return { col: match[1].toUpperCase(), row: Number(match[2]), colIndex: colToIndex(match[1]) }
}

function parseRange(range) {
  if (range === undefined || range === null || range === '') return null
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(String(range).trim())
  if (!match) fail('INVALID_ARGUMENT', 'range must look like A1:C10')
  const a = { col: match[1].toUpperCase(), row: Number(match[2]), colIndex: colToIndex(match[1]) }
  const b = { col: match[3].toUpperCase(), row: Number(match[4]), colIndex: colToIndex(match[3]) }
  return {
    c1: Math.min(a.colIndex, b.colIndex),
    c2: Math.max(a.colIndex, b.colIndex),
    r1: Math.min(a.row, b.row),
    r2: Math.max(a.row, b.row),
  }
}

function parseSharedStrings(xml) {
  if (xml === null) return []
  const items = []
  for (const match of xml.toString('utf8').matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g)) {
    items.push(xmlLocalText(match[1], 't').join(''))
  }
  return items
}

function parseSheets(workbook, rels) {
  const sheets = []
  const relMap = {}
  if (rels !== null) {
    for (const match of rels.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const attrs = xmlAttrs(match[1])
      if (attrs.Id && attrs.Target) relMap[attrs.Id] = attrs.Target.replace(/^\.\//, '')
    }
  }
  for (const match of workbook.toString('utf8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = xmlAttrs(match[1])
    const relId = attrs['r:id'] ?? attrs.id
    const target = relMap[relId] ?? `worksheets/sheet${sheets.length + 1}.xml`
    sheets.push({ name: attrs.name ?? `Sheet${sheets.length + 1}`, path: `xl/${target.replace(/^\/+/, '')}` })
  }
  return sheets
}

function cellValue(inner, attrs, strings) {
  const type = attrs.t ?? 'n'
  if (type === 's') {
    const index = Number.parseInt(xmlLocalText(inner, 'v')[0] ?? '', 10)
    return Number.isInteger(index) ? (strings[index] ?? '') : ''
  }
  if (type === 'inlineStr') return xmlLocalText(inner, 't').join('')
  if (type === 'b') return xmlLocalText(inner, 'v')[0] === '1'
  if (type === 'str' || type === 'e') return xmlLocalText(inner, 'v')[0] ?? ''
  const raw = xmlLocalText(inner, 'v')[0]
  if (raw === undefined) return ''
  const number = Number(raw)
  return Number.isFinite(number) ? number : raw
}

export async function extractXlsx(sandbox, args = {}) {
  const { resolved, data } = await readBoundedFile(sandbox, args.path, 'xlsx_extract')
  const workbook = readZipEntry(data, 'xl/workbook.xml')
  if (workbook === null) fail('INVALID_ARGUMENT', `${resolved.relative} is not an XLSX file (missing xl/workbook.xml)`)
  const sheets = parseSheets(workbook, readZipEntry(data, 'xl/_rels/workbook.xml.rels'))
  if (sheets.length === 0) fail('INVALID_ARGUMENT', `${resolved.relative} has no worksheets`)
  let selected = sheets[0]
  if (args.sheet !== undefined && args.sheet !== null && args.sheet !== '') {
    if (typeof args.sheet === 'number') {
      selected = sheets[args.sheet - 1]
      if (selected === undefined) fail('NOT_FOUND', `sheet index ${args.sheet} does not exist`)
    } else {
      selected = sheets.find(entry => entry.name === args.sheet)
      if (selected === undefined && /^[1-9]\d*$/.test(args.sheet)) selected = sheets[Number(args.sheet) - 1]
      if (selected === undefined) fail('NOT_FOUND', `sheet ${args.sheet} does not exist`)
    }
  }
  const sheetXml = readZipEntry(data, selected.path)
  if (sheetXml === null) fail('INVALID_ARGUMENT', `${resolved.relative} is missing ${selected.path}`)
  const strings = parseSharedStrings(readZipEntry(data, 'xl/sharedStrings.xml'))
  const range = parseRange(args.range)
  const maxCells = clampInteger(args.max_cells, { min: 1, max: DOCUMENT_LIMITS.xlsx_max_cells, fallback: DOCUMENT_LIMITS.xlsx_default_cells, label: 'max_cells' })
  const maxRows = clampInteger(args.max_rows, { min: 1, max: DOCUMENT_LIMITS.xlsx_max_rows, fallback: DOCUMENT_LIMITS.xlsx_default_rows, label: 'max_rows' })
  const maxCols = clampInteger(args.max_cols, { min: 1, max: DOCUMENT_LIMITS.xlsx_max_cols, fallback: DOCUMENT_LIMITS.xlsx_default_cols, label: 'max_cols' })

  const rows = []
  let cellCount = 0
  let truncated = false
  for (const match of sheetXml.toString('utf8').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
    const attrText = match[1] ?? match[3] ?? ''
    const inner = match[2] ?? ''
    const attrs = xmlAttrs(attrText)
    const ref = parseCellRef(attrs.r)
    if (ref === null) continue
    if (range !== null && (ref.row < range.r1 || ref.row > range.r2 || ref.colIndex < range.c1 || ref.colIndex > range.c2)) continue
    if (ref.colIndex > maxCols) continue
    if (rows.length > 0 && ref.row !== rows[rows.length - 1].row && rows.length >= maxRows) { truncated = true; break }
    if (cellCount >= maxCells) { truncated = true; break }
    const value = cellValue(inner, attrs, strings)
    if (value === '' && args.include_empty !== true) continue
    let row = rows[rows.length - 1]
    if (row === undefined || row.row !== ref.row) {
      if (rows.length >= maxRows) { truncated = true; break }
      row = { row: ref.row, cells: [] }
      rows.push(row)
    }
    row.cells.push({ col: ref.col, value })
    cellCount += 1
  }

  return {
    path: resolved.relative,
    sheet: selected.name,
    sheets: sheets.map(entry => entry.name),
    ...(typeof args.range === 'string' && args.range !== '' ? { range: args.range } : {}),
    rows,
    row_count: rows.length,
    cell_count: cellCount,
    truncated,
  }
}

const TEXT_EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    first_page: { type: 'integer' },
    last_page: { type: 'integer' },
    paragraphs: { type: 'integer' },
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    next_offset: { type: 'integer' },
    offset: { type: 'integer' },
    chars: { type: 'integer' },
  },
}

export const DOCUMENT_TOOLS = [
  {
    name: 'pdf_extract_text',
    mutating: false,
    description: `Extract text from a PDF inside the session workspace via poppler pdftotext. Page range and max_chars (${DOCUMENT_LIMITS.text_max_chars}) bound the result. Fails with UNSUPPORTED when poppler is not installed. Related: pdf_info, pdf_render_page.`,
    parameters: {
      path: { type: 'string', required: true, description: 'PDF path relative to the session workspace root.' },
      first_page: { type: 'number', description: '1-based first page (default 1).' },
      last_page: { type: 'number', description: '1-based last page (default: document end, still clipped by max_chars).' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DOCUMENT_LIMITS.text_default_chars}).` },
      offset: { type: 'number', description: 'Character offset for the next page of text.' },
      layout: { type: 'boolean', description: 'Preserve approximate layout (pdftotext -layout).' },
    },
    outputSchema: TEXT_EXTRACT_SCHEMA,
    execute: (sandbox, args) => extractPdfText(sandbox, args),
    presentTitle: args => `pdf extract ${args.path}`,
  },
  {
    name: 'docx_extract_text',
    mutating: false,
    description: `Extract paragraph text from a DOCX inside the session workspace. ZIP-bomb and encryption protected; output is clipped to max_chars. Paths stay inside the session root.`,
    parameters: {
      path: { type: 'string', required: true, description: 'DOCX path relative to the session workspace root.' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DOCUMENT_LIMITS.text_default_chars}).` },
      offset: { type: 'number', description: 'Character offset for the next page of text.' },
    },
    outputSchema: TEXT_EXTRACT_SCHEMA,
    execute: (sandbox, args) => extractDocxText(sandbox, args),
    presentTitle: args => `docx extract ${args.path}`,
  },
  {
    name: 'xlsx_extract',
    mutating: false,
    description: `Extract a bounded cell window from an XLSX inside the session workspace. Select a sheet and optional A1:C10 range; cell/row/column caps apply. ZIP-bomb and encryption protected. Not a formula engine.`,
    parameters: {
      path: { type: 'string', required: true, description: 'XLSX path relative to the session workspace root.' },
      sheet: { type: 'string', description: 'Sheet name or 1-based index as a decimal string (default: first sheet).' },
      range: { type: 'string', description: 'Optional A1:C10 window.' },
      max_cells: { type: 'number', description: `Maximum cells to return (default ${DOCUMENT_LIMITS.xlsx_default_cells}).` },
      max_rows: { type: 'number', description: `Maximum rows to return (default ${DOCUMENT_LIMITS.xlsx_default_rows}).` },
      max_cols: { type: 'number', description: `Maximum column index to include (default ${DOCUMENT_LIMITS.xlsx_default_cols}).` },
      include_empty: { type: 'boolean', description: 'Keep blank cells. Default false.' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        sheet: { type: 'string', required: true },
        sheets: { type: 'array', required: true, items: { type: 'string' } },
        range: { type: 'string' },
        rows: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              row: { type: 'integer', required: true },
              cells: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    col: { type: 'string', required: true },
                    value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
                  },
                },
              },
            },
          },
        },
        row_count: { type: 'integer', required: true },
        cell_count: { type: 'integer', required: true },
        truncated: { type: 'boolean', required: true },
      },
    },
    execute: (sandbox, args) => extractXlsx(sandbox, args),
    presentTitle: args => `xlsx extract ${args.path}`,
  },
]
