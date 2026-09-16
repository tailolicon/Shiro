import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_LIMITS, HOST_TOOLS, hostSystemInfo, listHostProcesses } from '../src/host-info.js'

async function fakeProc(entries) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-proc-'))
  for (const entry of entries) {
    const dir = join(root, String(entry.pid))
    await mkdir(dir)
    const name = entry.name ?? 'proc'
    const state = entry.state ?? 'S'
    const ppid = entry.ppid ?? 1
    const rssPages = entry.rssPages ?? 10
    // pid (comm) state ppid ... rss is field 24, so 20 dummy fields sit between ppid and rss.
    const rest = [state, String(ppid), ...Array.from({ length: 20 }, () => '0'), String(rssPages)].join(' ')
    await writeFile(join(dir, 'stat'), `${entry.pid} (${name}) ${rest}\n`)
    await writeFile(join(dir, 'status'), [
      `Name:\t${name}`,
      `State:\t${state} (sleeping)`,
      `PPid:\t${ppid}`,
      `Uid:\t${entry.uid ?? 1000}\t${entry.uid ?? 1000}\t${entry.uid ?? 1000}\t${entry.uid ?? 1000}`,
      `VmRSS:\t${entry.rssKb ?? 40} kB`,
      `Threads:\t${entry.threads ?? 1}`,
      '',
    ].join('\n'))
    const cmdline = entry.cmdline === undefined ? `${name}\0--flag` : entry.cmdline
    await writeFile(join(dir, 'cmdline'), cmdline)
    if (entry.environ !== undefined) await writeFile(join(dir, 'environ'), entry.environ)
  }
  await writeFile(join(root, 'cpuinfo'), 'not a process')
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('host_system_info is a bounded identity snapshot with no environment dump', () => {
  const info = hostSystemInfo()
  assert.equal(typeof info.hostname, 'string')
  assert.notEqual(info.hostname, '')
  assert.equal(info.platform, process.platform)
  assert.equal(info.arch, process.arch)
  assert.equal(typeof info.release, 'string')
  assert.ok(info.cpus.count >= 1)
  assert.ok(info.memory.total_bytes > 0)
  assert.ok(info.memory.free_bytes >= 0)
  assert.ok(info.uptime_seconds >= 0)
  assert.equal(info.self.pid, process.pid)
  assert.equal(info.env, undefined)
  assert.equal(info.environment, undefined)
  assert.equal('env' in info, false)
  const serialized = JSON.stringify(info)
  for (const name of ['PATH', 'HOME', 'SHIRO_BRIDGE_TOKEN', 'SHIRO_RELAY_API_TOKEN']) {
    assert.equal(serialized.includes(`"${name}"`), false, `must not dump ${name}`)
  }
})

test('host_process_list reads a proc tree, skips kernel threads, and never opens environ', async () => {
  const { root, cleanup } = await fakeProc([
    { pid: 1, name: 'init', cmdline: '/sbin/init\0', uid: 0, rssKb: 80 },
    { pid: 8, name: 'kthreadd', cmdline: '', uid: 0 },
    { pid: 42, name: 'node', cmdline: 'node\0-e\0sk-abcdefghijklmnopqrstuv', uid: 1000, rssKb: 12000 },
    { pid: 99, name: 'secret', cmdline: 'worker\0--token=sk-live_abcdefghijklmnopqrstuv', environ: 'SECRET=supersecretvalue\0PATH=/bin', uid: 1000 },
  ])
  try {
    const listed = listHostProcesses({ limit: 50 }, { procRoot: root })
    const names = listed.processes.map(entry => entry.name)
    assert.deepEqual(names.sort(), ['init', 'node', 'secret'])
    assert.equal(listed.processes.find(entry => entry.name === 'kthreadd'), undefined)
    assert.equal(listed.kernel_threads_omitted, 1)
    assert.equal(listed.truncated, false)

    const node = listed.processes.find(entry => entry.pid === 42)
    assert.equal(node.ppid, 1)
    assert.equal(node.uid, 1000)
    assert.equal(node.rss_kb, 12000)
    assert.match(node.cmdline, /^node -e /)
    assert.equal(node.cmdline.includes('sk-abcdefghijklmnopqrstuv'), false)
    assert.match(node.cmdline, /sk-\*\*\*/)

    const secret = listed.processes.find(entry => entry.pid === 99)
    assert.equal(JSON.stringify(secret).includes('supersecretvalue'), false)
    assert.equal(secret.environ, undefined)
    assert.equal(secret.environment, undefined)
    assert.equal(secret.cwd, undefined)
    assert.equal(secret.exe, undefined)
  } finally {
    await cleanup()
  }
})

test('host_process_list filters, paginates, and truncates command lines', async () => {
  const { root, cleanup } = await fakeProc([
    { pid: 10, name: 'alpha', cmdline: 'alpha\0one' },
    { pid: 20, name: 'bravo', cmdline: 'bravo\0two' },
    { pid: 30, name: 'charlie', cmdline: `charlie\0${'x'.repeat(2000)}` },
  ])
  try {
    const named = listHostProcesses({ name: 'BRAVO' }, { procRoot: root })
    assert.equal(named.total, 1)
    assert.equal(named.processes[0].pid, 20)

    const page = listHostProcesses({ limit: 1 }, { procRoot: root })
    assert.equal(page.processes.length, 1)
    assert.equal(page.truncated, true)
    assert.equal(page.next_cursor, String(page.processes[0].pid))

    const rest = listHostProcesses({ limit: 10, cursor: page.next_cursor }, { procRoot: root })
    assert.ok(rest.processes.every(entry => entry.pid > page.processes[0].pid))
    assert.equal(rest.truncated, false)

    const long = listHostProcesses({ name: 'charlie' }, { procRoot: root }).processes[0]
    assert.ok(long.cmdline.length <= HOST_LIMITS.cmdline_max_chars)
    assert.equal(long.cmdline_truncated, true)
  } finally {
    await cleanup()
  }
})

test('host_process_list reports truncation when the scan cap is hit before matching', async () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({
    pid: index + 1,
    name: index === 5 ? 'needle' : 'other',
    cmdline: index === 5 ? 'needle\0' : 'other\0',
  }))
  const { root, cleanup } = await fakeProc(entries)
  try {
    const listed = listHostProcesses({ name: 'needle', limit: 10 }, { procRoot: root, scanCap: 3 })
    assert.equal(listed.total, 0)
    assert.equal(listed.scanned, 3)
    assert.equal(listed.truncated, true)
    assert.equal(listed.next_cursor, '3')
    const rest = listHostProcesses({ name: 'needle', cursor: listed.next_cursor }, { procRoot: root, scanCap: 3 })
    assert.equal(rest.total, 1)
    assert.equal(rest.processes[0].name, 'needle')
  } finally {
    await cleanup()
  }
})

test('host_process_list finds this process on a live Linux /proc', {
  skip: process.platform === 'linux' ? false : 'host_process_list reads /proc',
}, () => {
  const listed = listHostProcesses({ pid: process.pid, include_kernel: true })
  assert.equal(listed.total, 1)
  assert.equal(listed.processes[0].pid, process.pid)
  assert.equal(typeof listed.processes[0].name, 'string')
})

test('HOST_TOOLS are the read-only pair the Harness plugin registers', () => {
  assert.deepEqual(HOST_TOOLS.map(spec => spec.name), ['host_system_info', 'host_process_list'])
  for (const spec of HOST_TOOLS) {
    assert.equal(spec.mutating, false)
    assert.equal(typeof spec.description, 'string')
    assert.ok(spec.description.length > 40)
  }
})
