import { createHash } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ActionError, fail, guard } from './action-errors.js'
import { BUSY_POLICY } from './browser-ownership.js'
import { readImageHeader } from './media-actions.js'

// browser_tab_screenshot: what a Shiro-owned tab currently looks like.
//
// Shape of the pipeline, in this order and no other:
//
//   verified owned-tab gate -> capability check -> destination validation
//   -> ownership re-check -> relay capture -> bounded/validated bytes
//   -> atomic write into the workspace -> metadata + resource uri
//
// The image never travels back inside the JSON result. A screenshot is
// hundreds of kilobytes of base64 that would blow out the tool result and land
// in conversation context for no reason; it goes to a file in the workspace and
// the caller gets the same shiro:// resource uri every other artifact uses (and
// can look at it with image_open).

export const SCREENSHOT_LIMITS = Object.freeze({
  max_bytes_default: 4_000_000,
  max_bytes_cap: 6_000_000,
  timeout_default_ms: 20_000,
  timeout_max_ms: 60_000,
  min_width: 320,
  max_width: 4096,
  default_directory: '.shiro/screenshots',
})

export const SCREENSHOT_FORMATS = Object.freeze(['png', 'webp'])

const MIME = Object.freeze({ png: 'image/png', webp: 'image/webp' })

// The relay route and the extension capability this action needs. Kept here so
// the UNSUPPORTED message tells an operator exactly what is missing rather than
// "not supported".
export const SCREENSHOT_RELAY_CONTRACT = Object.freeze({
  route: 'POST /browser/tabs/screenshot',
  capability_flag: 'capabilities.browser.screenshot',
  extension_permission: 'a Chrome permission that can capture a background tab (activeTab/<all_urls> for tabs.captureVisibleTab, or debugger for Page.captureScreenshot)',
})

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

/**
 * Decode and sanity-check what the relay returned. A relay that answers with
 * something other than one bounded image of the requested format is a bug or a
 * compromise, and either way its bytes must not be written to disk.
 */
export function decodeCapture(payload, { format, maxBytes }) {
  const image = payload?.image ?? payload
  const encoded = image?.data_base64 ?? image?.dataBase64 ?? image?.data
  if (typeof encoded !== 'string' || encoded.trim() === '') {
    fail('PROCESS_FAILED', 'the browser relay returned no image data for this capture')
  }
  if (encoded.length > maxBytes * 2) {
    // Bound before allocating: base64 is 4/3 of the payload, so this rejects an
    // oversized capture without materializing it.
    fail('INVALID_ARGUMENT', `the capture is larger than max_bytes (${maxBytes}); lower max_width, use format=webp, or raise max_bytes`)
  }
  let bytes
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    fail('PROCESS_FAILED', 'the browser relay returned image data that is not valid base64')
  }
  if (bytes.length === 0) fail('PROCESS_FAILED', 'the browser relay returned an empty image')
  if (bytes.length > maxBytes) {
    fail('INVALID_ARGUMENT', `the capture is ${bytes.length} bytes, over max_bytes ${maxBytes}; lower max_width, use format=webp, or raise max_bytes`)
  }
  const header = readImageHeader(bytes)
  if (header === null || header.format !== format) {
    // Never trust a claimed content type: the magic bytes decide.
    fail('PROCESS_FAILED', `the browser relay returned ${header?.format ?? 'unrecognized'} data where ${format} was requested`)
  }
  return { bytes, width: header.width, height: header.height }
}

/**
 * @param sandbox workspace Sandbox for the destination path.
 * @param fleet FleetManager, the ownership authority (resolveOwnedTab/recheckOwnedTab).
 * @param transport relay transport (capabilities/screenshot).
 */
