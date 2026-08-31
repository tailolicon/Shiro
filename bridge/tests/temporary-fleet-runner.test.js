import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_FLEET_SIZE,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_LAUNCH_ATTEMPTS,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_SESSION_RUNS,
  DEFAULT_STAGGER_SECONDS,
  extractEmbeddedPrompt,
  promptFileArgument,
  renderFleetPrompt,
  cleanupBusyEvidence,
  hasActiveGenerationControl,
  hasActiveTemporaryChatControl,
  hasExpectedChatMode,
  hasInactiveTemporaryChatControl,
  hasSendControl,
  isTemporaryChatUrl,
  isSuccessfulSession,
  fleetNeedsRotation,
  hasRemainingRounds,
  sessionRunCount,
  selectFleetClients,
  selectStatusFleet,
} from '../../scripts/Run-Hachimi-Temporary-Fleet.mjs'

const inactive = '<button aria-label="Trò chuyện tạm thời"><span><svg class="icon"></svg><svg class="icon opacity-0"></svg></span></button>'
const active = '<button aria-label="Tắt trò chuyện tạm thời"><span><svg class="icon opacity-0"></svg><svg class="icon"></svg></span></button>'
const activeWhileGenerating = '<button aria-label="Trò chuyện tạm thời"><span><svg class="icon opacity-0"></svg><svg class="icon"></svg></span></button>'

test('relay fleet runner recognizes only the active Temporary control state', () => {
  assert.equal(hasActiveTemporaryChatControl(inactive), false)
  assert.equal(hasInactiveTemporaryChatControl(inactive), true)
  assert.equal(hasActiveTemporaryChatControl(active), true)
  assert.equal(hasInactiveTemporaryChatControl(active), false)
  assert.equal(hasActiveTemporaryChatControl(activeWhileGenerating), true)
  assert.equal(hasActiveTemporaryChatControl('<button aria-label="Tắt trò chuyện tạm thời"></button>'), false)
  assert.equal(isTemporaryChatUrl('https://chatgpt.com/?temporary-chat=true'), true)
  assert.equal(isTemporaryChatUrl('https://chatgpt.com/c/normal'), false)
  assert.equal(hasExpectedChatMode(active, true, 'https://chatgpt.com/?temporary-chat=true'), true)
  assert.equal(hasExpectedChatMode(inactive, false, 'https://chatgpt.com/c/normal'), true)
  assert.equal(hasExpectedChatMode('', false, 'https://chatgpt.com/c/normal'), true)
  assert.equal(hasExpectedChatMode(active, false, 'https://chatgpt.com/?temporary-chat=true'), false)
})

test('cleanup ignores stale streaming markup only after final output and the idle send control', () => {
  const stop = '<button data-testid="stop-button" aria-label="Stop generating"></button>'
  const send = '<button data-testid="send-button" aria-label="Send prompt"></button>'
  const idleSend = '<button data-testid="send-button" aria-disabled="true" aria-label="Gửi câu lệnh"></button>'
  const composerSend = '<button data-testid="composer-submit-button" aria-disabled="true"></button>'
  const idleVoice = '<button type="button" aria-label="Start Voice" class="composer-submit-button-color text-submit-btn-text"></button>'
  const staleClient = {
    activeRequest: null,
    tabObservation: {
      generation: { state: 'active', activeTool: false },
      output: { finalMessage: true },
    },
  }
  assert.equal(hasActiveGenerationControl(stop), true)
  assert.equal(hasActiveGenerationControl(send), false)
  assert.equal(hasSendControl(send), true)
  assert.equal(hasSendControl(idleSend), true)
  assert.equal(hasSendControl(composerSend), true)
  assert.equal(hasSendControl(idleVoice), true)
  assert.equal(cleanupBusyEvidence(staleClient, send), '')
  assert.equal(cleanupBusyEvidence(staleClient, composerSend), '')
  assert.equal(cleanupBusyEvidence(staleClient, idleVoice), '')
  assert.equal(cleanupBusyEvidence(staleClient, stop), 'stop_control')
  assert.equal(cleanupBusyEvidence({ ...staleClient, activeRequest: { requestId: 'request-1' } }, send), 'active_request')
  assert.equal(cleanupBusyEvidence({
    ...staleClient,
    tabObservation: { generation: { state: 'active', activeTool: true }, output: { finalMessage: true } },
  }, send), 'active_tool')
  assert.equal(cleanupBusyEvidence({
    ...staleClient,
    tabObservation: { generation: { state: 'active', activeTool: false }, output: { finalMessage: false } },
  }, send), 'unsettled_generation')
})

