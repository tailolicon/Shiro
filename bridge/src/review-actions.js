import { createHash } from 'node:crypto'
import { fail } from './action-errors.js'
import { git, repoRoot } from './git-actions.js'

// Review: look at a change hunk by hunk, then accept or undo it piece by piece.
//
// git_diff already returns a diff as text. What a review needs on top of that is
// ADDRESSABILITY: a way to say "this hunk, the third one in that file" and act
// on exactly it. So the diff is parsed into hunks, each gets an opaque id, and
// staging or reverting rebuilds a minimal one-hunk patch and applies it.
//
// The id is content-addressed -- position plus a hash of the hunk text -- so an
// id that no longer describes the same change is rejected instead of applied to
// whatever now sits at that position. That is the whole safety property here: a
// review that acts on a stale id would revert the wrong code.

export const REVIEW_LIMITS = Object.freeze({
  max_files: 200,
  max_hunks: 500,
  max_hunk_bytes: 20_000,
  max_diff_bytes: 2_000_000,
  max_findings: 200,
  max_summary_length: 500,
})

export const PRIORITIES = Object.freeze(['blocker', 'high', 'medium', 'low', 'nit'])

// Pinned prefixes: diff.mnemonicPrefix would otherwise emit i/ w/ c/ o/ and the
// one-hunk patches this module rebuilds would no longer apply with git's
// default -p1.
const DIFF_BASE = Object.freeze(['diff', '--src-prefix=a/', '--dst-prefix=b/'])

/** Drop a one-letter diff prefix (a/, b/, i/, w/, c/, o/) from a diff path. */
function stripPrefix(value) {
  const text = String(value ?? '')
  return /^[abciwo]\//.test(text) ? text.slice(2) : text
}

function hunkId(filePath, index, body) {
  const digest = createHash('sha256').update(`${filePath}\n${body}`).digest('hex').slice(0, 10)
  return `h${index}.${digest}`
}

/**
 * Split a unified diff into files and hunks, keeping each file's header so a
 * single hunk can be replayed as a standalone patch.
 */
export function parseUnifiedDiff(diffText) {
  const text = String(diffText ?? '')
  if (text.trim() === '') return []
  const files = []
  let current = null
  let hunk = null
  let hunkIndex = 0

  const closeHunk = () => {
    if (current !== null && hunk !== null) {
      hunk.body = hunk.lines.join('\n')
      hunk.hunk_id = hunkId(current.path, hunkIndex, hunk.body)
      hunkIndex += 1
      delete hunk.lines
      current.hunks.push(hunk)
      hunk = null
    }
  }
  const closeFile = () => {
    closeHunk()
    if (current !== null) files.push(current)
    current = null
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      // The prefixes are not always a/ and b/: git's diff.mnemonicPrefix makes
      // them i/ w/ c/ o/ depending on what is being compared. Every diff this
      // module issues pins them to a/ b/, but the parser stays tolerant so a
      // diff produced elsewhere still parses.
      const match = /^diff --git (\S+) (\S+)$/.exec(line)
      current = {
        path: match === null ? line.slice(11) : stripPrefix(match[2]),
        old_path: match === null ? undefined : stripPrefix(match[1]),
        header: [line],
        hunks: [],
        binary: false,
      }
      continue
    }
    if (current !== null && hunk === null && line.startsWith('+++ ')) {
      // The +++ line is the authority on the new path when it is not /dev/null.
      const target = line.slice(4).trim()
      if (target !== '/dev/null') current.path = stripPrefix(target)
      current.header.push(line)
      continue
    }
    if (current === null) continue
    if (line.startsWith('@@')) {
      closeHunk()
      const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      hunk = {
        header: line,
        old_start: range === null ? 0 : Number(range[1]),
        old_lines: range === null ? 0 : Number(range[2] ?? 1),
        new_start: range === null ? 0 : Number(range[3]),
        new_lines: range === null ? 0 : Number(range[4] ?? 1),
        additions: 0,
        deletions: 0,
        lines: [line],
      }
      continue
    }
    if (hunk === null) {
      if (line.startsWith('Binary files ')) current.binary = true
      current.header.push(line)
      continue
    }
    hunk.lines.push(line)
    if (line.startsWith('+')) hunk.additions += 1
    else if (line.startsWith('-')) hunk.deletions += 1
  }
  closeFile()
  return files
}

