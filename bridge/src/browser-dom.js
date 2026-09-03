import { ActionError, fail, requireConfirmation } from './action-errors.js'
import { BUSY_POLICY } from './browser-ownership.js'

// browser_dom_query / browser_tab_click / browser_tab_type.
//
// The public flow is deliberately handle-based rather than coordinate-based: a
// query returns opaque element handles, and click/type name a handle, which is
// resolved again inside the page at the moment of the interaction. Clicking a
// point the caller measured earlier clicks whatever has since moved under it.
//
// Handles are scoped twice. The page-side registry keys them by document
// generation, so a navigation or reload invalidates every handle from the old
// document. This layer adds the tab: a public handle carries the tab id, and a
// handle minted on one tab is refused on another before the relay is touched.

export const DOM_LIMITS = Object.freeze({
  max_results: 200,
  default_results: 50,
  max_text_bytes: 4_000,
  default_text_bytes: 400,
  max_selector_length: 2_000,
  max_text_length: 20_000,
  timeout_default_ms: 15_000,
  timeout_max_ms: 60_000,
})

export const CLICK_BUTTONS = Object.freeze(['left', 'right', 'middle'])
export const TYPE_MODES = Object.freeze(['append', 'replace'])

/** Public handle = tab + page handle, so a handle cannot cross tabs. */
export function encodeHandle(tabId, pageHandle) {
  return `t${tabId}.${pageHandle}`
}

export function decodeHandle(value, expectedTabId) {
  const raw = String(value ?? '').trim()
  const match = /^t(\d+)\.(.+)$/.exec(raw)
  if (match === null) fail('INVALID_ARGUMENT', 'element_id is not an element handle from browser_dom_query')
  const tabId = Number(match[1])
  if (tabId !== expectedTabId) {
    // Not a leak: the caller already knows both tab ids -- it holds the handle
    // and it named the tab. Refusing loudly beats clicking the wrong page.
    fail('CONFLICT', `this element handle belongs to browser tab ${tabId}, not ${expectedTabId}; element handles never cross tabs`)
  }
  return match[2]
}

function requireRelay(fleet, transport) {
  if (fleet === null || fleet === undefined || transport === null || transport === undefined) {
    fail('UNSUPPORTED', 'the ChatGPT browser relay is not configured on this deployment; bridge_capabilities reports fleet=false')
  }
}

async function requireDomCapability(transport, signal) {
  let capabilities
  try {
    capabilities = await transport.capabilities(signal)
  } catch (error) {
    throw new ActionError('UNSUPPORTED', `the browser relay is unreachable: ${error.message}`, { retryable: true })
  }
  if (capabilities?.dom !== true) {
    fail('UNSUPPORTED', 'this browser relay build exposes no DOM routes. They need POST /browser/dom/query|click|type and capabilities.browser.dom=true, which requires the CDP-capable extension (permission "debugger"). bridge_capabilities reports features.browser_dom=false until then.')
  }
}

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

function relayFailure(action, tabId, error) {
  const message = String(error?.message || error)
  // The extension answers a stale handle with a specific sentence; surface it
  // as CONFLICT so a client knows to re-query rather than retry blindly.
  if (/document was replaced|previous document generation|not known to the current document|removed from the document/i.test(message)) {
    return new ActionError('CONFLICT', `${message}. Run browser_dom_query again to get fresh element handles.`)
  }
  if (/not visible|disabled|does not accept typed text|password or one-time-code/i.test(message)) {
    return new ActionError('INVALID_ARGUMENT', message)
  }
  return new ActionError('PROCESS_FAILED', `the browser relay could not ${action} on browser tab ${tabId}: ${message}`)
}

