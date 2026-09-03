import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { asActionError, fail, guard } from './action-errors.js'

// Deterministic filesystem actions for the Shiro connector.
//
// Every one of these replaces what used to be a Harness turn ("read this
// file", "list that directory", "grep for X"): no LLM, no durable session, one
// MCP round-trip. Confinement is delegated to Sandbox (sandbox.js) so there is
// a single symlink-aware implementation of "inside the fixed project root".
//
// All outputs are bounded. A caller that hits a limit gets `truncated: true`
// plus the cursor/offset needed to continue, never a silent short read.

export const FS_LIMITS = Object.freeze({
  read_max_bytes: 1_000_000,
  read_default_bytes: 131_072,
  line_mode_max_bytes: 4_000_000,
  hash_max_bytes: 8_000_000,
  list_max_entries: 1000,
  list_default_entries: 200,
  list_scan_cap: 20_000,
  list_max_depth: 32,
  search_max_results: 500,
  search_default_results: 50,
  search_max_file_bytes: 2_000_000,
  search_scan_cap: 20_000,
  search_snippet_bytes: 400,
  write_max_bytes: 4_000_000,
})

// Directories that would otherwise dominate every listing and search in this
// repository. `include_ignored` opts back in explicitly.
export const DEFAULT_IGNORED_DIRECTORIES = Object.freeze([
  '.git', 'node_modules', '.pnpm-store', '.venv', '__pycache__',
  'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '.ShiroRuntime',
])

const IGNORED = new Set(DEFAULT_IGNORED_DIRECTORIES)

function isoTime(value) {
  return new Date(value).toISOString()
}

function entryType(info) {
  if (info.isSymbolicLink()) return 'symlink'
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  return 'other'
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

/**
 * Minimal glob matcher over '/'-joined project-relative paths.
 * Supports '*' (no separator), '**' (any depth), '?' and character classes --
 * enough for include/exclude filters without pulling in a dependency whose
 * transitive surface would need auditing.
 */
export function globToRegExp(pattern, { caseSensitive = true } = {}) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') index += 1
        source += '(?:.*/)?'
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') { source += '[^/]'; continue }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1)
      if (close === -1) { source += '\\['; continue }
      const body = pattern.slice(index + 1, close).replace(/\\/g, '\\\\')
      source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
      index = close
      continue
    }
    source += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  source += '$'
  try {
    return new RegExp(source, caseSensitive ? '' : 'i')
  } catch {
    fail('INVALID_ARGUMENT', `glob pattern is not usable: ${pattern}`)
  }
}

function matchesAny(relativePath, patterns) {
  return patterns.some(pattern => pattern.test(relativePath))
}

function compileGlobs(value, label) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  if (list.length > 32) fail('INVALID_ARGUMENT', `${label} accepts at most 32 patterns`)
  return list.map(pattern => {
    if (typeof pattern !== 'string' || pattern === '') fail('INVALID_ARGUMENT', `${label} entries must be non-empty strings`)
    return globToRegExp(pattern)
  })
}

async function fileMetadata(absolute, relativePath, info, { includeHash = false } = {}) {
  const meta = {
    path: relativePath,
    type: entryType(info),
    size: info.size,
    mtime: isoTime(info.mtimeMs),
    ctime: isoTime(info.ctimeMs),
    mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
  }
  if (includeHash && info.isFile() && info.size <= FS_LIMITS.hash_max_bytes) {
    meta.sha256 = sha256(await guard(() => readFile(absolute), { prefix: 'read for hash' }))
  }
  return meta
}

