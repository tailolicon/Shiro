import { extname } from 'node:path'

// Shared file-kind classification: index.js uses it to pick the right MCP
// content block for harness_get_artifact, and the artifact_* direct actions use
// it to label listings. One table, so the two never disagree about what counts
// as an image or as text.

export const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
})

export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py',
  '.sh', '.bash', '.ps1', '.yml', '.yaml', '.html', '.css', '.svg', '.diff',
  '.patch', '.log', '.csv', '.tsv', '.xml', '.toml', '.ini', '.env', '.lua',
])

/** Classify by extension alone -- no read, so it is safe on a large listing. */
export function classifyByExtension(path) {
  const extension = extname(path).toLowerCase()
  const imageMime = IMAGE_MIME_BY_EXTENSION[extension]
  if (imageMime !== undefined) return { kind: 'image', mime_type: imageMime }
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', mime_type: 'text/plain' }
  return { kind: 'blob', mime_type: 'application/octet-stream' }
}
