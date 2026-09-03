import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertUnchanged, ownerOfTab, recheckOwnedBrowserTab, resolveOwnedBrowserTab,
} from '../src/browser-ownership.js'
import {
  clickOwnedTabElement, decodeHandle, encodeHandle, evaluateInOwnedTab, queryOwnedTabDom, typeIntoOwnedTabElement,
} from '../src/browser-dom.js'

import { setConfirmationPolicy } from '../src/action-errors.js'

// This file exercises the confirmation brake, which ships OFF: a destructive
// action no longer costs a refusal-then-repeat round trip on an operator's own
// machine. The tests below are what an operator gets back with
// SHIRO_REQUIRE_CONFIRMATIONS=1, so they turn it on for this file.
setConfirmationPolicy({ required: true })

const OWNED_TAB = 7
const OTHER_OWNED_TAB = 9
const FOREIGN_TAB = 8

function harness(overrides = {}) {
  const state = {
    clients: [
      { id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true },
      { id: 'client-other', browserTabId: OTHER_OWNED_TAB, url: 'https://chatgpt.com/c/def', ready: true },
      { id: 'client-foreign', browserTabId: FOREIGN_TAB, url: 'https://chatgpt.com/c/private', ready: true },
    ],
    busy: '',
    modeOk: true,
    capabilities: { dom: true, evaluate: true },
    queryReply: () => ({
      generation: 'g1',
      elements: [
        { element_id: 'g1:1', tag: 'button', name: 'Send', visible: true, enabled: true, editable: false, box: { x: 1, y: 2, width: 30, height: 12 } },
        { element_id: 'g1:2', tag: 'input', type: 'password', secret: true, visible: true, enabled: true, editable: true, box: { x: 1, y: 20, width: 30, height: 12 } },
      ],
      total: 2,
      truncated: false,
      url: 'https://chatgpt.com/c/abc',
    }),
    clickReply: () => ({ clicked: true, tag: 'button', at: { x: 16, y: 8 }, url: 'https://chatgpt.com/c/abc' }),
    typeReply: options => ({ typed: true, mode: options.mode, characters: options.text.length, submitted: options.submit === true, tag: 'textarea', url: 'https://chatgpt.com/c/abc' }),
    evaluateReply: () => ({ json: '{"ok":true}', valueType: 'object', bytes: 11, url: 'https://chatgpt.com/c/abc' }),
    calls: [],
    listCalls: 0,
    ...overrides,
  }
  const fleets = [{
    name: 'writers',
    config: { chatMode: 'normal' },
    workers: [
      { slot: 1, workerId: 'worker-1', browserTabId: OWNED_TAB, state: 'idle' },
      { slot: 2, workerId: 'worker-2', browserTabId: OTHER_OWNED_TAB, state: 'idle' },
    ],
  }]
  const listClients = async () => {
    state.listCalls += 1
    return typeof state.clients === 'function' ? state.clients(state.listCalls) : state.clients
  }
  const shared = { findOwner: tabId => ownerOfTab(fleets, tabId), listClients }
  const fleet = {
    async resolveOwnedTab(tabId, options) {
      return await resolveOwnedBrowserTab({ ...shared, tabId, inspect: async () => ({ modeOk: state.modeOk, busy: state.busy }), ...options })
    },
    async recheckOwnedTab(tabId, marker, action) {
      return assertUnchanged(marker, await recheckOwnedBrowserTab({ ...shared, tabId, action }), action)
    },
  }
  const transport = {
    async capabilities() {
      if (state.capabilitiesThrows) throw new Error('relay down')
      return state.capabilities
    },
    async queryDom(clientId, options) { state.calls.push(['query', clientId, options]); return state.queryReply(options) },
    async clickElement(clientId, options) { state.calls.push(['click', clientId, options]); return state.clickReply(options) },
    async typeIntoElement(clientId, options) { state.calls.push(['type', clientId, options]); return state.typeReply(options) },
    async evaluate(clientId, options) { state.calls.push(['evaluate', clientId, options]); return state.evaluateReply(options) },
  }
  return { state, fleet, transport }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('a handle carries its tab and is refused on any other', () => {
  const handle = encodeHandle(OWNED_TAB, 'g1:5')
  assert.equal(handle, 't7.g1:5')
  assert.equal(decodeHandle(handle, OWNED_TAB), 'g1:5')
  assert.throws(() => decodeHandle(handle, OTHER_OWNED_TAB), error => {
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /never cross tabs/)
    return true
  })
  for (const bad of ['g1:5', '', 'tabby.g1:5', 't7', 'tx.g1:1']) {
    assert.throws(() => decodeHandle(bad, OWNED_TAB), error => error.code === 'INVALID_ARGUMENT', bad)
  }
})

test('a query returns bounded descriptors with tab-scoped handles', async () => {
  const { fleet, transport, state } = harness()
  const result = await queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'button, input' }, { fleet, transport })
  assert.equal(result.returned, 2)
  assert.equal(result.generation, 'g1')
  assert.equal(result.elements[0].element_id, 't7.g1:1')
  assert.equal(result.elements[0].name, 'Send')
  // The password field is described but its value is not present.
  assert.equal(result.elements[1].secret, true)
  assert.equal(result.elements[1].value, undefined)
  assert.equal(state.calls[0][1], 'client-owned', 'addressed by the derived client id')
  assert.equal(state.calls[0][2].selector, 'button, input')
})

