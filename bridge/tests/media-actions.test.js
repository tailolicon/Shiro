import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { imageMetadata, MEDIA_LIMITS, openImage, pdfInfo, readImageHeader, renderPdfPage } from '../src/media-actions.js'

function hasTool(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
    return true
  } catch { return false }
}

const POPPLER = hasTool('pdfinfo') && hasTool('pdftoppm')

/** 1x1 PNG, written by hand so the test needs no encoder. */
function onePixelPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(1, 8)
  ihdr.writeUInt32BE(1, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr])
}

/** Minimal JPEG: SOI plus an SOF0 frame header carrying the dimensions. */
function jpegHeader(width, height) {
  const frame = Buffer.alloc(11)
  frame[0] = 0xff
  frame[1] = 0xc0
  frame.writeUInt16BE(9, 2)
  frame[4] = 8
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame])
}

function gifHeader(width, height) {
  const buffer = Buffer.alloc(13)
  buffer.write('GIF89a', 0)
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  return buffer
}

/** A one-page PDF with an xref table, built inline so no fixture file is needed. */
function samplePdf() {
  const bodies = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  const stream = 'BT /F1 24 Tf 20 40 Td (Shiro) Tj ET'
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-media-'))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('container headers give the geometry without decoding pixels', () => {
  assert.deepEqual(readImageHeader(onePixelPng()), { format: 'png', width: 1, height: 1 })
  assert.deepEqual(readImageHeader(jpegHeader(640, 480)), { format: 'jpeg', width: 640, height: 480 })
  assert.deepEqual(readImageHeader(gifHeader(12, 34)), { format: 'gif', width: 12, height: 34 })
  assert.equal(readImageHeader(Buffer.from('not an image at all, just text')), null)
})

test('image_metadata reports size and inline fitness for a real file', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'pixel.png'), onePixelPng())
    const meta = await imageMetadata(sandbox, { path: 'pixel.png', include_hash: true })
    assert.equal(meta.format, 'png')
    assert.equal(meta.mime_type, 'image/png')
    assert.equal(meta.width, 1)
    assert.equal(meta.height, 1)
    assert.equal(meta.fits_inline, true)
    assert.match(meta.sha256, /^[0-9a-f]{64}$/)

    await writeFile(join(root, 'notes.txt'), 'plain text')
    await rejects(imageMetadata(sandbox, { path: 'notes.txt' }), 'INVALID_ARGUMENT')
    await rejects(imageMetadata(sandbox, { path: 'missing.png' }), 'NOT_FOUND')
    await rejects(imageMetadata(sandbox, { path: '../escape.png' }), 'OUTSIDE_SANDBOX')
  } finally {
    await cleanup()
  }
})

test('image_open returns the bytes and refuses a file over the inline limit', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    const png = onePixelPng()
    await writeFile(join(root, 'pixel.png'), png)
    const opened = await openImage(sandbox, { path: 'pixel.png' })
    assert.equal(opened.mimeType, 'image/png')
    assert.ok(opened.data.equals(png))
    assert.equal(opened.meta.width, 1)

    await rejects(openImage(sandbox, { path: 'pixel.png' }, { maxBytes: 4 }), 'INVALID_ARGUMENT')
    assert.ok(MEDIA_LIMITS.image_max_bytes > 0)
  } finally {
    await cleanup()
  }
})

test('pdf_info reads the page count', { skip: POPPLER ? false : 'poppler-utils not installed' }, async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'doc.pdf'), samplePdf())
    const info = await pdfInfo(sandbox, { path: 'doc.pdf' })
    assert.equal(info.pages, 1)
    assert.equal(info.encrypted, false)
    assert.match(info.page_size, /200/)
    assert.ok(info.size > 0)

    await writeFile(join(root, 'fake.pdf'), 'not really a pdf')
    await rejects(pdfInfo(sandbox, { path: 'fake.pdf' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('pdf_render_page rasterises a page without touching the workspace', { skip: POPPLER ? false : 'poppler-utils not installed' }, async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'doc.pdf'), samplePdf())
    const rendered = await renderPdfPage(sandbox, { path: 'doc.pdf', page: 1, dpi: 60 })
    assert.equal(rendered.mimeType, 'image/png')
    assert.equal(rendered.meta.page, 1)
    assert.ok(rendered.meta.width > 0 && rendered.meta.height > 0)
    assert.deepEqual(readImageHeader(rendered.data).format, 'png')

    const { readdir } = await import('node:fs/promises')
    assert.deepEqual((await readdir(root)).sort(), ['doc.pdf'], 'rendering leaves no temp files behind')

    // save_to is the opt-in that does write into the workspace.
    const saved = await renderPdfPage(sandbox, { path: 'doc.pdf', page: 1, dpi: 60, save_to: 'out/page1.png' })
    assert.equal(saved.meta.saved_to, 'out/page1.png')

    await rejects(renderPdfPage(sandbox, { path: 'doc.pdf', page: 9 }), 'INVALID_ARGUMENT')
    await rejects(renderPdfPage(sandbox, { path: 'doc.pdf', dpi: 5000 }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('a missing renderer is reported as UNSUPPORTED, never as a fake success', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'doc.pdf'), samplePdf())
    await rejects(pdfInfo(sandbox, { path: 'doc.pdf' }, { tool: 'pdfinfo-not-installed' }), 'UNSUPPORTED')
    await rejects(renderPdfPage(sandbox, { path: 'doc.pdf' }, { tool: 'pdftoppm-not-installed' }), 'UNSUPPORTED')
  } finally {
    await cleanup()
  }
})
