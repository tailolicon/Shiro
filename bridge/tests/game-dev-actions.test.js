import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Sandbox } from '../src/sandbox.js'
import { ProcessRegistry, buildEnvironment, runCommand } from '../src/exec-actions.js'
import { selectDesktopEnvironment, parseDesktopEnvironment } from '../src/desktop-environment.js'
import { createGameDevTools, unityParameters, unwrapUnity, hyprlandDispatchArgv, registerGameDevActions } from '../src/game-dev-actions.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-game-tools-'))
  const sandbox = new Sandbox(root)
  const processes = new ProcessRegistry({ sandbox })
  const checked = []
  const policy = { assertCommand: a => checked.push(a.argv) }
  const tools = createGameDevTools({ sandbox, processes, policy, confinement: null })
  t.after(async () => { await processes.disposeAll(); await rm(root, { recursive: true, force: true }) })
  return { root, sandbox, processes, tools, checked }
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code)

async function fakeBinary(root, name, code, t) {
  const dir = join(root, 'bin')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), `#!${process.execPath}\n${code}`, { mode: 0o755 })
  const original = process.env.PATH
  process.env.PATH = `${dir}:${original}`
  t.after(() => { process.env.PATH = original })
}

test('desktop environment copies only bounded session metadata, never credentials', () => {
  const source = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', SHIRO_BRIDGE_TOKEN: 'secret-token',
    AWS_SECRET_ACCESS_KEY: 'private-key', XAUTHORITY: '/home/test/.Xauthority', PULSE_SERVER: 'bad\nvalue' }
  const result = selectDesktopEnvironment(source)
  assert.equal(result.DISPLAY, ':0')
  assert.equal(result.SHIRO_BRIDGE_TOKEN, undefined)
  assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(result.PULSE_SERVER, undefined)
  assert.equal(result.XAUTHORITY, source.XAUTHORITY)
  assert.equal(buildEnvironment({}, source).WAYLAND_DISPLAY, 'wayland-1')
})

test('systemd environment parsing keeps equals signs and excludes unrelated settings', () => {
  const value = parseDesktopEnvironment('DISPLAY=:0\nDBUS_SESSION_BUS_ADDRESS=unix:path=/x=1\nTOKEN=abc\nNOT_ALLOWED=foo')
  assert.deepEqual(value, { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x=1' })
  assert.deepEqual(selectDesktopEnvironment({ DISPLAY: 'x'.repeat(5000) }), {})
})

test('Unity parameters are argv data; reserved target and shell-like keys fail', () => {
  assert.deepEqual(unityParameters({ code: 'a; touch /tmp/not-executed', async_tests: true, scenes: ['a', 'b'] }),
    ['--code', 'a; touch /tmp/not-executed', '--async_tests', 'true', '--scenes', '["a","b"]'])
  for (const key of ['project-path', 'format', 'bad key', 'runtime', 'constructor']) assert.throws(() => unityParameters({ [key]: 'x' }), e => e.code === 'INVALID_ARGUMENT')
  assert.throws(() => unityParameters({ code: '\0' }), e => e.code === 'INVALID_ARGUMENT')
})

test('nested Unity failures never become success from exit zero', () => {
  assert.equal(unwrapUnity({ success: true, data: { result: '{"status":"completed","failed":true}' } }).success, false)
  assert.equal(unwrapUnity({ success: true, data: { result: { Summary: { Failed: 2 } } } }).success, false)
  assert.equal(unwrapUnity({ success: true, data: { result: { success: true, result: { success: false } } } }).success, false)
  assert.equal(unwrapUnity({ success: true, data: { result: { status: 'running' } } }).result.status, 'running')
  assert.equal(unwrapUnity({ success: false, errors: ['failure'] }).success, false)
})

test('Unity native command records fresh failure receipts instead of old Temp results', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'prototype/ProjectSettings'), { recursive: true })
  await writeFile(join(f.root, 'prototype/ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.23f1')
  await fakeBinary(f.root, 'unity', `console.log(JSON.stringify({success:true,data:{result:JSON.stringify({status:'completed',summary:{total:3,failed:1,passed:2}})}}))`, t)
  const a = await f.tools.unity({ command: 'test_status' })
  const b = await f.tools.unity({ command: 'test_status' })
  assert.equal(a.success, false)
  assert.notEqual(a.details.receipt, b.details.receipt)
  assert.equal(a.details.result.summary.failed, 1)
  const receipt = JSON.parse(await readFile(join(f.root, a.details.receipt), 'utf8'))
  assert.equal(receipt.exit_code, 0)
  assert.ok(receipt.logs.stdout.sha256)
  assert.ok(f.checked.some(a => a.includes('test_status')))
})

