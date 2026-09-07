/** The engine contract uses exclusive beforeSeq pages, containing raw events.
 * Require explicit pagination metadata and consecutive sequence coverage from
 * the baseline (or genesis for -1) to the observed tail. No partial proof.
 */
export async function recoveryHistory(readPage, afterSeq, { maxPages = 32 } = {}) {
  let beforeSeq
  let entries = []
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await readPage(beforeSeq)
    if (!page || typeof page.hasMore !== 'boolean' || page.truncated === true || !Array.isArray(page.events) || !page.events.length) return null
    const events = page.events
    for (let i = 0; i < events.length; i++) {
      const seq = events[i]?.event?.seq
      if (!Number.isSafeInteger(seq) || seq < 0 || (i && seq !== events[i - 1].event.seq + 1)) return null
    }
    const first = events[0].event.seq
    const last = events.at(-1).event.seq
    if (beforeSeq !== undefined && last !== beforeSeq - 1) return null
    entries = [...events, ...entries]
    if (first <= Math.max(afterSeq, 0)) {
      // At genesis the provider must also certify there is no missing past.
      if (afterSeq === -1 && (first !== 0 || page.hasMore)) return null
      return { events: entries, hasMore: page.hasMore, baselineCovered: true }
    }
    if (!page.hasMore) return null
    beforeSeq = first
  }
  return null
}