/** Rebuild a standalone patch containing exactly one hunk. */
export function buildHunkPatch(file, hunk) {
  return `${file.header.join('\n')}\n${hunk.body}\n`
}

function boundedFiles(files) {
  const limited = files.slice(0, REVIEW_LIMITS.max_files)
  let hunks = 0
  return limited.map(file => ({
    ...file,
    hunks: file.hunks.filter(() => {
      hunks += 1
      return hunks <= REVIEW_LIMITS.max_hunks
    }).map(hunk => ({
      ...hunk,
      body: hunk.body.length > REVIEW_LIMITS.max_hunk_bytes
        ? `${hunk.body.slice(0, REVIEW_LIMITS.max_hunk_bytes)}\n[hunk truncated]`
        : hunk.body,
      body_truncated: hunk.body.length > REVIEW_LIMITS.max_hunk_bytes || undefined,
    })),
  }))
}

async function diffArguments(root, args, options) {
  // `since_snapshot` is how "what changed in the last turn" is expressed: take a
  // snapshot before the turn, diff against it afterwards.
  if (typeof args.since_snapshot === 'string' && args.since_snapshot.trim() !== '') {
    const id = args.since_snapshot.trim()
    if (!/^[0-9a-f]{8,64}$/i.test(id)) fail('INVALID_ARGUMENT', 'since_snapshot is not a snapshot identifier from worktree_snapshot')
    const resolved = await git(root, ['rev-parse', '--verify', `refs/shiro/snapshots/${id}^{commit}`], { ...options, allowFailure: true })
    if (resolved.exitCode !== 0) fail('NOT_FOUND', `snapshot ${id} does not exist in this repository`)
    return { argv: [...DIFF_BASE, resolved.stdout.trim()], against: `snapshot ${id}` }
  }
  if (args.staged === true) return { argv: [...DIFF_BASE, '--cached'], against: 'the index' }
  if (typeof args.base === 'string' && args.base.trim() !== '') {
    const base = args.base.trim()
    if (!/^[A-Za-z0-9._/~^{}@-]+$/.test(base)) fail('INVALID_ARGUMENT', `base is not a valid revision: ${base}`)
    return { argv: [...DIFF_BASE, base], against: base }
  }
  return { argv: [...DIFF_BASE, 'HEAD'], against: 'HEAD' }
}

/** review_diff: the change under review, split into addressable hunks. */

/**
 * Untracked files, rendered as ordinary "new file" diffs.
 *
 * `git diff HEAD` cannot see them, which made review blind to exactly the files
 * an agent had just created -- the ones most worth reviewing. `git add -N` would
 * make git show them, but it MUTATES the index, and a review action that stages
 * things behind the caller's back is worse than one that misses them. So each
 * untracked file is diffed against /dev/null out-of-tree and the header is
 * rewritten into the same `diff --git a/x b/x` shape the parser already reads.
 */
async function untrackedDiff(root, args, options) {
  if (args.staged === true || typeof args.base === 'string' || typeof args.since_snapshot === 'string') return ''
  if (args.include_untracked === false) return ''
  const listed = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], options)
  const paths = listed.stdout.split('\0').filter(entry => entry !== '')
  if (paths.length === 0) return ''
  const wanted = Array.isArray(args.paths) && args.paths.length > 0 ? new Set(args.paths.map(String)) : null
  const chunks = []
  for (const path of paths.slice(0, REVIEW_LIMITS.max_files)) {
    if (wanted !== null && !wanted.has(path)) continue
    // --no-index exits 1 when the files differ, which is the normal case here.
    const diff = await git(root, ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', '--', '/dev/null', path], { ...options, allowFailure: true })
    const body = diff.stdout
    if (body === '') continue
    chunks.push(body
      .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
      .replace(/^--- \/dev\/null$/m, '--- /dev/null')
      .replace(/^\+\+\+ b\/.*$/m, `+++ b/${path}`))
  }
  return chunks.join('')
}