test('Unity rejects wrong project and attempts to override target before running it', async t => {
  const f = await fixture(t)
  await rejects(() => f.tools.unity({ project_path: '../escape' }), 'OUTSIDE_SANDBOX')
  await mkdir(join(f.root, 'prototype/ProjectSettings'), { recursive: true })
  await writeFile(join(f.root, 'prototype/ProjectSettings/ProjectVersion.txt'), 'version')
  await rejects(() => f.tools.unity({ service: 'bad;command.service' }), 'INVALID_ARGUMENT')
})

test('blender run validates workspace script paths including symlinks', async t => {
  const f = await fixture(t)
  await rejects(() => f.tools.blenderRun({}), 'INVALID_ARGUMENT')
  await symlink('/etc/passwd', join(f.root, 'escape.py'))
  await rejects(() => f.tools.blenderRun({ script: 'escape.py' }), 'OUTSIDE_SANDBOX')
  await writeFile(join(f.root, 'wrong.txt'), 'x')
  await rejects(() => f.tools.blenderRun({ script: 'wrong.txt' }), 'INVALID_ARGUMENT')
})

test('Blender background jobs return a registered process and durable logs', async t => {
  const f = await fixture(t)
  await fakeBinary(f.root, 'blender', `console.log('actual mock Blender execution');`, t)
  await writeFile(join(f.root, 'script.py'), 'print(42)')
  const started = await f.tools.blenderRun({ script: 'script.py', args: ['literal;argument'], timeout_seconds: 10 })
  assert.equal(started.details.status, 'started')
  let status
  for (let i = 0; i < 100; i++) {
    status = f.processes.status({ process_id: started.details.process_id })
    if (status.state !== 'running') break
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(status.exit_code, 0)
  const receipt = JSON.parse(await readFile(join(f.root, started.details.receipt), 'utf8'))
  assert.equal(receipt.success, true)
  assert.ok(receipt.argv.includes('--disable-autoexec'))
  assert.ok(receipt.argv.includes('literal;argument'))
})

test('job logs retain more than the connector ring without silently truncating', async t => {
  const f = await fixture(t)
  await fakeBinary(f.root, 'blender', `process.stdout.write('x'.repeat(1200000));`, t)
  await writeFile(join(f.root, 'script.py'), 'print(42)')
  const value = await f.tools.blenderRun({ script: 'script.py', background: false, timeout_seconds: 10 })
  assert.equal(value.success, true)
  assert.equal(value.details.output_truncated, true)
  const receipt = JSON.parse(await readFile(join(f.root, value.details.receipt), 'utf8'))
  assert.equal(receipt.logs.stdout.retained_bytes, 1200000)
  assert.equal(receipt.logs.stdout.truncated, false)
})

test('render refuses existing output and symlink escape without invoking Blender', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'model.glb'), 'test input')
  await writeFile(join(f.root, 'exists.png'), 'keep')
  await rejects(() => f.tools.blenderAsset({ path: 'model.glb', output: 'exists.png' }, true), 'ALREADY_EXISTS')
  await symlink('/tmp', join(f.root, 'outside'))
  await rejects(() => f.tools.blenderAsset({ path: 'model.glb', output: 'outside/test.png' }, true), 'OUTSIDE_SANDBOX')
  assert.equal(await readFile(join(f.root, 'exists.png'), 'utf8'), 'keep')
})