/** fs_read: bounded file read by byte window or line range. */
export async function readEntry(sandbox, args = {}) {
  const target = await sandbox.resolveExisting(args.path)
  const info = await guard(() => stat(target.absolute), { prefix: 'stat' })
  if (!info.isFile()) fail('INVALID_ARGUMENT', `path is a ${entryType(info)}, not a regular file: ${target.relative}`)
  const encoding = args.encoding ?? 'utf8'
  if (encoding !== 'utf8' && encoding !== 'base64') fail('INVALID_ARGUMENT', 'encoding must be utf8 or base64')

  const wantsLines = args.start_line !== undefined || args.end_line !== undefined
  const hashable = info.size <= FS_LIMITS.hash_max_bytes

  if (wantsLines) {
    if (encoding !== 'utf8') fail('INVALID_ARGUMENT', 'line ranges require encoding utf8')
    if (info.size > FS_LIMITS.line_mode_max_bytes) {
      fail('INVALID_ARGUMENT', `file is ${info.size} bytes; line ranges are supported up to ${FS_LIMITS.line_mode_max_bytes}. Read it with offset/max_bytes instead.`)
    }
    const buffer = await guard(() => readFile(target.absolute), { prefix: 'read' })
    const lines = buffer.toString('utf8').split('\n')
    const lineCount = lines.length
    const startLine = clampInteger(args.start_line, { min: 1, max: Math.max(lineCount, 1), fallback: 1, label: 'start_line' })
    const endLine = clampInteger(args.end_line, { min: 1, max: Math.max(lineCount, 1), fallback: lineCount, label: 'end_line' })
    if (endLine < startLine) fail('INVALID_ARGUMENT', 'end_line must be greater than or equal to start_line')
    const maxBytes = clampInteger(args.max_bytes, { min: 1, max: FS_LIMITS.read_max_bytes, fallback: FS_LIMITS.read_default_bytes, label: 'max_bytes' })
    const selected = []
    let used = 0
    let last = startLine - 1
    for (let index = startLine - 1; index < endLine; index += 1) {
      const size = Buffer.byteLength(lines[index], 'utf8') + 1
      if (selected.length > 0 && used + size > maxBytes) break
      selected.push(lines[index])
      used += size
      last = index
    }
    const truncated = last + 1 < endLine
    return {
      path: target.relative,
      encoding: 'utf8',
      mode: 'lines',
      content: selected.join('\n'),
      start_line: startLine,
      end_line: last + 1,
      line_count: lineCount,
      size: info.size,
      mtime: isoTime(info.mtimeMs),
      sha256: hashable ? sha256(buffer) : undefined,
      truncated,
      next_start_line: truncated ? last + 2 : undefined,
      eof: !truncated && last + 1 >= lineCount,
    }
  }

  const offset = clampInteger(args.offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0, label: 'offset' })
  if (offset > info.size) fail('INVALID_ARGUMENT', `offset ${offset} is beyond the ${info.size}-byte file`)
  const maxBytes = clampInteger(args.max_bytes, { min: 1, max: FS_LIMITS.read_max_bytes, fallback: FS_LIMITS.read_default_bytes, label: 'max_bytes' })
  const length = Math.min(maxBytes, info.size - offset)
  const handle = await guard(() => open(target.absolute, 'r'), { prefix: 'open' })
  let slice
  let full
  try {
    slice = Buffer.alloc(length)
    if (length > 0) await handle.read(slice, 0, length, offset)
    full = hashable ? await handle.readFile() : null
  } finally {
    await handle.close()
  }
  const nextOffset = offset + length
  const truncated = nextOffset < info.size
  return {
    path: target.relative,
    encoding,
    mode: 'bytes',
    content: slice.toString(encoding),
    byte_offset: offset,
    bytes_returned: length,
    size: info.size,
    mtime: isoTime(info.mtimeMs),
    sha256: full === null ? undefined : sha256(full),
    truncated,
    next_offset: truncated ? nextOffset : undefined,
    eof: !truncated,
  }
}