export async function captureOwnedTabScreenshot(sandbox, args = {}, { fleet, transport, now = () => Date.now(), signal } = {}) {
  if (fleet === null || fleet === undefined || transport === null || transport === undefined) {
    fail('UNSUPPORTED', 'the ChatGPT browser relay is not configured on this deployment; bridge_capabilities reports fleet=false')
  }
  const format = args.format ?? 'png'
  if (!SCREENSHOT_FORMATS.includes(format)) fail('INVALID_ARGUMENT', `format must be one of ${SCREENSHOT_FORMATS.join(', ')}`)
  const maxBytes = clampInteger(args.max_bytes, { min: 1024, max: SCREENSHOT_LIMITS.max_bytes_cap, fallback: SCREENSHOT_LIMITS.max_bytes_default, label: 'max_bytes' })
  const maxWidth = clampInteger(args.max_width, { min: SCREENSHOT_LIMITS.min_width, max: SCREENSHOT_LIMITS.max_width, fallback: undefined, label: 'max_width' })
  const timeoutMs = clampInteger(args.timeout_ms, { min: 1000, max: SCREENSHOT_LIMITS.timeout_max_ms, fallback: SCREENSHOT_LIMITS.timeout_default_ms, label: 'timeout_ms' })
  const fullPage = args.full_page === true

  // Capability first: an operator who has not extended the relay gets a precise
  // answer instead of a confusing relay 404 halfway through the pipeline.
  let capabilities
  try {
    capabilities = await transport.capabilities(signal)
  } catch (error) {
    throw new ActionError('UNSUPPORTED', `the browser relay is unreachable, so no capture can run: ${error.message}`, { retryable: true })
  }
  if (capabilities?.screenshot !== true) {
    fail('UNSUPPORTED', `this browser relay build exposes no screenshot route. Capturing a tab needs the relay to expose ${SCREENSHOT_RELAY_CONTRACT.route} and advertise ${SCREENSHOT_RELAY_CONTRACT.capability_flag}=true, which in turn needs ${SCREENSHOT_RELAY_CONTRACT.extension_permission}. bridge_capabilities reports features.browser_screenshot=false until then.`)
  }

  // Screenshots are read-only, so unlike click/type they may run while the tab
  // is generating -- watching a response arrive is a legitimate use.
  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.allow,
    action: 'capturing a screenshot',
  })

  const destination = await sandbox.resolveForWrite(
    typeof args.save_to === 'string' && args.save_to.trim() !== ''
      ? args.save_to.trim()
      : `${SCREENSHOT_LIMITS.default_directory}/tab-${record.browser_tab_id}-${stamp(now())}.${format}`,
  )
  let existing = null
  try { existing = await stat(destination.absolute) } catch { existing = null }
  if (existing !== null && args.overwrite !== true) {
    fail('ALREADY_EXISTS', `${destination.relative} already exists; pass overwrite=true to replace it`)
  }

  // Re-check immediately before the relay call: the tab may have navigated,
  // closed, or been recycled into another slot while the path was validated.
  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'capturing a screenshot')

  let payload
  try {
    payload = await transport.screenshot(record.browser_client_id, { format, fullPage, maxWidth, timeoutMs }, signal)
  } catch (error) {
    throw new ActionError('PROCESS_FAILED', `the browser relay could not capture browser tab ${record.browser_tab_id}: ${error.message}`)
  }

  const temporary = `${destination.absolute}.shiro-capture`
  try {
    const { bytes, width, height } = decodeCapture(payload, { format, maxBytes })
    await guard(async () => {
      await mkdir(dirname(destination.absolute), { recursive: true })
      await writeFile(temporary, bytes, { mode: 0o644 })
      await rename(temporary, destination.absolute)
    }, { prefix: `writing ${destination.relative}` })
    return {
      browser_tab_id: record.browser_tab_id,
      fleet: record.fleet,
      slot: record.slot,
      url: record.url,
      busy: record.busy,
      path: destination.relative,
      format,
      mime_type: MIME[format],
      full_page: fullPage,
      width,
      height,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      overwrote: existing !== null,
      captured_at: new Date(now()).toISOString(),
    }
  } catch (error) {
    // Never leave a partial capture behind, whatever went wrong above.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