/** browser_dom_query: bounded, structured descriptors plus fresh handles. */
export async function queryOwnedTabDom(args = {}, { fleet, transport, signal } = {}) {
  requireRelay(fleet, transport)
  const selector = String(args.selector ?? '').trim()
  if (selector === '') fail('INVALID_ARGUMENT', 'selector is required')
  if (selector.length > DOM_LIMITS.max_selector_length) fail('INVALID_ARGUMENT', `selector is longer than ${DOM_LIMITS.max_selector_length} characters`)
  const maxResults = clampInteger(args.max_results, { min: 1, max: DOM_LIMITS.max_results, fallback: DOM_LIMITS.default_results, label: 'max_results' })
  const maxTextBytes = clampInteger(args.max_text_bytes, { min: 0, max: DOM_LIMITS.max_text_bytes, fallback: DOM_LIMITS.default_text_bytes, label: 'max_text_bytes' })
  const timeoutMs = clampInteger(args.timeout_ms, { min: 1000, max: DOM_LIMITS.timeout_max_ms, fallback: DOM_LIMITS.timeout_default_ms, label: 'timeout_ms' })
  await requireDomCapability(transport, signal)

  // Reading the page is safe while a response streams.
  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.allow,
    action: 'querying the DOM',
  })
  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'querying the DOM')

  let payload
  try {
    payload = await transport.queryDom(record.browser_client_id, {
      selector,
      maxResults,
      maxTextBytes,
      visibleOnly: args.visible_only === true,
      includeHidden: args.include_hidden === true,
      timeoutMs,
    }, signal)
  } catch (error) {
    throw relayFailure('query the DOM', record.browser_tab_id, error)
  }

  const elements = (Array.isArray(payload?.elements) ? payload.elements : []).map(element => ({
    ...element,
    element_id: encodeHandle(record.browser_tab_id, String(element.element_id || '')),
  }))
  return {
    browser_tab_id: record.browser_tab_id,
    fleet: record.fleet,
    slot: record.slot,
    selector,
    url: String(payload?.url || record.url || ''),
    generation: String(payload?.generation || ''),
    elements,
    total: Number(payload?.total) || elements.length,
    returned: elements.length,
    truncated: payload?.truncated === true,
  }
}

/** browser_tab_click: click the element a handle points at, as it is now. */
export async function clickOwnedTabElement(args = {}, { fleet, transport, signal } = {}) {
  requireRelay(fleet, transport)
  const button = args.button ?? 'left'
  if (!CLICK_BUTTONS.includes(button)) fail('INVALID_ARGUMENT', `button must be one of ${CLICK_BUTTONS.join(', ')}`)
  const clickCount = clampInteger(args.click_count, { min: 1, max: 3, fallback: 1, label: 'click_count' })
  const timeoutMs = clampInteger(args.timeout_ms, { min: 1000, max: DOM_LIMITS.timeout_max_ms, fallback: DOM_LIMITS.timeout_default_ms, label: 'timeout_ms' })
  await requireDomCapability(transport, signal)

  // Clicking mid-generation can cancel or steer the response being produced.
  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.refuse,
    action: 'clicking an element',
  })
  const pageHandle = decodeHandle(args.element_id, record.browser_tab_id)
  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'clicking an element')

  let payload
  try {
    payload = await transport.clickElement(record.browser_client_id, { elementId: pageHandle, button, clickCount, timeoutMs }, signal)
  } catch (error) {
    throw relayFailure('click', record.browser_tab_id, error)
  }
  return {
    browser_tab_id: record.browser_tab_id,
    element_id: String(args.element_id),
    clicked: payload?.clicked === true,
    button,
    click_count: clickCount,
    tag: String(payload?.tag || ''),
    at: payload?.at,
    url: String(payload?.url || record.url || ''),
  }
}

/** browser_tab_type: insert text into the element a handle points at. */
export async function typeIntoOwnedTabElement(args = {}, { fleet, transport, signal } = {}) {
  requireRelay(fleet, transport)
  const text = String(args.text ?? '')
  if (text.length > DOM_LIMITS.max_text_length) {
    fail('INVALID_ARGUMENT', `text is ${text.length} characters; the limit is ${DOM_LIMITS.max_text_length}`)
  }
  const mode = args.mode ?? 'append'
  if (!TYPE_MODES.includes(mode)) fail('INVALID_ARGUMENT', `mode must be one of ${TYPE_MODES.join(', ')}`)
  const timeoutMs = clampInteger(args.timeout_ms, { min: 1000, max: DOM_LIMITS.timeout_max_ms, fallback: DOM_LIMITS.timeout_default_ms, label: 'timeout_ms' })
  await requireDomCapability(transport, signal)

  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.refuse,
    action: 'typing into an element',
  })
  const pageHandle = decodeHandle(args.element_id, record.browser_tab_id)
  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'typing into an element')

  let payload
  try {
    payload = await transport.typeIntoElement(record.browser_client_id, {
      elementId: pageHandle,
      text,
      mode,
      submit: args.submit === true,
      timeoutMs,
    }, signal)
  } catch (error) {
    throw relayFailure('type', record.browser_tab_id, error)
  }
  return {
    browser_tab_id: record.browser_tab_id,
    element_id: String(args.element_id),
    typed: payload?.typed === true,
    mode,
    // The text is never echoed back: a result is a logged artifact, and the
    // caller already knows what it sent.
    characters: text.length,
    submitted: payload?.submitted === true,
    tag: String(payload?.tag || ''),
    url: String(payload?.url || record.url || ''),
  }
}