/** fs_list: bounded, deterministic directory listing with an index cursor. */
export async function listDirectory(sandbox, args = {}) {
  const target = await sandbox.resolveExisting(args.path ?? '.')
  const info = await guard(() => stat(target.absolute), { prefix: 'stat' })
  if (!info.isDirectory()) fail('INVALID_ARGUMENT', `path is not a directory: ${target.relative}`)
  const recursive = args.recursive === true
  const depth = clampInteger(args.depth, { min: 1, max: FS_LIMITS.list_max_depth, fallback: recursive ? 8 : 1, label: 'depth' })
  const limit = clampInteger(args.limit, { min: 1, max: FS_LIMITS.list_max_entries, fallback: FS_LIMITS.list_default_entries, label: 'limit' })
  const cursor = args.cursor === undefined ? 0 : Number(args.cursor)
  if (!Number.isInteger(cursor) || cursor < 0) fail('INVALID_ARGUMENT', 'cursor must be a non-negative integer index returned by a previous call')
  const includeHidden = args.include_hidden === true
  const includeIgnored = args.include_ignored === true
  const globs = compileGlobs(args.glob, 'glob')
  const excludes = compileGlobs(args.exclude, 'exclude')

  const entries = []
  let scanned = 0
  let scanCapped = false
  const walk = async (directory, level) => {
    if (scanCapped) return
    let items
    try {
      items = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (level === 0) throw error
      return
    }
    items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const item of items) {
      if (scanned >= FS_LIMITS.list_scan_cap) { scanCapped = true; return }
      if (!includeHidden && item.name.startsWith('.')) continue
      if (!includeIgnored && item.isDirectory() && IGNORED.has(item.name)) continue
      scanned += 1
      const absolute = join(directory, item.name)
      const relativePath = sandbox.relative(absolute)
      const isDirectory = item.isDirectory()
      const matches = (globs.length === 0 || matchesAny(relativePath, globs))
        && !(excludes.length > 0 && matchesAny(relativePath, excludes))
      if (matches) {
        let itemInfo = null
        try { itemInfo = await lstat(absolute) } catch { itemInfo = null }
        entries.push({
          path: relativePath,
          name: item.name,
          type: itemInfo === null ? (isDirectory ? 'directory' : 'file') : entryType(itemInfo),
          size: itemInfo === null || isDirectory ? undefined : itemInfo.size,
          mtime: itemInfo === null ? undefined : isoTime(itemInfo.mtimeMs),
        })
      }
      if (recursive && isDirectory && level + 1 < depth) await walk(absolute, level + 1)
    }
  }
  await guard(() => walk(target.absolute, 0), { prefix: 'list' })

  const page = entries.slice(cursor, cursor + limit)
  const next = cursor + page.length
  const truncated = next < entries.length
  return {
    path: target.relative,
    entries: page,
    total_matched: entries.length,
    returned: page.length,
    cursor,
    truncated: truncated || scanCapped,
    next_cursor: truncated ? String(next) : undefined,
    scan_capped: scanCapped ? FS_LIMITS.list_scan_cap : undefined,
  }
}

/** fs_stat: metadata for one path, hashing only when asked and cheap. */
export async function statPath(sandbox, args = {}) {
  const follow = args.follow !== false
  const target = await sandbox.resolveExisting(args.path, { follow: false })
  const linkInfo = await guard(() => lstat(target.absolute), { prefix: 'lstat' })
  if (!linkInfo.isSymbolicLink()) {
    return { ...await fileMetadata(target.absolute, target.relative, linkInfo, { includeHash: args.include_hash === true }), is_symlink: false }
  }
  const linkTarget = await guard(() => readlink(target.absolute), { prefix: 'readlink' })
  if (!follow) {
    return {
      path: target.relative,
      type: 'symlink',
      size: linkInfo.size,
      mtime: isoTime(linkInfo.mtimeMs),
      ctime: isoTime(linkInfo.ctimeMs),
      mode: (linkInfo.mode & 0o777).toString(8).padStart(3, '0'),
      is_symlink: true,
      symlink_target: linkTarget,
    }
  }
  const followed = await sandbox.resolveExisting(args.path)
  const info = await guard(() => stat(followed.absolute), { prefix: 'stat' })
  return {
    ...await fileMetadata(followed.absolute, target.relative, info, { includeHash: args.include_hash === true }),
    is_symlink: true,
    symlink_target: linkTarget,
  }
}

function looksBinary(buffer) {
  return buffer.subarray(0, 4096).includes(0)
}

