import { win32 } from 'node:path'

export function workspaceRelative(root, requested = '.') {
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('workdir must be a relative project path')
  if (win32.isAbsolute(requested)) throw new Error('workdir must stay relative to the fixed project root')
  const absolute = win32.resolve(root, requested)
  const rel = win32.relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${win32.sep}`) || win32.isAbsolute(rel)) throw new Error('workdir escapes the fixed project root')
  return rel === '' ? '/workspace' : `/workspace/${rel.split(win32.sep).join('/')}`
}
