import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { ActionError, fail, guard } from './action-errors.js'

// Looking at files, not just reading their bytes.
//
// fs_read returns base64 for a PNG, which tells a model nothing. These actions
// return the picture itself as an MCP image block (image_open), the geometry
// without decoding the pixels (image_metadata), and a rendered page of a PDF
// (pdf_render_page) -- the three things a coding agent actually needs when the
// artifact under discussion is visual. Rendering shells out to poppler, which
// is optional: when it is missing the action says so with UNSUPPORTED instead
// of pretending.

export const MEDIA_LIMITS = Object.freeze({
  image_max_bytes: 6_000_000,
  pdf_render_timeout_ms: 30_000,
  pdf_max_dpi: 300,
  pdf_default_dpi: 120,
  pdf_max_page: 5000,
})

const IMAGE_MIME = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
})

/**
 * Read geometry straight out of the container header. No decoder, no
 * dependency, no pixel work -- a 40 MB screenshot costs the same few hundred
 * bytes to measure as a thumbnail does.
 */
export function readImageHeader(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (buffer.length >= 30 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buffer.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { format: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
      return { format: 'webp', width, height }
    }
    return { format: 'webp' }
  }
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { format: 'bmp', width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    // JPEG: walk the marker chain to the frame header that carries the size.
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const length = buffer.readUInt16BE(offset + 2)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) {
        return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
    return { format: 'jpeg' }
  }
  return null
}

async function readBounded(sandbox, path, maxBytes, what) {
  const resolved = await sandbox.resolveExisting(path)
  const info = await guard(() => stat(resolved.absolute), { prefix: `reading ${resolved.relative}` })
  if (!info.isFile()) fail('INVALID_ARGUMENT', `${resolved.relative} is not a regular file`)
  if (info.size > maxBytes) {
    fail('INVALID_ARGUMENT', `${resolved.relative} is ${info.size} bytes; ${what} is limited to ${maxBytes}. Resize or crop it first, or read it with fs_read in pages.`)
  }
  const data = await guard(() => readFile(resolved.absolute), { prefix: `reading ${resolved.relative}` })
  return { resolved, info, data }
}

/** image_metadata: format and pixel size without shipping the bytes anywhere. */
export async function imageMetadata(sandbox, args = {}) {
  const resolved = await sandbox.resolveExisting(args.path)
  const info = await guard(() => stat(resolved.absolute), { prefix: `reading ${resolved.relative}` })
  if (!info.isFile()) fail('INVALID_ARGUMENT', `${resolved.relative} is not a regular file`)
  const handle = await guard(() => readFile(resolved.absolute, { flag: 'r' }), { prefix: `reading ${resolved.relative}` })
  const header = readImageHeader(handle.subarray(0, Math.min(handle.length, 65_536)))
  if (header === null) {
    fail('INVALID_ARGUMENT', `${resolved.relative} is not a PNG, JPEG, GIF, WebP or BMP image (extension ${extname(resolved.relative) || 'none'})`)
  }
  return {
    path: resolved.relative,
    format: header.format,
    mime_type: IMAGE_MIME[header.format],
    width: header.width,
    height: header.height,
    size: info.size,
    mtime: new Date(info.mtimeMs).toISOString(),
    sha256: args.include_hash === true ? createHash('sha256').update(handle).digest('hex') : undefined,
    fits_inline: info.size <= MEDIA_LIMITS.image_max_bytes,
  }
}

/** image_open: the picture itself, as an MCP image block the client renders. */
export async function openImage(sandbox, args = {}, { maxBytes = MEDIA_LIMITS.image_max_bytes } = {}) {
  const { resolved, info, data } = await readBounded(sandbox, args.path, maxBytes, 'an inline image')
  const header = readImageHeader(data)
  if (header === null) {
    fail('INVALID_ARGUMENT', `${resolved.relative} is not a PNG, JPEG, GIF, WebP or BMP image; use fs_read with encoding=base64 for other binary files`)
  }
  return {
    meta: {
      path: resolved.relative,
      format: header.format,
      mime_type: IMAGE_MIME[header.format],
      width: header.width,
      height: header.height,
      size: info.size,
      sha256: createHash('sha256').update(data).digest('hex'),
    },
    mimeType: IMAGE_MIME[header.format],
    data,
  }
}