/** fs_search: bounded literal/regex content search with snippets. */
export async function searchText(sandbox, args = {}) {
  const query = args.query
  if (typeof query !== 'string' || query === '') fail('INVALID_ARGUMENT', 'query is required')
  const target = await sandbox.resolveExisting(args.path ?? '.')
  const caseSensitive = args.case_sensitive === true
  const flags = caseSensitive ? 'g' : 'gi'
  const source = args.regex === true ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (args.regex === true) {
    try {
      new RegExp(source, flags)
    } catch (error) {
      fail('INVALID_ARGUMENT', `query is not a valid regular expression: ${error.message}`)
    }
  }
  const maxResults = clampInteger(args.max_results, { min: 1, max: FS_LIMITS.search_max_results, fallback: FS_LIMITS.search_default_results, label: 'max_results' })
  const perFile = clampInteger(args.max_matches_per_file, { min: 1, max: 100, fallback: 10, label: 'max_matches_per_file' })
  const contextLines = clampInteger(args.context_lines, { min: 0, max: 5, fallback: 0, label: 'context_lines' })
  const includeIgnored = args.include_ignored === true
  const includeHidden = args.include_hidden === true
  const globs = compileGlobs(args.glob, 'glob')
  const excludes = compileGlobs(args.exclude, 'exclude')

  // Phase 1: collect the candidate files in deterministic sorted order. Doing
  // this before any reading is what lets phase 2 read in parallel without the
  // result order depending on which read happened to finish first.
  const candidates = []
  let scanCapped = false
  const collect = async directory => {
    if (scanCapped) return
    let items
    try { items = await readdir(directory, { withFileTypes: true }) } catch { return }
    items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const item of items) {
      if (scanCapped) return
      if (candidates.length >= FS_LIMITS.search_scan_cap) { scanCapped = true; return }
      if (!includeHidden && item.name.startsWith('.')) continue
      const absolute = join(directory, item.name)
      const relativePath = sandbox.relative(absolute)
      if (item.isDirectory()) {
        if (!includeIgnored && IGNORED.has(item.name)) continue
        if (excludes.length > 0 && matchesAny(relativePath, excludes)) continue
        await collect(absolute)
        continue
      }
      if (!item.isFile()) continue
      if (globs.length > 0 && !matchesAny(relativePath, globs)) continue
      if (excludes.length > 0 && matchesAny(relativePath, excludes)) continue
      candidates.push({ absolute, relativePath })
    }
  }

  const scanOne = async ({ absolute, relativePath }) => {
    let info
    try { info = await stat(absolute) } catch { return null }
    if (!info.isFile()) return null
    if (info.size > FS_LIMITS.search_max_file_bytes) return { skipped: true, matches: [] }
    let buffer
    try { buffer = await readFile(absolute) } catch { return { skipped: true, matches: [] } }
    if (looksBinary(buffer)) return { skipped: true, matches: [] }
    const text = buffer.toString('utf8')
    // Whole-buffer pre-check: most scanned files hold no match at all, and
    // splitting every one of them into lines is what makes a repository-wide
    // search slow. Only files that can match pay for the line split.
    const probe = new RegExp(source, flags)
    if (!probe.test(text)) return { skipped: false, matches: [] }
    const lines = text.split('\n')
    const matcher = new RegExp(source, flags)
    const matches = []
    for (let index = 0; index < lines.length && matches.length < perFile; index += 1) {
      matcher.lastIndex = 0
      const hit = matcher.exec(lines[index])
      if (hit === null) continue
      const line = lines[index]
      matches.push({
        path: relativePath,
        line: index + 1,
        column: hit.index + 1,
        text: line.length > FS_LIMITS.search_snippet_bytes ? `${line.slice(0, FS_LIMITS.search_snippet_bytes)}\u2026` : line,
        before: contextLines === 0 ? undefined : lines.slice(Math.max(0, index - contextLines), index),
        after: contextLines === 0 ? undefined : lines.slice(index + 1, index + 1 + contextLines),
      })
    }
    return { skipped: false, matches }
  }

  const rootInfo = await guard(() => stat(target.absolute), { prefix: 'stat' })
  if (rootInfo.isFile()) candidates.push({ absolute: target.absolute, relativePath: target.relative })
  else await guard(() => collect(target.absolute), { prefix: 'search' })

  // Phase 2: read in bounded parallel batches, appending results in candidate
  // order so the response is identical no matter how the reads interleave.
  const matches = []
  let filesScanned = 0
  let filesSkipped = 0
  let truncated = false
  const BATCH = 16
  for (let start = 0; start < candidates.length && !truncated; start += BATCH) {
    const batch = await Promise.all(candidates.slice(start, start + BATCH).map(scanOne))
    for (const outcome of batch) {
      if (outcome === null) continue
      if (outcome.skipped) { filesSkipped += 1; continue }
      filesScanned += 1
      for (const match of outcome.matches) {
        if (matches.length >= maxResults) { truncated = true; break }
        matches.push(match)
      }
    }
  }

  return {
    query,
    regex: args.regex === true,
    path: target.relative,
    matches,
    match_count: matches.length,
    files_scanned: filesScanned,
    files_skipped: filesSkipped,
    truncated: truncated || scanCapped,
    // Distinguish "stopped at max_results" from "did not look at every file":
    // only the second means the answer could be incomplete for the whole tree.
    scan_capped: scanCapped ? FS_LIMITS.search_scan_cap : undefined,
  }
}