test('desktop capture is explicit and input rejects stale addresses and bounds', async t => {
  const f = await fixture(t)
  await fakeBinary(f.root, 'hyprctl', `console.log(JSON.stringify([{address:'0xabc',pid:42,title:'test',class:'test',at:[10,20],size:[100,80],mapped:true,hidden:false}]))`, t)
  await rejects(() => f.tools.capture({ output: 'shot.png' }), 'INVALID_ARGUMENT')
  await rejects(() => f.tools.input({ window_address: 'oops', action: 'key', key: 'a' }), 'INVALID_ARGUMENT')
  await rejects(() => f.tools.input({ window_address: '0xdef', action: 'key', key: 'a' }), 'NOT_FOUND')
  await rejects(() => f.tools.input({ window_address: '0xabc', action: 'click', x: 200, y: 10 }), 'INVALID_ARGUMENT')
  await rejects(() => f.tools.input({ window_address: '0xabc', action: 'key', key: ';rm' }), 'INVALID_ARGUMENT')
})

test('PCM audio analysis has measured values and a real receipt', async t => {
  const f = await fixture(t)
  const script = "import wave,struct; w=wave.open('tone.wav','wb'); w.setparams((1,2,8000,0,'NONE','not compressed')); w.writeframes(struct.pack('<4h',0,16384,-16384,0)); w.close()"
  const generated = await runCommand(f.sandbox, { argv: ['python3', '-c', script] })
  assert.equal(generated.exit_code, 0)
  const result = await f.tools.audioAnalyze({ path: 'tone.wav' })
  assert.equal(result.success, true)
  assert.equal(result.details.audio.peak, .5)
  assert.equal(result.details.audio.hard_clip_samples, 0)
  assert.equal(result.details.audio.dc_offset, 0)
  assert.equal(result.details.audio.samples, 4)
})

test('game-development registry has workspace scoping and reload does not stop jobs', async t => {
  const f = await fixture(t)
  const entries = []
  registerGameDevActions({ define: (name, spec, handler) => entries.push({name,spec,handler}),
    sandboxOf: () => f.sandbox, workspaceIdOf: () => 'project', processes: f.processes,
    terminals: { list: () => ({ terminals: [] }) }, controller: { operationList: () => ({ active: 1 }) } })
  assert.equal(entries.length, 11)
  for (const entry of entries) {
    assert.ok(entry.spec.output.success)
    assert.equal(entry.spec.family, 'game-development')
    if (entry.name !== 'reload_readiness') assert.equal(entry.spec.workspaceScoped, true)
  }
  const ready = await entries.find(e => e.name === 'reload_readiness').handler({})
  assert.equal(ready.details.ready, false)
  assert.equal(ready.details.active_turns, 1)
})


test('Hyprland Lua input uses the verified structured dispatcher API and explicit empty mods', () => {
  const focus=hyprlandDispatchArgv('hyprctl','lua','focus',{address:'0xabc'})
  assert.deepEqual(focus,['hyprctl','eval','hl.dispatch(hl.dsp.focus({window="address:0xabc"}))'])
  const key=hyprlandDispatchArgv('hyprctl','lua','key',{address:'0xabc',key:'F8'})
  assert.match(key[2], /mods=""/)
  assert.match(key[2], /key="F8"/)
  assert.match(key[2], /window="address:0xabc"/)
})

test('Unverified native Lua clicks fail instead of pretending success', () => {
  assert.throws(()=>hyprlandDispatchArgv('hyprctl','lua','click',{address:'0xabc'}), e=>e.code==='UNSUPPORTED')
})
