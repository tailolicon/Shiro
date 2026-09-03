import { posix, win32 } from 'node:path'

const DEFAULT_IMAGE = process.env.SHIRO_RUNNER_IMAGE || 'shiro-runner:0.1.0'

export function workspaceRelative(root, requested = '.') {
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('workdir must be a relative project path')
  if (win32.isAbsolute(requested) || posix.isAbsolute(requested)) throw new Error('workdir must stay relative to the fixed project root')
  const pathApi = win32.isAbsolute(root) ? win32 : posix
  const absolute = pathApi.resolve(root, requested)
  const rel = pathApi.relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) throw new Error('workdir escapes the fixed project root')
  return rel === '' ? '/workspace' : `/workspace/${rel.split(pathApi.sep).join('/')}`
}

export function containerArguments({ workspaceRoot, command, workdir, containerName, image = DEFAULT_IMAGE }) {
  return [
    'run', '--rm', '--name', containerName,
    '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512', '--memory', '4g', '--cpus', '4',
    '--mount', `type=bind,source=${workspaceRoot},target=/workspace`,
    '--mount', 'type=volume,source=shiro-root-node-modules,target=/workspace/node_modules,readonly',
    '--mount', 'type=volume,source=shiro-bridge-node-modules,target=/workspace/bridge/node_modules,readonly',
    '--mount', 'type=volume,source=shiro-pnpm-store,target=/pnpm/store,readonly',
    '--workdir', workspaceRelative(workspaceRoot, workdir),
    '--env', 'CI=true', '--env', 'PNPM_STORE_DIR=/pnpm/store', image, command,
  ]
}
