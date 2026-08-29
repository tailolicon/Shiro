/*
 * Paste this whole file into the DevTools Console on chatgpt.com.
 * It fails closed unless the current UI positively identifies a Temporary Chat.
 */
(async () => {
  const PROMPT = String.raw`Continue tailolicon/hachimi-tl-vi as a parallel context-curation worker.

IMPORTANT: SESSION BUDGET IS SHORT.
Your first priority is to CLAIM WORK IMMEDIATELY.
Do not perform deep repository analysis before claiming.

Repository main is the source of truth.
Do not rely on chat history or private memory.

==================================================
PHASE 0 — FAST CLAIM
==================================================

Before claiming, read ONLY:

1. work/curation/active_plan.json
2. The active plan referenced by active_plan.json
3. PARALLEL_CURATION.md — only enough to understand:
   - claim schema
   - result schema
   - completion schema
   - lease duration

Do NOT read large glossary/evidence files before obtaining a claim.

Immediately find one batch that:

- is absent from work/curation/merged/<batch_id>.json
- has no valid non-expired claim at
  work/curation/claims/<batch_id>.json

Claim exactly one batch by atomically creating:

work/curation/claims/<batch_id>.json

Use:
- exact active plan_id
- current lease duration
- unique claim_id
- unique worker_id

Never overwrite an active claim.

If another worker wins the race, immediately try the next batch.

TARGET:
Obtain a valid claim as one of the first repository mutations of the
session. Do not research characters or terminology before claiming.

BATCH SELECTION:
- Do not scan the entire repository to determine global proportions.
- Prefer an available term-* batch by default.
- Choose speech-* when it is immediately available and speech work is
  clearly needed from the active plan metadata.
- Do not spend significant time optimizing batch selection.

==================================================
PHASE 1 — LOAD ONLY REQUIRED CONTEXT
==================================================

AFTER successfully claiming a batch, read:

Always:
1. GAME_CONTEXT.md
2. CONTEXT_MAINTENANCE.md
3. PARALLEL_CURATION.md
4. glossary/characters.json
5. glossary/style_rules.json

If the claimed batch is speech-* read ONLY speech-related sources:
6. glossary/speech_bible.json
7. glossary/speech_samples.json
8. glossary/speech_evidence.json
9. glossary/speech_review_queue.json

Do NOT read terminology-only files unless actually required by a
specific speech ambiguity.

If the claimed batch is term-* read ONLY terminology-related sources:
6. glossary/term_registry.json
7. glossary/terminology_review_queue.json
8. glossary/generated_candidates.json
9. glossary/observed_terms.json

Do NOT read speech_samples.json, speech_evidence.json, or the full
speech review data for terminology batches unless a specific item
requires it.

Whenever possible, inspect only entries relevant to the batch instead
of exhaustively analyzing an entire large JSON file.

==================================================
GENERAL RULES
==================================================

Your job is to improve the shared Uma Musume Pretty Derby JP-server
translation context used by Vietnamese translation workers.

Repository context overrides model priors.

Never edit:
- localized_data
- translation_progress.json
- translation claims/results
- glossary/speech_bible.json
- glossary/terminology_reviews.json
- glossary/term_registry.json
- glossary/speech_review_queue.json
- glossary/terminology_review_queue.json

The merge-curation workflow exclusively owns canonical merging.

Heartbeat your own claim if substantial work is still in progress.
Update heartbeat_at and expires_at while preserving the same claim_id.

Do not heartbeat unnecessarily after every small read.

==================================================
SPEECH BATCH
==================================================

For every character assigned by the claimed batch, produce compact
Vietnamese translation guidance.

Use repository evidence first.

Relevant sources:
- glossary/characters.json
- glossary/speech_samples.json
- glossary/speech_evidence.json
- glossary/speech_bible.json

Public/official Uma Musume references may be researched only when
repository evidence is insufficient.

Do not use UmaTL English translation text as AI input.

Focus only on translation-relevant information:
- register
- emotional tone
- tempo/rhythm
- formality
- explicit self-reference
- characteristic sentence construction
- genuinely evidenced quirks
- serious vs casual tone changes
- concrete Vietnamese translation rules
- concrete anti-rules

Scene context and actual source wording outrank generic profiles.

Never invent:
- fixed pronoun relationships
- romance/intimacy
- hierarchy
- dialect
- age relationships
- honorific relationships
- catchphrases

Do not derive personality mechanically from punctuation statistics.

Do not force Japanese quirks into unnatural Vietnamese.

Preserve explicit distinctive self-reference when evidenced.

Each profile must follow PARALLEL_CURATION.md and contain:
- character_key
- canonical
- register
- tempo
- politeness
- translation_rules
- anti_rules when useful
- self_reference only when supported
- source_urls only when research was used
- evidence_note
- confidence: high | medium | low

translation_rules must contain at least 2 actionable rules.

Never directly overwrite an already curated canonical profile.

==================================================
TERMINOLOGY BATCH
==================================================

For every assigned source entity choose EXACTLY ONE:

- lock
- defer
- ignore

Use only evidence relevant to the claimed items from:
- glossary/terminology_review_queue.json
- glossary/generated_candidates.json
- glossary/term_registry.json
- glossary/observed_terms.json
- glossary/characters.json
- source locators in the batch
- reliable public/current game references when required

LOCK:
Vietnamese term is sufficiently verified and stable.

DEFER:
meaningful ambiguity or insufficient evidence.

IGNORE:
item should not become canonical terminology.

When uncertain: DEFER.

Critical rules:

- Chinese is a semantic bridge, not authority for proper-name spelling.
- Never literally translate Chinese character/racehorse names.
- Prefer verified canonical Roman-letter proper names.
- Preserve established JP-series terminology.
- スタミナ / 耐力 = Thể lực
- 体力 = Năng lượng

Running styles:
- Nige
- Senko
- Sashi
- Oikomi
- Dai Nige

Surfaces/distances:
- Turf = Sân cỏ
- Dirt = Dirt
- Short = Cự ly ngắn
- Mile = Mile
- Medium = Cự ly trung bình
- Long = Cự ly dài

Do not use UmaTL English translation text as AI input.

For lock include:
- source_zh_cn
- action = lock
- target_vi
- kind
- stable term_id where appropriate
- verified Japanese aliases when available
- useful aliases
- concise review note

For defer/ignore include a concise reason.

==================================================
RESULT
==================================================

Complete ALL AND ONLY items assigned to the claimed batch.

QA before writing:
- unsupported claims
- invented pronoun relationships
- literal Chinese proper-name calques
- inconsistent canonical names
- terminology conflicts
- duplicated concepts
- schema errors
- missing batch items

If uncertain, be conservative or defer.

Write exactly one result:

work/curation/results/<batch_id>/<claim_id>.json

It must use the exact:
- plan_id
- batch_id
- claim_id

and follow PARALLEL_CURATION.md exactly.

Commit the completed result.

Then create:

work/curation/completions/<batch_id>/<claim_id>.json

using the same:
- plan_id
- batch_id
- claim_id
- worker_id

and exact result path.

==================================================
CONTINUOUS FAST LOOP
==================================================

After completing a batch:

1. Read ONLY work/curation/active_plan.json.
2. If plan_id changed:
   - read the new active plan
   - refresh required protocol context if necessary.
3. Otherwise DO NOT reload all bootstrap/glossary files.
4. Check merged/ and claims/ for another available batch.
5. Immediately claim another batch.
6. Load only batch-specific evidence.
7. Work, result, commit, completion.
8. Repeat.

Do not stop after one batch while safely assignable batches remain.

TIME-BUDGET RULE:

Prioritize completing and committing claimed work over starting
expensive research.

If session/tool budget is becoming constrained:
- finish the currently claimed batch if safely possible;
- do not claim another batch unless there is enough budget to complete
  it;
- never leave fabricated or partial results merely to mark completion.

At the end report ONLY:
- batches completed
- speech profiles curated
- terminology decisions made
- locks / defers / ignores
- unresolved blockers`;

  const INTERVAL_MS = 30 * 60 * 1000;
  const FLEET_SIZE = 5;
  const START_STAGGER_MS = 8_000;
  const SLOT_HEARTBEAT_MS = 15_000;
  const SLOT_STALE_MS = 5 * 60 * 1000;
  const FLEET_READY_TIMEOUT_MS = 15 * 60 * 1000;
  const SLOT_KEY_PREFIX = 'hachimi:temporary-curation:fleet-v1:slot:';
  const MAX_SENDS_PER_TEMP_CHAT = 12; // Six hours, then start a fresh Temporary Chat.
  const MAX_DOM_NODES = 60_000;
  const MAX_HEAP_RATIO = 0.80;

  window.__hachimiTemporaryScheduler?.stop?.('replaced by a new scheduler');

  const instanceId = crypto.randomUUID();
  let timer = null;
  let heartbeatTimer = null;
  let fleetSlot = 0;
  let stopped = false;
  let sending = false;
  let sentCount = 0;

  const visible = (element) => Boolean(
    element
    && element.getClientRects().length
    && getComputedStyle(element).visibility !== 'hidden'
    && getComputedStyle(element).display !== 'none'
  );

  function normalizedText(element) {
    return String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function slotKey(slot) {
    return `${SLOT_KEY_PREFIX}${slot}`;
  }

  function readSlot(slot) {
    try {
      return JSON.parse(localStorage.getItem(slotKey(slot)) || 'null');
    } catch {
      return null;
    }
  }

  function slotSnapshot() {
    const now = Date.now();
    const result = [];
    for (let slot = 1; slot <= FLEET_SIZE; slot += 1) {
      const record = readSlot(slot);
      if (!record || now - Number(record.heartbeatAt || 0) >= SLOT_STALE_MS) continue;
      result.push({
        slot,
        ageSeconds: Math.round((now - Number(record.heartbeatAt || 0)) / 1000),
        sentCount: Number(record.sentCount || 0),
        generating: Boolean(record.generating),
        domNodes: Number(record.domNodes || 0),
        heapMiB: Math.round(Number(record.heapUsed || 0) / 1024 / 1024),
      });
    }
    return result;
  }

  function ownSlotRecord() {
    const memory = performance.memory;
    return JSON.stringify({
      instanceId,
      heartbeatAt: Date.now(),
      sentCount,
      generating: sending || isGenerating(),
      domNodes: document.getElementsByTagName('*').length,
      heapUsed: Number(memory?.usedJSHeapSize || 0),
    });
  }

  function ownsFleetSlot() {
    return fleetSlot > 0 && readSlot(fleetSlot)?.instanceId === instanceId;
  }

  function claimFleetSlot() {
    const now = Date.now();
    for (let slot = 1; slot <= FLEET_SIZE; slot += 1) {
      const current = readSlot(slot);
      if (current && now - Number(current.heartbeatAt || 0) < SLOT_STALE_MS) continue;
      localStorage.setItem(slotKey(slot), ownSlotRecord());
      if (readSlot(slot)?.instanceId === instanceId) return slot;
    }
    return 0;
  }

  function refreshFleetSlot() {
    if (!ownsFleetSlot()) {
      stop('this tab lost its fleet slot');
      return;
    }
    localStorage.setItem(slotKey(fleetSlot), ownSlotRecord());
  }

  function releaseFleetSlot() {
    if (!ownsFleetSlot()) return;
    localStorage.removeItem(slotKey(fleetSlot));
  }

  // Fail closed. An inactive Temporary pill is not sufficient evidence.
  function temporaryChatEvidence() {
    const activeSelectors = [
      '[data-testid*="temporary" i][aria-pressed="true"]',
      '[data-testid*="temporary" i][aria-checked="true"]',
      '[data-testid*="temporary" i][data-state="on"]',
      '[data-testid*="temporary" i][data-state="checked"]',
      'button[aria-label*="Temporary" i][aria-pressed="true"]',
      'button[aria-label*="tạm thời" i][aria-pressed="true"]',
    ];
    const activeControl = document.querySelector(activeSelectors.join(','));
    if (visible(activeControl)) return normalizedText(activeControl) || 'active Temporary control';

    // Current ChatGPT Web uses two overlapping icons on the Temporary pill.
    // Inactive: first visible, second opacity-0. Active: first opacity-0, second visible.
    const temporaryPill = [...document.querySelectorAll('button[aria-label]')].find((button) => (
      visible(button)
      && /^(temporary(?: chat)?|trò chuyện tạm thời|chat tạm thời|turn off temporary(?: chat)?|disable temporary(?: chat)?|tắt trò chuyện tạm thời)$/i.test(button.getAttribute('aria-label') || '')
    ));
    const pillIcons = temporaryPill ? [...temporaryPill.querySelectorAll('svg')] : [];
    if (
      pillIcons.length >= 2
      && pillIcons[0].classList.contains('opacity-0')
      && !pillIcons[1].classList.contains('opacity-0')
    ) return temporaryPill.getAttribute('aria-label') || 'active Temporary pill';

    const bannerPattern = /^(temporary chat|chat tạm thời|trò chuyện tạm thời|cuộc trò chuyện tạm thời)$/i;
    const banner = [...document.querySelectorAll('h1, h2, [role="heading"], [role="status"], [role="alert"]')]
      .find((element) => visible(element) && bannerPattern.test(normalizedText(element)));
    if (banner) return normalizedText(banner);

    return '';
  }

  function findComposer() {
    return [...document.querySelectorAll([
      '#prompt-textarea[contenteditable]:not([contenteditable="false"])',
      'textarea#prompt-textarea',
      'textarea[name="prompt-textarea"]',
      '[role="textbox"][contenteditable]:not([contenteditable="false"])',
    ].join(','))].find(visible) || null;
  }

  function isGenerating() {
    return [...document.querySelectorAll([
      '[data-testid*="stop" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Dừng" i]',
    ].join(','))].some(visible);
  }

  function memoryRisk() {
    const domNodes = document.getElementsByTagName('*').length;
    if (domNodes >= MAX_DOM_NODES) return `DOM has ${domNodes.toLocaleString()} nodes`;

    const memory = performance.memory;
    if (memory?.jsHeapSizeLimit > 0) {
      const ratio = memory.usedJSHeapSize / memory.jsHeapSizeLimit;
      if (ratio >= MAX_HEAP_RATIO) return `JavaScript heap is ${Math.round(ratio * 100)}% full`;
    }
    return '';
  }

  function composerText(composer) {
    return String('value' in composer ? composer.value : composer.innerText || composer.textContent || '');
  }

  function setComposerText(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
    } else {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand?.('insertText', false, text);
      if (!composerText(composer).trim()) composer.textContent = text;
    }
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitForSendButton(composer, timeoutMs = 5_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const root = composer.closest('form, [data-testid*="composer" i], [data-type="unified-composer"]') || document;
      const button = [...root.querySelectorAll([
        '[data-testid="send-button"]',
        '[data-testid*="send" i]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Gửi" i]',
      ].join(','))].find((candidate) => (
        visible(candidate)
        && !candidate.disabled
        && candidate.getAttribute('aria-disabled') !== 'true'
      ));
      if (button) return button;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  function scheduleNext() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(runOnce, INTERVAL_MS);
    console.log(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] Next attempt: ${new Date(Date.now() + INTERVAL_MS).toLocaleString()}`);
  }

  function stop(reason = 'stopped manually') {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(heartbeatTimer);
    timer = null;
    heartbeatTimer = null;
    releaseFleetSlot();
    console.warn(`[Hachimi ${fleetSlot || '?'}/${FLEET_SIZE}] Scheduler stopped: ${reason}`);
  }

  async function runOnce() {
    if (stopped || sending) return;
    sending = true;
    try {
      if (!ownsFleetSlot()) {
        stop('this tab no longer owns its fleet slot');
        return;
      }
      const activeFleet = slotSnapshot();
      if (activeFleet.length !== FLEET_SIZE) {
        console.warn(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] Fleet has ${activeFleet.length}/${FLEET_SIZE} active tabs; skipped this slot.`);
        return;
      }
      const temporaryEvidence = temporaryChatEvidence();
      if (!temporaryEvidence) {
        stop('the current page is not positively identified as a Temporary Chat');
        return;
      }
      if (sentCount >= MAX_SENDS_PER_TEMP_CHAT) {
        stop(`reached the safe limit of ${MAX_SENDS_PER_TEMP_CHAT} sends; open a fresh Temporary Chat`);
        return;
      }
      const risk = memoryRisk();
      if (risk) {
        stop(`OOM guard triggered: ${risk}`);
        return;
      }
      if (isGenerating()) {
        console.warn(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] ChatGPT is still generating; skipped this 30-minute slot.`);
        return;
      }

      const composer = findComposer();
      if (!composer) {
        console.error('[Hachimi] Composer not found; this slot was skipped.');
        return;
      }

      setComposerText(composer, PROMPT);
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!composerText(composer).includes('Continue tailolicon/hachimi-tl-vi')) {
        console.error('[Hachimi] Prompt verification failed; nothing was submitted.');
        return;
      }

      const sendButton = await waitForSendButton(composer);
      if (!sendButton) {
        console.error('[Hachimi] Send button is unavailable; nothing was submitted.');
        return;
      }
      if (!temporaryChatEvidence()) {
        stop('Temporary Chat evidence disappeared before submission');
        return;
      }

      sendButton.click();
      sentCount += 1;
      refreshFleetSlot();
      console.log(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] Prompt ${sentCount}/${MAX_SENDS_PER_TEMP_CHAT} submitted at ${new Date().toLocaleString()} (${temporaryEvidence}).`);
    } catch (error) {
      console.error('[Hachimi] Submission failed:', error);
    } finally {
      sending = false;
      if (!stopped) scheduleNext();
    }
  }

  window.__hachimiTemporaryScheduler = Object.freeze({
    sendNow: runOnce,
    stop,
    status: () => ({
      stopped,
      sending,
      sentCount,
      maxSends: MAX_SENDS_PER_TEMP_CHAT,
      fleetSlot,
      fleetSize: FLEET_SIZE,
      activeFleet: slotSnapshot(),
      temporaryEvidence: temporaryChatEvidence(),
      memoryRisk: memoryRisk(),
    }),
    fleetStatus: slotSnapshot,
  });

  const temporaryEvidence = temporaryChatEvidence();
  if (!temporaryEvidence) {
    stop('open and visibly activate a Temporary Chat before installing the scheduler');
    return;
  }
  try {
    fleetSlot = claimFleetSlot();
  } catch (error) {
    stop(`fleet coordination storage is unavailable: ${error.message}`);
    return;
  }
  if (!fleetSlot) {
    stop(`all ${FLEET_SIZE} fleet slots are already active`);
    return;
  }

  heartbeatTimer = setInterval(refreshFleetSlot, SLOT_HEARTBEAT_MS);
  addEventListener('pagehide', () => stop('page closed or reloaded'), { once: true });

  console.log(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] Temporary-only fleet scheduler installed. Interval: 30 minutes.`);
  console.log('[Hachimi] Stop: __hachimiTemporaryScheduler.stop()');
  console.log('[Hachimi] Status: __hachimiTemporaryScheduler.status()');
  console.log('[Hachimi] Fleet: __hachimiTemporaryScheduler.fleetStatus()');
  console.log(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] Waiting for all ${FLEET_SIZE} Temporary Chat tabs...`);

  const fleetWaitStartedAt = Date.now();
  function waitForFullFleet() {
    if (stopped) return;
    const activeFleet = slotSnapshot();
    if (activeFleet.length === FLEET_SIZE) {
      const initialDelay = (fleetSlot - 1) * START_STAGGER_MS;
      console.log(`[Hachimi ${fleetSlot}/${FLEET_SIZE}] Fleet ready. First send in ${initialDelay / 1000} seconds.`);
      timer = setTimeout(runOnce, initialDelay);
      return;
    }
    if (Date.now() - fleetWaitStartedAt >= FLEET_READY_TIMEOUT_MS) {
      stop(`fleet did not reach ${FLEET_SIZE} active Temporary Chats within 15 minutes`);
      return;
    }
    timer = setTimeout(waitForFullFleet, 1_000);
  }
  waitForFullFleet();
})();