function assertWritableSize(content) {
  const bytes = Buffer.byteLength(content)
  if (bytes > FS_LIMITS.write_max_bytes) {
    fail('INVALID_ARGUMENT', `content is ${bytes} bytes; the direct-write limit is ${FS_LIMITS.write_max_bytes}. Write it in pieces with fs_update_file mode=append.`)
  }
  return bytes
}

function decodeContent(content, encoding) {
  if (typeof content !== 'string') fail('INVALID_ARGUMENT', 'content must be a string')
  if (encoding === 'base64') {
    const buffer = Buffer.from(content, 'base64')
    if (buffer.toString('base64').replace(/=+$/, '') !== content.replace(/\s/g, '').replace(/=+$/, '')) {
      fail('INVALID_ARGUMENT', 'content is not valid base64')
    }
    return buffer
  }
  if (encoding !== undefined && encoding !== 'utf8') fail('INVALID_ARGUMENT', 'encoding must be utf8 or base64')
  return Buffer.from(content, 'utf8')
}

/**
 * Write through a same-directory temporary file and rename() over the target,
 * so a reader never observes a half-written file and a failed write leaves the
 * previous content intact.
 */
async function atomicWrite(absolute, buffer, mode) {
  const temporary = join(dirname(absolute), `.shiro-write.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await writeFile(temporary, buffer, mode === undefined ? {} : { mode })
    await rename(temporary, absolute)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function readIfExists(absolute) {
  try {
    const info = await lstat(absolute)
    if (!info.isFile()) return { info, content: null }
    return { info, content: await readFile(absolute) }
  } catch {
    return { info: null, content: null }
  }
}

/** fs_create_file: idempotent create; identical content is a safe no-op. */
export async function createFile(sandbox, args = {}) {
  const target = await sandbox.resolveForWrite(args.path)
  const buffer = decodeContent(args.content ?? '', args.encoding)
  assertWritableSize(buffer)
  const existing = await readIfExists(target.absolute)
  if (existing.info !== null) {
    if (!existing.info.isFile()) fail('CONFLICT', `path already exists as a ${entryType(existing.info)}: ${target.relative}`)
    if (existing.content !== null && existing.content.equals(buffer)) {
      const info = await stat(target.absolute)
      return { path: target.relative, created: false, unchanged: true, bytes: buffer.length, sha256: sha256(buffer), mtime: isoTime(info.mtimeMs) }
    }
    if (args.fail_if_exists !== false) {
      fail('ALREADY_EXISTS', `file already exists with different content: ${target.relative}. Use fs_update_file (optionally with expected_sha256), or pass fail_if_exists=false to overwrite.`)
    }
  }
  if (args.create_parents === true) {
    await guard(() => mkdir(dirname(target.absolute), { recursive: true }), { prefix: 'create parents' })
  } else if (existing.info === null) {
    const parent = dirname(target.absolute)
    try { await stat(parent) } catch { fail('NOT_FOUND', `parent directory does not exist: ${sandbox.relative(parent)}. Pass create_parents=true or call fs_mkdir first.`) }
  }
  await guard(() => atomicWrite(target.absolute, buffer), { prefix: 'write' })
  const info = await stat(target.absolute)
  return {
    path: target.relative,
    created: existing.info === null,
    unchanged: false,
    bytes: buffer.length,
    sha256: sha256(buffer),
    mtime: isoTime(info.mtimeMs),
    previous_sha256: existing.content === null ? undefined : sha256(existing.content),
  }
}

/** fs_update_file: full replace, single-occurrence patch, or append. */
export async function updateFile(sandbox, args = {}) {
  const target = await sandbox.resolveForWrite(args.path)
  const mode = args.mode ?? 'replace'
  if (!['replace', 'replace_once', 'append'].includes(mode)) fail('INVALID_ARGUMENT', 'mode must be replace, replace_once, or append')
  const existing = await readIfExists(target.absolute)
  if (existing.info === null) {
    if (args.create !== true) fail('NOT_FOUND', `file does not exist: ${target.relative}. Use fs_create_file, or pass create=true.`)
    if (mode === 'replace_once') fail('NOT_FOUND', `file does not exist: ${target.relative}; replace_once needs existing content.`)
  } else if (!existing.info.isFile()) {
    fail('INVALID_ARGUMENT', `path is a ${entryType(existing.info)}, not a regular file: ${target.relative}`)
  }
  const previous = existing.content ?? Buffer.alloc(0)
  const previousHash = existing.info === null ? undefined : sha256(previous)
  if (args.expected_sha256 !== undefined && args.expected_sha256 !== previousHash) {
    fail('CONFLICT', `file changed since it was read: expected_sha256 ${args.expected_sha256} but the file is ${previousHash ?? '(missing)'}. Re-read with fs_read and retry.`)
  }

  let next
  let replacements
  if (mode === 'append') {
    next = Buffer.concat([previous, decodeContent(args.content ?? '', args.encoding)])
  } else if (mode === 'replace_once') {
    if (typeof args.find !== 'string' || args.find === '') fail('INVALID_ARGUMENT', 'replace_once requires a non-empty find string')
    if (typeof args.replace !== 'string') fail('INVALID_ARGUMENT', 'replace_once requires a replace string')
    const text = previous.toString('utf8')
    const first = text.indexOf(args.find)
    if (first === -1) fail('NOT_FOUND', `find text does not occur in ${target.relative}`)
    if (text.indexOf(args.find, first + args.find.length) !== -1) {
      fail('CONFLICT', `find text occurs more than once in ${target.relative}; include enough surrounding context to make it unique`)
    }
    next = Buffer.from(`${text.slice(0, first)}${args.replace}${text.slice(first + args.find.length)}`, 'utf8')
    replacements = 1
  } else {
    next = decodeContent(args.content ?? '', args.encoding)
  }
  assertWritableSize(next)
  if (existing.info !== null && next.equals(previous)) {
    const info = await stat(target.absolute)
    return { path: target.relative, mode, unchanged: true, bytes: next.length, sha256: previousHash, previous_sha256: previousHash, mtime: isoTime(info.mtimeMs), replacements }
  }
  await guard(() => atomicWrite(target.absolute, next, existing.info === null ? undefined : existing.info.mode & 0o777), { prefix: 'write' })
  const info = await stat(target.absolute)
  return {
    path: target.relative,
    mode,
    unchanged: false,
    bytes: next.length,
    sha256: sha256(next),
    previous_sha256: previousHash,
    mtime: isoTime(info.mtimeMs),
    replacements,
    created: existing.info === null,
  }
}

/** fs_mkdir: create a directory; exist_ok makes it idempotent. */
export async function makeDirectory(sandbox, args = {}) {
  const target = await sandbox.resolveForWrite(args.path)
  const existing = await lstat(target.absolute).catch(() => null)
  if (existing !== null) {
    if (!existing.isDirectory()) fail('CONFLICT', `path already exists as a ${entryType(existing)}: ${target.relative}`)
    if (args.exist_ok === false) fail('ALREADY_EXISTS', `directory already exists: ${target.relative}`)
    return { path: target.relative, created: false }
  }
  await guard(() => mkdir(target.absolute, { recursive: args.parents === true }), { prefix: 'mkdir' })
  return { path: target.relative, created: true }
}

/** fs_delete: remove one path; trees need recursive=true and confirm=true. */
export async function deletePath(sandbox, args = {}) {
  const target = await sandbox.resolveExisting(args.path, { follow: false })
  const info = await guard(() => lstat(target.absolute), { prefix: 'lstat' })
  const type = entryType(info)
  if (args.expected_type !== undefined && args.expected_type !== type) {
    fail('CONFLICT', `path is a ${type}, not the expected ${args.expected_type}: ${target.relative}`)
  }
  if (type === 'directory') {
    const items = await guard(() => readdir(target.absolute), { prefix: 'readdir' })
    if (items.length > 0 && args.recursive !== true) {
      fail('CONFLICT', `directory is not empty (${items.length} entries): ${target.relative}. Pass recursive=true with confirm=true to delete the tree.`)
    }
    await guard(() => rm(target.absolute, { recursive: true, force: false }), { prefix: 'delete' })
    return { path: target.relative, deleted: true, type, entries_removed: items.length }
  }
  if (type === 'file' && args.expected_sha256 !== undefined) {
    const actual = sha256(await guard(() => readFile(target.absolute), { prefix: 'read' }))
    if (actual !== args.expected_sha256) {
      fail('CONFLICT', `file changed since it was read: expected_sha256 ${args.expected_sha256} but the file is ${actual}`)
    }
  }
  await guard(() => unlink(target.absolute), { prefix: 'delete' })
  return { path: target.relative, deleted: true, type }
}

async function prepareDestination(sandbox, args, label) {
  const source = await sandbox.resolveExisting(args.source, { follow: false })
  const destination = await sandbox.resolveForWrite(args.destination)
  const existing = await lstat(destination.absolute).catch(() => null)
  if (existing !== null && args.overwrite !== true) {
    fail('ALREADY_EXISTS', `${label} destination already exists: ${destination.relative}. Pass overwrite=true with confirm=true to replace it.`)
  }
  if (args.create_parents === true) {
    await guard(() => mkdir(dirname(destination.absolute), { recursive: true }), { prefix: 'create parents' })
  }
  return { source, destination, overwrote: existing !== null }
}

/** fs_move: rename inside the root, with a copy+delete fallback across devices. */
export async function movePath(sandbox, args = {}) {
  const { source, destination, overwrote } = await prepareDestination(sandbox, args, 'move')
  if (source.absolute === destination.absolute) return { source: source.relative, destination: destination.relative, moved: false, unchanged: true }
  try {
    await rename(source.absolute, destination.absolute)
  } catch (error) {
    // Only a cross-device rename is worth a copy+delete fallback; every other
    // failure (permissions, a vanished source) must surface as itself.
    if (error.code !== 'EXDEV') throw asActionError(error, 'INTERNAL', 'move')
    await guard(() => cp(source.absolute, destination.absolute, { recursive: true, force: true, verbatimSymlinks: true }), { prefix: 'move (copy stage)' })
    await guard(() => rm(source.absolute, { recursive: true, force: true }), { prefix: 'move (remove stage)' })
  }
  return { source: source.relative, destination: destination.relative, moved: true, overwrote }
}

/** fs_copy: copy a file or (with recursive=true) a tree inside the root. */
export async function copyPath(sandbox, args = {}) {
  const { source, destination, overwrote } = await prepareDestination(sandbox, args, 'copy')
  const info = await guard(() => lstat(source.absolute), { prefix: 'lstat' })
  if (info.isDirectory()) {
    if (args.recursive !== true) fail('INVALID_ARGUMENT', `source is a directory: ${source.relative}. Pass recursive=true to copy the tree.`)
    await guard(() => cp(source.absolute, destination.absolute, { recursive: true, force: args.overwrite === true, errorOnExist: args.overwrite !== true, verbatimSymlinks: true }), { prefix: 'copy' })
    return { source: source.relative, destination: destination.relative, copied: true, type: 'directory', overwrote }
  }
  await guard(() => copyFile(source.absolute, destination.absolute, args.overwrite === true ? 0 : fsConstants.COPYFILE_EXCL), { prefix: 'copy' })
  return { source: source.relative, destination: destination.relative, copied: true, type: entryType(info), overwrote }
}