export async function reviewDiff(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const { argv, against } = await diffArguments(root, args, options)
  const full = [...argv]
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    full.push('--')
    for (const entry of args.paths.slice(0, 50)) {
      const value = String(entry)
      if (value.startsWith('-')) fail('INVALID_ARGUMENT', `path filter is not a path: ${value}`)
      full.push(value)
    }
  }
  const result = await git(root, full, options)
  // Untracked files are appended, not merged: they cannot collide with tracked
  // paths, and keeping them in one text means hunk ids stay content-addressed
  // the same way for both.
  result.stdout += await untrackedDiff(root, args, options)
  if (result.stdout.length > REVIEW_LIMITS.max_diff_bytes) {
    fail('INVALID_ARGUMENT', `the diff is ${result.stdout.length} bytes, over the ${REVIEW_LIMITS.max_diff_bytes} limit; narrow it with paths`)
  }
  const parsed = parseUnifiedDiff(result.stdout)
  const files = boundedFiles(parsed)
  const totalHunks = parsed.reduce((sum, file) => sum + file.hunks.length, 0)
  const shown = files.reduce((sum, file) => sum + file.hunks.length, 0)
  return {
    repository: root,
    against,
    files: files.map(file => ({
      path: file.path,
      old_path: file.old_path === file.path ? undefined : file.old_path,
      binary: file.binary,
      hunks: file.hunks.map(hunk => ({
        hunk_id: hunk.hunk_id,
        header: hunk.header,
        old_start: hunk.old_start,
        old_lines: hunk.old_lines,
        new_start: hunk.new_start,
        new_lines: hunk.new_lines,
        additions: hunk.additions,
        deletions: hunk.deletions,
        body: hunk.body,
        body_truncated: hunk.body_truncated,
      })),
    })),
    file_count: parsed.length,
    hunk_count: totalHunks,
    returned_hunks: shown,
    truncated: parsed.length > files.length || totalHunks > shown,
  }
}

async function locateHunk(sandbox, args, options) {
  const root = await repoRoot(sandbox, args.path)
  const wanted = String(args.hunk_id ?? '').trim()
  if (wanted === '') fail('INVALID_ARGUMENT', 'hunk_id is required')
  const { argv } = await diffArguments(root, args, options)
  const result = await git(root, argv, options)
  // The same text review_diff parsed, untracked files included -- otherwise a
  // hunk this bridge just handed out would be unaddressable, which reads to the
  // caller as a stale id when nothing is stale.
  const files = parseUnifiedDiff(result.stdout + await untrackedDiff(root, args, options))
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (hunk.hunk_id === wanted) return { root, file, hunk }
    }
  }
  // Content-addressed ids mean a stale one is detectable, and detected.
  fail('CONFLICT', `hunk ${wanted} is not in the current diff. The change moved or was already applied: run review_diff again and use a fresh hunk_id.`)
}

/** review_stage_hunk: stage exactly one hunk. */
export async function stageHunk(sandbox, args = {}, options = {}) {
  const { root, file, hunk } = await locateHunk(sandbox, args, options)
  const patch = buildHunkPatch(file, hunk)
  const applied = await git(root, ['apply', '--cached', '-'], { ...options, stdin: patch, allowFailure: true })
  if (applied.exitCode !== 0) {
    fail('GIT_CONFLICT', `the hunk could not be staged: ${(applied.stderr || applied.stdout || '').trim()}`)
  }
  return { repository: root, path: file.path, hunk_id: hunk.hunk_id, staged: true, additions: hunk.additions, deletions: hunk.deletions }
}

