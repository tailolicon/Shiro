import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_CONTENT_LENGTH = 32_000
const MAX_TITLE_LENGTH = 240
const MAX_TAGS = 24
const MAX_TAG_LENGTH = 64
const MAX_MEMORIES = 20_000
const STORE_VERSION = 1

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  const text = value.trim()
  if (text.length > maxLength) throw new Error(`${label} must contain at most ${maxLength} characters`)
  return text
}

function optionalText(value, label, maxLength) {
  if (value === undefined) return undefined
  return requiredText(value, label, maxLength)
}

function normalizeTags(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('tags must be an array')
  if (value.length > MAX_TAGS) throw new Error(`tags must contain at most ${MAX_TAGS} items`)
  const tags = []
  const seen = new Set()
  for (const raw of value) {
    const tag = requiredText(raw, 'tag', MAX_TAG_LENGTH)
    const key = tag.normalize('NFKC').toLocaleLowerCase('vi')
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

function emptyDatabase() {
  return { version: STORE_VERSION, nextId: 1, memories: [] }
}

function validateDatabase(value) {
  if (typeof value !== 'object' || value === null || value.version !== STORE_VERSION
    || !Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.memories)) {
    throw new Error('Shiro memory database is invalid or uses an unsupported version')
  }
  return value
}

function fold(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('vi')
}

function terms(value) {
  return [...new Set(fold(value).split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length > 1))]
}

function snippet(content, queryTerms, maxLength = 360) {
  if (content.length <= maxLength) return content
  const folded = fold(content)
  let index = -1
  for (const term of queryTerms) {
    const candidate = folded.indexOf(term)
    if (candidate >= 0 && (index < 0 || candidate < index)) index = candidate
  }
  const start = Math.max(0, (index < 0 ? 0 : index) - 90)
  const end = Math.min(content.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

function publicMemory(memory, includeContent = true) {
  return {
    id: memory.id,
    title: memory.title ?? null,
    ...(includeContent ? { content: memory.content } : {}),
    tags: [...memory.tags],
    importance: memory.importance,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    archivedAt: memory.archivedAt,
  }
}

function scoreMemory(memory, query, queryTerms) {
  const title = fold(memory.title ?? '')
  const content = fold(memory.content)
  const tags = memory.tags.map(fold)
  const phrase = fold(query)
  let score = 0
  if (phrase.length > 1) {
    if (title.includes(phrase)) score += 16
    if (content.includes(phrase)) score += 8
    if (tags.some(tag => tag.includes(phrase))) score += 12
  }
  for (const term of queryTerms) {
    if (title.includes(term)) score += 5
    if (content.includes(term)) score += 2
    if (tags.some(tag => tag.includes(term))) score += 4
  }
  if (memory.importance === 'high') score += 1.5
  if (memory.importance === 'low') score -= 0.25
  return score
}

export class MemoryStore {
  #queue = Promise.resolve()

  constructor(root) {
    if (typeof root !== 'string' || root.trim() === '') throw new Error('memoryRoot is required')
    if (!isAbsolute(root)) throw new Error('memoryRoot must be an absolute path')
    this.root = resolve(root)
    this.path = join(this.root, 'memories.json')
  }

  #run(operation) {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  async #read() {
    try {
      return validateDatabase(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyDatabase()
      throw error
    }
  }

  async #write(database) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.path)
  }

  store(input) {
    return this.#run(async () => {
      const database = await this.#read()
      const now = new Date().toISOString()
      const id = optionalText(input.id, 'id', 80)
      const content = requiredText(input.content, 'content', MAX_CONTENT_LENGTH)
      const title = optionalText(input.title, 'title', MAX_TITLE_LENGTH)
      const tags = normalizeTags(input.tags)
      const importance = input.importance ?? 'normal'
      if (!['low', 'normal', 'high'].includes(importance)) throw new Error('importance must be low, normal, or high')
      let memory
      if (id !== undefined) {
        memory = database.memories.find(candidate => candidate.id === id)
        if (memory === undefined) throw new Error(`memory ${JSON.stringify(id)} was not found`)
        memory.title = title
        memory.content = content
        memory.tags = tags
        memory.importance = importance
        memory.updatedAt = now
        memory.archivedAt = null
      } else {
        if (database.memories.length >= MAX_MEMORIES) throw new Error(`memory limit reached (${MAX_MEMORIES})`)
        memory = {
          id: `mem_${String(database.nextId++).padStart(6, '0')}`,
          title,
          content,
          tags,
          importance,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        }
        database.memories.push(memory)
      }
      await this.#write(database)
      return publicMemory(memory)
    })
  }

  get(id, includeArchived = false) {
    return this.#run(async () => {
      const database = await this.#read()
      const normalizedId = requiredText(id, 'id', 80)
      const memory = database.memories.find(candidate => candidate.id === normalizedId)
      if (memory === undefined || (!includeArchived && memory.archivedAt !== null)) {
        throw new Error(`memory ${JSON.stringify(normalizedId)} was not found`)
      }
      return publicMemory(memory)
    })
  }

  search(input) {
    return this.#run(async () => {
      const database = await this.#read()
      const query = requiredText(input.query, 'query', 1_000)
      const queryTerms = terms(query)
      const wantedTags = normalizeTags(input.tags).map(fold)
      const limit = input.limit ?? 8
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50')
      const matches = database.memories
        .filter(memory => memory.archivedAt === null)
        .filter(memory => wantedTags.length === 0 || wantedTags.every(tag => memory.tags.map(fold).includes(tag)))
        .map(memory => ({ memory, score: scoreMemory(memory, query, queryTerms) }))
        .filter(match => match.score > 0)
        .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
        .slice(0, limit)
        .map(({ memory, score }) => ({
          ...publicMemory(memory, false),
          score: Math.round(score * 100) / 100,
          snippet: snippet(memory.content, queryTerms),
        }))
      return { query, matches }
    })
  }

  list(input = {}) {
    return this.#run(async () => {
      const database = await this.#read()
      const state = input.state ?? 'active'
      if (!['active', 'archived', 'all'].includes(state)) throw new Error('state must be active, archived, or all')
      const wantedTags = normalizeTags(input.tags).map(fold)
      const limit = input.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100')
      const memories = database.memories
        .filter(memory => state === 'all' || (state === 'active' ? memory.archivedAt === null : memory.archivedAt !== null))
        .filter(memory => wantedTags.length === 0 || wantedTags.every(tag => memory.tags.map(fold).includes(tag)))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
        .map(memory => publicMemory(memory, false))
      return { state, memories }
    })
  }

  archive(id) {
    return this.#setArchived(id, true)
  }

  restore(id) {
    return this.#setArchived(id, false)
  }

  #setArchived(id, archived) {
    return this.#run(async () => {
      const database = await this.#read()
      const normalizedId = requiredText(id, 'id', 80)
      const memory = database.memories.find(candidate => candidate.id === normalizedId)
      if (memory === undefined) throw new Error(`memory ${JSON.stringify(normalizedId)} was not found`)
      const now = new Date().toISOString()
      memory.archivedAt = archived ? now : null
      memory.updatedAt = now
      await this.#write(database)
      return publicMemory(memory)
    })
  }
}
