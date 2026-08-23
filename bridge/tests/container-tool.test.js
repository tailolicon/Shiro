import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRelative } from '../src/container-path.js'

test('container workdir stays beneath the fixed root', () => {
  assert.equal(workspaceRelative('E:\\Project\\Shiro', '.'), '/workspace')
  assert.equal(workspaceRelative('E:\\Project\\Shiro', 'bridge'), '/workspace/bridge')
  assert.throws(() => workspaceRelative('E:\\Project\\Shiro', '..'), /escapes/)
  assert.throws(() => workspaceRelative('E:\\Project\\Shiro', 'C:\\Windows'), /relative/)
})