/** review_revert_hunk: undo exactly one hunk in the working tree. */
export async function revertHunk(sandbox, args = {}, options = {}) {
  const { root, file, hunk } = await locateHunk(sandbox, args, options)
  const patch = buildHunkPatch(file, hunk)
  const check = await git(root, ['apply', '--reverse', '--check', '-'], { ...options, stdin: patch, allowFailure: true })
  if (check.exitCode !== 0) {
    fail('GIT_CONFLICT', `the hunk cannot be reverted cleanly: ${(check.stderr || check.stdout || '').trim()}. Nothing was changed.`)
  }
  const applied = await git(root, ['apply', '--reverse', '-'], { ...options, stdin: patch, allowFailure: true })
  if (applied.exitCode !== 0) {
    fail('GIT_CONFLICT', `the hunk could not be reverted: ${(applied.stderr || applied.stdout || '').trim()}`)
  }
  return { repository: root, path: file.path, hunk_id: hunk.hunk_id, reverted: true, additions: hunk.additions, deletions: hunk.deletions }
}

/**
 * review_findings: normalize a reviewer's findings and check each one against
 * the diff it claims to describe.
 *
 * This is not a notepad. A finding whose file is not in the change, or whose
 * line is not inside a changed hunk, is flagged -- because a review that points
 * at code the change never touched is the most common way review output wastes
 * the reader's time.
 */
export async function checkFindings(sandbox, args = {}, options = {}) {
  const input = Array.isArray(args.findings) ? args.findings : []
  if (input.length === 0) fail('INVALID_ARGUMENT', 'findings must be a non-empty array')
  if (input.length > REVIEW_LIMITS.max_findings) {
    fail('INVALID_ARGUMENT', `findings accepts at most ${REVIEW_LIMITS.max_findings} entries`)
  }
  const diff = await reviewDiff(sandbox, args, options)
  const changed = new Map()
  for (const file of diff.files) {
    const ranges = file.hunks.map(hunk => [hunk.new_start, hunk.new_start + Math.max(0, (hunk.new_lines ?? 1) - 1)])
    changed.set(file.path, ranges)
  }

  const findings = input.map((entry, index) => {
    const file = String(entry?.file ?? '').trim()
    const line = Number(entry?.line)
    const priority = PRIORITIES.includes(entry?.priority) ? entry.priority : 'medium'
    const summary = String(entry?.summary ?? '').trim().slice(0, REVIEW_LIMITS.max_summary_length)
    if (file === '') fail('INVALID_ARGUMENT', `findings[${index}].file is required`)
    if (summary === '') fail('INVALID_ARGUMENT', `findings[${index}].summary is required`)
    const ranges = changed.get(file)
    const inChange = ranges !== undefined
    const inHunk = inChange && Number.isFinite(line)
      ? ranges.some(([start, end]) => line >= start && line <= end)
      : false
    return {
      file,
      line: Number.isFinite(line) ? line : undefined,
      priority,
      summary,
      in_changed_file: inChange,
      in_changed_hunk: inHunk || undefined,
      // Said plainly rather than hidden in a boolean: this is the finding the
      // reader should double-check first.
      note: inChange ? undefined : 'this file is not part of the change under review',
    }
  })

  const order = new Map(PRIORITIES.map((value, index) => [value, index]))
  findings.sort((left, right) => order.get(left.priority) - order.get(right.priority))
  return {
    repository: diff.repository,
    against: diff.against,
    findings,
    total: findings.length,
    outside_change: findings.filter(finding => !finding.in_changed_file).length,
    by_priority: PRIORITIES.reduce((counts, priority) => ({
      ...counts,
      [priority]: findings.filter(finding => finding.priority === priority).length,
    }), {}),
  }
}
