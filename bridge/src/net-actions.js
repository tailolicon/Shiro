import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { asActionError, fail, guard } from './action-errors.js'

// download_file: pull one URL into the workspace.
//
// The bridge had no way to bring bytes in. fs_create_file with base64 covers a
// small inline file, but a release archive, a dataset, a font or a model
// checkpoint cannot travel through a JSON tool argument, and depending on curl
// or wget being installed (and on the model quoting a shell command correctly)
// is not a primitive. This is: a typed action with a byte cap, a hash, an
// atomic rename and an explicit confirmation gate, because it both leaves the
// machine and writes to disk.

export const NET_LIMITS = Object.freeze({
  max_bytes_default: 26_214_400,
  max_bytes_cap: 209_715_200,
  timeout_default_ms: 60_000,
  timeout_max_ms: 600_000,
  max_redirects: 5,
})

// Link-local space is where cloud instance-metadata services live. A model
// following a link out of a web page must never be able to read credentials
// out of 169.254.169.254; nothing legitimate is downloaded from there.
function isBlockedAddress(address, family) {
  if (family === 4) return address.startsWith('169.254.')
  const normalized = address.toLowerCase()
  return normalized.startsWith('fe80:') || normalized === '::ffff:169.254.169.254' || normalized.startsWith('::ffff:169.254.')
}

export function parseDownloadUrl(value, label = 'url') {
  let url
  try {
    url = new URL(String(value))
  } catch {
    fail('INVALID_ARGUMENT', `${label} is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('INVALID_ARGUMENT', `${label} must be http or https, not ${url.protocol.replace(':', '')}`)
  }
  if (url.username !== '' || url.password !== '') {
    fail('INVALID_ARGUMENT', `${label} must not embed credentials; pass them as headers if the server needs them`)
  }
  return url
}

async function assertResolvable(url) {
  let addresses
  try {
    addresses = await lookup(url.hostname, { all: true })
  } catch {
    return // let fetch report DNS failures with its own message
  }
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address, entry.family)) {
      fail('PERMISSION_REQUIRED', `${url.hostname} resolves to link-local address ${entry.address}; downloads from instance-metadata space are refused`)
    }
  }
}

function statusError(status, url) {
  if (status === 404 || status === 410) return { code: 'NOT_FOUND', message: `${url} returned ${status}` }
  if (status === 401 || status === 403) return { code: 'PERMISSION_REQUIRED', message: `${url} returned ${status}: the server refused this request` }
  if (status === 408 || status === 429) return { code: 'BUSY', message: `${url} returned ${status}` }
  return { code: 'PROCESS_FAILED', message: `${url} returned HTTP ${status}` }
}

/**
 * Follow redirects by hand so every hop is re-validated (scheme, credentials,
 * link-local target) and the chain stays short and reportable.
 */
async function resolveResponse(url, { headers, signal, fetchImpl }) {
  const chain = []
  let current = url
  for (let hop = 0; hop <= NET_LIMITS.max_redirects; hop += 1) {
    await assertResolvable(current)
    const response = await fetchImpl(current, { redirect: 'manual', headers, signal })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location') !== null) {
      const next = parseDownloadUrl(new URL(response.headers.get('location'), current).toString(), 'redirect target')
      await response.body?.cancel?.().catch(() => {})
      chain.push({ from: current.toString(), to: next.toString(), status: response.status })
      current = next
      continue
    }
    return { response, finalUrl: current, chain }
  }
  fail('PROCESS_FAILED', `${url} redirected more than ${NET_LIMITS.max_redirects} times`)
}

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

/**
 * The file object ChatGPT's connector runtime hands to a tool input declared in
 * `_meta["openai/fileParams"]`. Documented shape: download_url and file_id
 * always present, mime_type and file_name optional. Field reports also describe
 * a bare string arriving instead (a file id, or a ChatGPT-container path like
 * /mnt/data/x.zip), so this normalizes every observed form and says precisely
 * what happened for the ones that carry no fetchable URL.
 */
export function normalizeFileReference(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') fail('INVALID_ARGUMENT', 'file is an empty string')
    if (/^https?:\/\//i.test(trimmed)) return { download_url: trimmed }
    if (trimmed.startsWith('/')) {
      fail('UNSUPPORTED', `the connector passed the container path ${trimmed} instead of a file object. That path exists inside ChatGPT's own sandbox, not on this machine, so the bytes never reached the connector. Re-attach the file so the runtime sends a file object with download_url, or give artifact_import a source_url.`)
    }
    fail('UNSUPPORTED', `the connector passed only the file id ${trimmed}, with no download_url. Fetching by id alone would need OpenAI Files API credentials, which this bridge deliberately does not hold. Re-attach the file so the runtime sends the documented file object, or pass source_url.`)
  }
  if (value === null || typeof value !== 'object') {
    fail('INVALID_ARGUMENT', 'file must be the file object the connector supplies ({download_url, file_id, mime_type?, file_name?}) or a source_url string')
  }
  const url = value.download_url ?? value.downloadUrl
  if (typeof url !== 'string' || url.trim() === '') {
    fail('UNSUPPORTED', `the file object carried no download_url (keys: ${Object.keys(value).join(', ') || 'none'}). Without it there is nothing to fetch; pass source_url instead if you have a direct link.`)
  }
  return {
    download_url: url.trim(),
    file_id: typeof value.file_id === 'string' ? value.file_id : typeof value.fileId === 'string' ? value.fileId : undefined,
    mime_type: typeof value.mime_type === 'string' ? value.mime_type : typeof value.mimeType === 'string' ? value.mimeType : undefined,
    file_name: typeof value.file_name === 'string' ? value.file_name : typeof value.fileName === 'string' ? value.fileName : undefined,
  }
}

