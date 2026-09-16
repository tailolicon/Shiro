import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ActionError, fail } from './action-errors.js'
import { BUSY_POLICY } from './browser-ownership.js'
import { readImageHeader } from './media-actions.js'

export const COLLECT_IMAGE_LIMITS = Object.freeze({
  max_bytes_default: 32 * 1024 * 1024,
  max_bytes_cap: 64 * 1024 * 1024,
  chunk_bytes: 120_000,
  timeout_default_ms: 30_000,
  timeout_max_ms: 60_000,
})

const MIME_BY_FORMAT = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' })

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

function parseEvaluateJson(payload, label) {
  if (typeof payload?.json !== 'string') fail('PROCESS_FAILED', `${label} returned no JSON result`)
  try { return JSON.parse(payload.json) } catch { fail('PROCESS_FAILED', `${label} returned invalid JSON`) }
}

function initExpression({ key, imageAlt, generatedFileId }) {
  const alt = JSON.stringify(String(imageAlt || ''))
  const fileId = JSON.stringify(String(generatedFileId || ''))
  const cacheKey = JSON.stringify(key)
  return `(async()=>{const alt=${alt},fileId=${fileId};const imgs=[...document.images].filter(i=>(i.alt||'').startsWith('Generated image'));let img=null;if(fileId)img=imgs.find(i=>{try{return new URL(i.currentSrc||i.src,location.href).searchParams.get('id')===fileId}catch{return false}});if(!img&&alt)img=imgs.find(i=>i.alt===alt);if(!img&&!alt&&!fileId)img=imgs[imgs.length-1]||null;if(!img)throw new Error('generated image target not found');const src=img.currentSrc||img.src;const r=await fetch(src,{credentials:'include'});if(!r.ok)throw new Error('image fetch '+r.status);const b=new Uint8Array(await r.arrayBuffer());globalThis[${cacheKey}]=b;let resolvedId='';try{resolvedId=new URL(src,location.href).searchParams.get('id')||''}catch{}return {bytes:b.length,content_type:r.headers.get('content-type')||'',alt:img.alt||'',src,file_id:resolvedId,natural_width:img.naturalWidth||0,natural_height:img.naturalHeight||0};})()`
}

function chunkExpression(key, offset, length) {
  const cacheKey = JSON.stringify(key)
  return `(()=>{const b=globalThis[${cacheKey}];if(!(b instanceof Uint8Array))throw new Error('collector buffer missing');const s=b.subarray(${offset},${offset + length});let bin='';for(let i=0;i<s.length;i+=32768)bin+=String.fromCharCode(...s.subarray(i,Math.min(i+32768,s.length)));return btoa(bin)})()`
}

function cleanupExpression(key) {
  return `(()=>{delete globalThis[${JSON.stringify(key)}];return true})()`
}