export const EVALUATE_LIMITS = Object.freeze({
  max_expression_length: 20_000,
  max_result_bytes: 200_000,
  default_result_bytes: 50_000,
})

/**
 * browser_tab_evaluate: run the caller's JavaScript in an owned tab.
 *
 * Deliberately last and deliberately gated. Everything above it -- query,
 * click, type, navigate, screenshot -- covers the automation a page normally
 * needs, with per-action bounds. This one can do anything the page can, in a
 * tab holding a live ChatGPT session, so it is destructive by annotation and
 * refuses to run without an explicit confirmation.
 */
export async function evaluateInOwnedTab(args = {}, { fleet, transport, signal } = {}) {
  requireRelay(fleet, transport)
  const expression = String(args.expression ?? '')
  if (expression.trim() === '') fail('INVALID_ARGUMENT', 'expression is required')
  if (expression.length > EVALUATE_LIMITS.max_expression_length) {
    fail('INVALID_ARGUMENT', `expression is ${expression.length} characters; the limit is ${EVALUATE_LIMITS.max_expression_length}`)
  }
  const maxResultBytes = clampInteger(args.max_result_bytes, {
    min: 1000, max: EVALUATE_LIMITS.max_result_bytes, fallback: EVALUATE_LIMITS.default_result_bytes, label: 'max_result_bytes',
  })
  const timeoutMs = clampInteger(args.timeout_ms, { min: 1000, max: DOM_LIMITS.timeout_max_ms, fallback: DOM_LIMITS.timeout_default_ms, label: 'timeout_ms' })

  let capabilities
  try {
    capabilities = await transport.capabilities(signal)
  } catch (error) {
    throw new ActionError('UNSUPPORTED', `the browser relay is unreachable: ${error.message}`, { retryable: true })
  }
  if (capabilities?.evaluate !== true) {
    fail('UNSUPPORTED', 'this browser relay build exposes no evaluate route. It needs POST /browser/page/evaluate and capabilities.browser.evaluate=true, which requires the CDP-capable extension (permission "debugger"). bridge_capabilities reports features.browser_evaluate=false until then.')
  }

  const { record, marker } = await fleet.resolveOwnedTab(args.browser_tab_id, {
    busyPolicy: BUSY_POLICY.refuse,
    action: 'evaluating JavaScript',
  })
  requireConfirmation(args.confirm, `Run caller-supplied JavaScript in ${record.fleet} slot ${record.slot} (${record.url}), which can do anything that page can`)
  await fleet.recheckOwnedTab(record.browser_tab_id, marker, 'evaluating JavaScript')

  let payload
  try {
    payload = await transport.evaluate(record.browser_client_id, { expression, maxResultBytes, timeoutMs }, signal)
  } catch (error) {
    const message = String(error?.message || error)
    if (/cannot be serialized|bytes of JSON, over/i.test(message)) throw new ActionError('INVALID_ARGUMENT', message)
    throw new ActionError('PROCESS_FAILED', `evaluation failed on browser tab ${record.browser_tab_id}: ${message}`)
  }

  return {
    browser_tab_id: record.browser_tab_id,
    fleet: record.fleet,
    slot: record.slot,
    url: String(payload?.url || record.url || ''),
    value_type: String(payload?.valueType || 'object'),
    undefined_result: payload?.undefinedResult === true,
    json: typeof payload?.json === 'string' ? payload.json : undefined,
    bytes: Number(payload?.bytes) || 0,
  }
}