/** Strip a caller-supplied name down to one safe path segment. */
export function safeBasename(value, fallback = 'imported-file') {
  if (typeof value !== 'string') return fallback
  const last = value.split(/[\\/]/).pop() ?? ''
  const cleaned = last.replace(/[\0-\x1f\x7f]/g, '').replace(/^\.+/, '').trim()
  return cleaned === '' ? fallback : cleaned.slice(0, 120)
}

/**
 * artifact_import: bring a file the user attached in ChatGPT into a workspace.
 *
 * The connector runtime turns the attachment into a file reference carrying a
 * download_url, so the transfer is an ordinary fetch and reuses downloadFile
 * wholesale -- same byte cap, same atomic temp-then-rename, same hash, same
 * refusal of credentialled URLs and link-local hosts. Nothing about the import
 * path is more trusted than a plain download: download_url is model-reachable
 * text, so it goes through exactly the same gate.
 */
export async function importArtifact(sandbox, args = {}, options = {}) {
  if ((args.file === undefined) === (args.source_url === undefined)) {
    fail('INVALID_ARGUMENT', 'pass exactly one of file (the attachment the connector supplies) or source_url (a direct link)')
  }
  const reference = args.file === undefined
    ? { download_url: String(args.source_url) }
    : normalizeFileReference(args.file)
  const destination = typeof args.destination === 'string' && args.destination.trim() !== ''
    ? args.destination.trim()
    : safeBasename(reference.file_name ?? new URL(reference.download_url).pathname, reference.file_id ?? 'imported-file')
  const result = await downloadFile(sandbox, {
    url: reference.download_url,
    path: destination,
    overwrite: args.overwrite,
    create_parents: true,
    max_bytes: args.max_bytes,
    expected_sha256: args.expected_sha256,
  }, options)
  return {
    ...result,
    imported: true,
    file_id: reference.file_id,
    file_name: reference.file_name,
    declared_mime_type: reference.mime_type,
  }
}