test('relay fleet runner selects exactly five healthy tabs and deprioritizes generating tabs', () => {
  const clients = Array.from({ length: 12 }, (_, index) => ({
    id: `client-${index}`,
    browserTabId: 100 + index,
    ready: true,
    compatible: true,
    quarantined: false,
    tabObservation: { generation: { state: index === 0 ? 'active' : 'stopped' } },
  }))
  const fleet = selectFleetClients(clients)
  assert.equal(DEFAULT_FLEET_SIZE, 5)
  assert.equal(DEFAULT_INTERVAL_MINUTES, 27)
  assert.equal(DEFAULT_STAGGER_SECONDS, 8)
  assert.equal(DEFAULT_MAX_ROUNDS, 0)
  assert.equal(DEFAULT_MAX_SESSION_RUNS, 4)
  assert.equal(DEFAULT_MAX_LAUNCH_ATTEMPTS, 20)
  assert.equal(fleet.length, 5)
  assert.equal(fleet.some((client) => client.id === 'client-0'), false)
})

test('relay fleet resumes only still-open runner-owned tabs from status', () => {
  assert.deepEqual(selectStatusFleet({ sessions: [
    { id: 'a', tabId: 1, state: 'submitted' },
    { id: 'b', tabId: 2, state: 'closed' },
  ] }).map((item) => item.tabId), [1])
  assert.deepEqual(selectStatusFleet({ cleanup: [
    { id: 'c', tabId: 3, state: 'busy' },
    { id: 'd', tabId: 4, state: 'already_closed' },
  ] }).map((item) => item.tabId), [3])
})

test('relay fleet counts only successfully submitted Temporary sessions', () => {
  assert.equal(isSuccessfulSession({ state: 'submitted', tabId: 1 }), true)
  assert.equal(isSuccessfulSession({ state: 'reused_submitted', tabId: 1 }), true)
  assert.equal(isSuccessfulSession({ state: 'adopted_submitted', tabId: 2 }), true)
  assert.equal(isSuccessfulSession({ state: 'failed', tabId: 3 }), false)
  assert.equal(isSuccessfulSession({ state: 'memory_guard' }), false)
})

test('relay fleet rotates a cohort after four runs and supports an unlimited round budget', () => {
  assert.equal(sessionRunCount({ runCount: 3 }), 3)
  assert.equal(sessionRunCount({}), 4, 'unknown legacy session age must fail closed into rotation')
  assert.equal(fleetNeedsRotation([{ runCount: 3 }, { runCount: 4 }]), true)
  assert.equal(fleetNeedsRotation([{ runCount: 3 }, { runCount: 3 }]), false)
  assert.equal(hasRemainingRounds(10, 0), true)
  assert.equal(hasRemainingRounds(3, 4), true)
  assert.equal(hasRemainingRounds(4, 4), false)
})

test('relay fleet prompt extraction is exact and fails closed without markers', () => {
  assert.equal(extractEmbeddedPrompt('const PROMPT = String.raw`hello`;\n\n  const INTERVAL_MS'), 'hello')
  assert.throws(() => extractEmbeddedPrompt('const PROMPT = "hello"'), /marker is missing/)
})

test('fleet prompt file and slot placeholders are deterministic', () => {
  assert.equal(promptFileArgument(['--once', '--prompt-file=.\\repair.txt']), '.\\repair.txt')
  assert.equal(promptFileArgument(['--once']), '')
  assert.equal(renderFleetPrompt('slot {{FLEET_SLOT}}/{{FLEET_SIZE}}', 3), 'slot 3/5')
})
