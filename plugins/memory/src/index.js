import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './store.js'

export const name = 'shiro-memory'
export const inject = ['tools']

const MEMORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    content: { type: 'string' },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    importance: { type: 'string', required: true, enum: ['low', 'normal', 'high'] },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    archivedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  },
}

const FULL_MEMORY_SCHEMA = {
  ...MEMORY_SCHEMA,
  properties: { ...MEMORY_SCHEMA.properties, content: { type: 'string', required: true } },
}

const output = schema => ({
  schema,
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
})

const tagsParameter = {
  type: 'array',
  items: { type: 'string' },
  description: 'Optional tags. Matching is case-insensitive and accent-insensitive.',
}

export function apply(ctx, config = {}) {
  const memoryRoot = typeof config.memoryRoot === 'string' && config.memoryRoot.trim() !== ''
    ? resolve(config.memoryRoot)
    : null
  if (memoryRoot === null) throw new Error('shiro-memory: memoryRoot must be configured')
  const store = new MemoryStore(memoryRoot)

  ctx.tools.register(defineTool({
    name: 'memory_store',
    description: 'Persist a durable Shiro memory across chats. Omit id to create; pass an existing id to update and reactivate it.',
    parameters: {
      id: { type: 'string', description: 'Existing memory id to update.' },
      title: { type: 'string', description: 'Short optional title.' },
      content: { type: 'string', required: true, description: 'The fact, preference, decision, note, or reusable context to remember.' },
      tags: tagsParameter,
      importance: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' },
    },
    output: output(FULL_MEMORY_SCHEMA),
    execute: args => store.store(args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search durable Shiro memories by phrase, words, title, content, and optional tags.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to recall.' },
      tags: tagsParameter,
      limit: { type: 'integer', description: 'Maximum matches from 1 to 50.', default: 8 },
    },
    output: output({
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', required: true },
        matches: {
          type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              ...MEMORY_SCHEMA.properties,
              score: { type: 'number', required: true },
              snippet: { type: 'string', required: true },
            },
          },
        },
      },
    }),
    isConcurrencySafe: () => true,
    execute: args => store.search(args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_get',
    description: 'Read one durable Shiro memory by id.',
    parameters: {
      id: { type: 'string', required: true },
      include_archived: { type: 'boolean', default: false },
    },
    output: output(FULL_MEMORY_SCHEMA),
    isConcurrencySafe: () => true,
    execute: args => store.get(args.id, args.include_archived ?? false),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List recent durable Shiro memories, optionally filtered by tags and active/archive state.',
    parameters: {
      tags: tagsParameter,
      state: { type: 'string', enum: ['active', 'archived', 'all'], default: 'active' },
      limit: { type: 'integer', default: 20, description: 'Maximum results from 1 to 100.' },
    },
    output: output({
      type: 'object', additionalProperties: false, properties: {
        state: { type: 'string', required: true, enum: ['active', 'archived', 'all'] },
        memories: { type: 'array', required: true, items: MEMORY_SCHEMA },
      },
    }),
    isConcurrencySafe: () => true,
    execute: args => store.list(args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Reversibly archive one durable Shiro memory. This does not permanently delete it.',
    parameters: { id: { type: 'string', required: true } },
    output: output(FULL_MEMORY_SCHEMA),
    execute: args => store.archive(args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_restore',
    description: 'Restore one archived durable Shiro memory.',
    parameters: { id: { type: 'string', required: true } },
    output: output(FULL_MEMORY_SCHEMA),
    execute: args => store.restore(args.id),
  }))
}