test('a query works while the tab is generating, unlike click and type', async () => {
  const { fleet, transport } = harness({ busy: 'active_request' })
  const result = await queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'button' }, { fleet, transport })
  assert.equal(result.returned, 2)
  await rejects(clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1' }, { fleet, transport }), 'BUSY')
  await rejects(typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'x' }, { fleet, transport }), 'BUSY')
})

test('foreign and unknown tabs are refused identically for every DOM action', async () => {
  const { fleet, transport, state } = harness()
  const messages = []
  for (const tabId of [FOREIGN_TAB, 4242]) {
    for (const call of [
      () => queryOwnedTabDom({ browser_tab_id: tabId, selector: 'button' }, { fleet, transport }),
      () => clickOwnedTabElement({ browser_tab_id: tabId, element_id: `t${tabId}.g1:1` }, { fleet, transport }),
      () => typeIntoOwnedTabElement({ browser_tab_id: tabId, element_id: `t${tabId}.g1:1`, text: 'x' }, { fleet, transport }),
    ]) {
      await assert.rejects(call(), error => {
        assert.equal(error.code, 'NOT_FOUND')
        messages.push(error.message.replace(String(tabId), 'X'))
        return true
      })
    }
  }
  assert.equal(new Set(messages).size, 1, 'foreign and unknown must be indistinguishable')
  assert.equal(state.calls.length, 0, 'the relay is never asked about an unowned tab')
})

test('a handle minted on one owned tab is refused on another owned tab', async () => {
  const { fleet, transport, state } = harness()
  await rejects(
    clickOwnedTabElement({ browser_tab_id: OTHER_OWNED_TAB, element_id: encodeHandle(OWNED_TAB, 'g1:1') }, { fleet, transport }),
    'CONFLICT',
  )
  assert.equal(state.calls.length, 0, 'no click is dispatched across tabs')
})

test('a click resolves the handle and reports where it landed', async () => {
  const { fleet, transport, state } = harness()
  const result = await clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', button: 'left' }, { fleet, transport })
  assert.equal(result.clicked, true)
  assert.equal(result.tag, 'button')
  assert.deepEqual(result.at, { x: 16, y: 8 })
  // The tab prefix is stripped before the handle reaches the page.
  assert.equal(state.calls[0][2].elementId, 'g1:1')
})

test('a stale handle is a CONFLICT that tells the caller to re-query', async () => {
  for (const message of [
    'the document was replaced (navigation or reload), so every element handle from it is invalid',
    'this element handle belongs to a previous document generation',
    'this element handle is not known to the current document',
    'the element was removed from the document',
  ]) {
    const { fleet, transport } = harness({ clickReply: () => { throw new Error(message) } })
    await assert.rejects(
      clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1' }, { fleet, transport }),
      error => {
        assert.equal(error.code, 'CONFLICT')
        assert.match(error.message, /browser_dom_query again/)
        return true
      },
    )
  }
})

test('an unclickable element is an argument error, not a transport failure', async () => {
  for (const message of ['the element is not visible, so a click would not reach it', 'the element is disabled']) {
    const { fleet, transport } = harness({ clickReply: () => { throw new Error(message) } })
    await rejects(clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1' }, { fleet, transport }), 'INVALID_ARGUMENT')
  }
})

test('typing reports a length and never the text', async () => {
  const { fleet, transport, state } = harness()
  const secret = 'correct horse battery staple'
  const result = await typeIntoOwnedTabElement(
    { browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: secret, mode: 'replace' },
    { fleet, transport },
  )
  assert.equal(result.typed, true)
  assert.equal(result.characters, secret.length)
  assert.equal(result.mode, 'replace')
  assert.ok(!JSON.stringify(result).includes('horse'), 'the typed text must not come back in the result')
  assert.equal(state.calls[0][2].text, secret, 'though it obviously reaches the page')
})

test('submit is off unless asked for', async () => {
  const { fleet, transport, state } = harness()
  await typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'hello' }, { fleet, transport })
  assert.equal(state.calls.at(-1)[2].submit, false)
  const submitted = await typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'hello', submit: true }, { fleet, transport })
  assert.equal(submitted.submitted, true)
})

test('typing into a credential field is refused by the page and reported clearly', async () => {
  const { fleet, transport } = harness({
    typeReply: () => { throw new Error('refusing to type into a password or one-time-code field; the person at the keyboard should enter it') },
  })
  await assert.rejects(
    typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:2', text: 'hunter2' }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'INVALID_ARGUMENT')
      assert.match(error.message, /password or one-time-code/)
      return true
    },
  )
})