export async function collectGeneratedImage(sandbox, args = {}, { fleet, transport, now = () => Date.now(), signal } = {}) {
  if (!fleet || !transport) fail('UNSUPPORTED', 'the ChatGPT browser relay is not configured')
  const maxBytes = clampInteger(args.max_bytes, {
    min: 1024,
    max: COLLECT_IMAGE_LIMITS.max_bytes_cap,
    fallback: COLLECT_IMAGE_LIMITS.max_bytes_default,
    label: 'max_bytes',
  })
  const timeoutMs = clampInteger(args.timeout_ms, {
    min: 1000,
    max: COLLECT_IMAGE_LIMITS.timeout_max_ms,
    fallback: COLLECT_IMAGE_LIMITS.timeout_default_ms,
    label: 'timeout_ms',
  })
  if (typeof args.save_to !== 'string' || args.save_to.trim() === '') fail('INVALID_ARGUMENT', 'save_to is required')

  let capabilities
  try { capabilities = await transport.capabilities(signal) } catch (error) {
    throw new ActionError('UNSUPPORTED', `the browser relay is unreachable: ${error.message}`, { retryable: true })
  }
  if (capabilities?.evaluate !== true) {
    fail('UNSUPPORTED', 'collecting exact generated-image bytes requires the relay evaluate capability')
  }

  // Read-only with respect to ChatGPT: collection may happen even while the model turn is still finishing.
  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.allow,
    action: 'collecting a generated image',
  })
  const destination = await sandbox.resolveForWrite(args.save_to.trim())
  let existing = null
  try { existing = await stat(destination.absolute) } catch { existing = null }
  if (existing !== null && args.overwrite !== true) {
    fail('ALREADY_EXISTS', `${destination.relative} already exists; pass overwrite=true to replace it`)
  }

  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'collecting a generated image')
  const key = `__shiro_collect_${randomUUID().replaceAll('-', '')}`
  let init
  try {
    init = parseEvaluateJson(await transport.evaluate(record.browser_client_id, {
      expression: initExpression({ key, imageAlt: args.image_alt, generatedFileId: args.generated_file_id }),
      maxResultBytes: 50_000,
      timeoutMs,
    }, signal), 'image collector init')
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError('PROCESS_FAILED', `failed to fetch generated image in browser tab ${record.browser_tab_id}: ${error.message}`)
  }
  if (!Number.isInteger(init?.bytes) || init.bytes <= 0) fail('PROCESS_FAILED', 'generated image returned zero bytes')
  if (init.bytes > maxBytes) fail('INVALID_ARGUMENT', `generated image is ${init.bytes} bytes, over max_bytes ${maxBytes}`)

  const temporary = `${destination.absolute}.shiro-collect`
  const hash = createHash('sha256')
  let firstChunk = null
  let written = 0
  let handle
  try {
    await mkdir(dirname(destination.absolute), { recursive: true })
    handle = await open(temporary, 'w', 0o644)
    for (let offset = 0; offset < init.bytes; offset += COLLECT_IMAGE_LIMITS.chunk_bytes) {
      await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'collecting a generated image')
      const length = Math.min(COLLECT_IMAGE_LIMITS.chunk_bytes, init.bytes - offset)
      const encoded = parseEvaluateJson(await transport.evaluate(record.browser_client_id, {
        expression: chunkExpression(key, offset, length),
        maxResultBytes: 190_000,
        timeoutMs,
      }, signal), `image collector chunk ${offset}`)
      if (typeof encoded !== 'string' || encoded === '') fail('PROCESS_FAILED', `empty generated-image chunk at ${offset}`)
      const chunk = Buffer.from(encoded, 'base64')
      if (chunk.length !== length) fail('PROCESS_FAILED', `generated-image chunk length mismatch at ${offset}`)
      if (firstChunk === null) firstChunk = chunk
      hash.update(chunk)
      await handle.write(chunk, 0, chunk.length, offset)
      written += chunk.length
    }
    await handle.sync()
    await handle.close(); handle = undefined
    if (written !== init.bytes) fail('PROCESS_FAILED', `collected ${written} bytes, expected ${init.bytes}`)
    const header = readImageHeader(firstChunk)
    if (!header || !MIME_BY_FORMAT[header.format]) fail('PROCESS_FAILED', 'generated image bytes are not PNG/JPEG/WebP')
    await rename(temporary, destination.absolute)
    const sha256 = hash.digest('hex')
    transport.evaluate(record.browser_client_id, {
      expression: cleanupExpression(key), maxResultBytes: 2_000, timeoutMs: Math.min(timeoutMs, 5_000),
    }, signal).catch(() => {})
    return {
      browser_tab_id: record.browser_tab_id,
      fleet: record.fleet,
      slot: record.slot,
      conversation_url: String(record.url || ''),
      path: destination.relative,
      bytes: written,
      sha256,
      mime_type: MIME_BY_FORMAT[header.format],
      width: header.width,
      height: header.height,
      generated_file_id: String(init.file_id || ''),
      dom_alt: String(init.alt || ''),
      source_url: String(init.src || ''),
      natural_width: Number(init.natural_width) || undefined,
      natural_height: Number(init.natural_height) || undefined,
      overwrote: existing !== null,
      collected_at: new Date(now()).toISOString(),
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    transport.evaluate(record.browser_client_id, {
      expression: cleanupExpression(key), maxResultBytes: 2_000, timeoutMs: Math.min(timeoutMs, 5_000),
    }, signal).catch(() => {})
    throw error
  }
}