export async function downloadFile(sandbox, args = {}, { fetchImpl = fetch, signal } = {}) {
  const url = parseDownloadUrl(args.url)
  const maxBytes = clampInteger(args.max_bytes, { min: 1, max: NET_LIMITS.max_bytes_cap, fallback: NET_LIMITS.max_bytes_default, label: 'max_bytes' })
  const timeoutMs = clampInteger(args.timeout_ms, { min: 1000, max: NET_LIMITS.timeout_max_ms, fallback: NET_LIMITS.timeout_default_ms, label: 'timeout_ms' })
  const destination = await sandbox.resolveForWrite(args.path)

  let existing = null
  try {
    existing = await stat(destination.absolute)
  } catch { existing = null }
  if (existing !== null && args.overwrite !== true) {
    fail('ALREADY_EXISTS', `${destination.relative} already exists (${existing.size} bytes); pass overwrite=true to replace it`)
  }

  const headers = { 'user-agent': 'Shiro-Bridge/0.1 (+download_file)', accept: '*/*' }
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) fail('INVALID_ARGUMENT', `header name is not valid: ${name}`)
    if (typeof value !== 'string' || /[\r\n]/.test(value)) fail('INVALID_ARGUMENT', `header ${name} must be a single-line string`)
    headers[name.toLowerCase()] = value
  }

  // Same rule as fs_create_file: a missing parent is an explicit opt-in, not a
  // silent mkdir -p that could scatter directories on a typo'd path.
  if (args.create_parents === true) {
    await guard(() => mkdir(dirname(destination.absolute), { recursive: true }), { prefix: `creating the parent of ${destination.relative}` })
  } else {
    try {
      await stat(dirname(destination.absolute))
    } catch {
      fail('NOT_FOUND', `parent directory does not exist: ${sandbox.relative(dirname(destination.absolute))}. Pass create_parents=true or call fs_mkdir first.`)
    }
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`download timed out after ${timeoutMs} ms`))
  }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(new Error('download aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })

  const temporary = `${destination.absolute}.shiro-download-${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  try {
    const { response, finalUrl, chain } = await resolveResponse(url, { headers, signal: controller.signal, fetchImpl })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      const failure = statusError(response.status, finalUrl.toString())
      fail(failure.code, failure.message)
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel?.().catch(() => {})
      fail('INVALID_ARGUMENT', `${finalUrl} is ${declared} bytes; max_bytes is ${maxBytes}. Raise max_bytes (cap ${NET_LIMITS.max_bytes_cap}) or fetch a smaller file.`)
    }
    if (response.body === null) fail('PROCESS_FAILED', `${finalUrl} returned no body`)

    const hash = createHash('sha256')
    let received = 0
    const meter = new Transform({
      transform(chunk, _encoding, next) {
        received += chunk.length
        if (received > maxBytes) {
          next(Object.assign(new Error(`response exceeded max_bytes (${maxBytes}); download aborted after ${received} bytes`), { shiroCode: 'INVALID_ARGUMENT' }))
          return
        }
        hash.update(chunk)
        next(null, chunk)
      },
    })
    await pipeline(response.body, meter, createWriteStream(temporary, { mode: 0o644 }))

    const sha256 = hash.digest('hex')
    if (typeof args.expected_sha256 === 'string' && args.expected_sha256.toLowerCase() !== sha256) {
      await rm(temporary, { force: true })
      fail('CONFLICT', `downloaded content hashes to ${sha256}, not the expected ${args.expected_sha256}; the file was discarded`)
    }
    // Atomic publish: a reader never sees a half-written file at `path`.
    await guard(() => rename(temporary, destination.absolute), { prefix: 'publishing the download' })
    return {
      url: url.toString(),
      final_url: finalUrl.toString(),
      path: destination.relative,
      status: response.status,
      bytes: received,
      sha256,
      content_type: response.headers.get('content-type') ?? undefined,
      redirects: chain,
      overwrote: existing !== null,
      duration_ms: Date.now() - startedAt,
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    if (error?.shiroCode !== undefined) fail(error.shiroCode, error.message)
    if (error?.cause?.shiroCode !== undefined) fail(error.cause.shiroCode, error.cause.message)
    // The abort surfaces from fetch or from the stream pipeline with different
    // shapes; the flag is what actually knows why the transfer stopped.
    if (timedOut) fail('TIMEOUT', `downloading ${url} timed out after ${timeoutMs} ms`)
    if (controller.signal.aborted) fail('TIMEOUT', controller.signal.reason?.message ?? `downloading ${url} was aborted`)
    throw asActionError(error, 'PROCESS_FAILED', `downloading ${url}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
