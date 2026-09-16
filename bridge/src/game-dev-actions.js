import { z } from 'zod'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, delimiter, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, freemem, totalmem, platform } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { runCommand, buildEnvironment } from './exec-actions.js'
import { desktopEnvironment } from './desktop-environment.js'
import { fail } from './action-errors.js'
import { looseObject } from './mcp-result.js'
import { redactSecrets } from './redact.js'

export const GAME_TOOLS_VERSION = 1
const HERE = dirname(fileURLToPath(import.meta.url))
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const inputPath = () => z.string().min(1).max(4096)
const outputShape = { success: z.boolean(), details: looseObject() }
const TOOL_NAMES = ['python3', 'unity', 'blender', 'ffmpeg', 'ffprobe', 'hyprctl', 'grim', 'xdotool', 'wtype', 'git']

export async function findExecutable(name, environment = buildEnvironment()) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail('INVALID_ARGUMENT', 'Executable name must be a basename')
  const folders = [...new Set([...(environment.PATH ?? '').split(delimiter), join(environment.HOME ?? '', '.local', 'bin')])]
  for (const folder of folders) {
    if (!folder) continue
    const candidate = join(folder, name)
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate } catch { /* next */ }
  }
  return null
}

export function unityParameters(parameters = {}) {
  const argv = []
  const reserved = new Set(['project_path', 'project-path', 'format', 'json', 'runtime', 'runtime-path'])
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) || reserved.has(key) || ['constructor', 'prototype', '__proto__'].includes(key)) {
      fail('INVALID_ARGUMENT', `Invalid or reserved Unity parameter: ${key}`)
    }
    if (value === null || value === undefined) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.includes('\0') || text.length > 262144) fail('INVALID_ARGUMENT', `Invalid Unity parameter value: ${key}`)
    argv.push(`--${key}`, text)
  }
  return argv
}

export function unwrapUnity(document) {
  let value = document?.data?.result ?? document?.data ?? document
  for (let i = 0; i < 3 && typeof value === 'string'; i++) { try { value = JSON.parse(value) } catch { break } }
  let success = document?.success !== false && document?.data?.success !== false
  const inspect = node => {
    if (!node || typeof node !== 'object') return
    if (node.success === false || node.failed === true) success = false
    const summary = node.Summary ?? node.summary
    if (summary && Number(summary.Failed ?? summary.failed ?? 0) > 0) success = false
    if (node.result && typeof node.result === 'object') inspect(node.result)
  }
  inspect(value)
  return { success, result: value, errors: document?.errors ?? [] }
}

function bounded(value, max = 24000) {
  const text = JSON.stringify(value)
  return text.length <= max ? value : { truncated: true, preview: text.slice(0, max), note: 'Read the receipt log for the complete result.' }
}

export function hyprlandDispatchArgv(binary, mode, action, values) {
  if (mode === 'lua') {
    const window = JSON.stringify(`address:${values.address}`)
    if (action === 'focus') return [binary, 'eval', `hl.dispatch(hl.dsp.focus({window=${window}}))`]
    if (action === 'key') return [binary, 'eval', `hl.dispatch(hl.dsp.send_shortcut({mods=${JSON.stringify((values.modifiers ?? '').replaceAll('+', ' '))},key=${JSON.stringify(values.key)},window=${window}}))`]
    fail('UNSUPPORTED', 'Mouse-button injection is not verified on this Hyprland Lua backend. Use targeted keys or Unity/Blender APIs; do not claim a click occurred.')
  }
  if (action === 'focus') return [binary, 'dispatch', 'focuswindow', `address:${values.address}`]
  if (action === 'key') return [binary, 'dispatch', 'sendshortcut', `${(values.modifiers ?? '').replaceAll('+', ' ')},${values.key},address:${values.address}`]
  return [binary, 'dispatch', 'sendshortcut', `,mouse:${values.button === 'right' ? 273 : 272},address:${values.address}`]
}

