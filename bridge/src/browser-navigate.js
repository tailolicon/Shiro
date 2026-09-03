import { ActionError, fail, requireConfirmation } from './action-errors.js'
import { BUSY_POLICY } from './browser-ownership.js'

// browser_tab_navigate: point a Shiro-owned tab at a URL.
//
// Same pipeline as the capture: owned-tab gate -> capability -> validation ->
// ownership re-check -> relay -> bounded result.
//
// Two things are deliberately NOT blocked, because this runs on the operator's
// own machine and driving a local dev server is the point: localhost, 127.0.0.1
// and private/LAN addresses are all allowed. What stays blocked is schemes that
// are not useful as navigation targets and are useful as an escape hatch --
// javascript: (arbitrary execution with none of Runtime.evaluate's bounds),
// data:/blob: (content smuggled past every check), and file:/chrome:/
// chrome-extension:/devtools:/about: (the browser's own surfaces).

export const NAVIGATE_LIMITS = Object.freeze({
  timeout_default_ms: 30_000,
  timeout_max_ms: 120_000,
  max_url_length: 8_192,
})

export const WAIT_UNTIL = Object.freeze(['none', 'commit', 'load'])

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com'])

export function parseTargetUrl(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') fail('INVALID_ARGUMENT', 'url is required')
  if (raw.length > NAVIGATE_LIMITS.max_url_length) {
    fail('INVALID_ARGUMENT', `url is longer than ${NAVIGATE_LIMITS.max_url_length} characters`)
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    fail('INVALID_ARGUMENT', `url is not a valid absolute URL: ${raw}`)
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    fail('INVALID_ARGUMENT', `${url.protocol.replace(':', '')} URLs cannot be navigation targets; only http and https are allowed (localhost and private addresses are fine)`)
  }
  if (url.username !== '' || url.password !== '') {
    fail('INVALID_ARGUMENT', 'url must not embed credentials')
  }
  return url
}

export function isChatGptUrl(url) {
  try {
    return CHATGPT_ORIGINS.has(new URL(url).origin)
  } catch {
    return false
  }
}

/**
 * @param fleet FleetManager: the ownership authority and the source of truth
 *   for whether the tab is currently doing scheduled work.
 */
export async function navigateOwnedTab(args = {}, { fleet, transport, signal } = {}) {
  if (fleet === null || fleet === undefined || transport === null || transport === undefined) {
    fail('UNSUPPORTED', 'the ChatGPT browser relay is not configured on this deployment; bridge_capabilities reports fleet=false')
  }
  const url = parseTargetUrl(args.url)
  const waitUntil = args.wait_until ?? 'load'
  if (!WAIT_UNTIL.includes(waitUntil)) fail('INVALID_ARGUMENT', `wait_until must be one of ${WAIT_UNTIL.join(', ')}`)
  const timeoutMs = args.timeout_ms ?? NAVIGATE_LIMITS.timeout_default_ms
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > NAVIGATE_LIMITS.timeout_max_ms) {
    fail('INVALID_ARGUMENT', `timeout_ms must be an integer from 1000 to ${NAVIGATE_LIMITS.timeout_max_ms}`)
  }

  let capabilities
  try {
    capabilities = await transport.capabilities(signal)
  } catch (error) {
    throw new ActionError('UNSUPPORTED', `the browser relay is unreachable, so no navigation can run: ${error.message}`, { retryable: true })
  }
  if (capabilities?.navigate !== true) {
    fail('UNSUPPORTED', 'this browser relay build exposes no navigation route. It needs POST /browser/tabs/navigate and capabilities.browser.navigate=true, which requires the CDP-capable extension (permission "debugger"). bridge_capabilities reports features.browser_navigate=false until then.')
  }

  // Navigating mid-generation throws away the response being streamed.
  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.refuse,
    action: 'navigating the tab',
  })

  // Leaving ChatGPT turns a worker tab into something the fleet can no longer
  // verify as its own chat. That is fine when the operator means it, and is
  // never worth doing silently underneath a fleet that is actively scheduling.
  if (!isChatGptUrl(url)) {
    const fleetRunning = await fleetIsRunning(fleet, record.fleet)
    if (fleetRunning) {
      fail('BUSY', `browser tab ${record.browser_tab_id} is slot ${record.slot} of the running fleet ${record.fleet}; navigating it away from ChatGPT would take that worker out of service. Stop the fleet with fleet_stop first, or recycle the slot.`)
    }
    requireConfirmation(args.confirm, `Navigate ${record.fleet} slot ${record.slot} away from ChatGPT to ${url.origin}, which ends that tab's usefulness as a ChatGPT worker`)
  }

  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'navigating the tab')

  let payload
  try {
    payload = await transport.navigate(record.browser_client_id, {
      url: url.toString(),
      waitUntil,
      timeoutMs,
    }, signal)
  } catch (error) {
    throw new ActionError('PROCESS_FAILED', `the browser relay could not navigate browser tab ${record.browser_tab_id}: ${error.message}`)
  }

  const finalUrl = String(payload?.url || url.toString())
  return {
    browser_tab_id: record.browser_tab_id,
    fleet: record.fleet,
    slot: record.slot,
    requested_url: url.toString(),
    url: finalUrl,
    left_chatgpt: !isChatGptUrl(finalUrl),
    wait_until: waitUntil,
    loaded: payload?.loaded === true,
    ...(payload?.loadError ? { load_error: String(payload.loadError).slice(0, 400) } : {}),
    frame_id: payload?.frameId ? String(payload.frameId) : undefined,
  }
}

async function fleetIsRunning(fleet, name) {
  if (typeof fleet.status !== 'function' || typeof name !== 'string' || name === '') return false
  try {
    const snapshot = await fleet.status(name)
    return snapshot?.running === true
  } catch {
    return false
  }
}