test('ownership is re-checked before every DOM interaction', async () => {
  for (const call of [
    (fleet, transport) => queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'button' }, { fleet, transport }),
    (fleet, transport) => clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1' }, { fleet, transport }),
    (fleet, transport) => typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'x' }, { fleet, transport }),
  ]) {
    const { fleet, transport, state } = harness({
      clients: n => (n === 1
        ? [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true }]
        : [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/moved', ready: true }]),
    })
    await rejects(call(fleet, transport), 'CONFLICT')
    assert.equal(state.calls.length, 0)
  }
})

test('argument validation covers selectors, modes, buttons and sizes', async () => {
  const { fleet, transport } = harness()
  await rejects(queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: '' }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'a'.repeat(3000) }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'a', max_results: 0 }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', button: 'scroll' }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', click_count: 9 }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'x', mode: 'prepend' }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'x'.repeat(20_001) }, { fleet, transport }), 'INVALID_ARGUMENT')
})

test('a relay without the DOM routes says exactly what is missing', async () => {
  const { fleet, transport, state } = harness({ capabilities: { dom: false, screenshot: true } })
  for (const call of [
    () => queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'button' }, { fleet, transport }),
    () => clickOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1' }, { fleet, transport }),
    () => typeIntoOwnedTabElement({ browser_tab_id: OWNED_TAB, element_id: 't7.g1:1', text: 'x' }, { fleet, transport }),
  ]) {
    await assert.rejects(call(), error => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /\/browser\/dom\//)
      return true
    })
  }
  assert.equal(state.calls.length, 0)
})

test('an unreachable relay and a missing fleet are refused cleanly', async () => {
  const down = harness({ capabilitiesThrows: true })
  await assert.rejects(
    queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'a' }, { fleet: down.fleet, transport: down.transport }),
    error => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.equal(error.retryable, true)
      return true
    },
  )
  await rejects(queryOwnedTabDom({ browser_tab_id: OWNED_TAB, selector: 'a' }, { fleet: null, transport: null }), 'UNSUPPORTED')
})

test('evaluate refuses to run without an explicit confirmation', async () => {
  const { fleet, transport, state } = harness()
  await assert.rejects(
    evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: 'document.title' }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'PERMISSION_REQUIRED')
      assert.match(error.message, /confirm=true/)
      return true
    },
  )
  assert.equal(state.calls.length, 0, 'nothing runs in the page before the confirmation')

  const result = await evaluateInOwnedTab(
    { browser_tab_id: OWNED_TAB, expression: 'document.title', confirm: true },
    { fleet, transport },
  )
  assert.equal(result.json, '{"ok":true}')
  assert.equal(result.value_type, 'object')
  assert.equal(state.calls[0][1], 'client-owned')
})

test('evaluate is refused while the tab is generating', async () => {
  const { fleet, transport } = harness({ busy: 'active_request' })
  await rejects(
    evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: '1', confirm: true }, { fleet, transport }),
    'BUSY',
  )
})

test('evaluate refuses foreign tabs like every other browser action', async () => {
  const { fleet, transport, state } = harness()
  await rejects(
    evaluateInOwnedTab({ browser_tab_id: FOREIGN_TAB, expression: '1', confirm: true }, { fleet, transport }),
    'NOT_FOUND',
  )
  assert.equal(state.calls.length, 0)
})

test('an unserializable or oversized result is an argument error', async () => {
  for (const message of [
    'the expression produced a value that cannot be serialized (Converting circular structure to JSON)',
    'the expression produced 900000 bytes of JSON, over the 50000 byte limit',
  ]) {
    const { fleet, transport } = harness({ evaluateReply: () => { throw new Error(message) } })
    await rejects(
      evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: 'window', confirm: true }, { fleet, transport }),
      'INVALID_ARGUMENT',
    )
  }
})

test('a page exception surfaces as a process failure with the message', async () => {
  const { fleet, transport } = harness({ evaluateReply: () => { throw new Error('TypeError: x is not a function') } })
  await assert.rejects(
    evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: 'x()', confirm: true }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'PROCESS_FAILED')
      assert.match(error.message, /x is not a function/)
      return true
    },
  )
})

test('an undefined result is reported as undefined, not as null', async () => {
  const { fleet, transport } = harness({ evaluateReply: () => ({ undefinedResult: true, valueType: 'undefined' }) })
  const result = await evaluateInOwnedTab(
    { browser_tab_id: OWNED_TAB, expression: 'void 0', confirm: true },
    { fleet, transport },
  )
  assert.equal(result.undefined_result, true)
  assert.equal(result.json, undefined)
})

test('evaluate argument bounds and a relay without the route', async () => {
  const { fleet, transport } = harness()
  await rejects(evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: '  ', confirm: true }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: 'x'.repeat(20_001), confirm: true }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: '1', max_result_bytes: 10, confirm: true }, { fleet, transport }), 'INVALID_ARGUMENT')

  const older = harness({ capabilities: { dom: true, evaluate: false } })
  await assert.rejects(
    evaluateInOwnedTab({ browser_tab_id: OWNED_TAB, expression: '1', confirm: true }, { fleet: older.fleet, transport: older.transport }),
    error => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /\/browser\/page\/evaluate/)
      return true
    },
  )
})