export function createGameDevTools({ sandbox, policy, confinement, processes, workspaceId = 'project' }) {
  const execute = async (argv, extra = {}) => {
    policy?.assertCommand({ argv, shell: false })
    return runCommand(sandbox, { argv, timeout_ms: 15000, max_output_bytes: 1048576, ...extra }, { confinement })
  }
  const requireTool = async name => {
    const found = await findExecutable(name)
    if (!found) fail('NOT_FOUND', `${name} is not installed or not on the launcher's PATH; game_toolchain_status reports prerequisites.`)
    return found
  }
  const allocate = async label => {
    const relative = `.shiro/game-tools/${new Date().toISOString().replace(/[:.]/g, '-')}-${label}-${randomUUID().slice(0, 8)}`
    const path = await sandbox.resolveForWrite(relative)
    await mkdir(path.absolute, { recursive: true, mode: 0o700 })
    return { ...path, relative }
  }
  const recorded = async (argv, { label = 'job', timeoutSeconds = 300, background = false, env = {} } = {}) => {
    policy?.assertCommand({ argv, shell: false })
    const folder = await allocate(label)
    const specPath = join(folder.absolute, 'spec.json')
    await writeFile(specPath, JSON.stringify({ argv, cwd: sandbox.root, timeout_seconds: timeoutSeconds, log_limit_bytes: 67108864 }), { mode: 0o600 })
    const runner = [await requireTool('python3'), join(HERE, 'game-job.py'), specPath]
    policy?.assertCommand({ argv: runner, shell: false })
    const receipt = `${folder.relative}/result.json`
    if (background) {
      const proc = await processes.start({ argv: runner, env, label: `game-tools: ${label}` }, { sandbox, workspaceId })
      return { success: true, details: { status: 'started', process_id: proc.process_id, receipt, logs_directory: folder.relative,
        note: 'Started is not completed. Poll process_status/result.json. Reload ends bridge-owned jobs.' } }
    }
    const result = await runCommand(sandbox, { argv: runner, env, timeout_ms: Math.min(600000, (timeoutSeconds + 20) * 1000), max_output_bytes: 8192 }, { confinement })
    let saved
    try { saved = JSON.parse(await readFile(join(folder.absolute, 'result.json'), 'utf8')) }
    catch { saved = { status: 'interrupted', success: false, error: result.stderr || result.stdout } }
    const logs = {}
    for (const name of ['stdout', 'stderr']) {
      try { logs[name] = await readFile(join(folder.absolute, `${name}.log`), 'utf8') } catch { logs[name] = '' }
    }
    return { success: saved.success === true && result.exit_code === 0, details: { status: saved.status,
      exit_code: saved.exit_code ?? result.exit_code, receipt, logs_directory: folder.relative,
      stdout: redactSecrets(logs.stdout.slice(0, 24000)), stderr: redactSecrets(logs.stderr.slice(0, 6000)),
      output_truncated: logs.stdout.length > 24000 || logs.stderr.length > 6000 }, _logs: logs }
  }
  const clean = result => { const { _logs, ...value } = result; return value }
  const resolveInput = async (requested, extensions) => {
    const resolved = await sandbox.resolveExisting(requested)
    if (!(await stat(resolved.absolute)).isFile()) fail('INVALID_ARGUMENT', 'Input must be a regular file')
    if (extensions && !extensions.includes(extname(resolved.absolute).toLowerCase())) fail('INVALID_ARGUMENT', `Supported extensions: ${extensions.join(', ')}`)
    return resolved
  }
  const prepareOutput = async (requested, extension) => {
    if (extension && extname(requested).toLowerCase() !== extension) fail('INVALID_ARGUMENT', `Output must end with ${extension}`)
    const resolved = await sandbox.resolveForWrite(requested)
    // resolveForWrite checks parents; reject ANY existing leaf, including symlinks.
    try { await sandbox.resolveExisting(requested, { follow: false }); fail('ALREADY_EXISTS', `Output already exists: ${requested}`) }
    catch (error) { if (error.code !== 'NOT_FOUND') throw error }
    await mkdir(dirname(resolved.absolute), { recursive: true })
    return resolved
  }
  const status = async () => {
    const tools = {}
    for (const name of TOOL_NAMES) {
      const binary = await findExecutable(name)
      tools[name] = { installed: binary !== null, path: binary }
    }
    const session = desktopEnvironment()
    return { success: true, details: {
      game_tools_version: GAME_TOOLS_VERSION, platform: platform(), workspace: sandbox.root, tools,
      desktop_environment: session, cpu_threads: cpus().length, memory_bytes: totalmem(), free_memory_bytes: freemem(),
      missing_core_tools: ['python3', 'unity', 'blender', 'ffmpeg', 'ffprobe'].filter(name => !tools[name].installed),
      desktop_input_scope: 'Hyprland: target-window capture, focus and key input. Native mouse clicks are explicitly unavailable on the Lua backend.',
      scope: 'Installation and session discovery only. Use real compile/render/media tests for verification.',
      limitations: ['No automatic cloud/API credits, paid asset licenses, Steam publishing credentials or human playtest approval.',
        'Private LAN and multi-machine game behavior must be verified in the game; tool availability is not game completion.'],
    } }
  }
  const unity = async args => {
    let config = {}
    try { const path = await sandbox.resolveExisting('.shiro/game-dev.json'); config = JSON.parse(await readFile(path.absolute, 'utf8')) }
    catch (error) { if (error.code !== 'NOT_FOUND') throw error }
    const project = await sandbox.resolveDirectory(args.project_path ?? config.unity_project ?? 'prototype')
    try { await stat(join(project.absolute, 'ProjectSettings', 'ProjectVersion.txt')) }
    catch { fail('INVALID_ARGUMENT', 'Selected directory is not an initialized Unity project') }
    const service = args.service ?? config.unity_service
    const cli = await requireTool('unity')
    let prefix = []
    let target = { project_path: project.relative, mode: 'native' }
    if (service) {
      if (!/^[A-Za-z0-9_.@-]+\.service$/.test(service)) fail('INVALID_ARGUMENT', 'Unity service must be a user service unit name')
      const probe = await execute(['systemctl', '--user', 'show', service, '--property=MainPID', '--property=ActiveState', '--property=ExecStart'])
      if (probe.exit_code !== 0) fail('PROCESS_FAILED', `Cannot inspect managed Unity service: ${service}`)
      const values = Object.fromEntries(probe.stdout.trim().split('\n').map(line => { const pos = line.indexOf('='); return [line.slice(0, pos), line.slice(pos + 1)] }))
      const escaped = project.absolute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (values.ActiveState !== 'active' || !new RegExp(`${escaped}(?:[\\s;"']|$)`).test(values.ExecStart ?? '')) {
        fail('CONFLICT', 'Managed Editor is not active for the exact selected project; do not start a second Editor.')
      }
      const listing = await execute(['flatpak', 'ps', '--columns=instance,pid,application'])
      if (listing.exit_code !== 0) fail('PROCESS_FAILED', 'Cannot enumerate Flatpak instances')
      const matches = listing.stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(row => row[1] === values.MainPID && row[2] === 'com.unity.UnityHub')
      if (matches.length !== 1) fail('CONFLICT', 'Managed Editor PID does not resolve to exactly one Unity Flatpak instance')
      prefix = ['flatpak', 'enter', matches[0][0], 'env', 'UNITY_NO_CLI_INVOKED_TELEMETRY=1', 'UNITY_NO_PAGER=1']
      target = { ...target, mode: 'flatpak', service, managed_pid: Number(values.MainPID), instance: matches[0][0] }
    }
    const command = args.command ?? 'editor_status'
    if (command && !/^[A-Za-z][A-Za-z0-9_]*$/.test(command)) fail('INVALID_ARGUMENT', 'Unity command must be a catalog command name')
    const argv = [...prefix, cli, '--format', 'json', '--no-banner', '--non-interactive', '--no-pager', 'command',
      ...(command ? [command] : []), '--project-path', project.absolute, ...unityParameters(args.parameters)]
    const result = await recorded(argv, { label: `unity-${command || 'catalog'}`, timeoutSeconds: args.timeout_seconds ?? 300,
      env: { UNITY_NO_CLI_INVOKED_TELEMETRY: '1', UNITY_NO_PAGER: '1' } })
    let parsed
    try { parsed = unwrapUnity(JSON.parse(result._logs.stdout)) }
    catch { return { ...clean(result), success: false, details: { ...result.details, target, error: 'Unity did not return valid complete JSON; inspect the receipt.' } } }
    const { stdout, stderr, ...details } = result.details
    return { success: result.success && parsed.success, details: { ...details, target, command,
      result: bounded(redactSecrets(parsed.result)), errors: redactSecrets(parsed.errors),
      note: 'An async queued/running response accepts a job; poll recompile_status, test_status or build_status for its outcome.' } }
  }
  const blenderRun = async args => {
    if (!args.script && !args.blend_file) fail('INVALID_ARGUMENT', 'Specify a workspace Python script or .blend file')
    const argv = [await requireTool('blender'), '--background', '--factory-startup', '--disable-autoexec']
    if (args.blend_file) argv.push((await resolveInput(args.blend_file, ['.blend'])).absolute)
    argv.push('--python-exit-code', '1')
    if (args.script) argv.push('--python', (await resolveInput(args.script, ['.py'])).absolute)
    for (const text of args.args ?? []) if (text.includes('\0')) fail('INVALID_ARGUMENT', 'Blender script arguments must not contain NUL')
    if (args.args?.length) argv.push('--', ...args.args)
    return clean(await recorded(argv, { label: 'blender-script', timeoutSeconds: args.timeout_seconds ?? 300, background: args.background !== false }))
  }
  const blenderAsset = async (args, render) => {
    const input = await resolveInput(args.path, ['.blend', '.glb', '.gltf', '.fbx', '.obj', '.stl'])
    const folder = await allocate(render ? 'blender-render' : 'blender-inspect')
    const report = join(folder.absolute, 'asset-report.json')
    const output = render ? await prepareOutput(args.output, '.png') : { absolute: join(folder.absolute, 'unused.png') }
    const argv = [await requireTool('blender'), '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
      '--python', join(HERE, 'blender-tools.py'), '--', render ? 'render' : 'inspect', '--input', input.absolute,
      '--output', output.absolute, '--report', report, '--resolution', String(args.resolution ?? 512), '--frame', String(args.frame ?? 1)]
    const result = clean(await recorded(argv, { label: render ? 'blender-render' : 'blender-inspect', timeoutSeconds: args.timeout_seconds ?? 300 }))
    if (result.success) {
      try { result.details.asset = JSON.parse(await readFile(report, 'utf8')) }
      catch { result.success = false; result.details.error = 'Blender exited without a valid asset report' }
    }
    result.details.report = sandbox.relative(report)
    if (render && result.success) result.details.output = output.relative
    return result
  }
  const mediaProbe = async args => {
    const input = await resolveInput(args.path)
    const result = await recorded([await requireTool('ffprobe'), '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-show_format', '-show_streams', '-of', 'json', input.absolute], { label: 'media-probe', timeoutSeconds: 60 })
    if (result.success) {
      try { result.details.media = bounded(JSON.parse(result._logs.stdout)); delete result.details.stdout }
      catch { result.success = false }
    }
    return clean(result)
  }
  const audioAnalyze = async args => {
    const input = await resolveInput(args.path, ['.wav'])
    const result = await recorded([await requireTool('python3'), join(HERE, 'audio-analyze.py'), input.absolute], { label: 'audio-analyze', timeoutSeconds: 120 })
    if (result.success) {
      try { result.details.audio = JSON.parse(result._logs.stdout); delete result.details.stdout }
      catch { result.success = false }
    }
    return clean(result)
  }
  const windows = async () => {
    const response = await execute([await requireTool('hyprctl'), '-j', 'clients'])
    if (response.exit_code !== 0) fail('UNSUPPORTED', 'No accessible Hyprland session. Use Unity screenshot for headless Editor capture.')
    const clients = JSON.parse(response.stdout)
    return clients.map(c => ({ address: c.address, pid: c.pid, title: c.title, class: c.class, at: c.at, size: c.size,
      workspace: c.workspace?.id, mapped: c.mapped, hidden: c.hidden, xwayland: c.xwayland }))
  }
  let desktopModeValue
  const desktopMode = async () => {
    if (desktopModeValue) return desktopModeValue
    const result = await execute([await requireTool('hyprctl'), 'repl', 'return type(hl.dsp)'])
    desktopModeValue = result.exit_code === 0 && result.stdout.trim() === 'table' ? 'lua' : 'legacy'
    return desktopModeValue
  }
  const focusWindow = async window => {
    const argv = hyprlandDispatchArgv(await requireTool('hyprctl'), await desktopMode(), 'focus', { address: window.address })
    const result = await execute(argv)
    if (result.exit_code !== 0 || /^error:/m.test(result.stdout)) fail('PROCESS_FAILED', 'Could not focus requested window: ' + result.stdout.slice(0, 800))
    return result
  }
  const getWindow = async address => {
    if (!/^0x[0-9a-f]+$/i.test(address ?? '')) fail('INVALID_ARGUMENT', 'Use a window address from desktop_windows')
    const window = (await windows()).find(c => c.address === address)
    if (!window) fail('NOT_FOUND', 'Desktop window no longer exists; refresh desktop_windows')
    if (!window.mapped || window.hidden || !window.size?.every(v => Number.isFinite(v) && v > 0)) fail('CONFLICT', 'Window is not mapped and visible')
    return window
  }
  const capture = async args => {
    if (!args.window_address && args.full_desktop !== true) fail('INVALID_ARGUMENT', 'Select a window_address or explicitly request full_desktop=true')
    const output = await prepareOutput(args.output, '.png')
    const argv = [await requireTool('grim')]
    let window
    if (args.window_address) {
      window = await getWindow(args.window_address)
      if (args.focus === true) {
        await focusWindow(window)
        await new Promise(resolve => setTimeout(resolve, 200))
        window = await getWindow(args.window_address)
      }
      const [x, y] = window.at.map(Math.round); const [w, h] = window.size.map(Math.round)
      argv.push('-g', `${x},${y} ${w}x${h}`)
    }
    argv.push(output.absolute)
    const result = clean(await recorded(argv, { label: 'desktop-capture', timeoutSeconds: 20 }))
    if (result.success) {
      const data = await readFile(output.absolute)
      if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('PROCESS_FAILED', 'Capture did not produce a PNG')
      result.details.image = { path: output.relative, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20), sha256: createHash('sha256').update(data).digest('hex') }
      result.details.note = 'Actual visible desktop region, not an offscreen isolated window. Occluding windows can appear. Use focus=true explicitly or Unity screenshot.'
    }
    return result
  }
  const input = async args => {
    const window = await getWindow(args.window_address)
    const hypr = await requireTool('hyprctl')
    let argv
    if (args.action === 'key') {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(args.key ?? '')) fail('INVALID_ARGUMENT', 'Key must be an XKB keysym such as Return, Escape or F5')
      if (!/^(?:(?:CTRL|ALT|SHIFT|SUPER)(?:\+|$))*$/.test(args.modifiers ?? '')) fail('INVALID_ARGUMENT', 'Modifiers must use CTRL+ALT+SHIFT+SUPER syntax')
      argv = hyprlandDispatchArgv(hypr, await desktopMode(), 'key', { ...args, address: window.address })
    } else if (args.action === 'focus') argv = hyprlandDispatchArgv(hypr, await desktopMode(), 'focus', { address: window.address })
    else {
      const { x, y } = args
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= window.size[0] || y >= window.size[1]) fail('INVALID_ARGUMENT', 'Click position must be inside the selected window, in logical pixels')
      const mode = await desktopMode()
      if (mode === 'lua') fail('UNSUPPORTED', 'Mouse-button injection is not verified on the Hyprland Lua backend. Targeted keys and Unity/Blender API control are available.')
      await focusWindow(window)
      const moved = await execute([hypr, 'dispatch', 'movecursor', String(Math.round(window.at[0] + x)), String(Math.round(window.at[1] + y))])
      if (moved.exit_code !== 0) fail('PROCESS_FAILED', 'Could not position cursor')
      argv = [hypr, 'dispatch', 'sendshortcut', `,mouse:${args.button === 'right' ? 273 : 272},address:${window.address}`]
    }
    const result = clean(await recorded(argv, { label: 'desktop-input', timeoutSeconds: 15 }))
    if (/^error:/m.test(result.details.stdout ?? '')) result.success = false
    result.details.window_address = window.address
    return result
  }
  return { status, unity, blenderRun, blenderAsset, mediaProbe, audioAnalyze, windows, capture, input }
}

