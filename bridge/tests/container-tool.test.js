import test from 'node:test'
import assert from 'node:assert/strict'
import { containerArguments, workspaceRelative } from '../src/container-path.js'

test('container workdir stays beneath the fixed root', () => {
  assert.equal(workspaceRelative('E:\\Project\\Shiro', '.'), '/workspace')
  assert.equal(workspaceRelative('E:\\Project\\Shiro', 'bridge'), '/workspace/bridge')
  assert.throws(() => workspaceRelative('E:\\Project\\Shiro', '..'), /escapes/)
  assert.throws(() => workspaceRelative('E:\\Project\\Shiro', 'C:\\Windows'), /relative/)

  assert.equal(workspaceRelative('/home/tailolicon/Projects/Shiro', '.'), '/workspace')
  assert.equal(workspaceRelative('/home/tailolicon/Projects/Shiro', 'bridge/tests'), '/workspace/bridge/tests')
  assert.throws(() => workspaceRelative('/home/tailolicon/Projects/Shiro', '..'), /escapes/)
  assert.throws(() => workspaceRelative('/home/tailolicon/Projects/Shiro', '/etc'), /relative/)
})

test('shared dependency volumes are read-only during task execution', () => {
  const args = containerArguments({
    workspaceRoot: 'E:\\Project\\Shiro',
    command: 'npm test',
    workdir: '.',
    containerName: 'shiro-task-test',
  })
  const mounts = args.filter(value => typeof value === 'string' && value.startsWith('type=volume'))
  assert.equal(mounts.length, 3)
  assert.ok(mounts.every(value => value.endsWith(',readonly')))
})