function runTool(command, argv, { timeoutMs, maxBytes = 20_000_000 }) {
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
    let overflow = false
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      out.push(chunk)
    })
    child.stderr.on('data', chunk => err.push(chunk))
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
      if (overflow) { rejectRun(new ActionError('INVALID_ARGUMENT', `${command} produced more than ${maxBytes} bytes; lower the dpi`)); return }
      resolveRun({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

function parsePdfInfo(text) {
  const fields = {}
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    fields[line.slice(0, separator).trim().toLowerCase().replace(/\s+/g, '_')] = line.slice(separator + 1).trim()
  }
  return fields
}

/** pdf_info: page count and document metadata, via poppler's pdfinfo. */
export async function pdfInfo(sandbox, args = {}, { tool = 'pdfinfo' } = {}) {
  const resolved = await sandbox.resolveExisting(args.path)
  const info = await guard(() => stat(resolved.absolute), { prefix: `reading ${resolved.relative}` })
  if (!info.isFile()) fail('INVALID_ARGUMENT', `${resolved.relative} is not a regular file`)
  const result = await runTool(tool, [resolved.absolute], { timeoutMs: MEDIA_LIMITS.pdf_render_timeout_ms })
  if (result.code !== 0) {
    fail('INVALID_ARGUMENT', `${resolved.relative} could not be read as a PDF: ${result.stderr.trim() || `pdfinfo exited ${result.code}`}`)
  }
  const fields = parsePdfInfo(result.stdout.toString('utf8'))
  const pages = Number.parseInt(fields.pages ?? '', 10)
  return {
    path: resolved.relative,
    pages: Number.isFinite(pages) ? pages : undefined,
    title: fields.title || undefined,
    author: fields.author || undefined,
    creator: fields.creator || undefined,
    producer: fields.producer || undefined,
    creation_date: fields.creationdate || undefined,
    page_size: fields.page_size || undefined,
    encrypted: fields.encrypted !== undefined ? !fields.encrypted.startsWith('no') : undefined,
    size: info.size,
    fields,
  }
}

/**
 * pdf_render_page: one page as a PNG image block. Rendering goes to poppler's
 * stdout, so nothing temporary is ever written into the workspace unless the
 * caller explicitly asks for save_to.
 */
export async function renderPdfPage(sandbox, args = {}, { tool = 'pdftoppm', maxBytes = MEDIA_LIMITS.image_max_bytes } = {}) {
  const resolved = await sandbox.resolveExisting(args.path)
  const page = args.page ?? 1
  if (!Number.isInteger(page) || page < 1 || page > MEDIA_LIMITS.pdf_max_page) {
    fail('INVALID_ARGUMENT', `page must be an integer from 1 to ${MEDIA_LIMITS.pdf_max_page}`)
  }
  const dpi = args.dpi ?? MEDIA_LIMITS.pdf_default_dpi
  if (!Number.isInteger(dpi) || dpi < 30 || dpi > MEDIA_LIMITS.pdf_max_dpi) {
    fail('INVALID_ARGUMENT', `dpi must be an integer from 30 to ${MEDIA_LIMITS.pdf_max_dpi}`)
  }
  const argv = ['-png', '-singlefile', '-f', String(page), '-l', String(page), '-r', String(dpi)]
  if (args.grayscale === true) argv.push('-gray')
  argv.push(resolved.absolute)
  const result = await runTool(tool, argv, { timeoutMs: MEDIA_LIMITS.pdf_render_timeout_ms, maxBytes })
  if (result.code !== 0 || result.stdout.length === 0) {
    fail('INVALID_ARGUMENT', `page ${page} of ${resolved.relative} could not be rendered: ${result.stderr.trim() || `pdftoppm exited ${result.code}`}. Check pdf_info for the page count.`)
  }
  const header = readImageHeader(result.stdout)
  const meta = {
    path: resolved.relative,
    page,
    dpi,
    mime_type: 'image/png',
    width: header?.width,
    height: header?.height,
    bytes: result.stdout.length,
    sha256: createHash('sha256').update(result.stdout).digest('hex'),
  }
  if (typeof args.save_to === 'string' && args.save_to !== '') {
    const destination = await sandbox.resolveForWrite(args.save_to)
    await guard(async () => {
      await mkdir(dirname(destination.absolute), { recursive: true })
      await writeFile(destination.absolute, result.stdout)
    }, { prefix: `writing ${destination.relative}` })
    meta.saved_to = destination.relative
  }
  return { meta, mimeType: 'image/png', data: result.stdout }
}