export function registerGameDevActions({ define, sandboxOf, policy, confinement, processes, workspaceIdOf, terminals, controller }) {
  const tools = args => createGameDevTools({ sandbox: sandboxOf(args), policy, confinement, processes, workspaceId: workspaceIdOf(args) })
  const add = (name, title, description, input, handler, annotations = WRITE) => define(name, {
    family: 'game-development', workspaceScoped: true, title, description,
    input, output: outputShape, annotations,
  }, async args => handler(tools(args), args))
  add('game_toolchain_status', 'Inspect local game-development prerequisites',
    'Discover installed Unity/Blender/FFmpeg/Python tools, usable desktop session metadata, and resource limits. No downloads, installs, model calls or game-completion claims.', {}, t => t.status(), READ)
  add('unity_command', 'Run an official live Unity command with receipts',
    'Discover the exact command catalog with command="". Otherwise call a catalog command and structured parameters. Targets a workspace Unity project; optionally resolves the managed user service to its exact Flatpak instance. Never starts a second Editor, edits YAML or reads auth tokens. Config defaults may be stored in .shiro/game-dev.json. Saves current stdout/stderr and job receipts; queued/running is not a passing test.', {
      project_path: inputPath().optional(), service: z.string().max(150).optional(), command: z.string().max(100).default('editor_status'),
      parameters: z.record(z.string(), z.any()).optional(), timeout_seconds: z.number().int().min(1).max(550).optional(),
    }, (t, a) => t.unity(a))
  add('blender_run', 'Run workspace Blender Python or a blend file',
    'Execute Blender headlessly with automatic embedded script execution disabled. A supplied workspace Python script runs explicitly. Background by default, returns process_id plus durable disk log/receipt paths. Poll before using outputs; reload terminates active bridge-owned jobs.', {
      script: inputPath().optional(), blend_file: inputPath().optional(), args: z.array(z.string()).max(64).optional(),
      background: z.boolean().optional(), timeout_seconds: z.number().int().min(1).max(550).optional(),
    }, (t, a) => t.blenderRun(a))
  const asset = { path: inputPath(), timeout_seconds: z.number().int().min(1).max(550).optional() }
  add('blender_inspect', 'Inspect real 3D asset geometry',
    'Open .blend/.glb/.gltf/.fbx/.obj/.stl using Blender with auto-run disabled; report geometry, materials, armatures, actions, missing image files and finite bounds. No original asset is overwritten.', asset, (t, a) => t.blenderAsset(a, false))
  add('blender_render', 'Render a 3D asset to a new PNG',
    'Render a workspace 3D asset with a fitted preview camera and lighting using CPU Cycles (no driver change). Input is not saved or overwritten. New PNG path must not already exist. Returns technical report and durable logs.', {
      ...asset, output: inputPath(), resolution: z.number().int().min(64).max(2048).optional(), frame: z.number().int().min(1).max(100000).optional(),
    }, (t, a) => t.blenderAsset(a, true))
  add('media_probe', 'Inspect an audio or video artifact',
    'Use local FFprobe on a workspace file; returns streams, codecs, duration and format plus current receipt. Network protocols are not allowed for input media.', { path: inputPath() }, (t, a) => t.mediaProbe(a))
  add('audio_analyze', 'Measure PCM sound and music quality properties',
    'Analyze a workspace PCM WAV in a bounded streaming pass: sample rate, channels, RMS, peak, clipping, DC offset, duration and checksum. This is not human listening or mastering approval.', { path: inputPath() }, (t, a) => t.audioAnalyze(a))
  add('desktop_windows', 'List the current Hyprland windows',
    'Return bounded window addresses, process IDs, geometry and titles for explicit game/Editor targeting. No screenshot or input is performed. Current backend is Hyprland only.', {
      pid: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(40),
    }, async (t, a) => { const all = (await t.windows()).filter(w => a.pid === undefined || w.pid === a.pid); return { success: true, details: { windows: all.slice(0, a.limit), total: all.length, truncated: all.length > a.limit } } })
  add('desktop_capture', 'Capture an explicit game window or desktop region',
    'Save actual visible pixels to a new PNG using grim. Select window_address; focus=true explicitly focuses it first. Full desktop capture requires full_desktop=true. Occlusions are reported honestly; use Unity screenshot for isolated game-view rendering.', {
      window_address: z.string().optional(), full_desktop: z.boolean().optional(), focus: z.boolean().optional(), output: inputPath(),
    }, (t, a) => t.capture(a))
  add('desktop_input', 'Send an explicit input to a chosen desktop window',
    'Target a current Hyprland window address. Send an XKB keysym or focus; legacy-backend clicks are bounded to the target. Native mouse clicks on the Lua backend return UNSUPPORTED rather than a false success. Click/focus can visibly change focus/cursor. No global untargeted input, shell text, or text/password entry.', {
      window_address: z.string(), action: z.enum(['key', 'focus', 'click']), key: z.string().optional(), modifiers: z.string().optional(),
      x: z.number().int().optional(), y: z.number().int().optional(), button: z.enum(['left', 'right']).optional(),
    }, (t, a) => t.input(a))
  define('reload_readiness', {
    family: 'game-development', title: 'Check whether connector reload would interrupt work',
    description: 'Read active bridge-owned processes, terminals and Harness turns. Does not kill, restart, change permissions or claim reload succeeded. Persist work and drain active jobs before the user restarts Shiro.', input: {}, output: outputShape, annotations: READ,
  }, async () => {
    const running = processes.list({ state: 'running', limit: 100 }).processes ?? []
    const ptys = terminals.list?.({})?.terminals?.filter(t => t.state === 'running') ?? []
    const operations = controller.operationList?.({}) ?? {}
    const active = Number(operations.active ?? 0)
    return { success: true, details: { ready: running.length === 0 && ptys.length === 0 && active === 0,
      game_tools_version: GAME_TOOLS_VERSION, active_turns: active,
      processes: running.map(p => ({ process_id: p.process_id, label: p.label, workspace: p.workspace, pid: p.pid })),
      terminals: ptys.map(t => ({ terminal_id: t.terminal_id, label: t.label })),
      instruction: 'Restart the local Shiro backend from its launcher, then refresh/reload the ChatGPT connector tool catalog. Refreshing only the catalog does not load new server code.' } }
  })
}
