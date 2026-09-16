#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const shiroRoot = path.resolve(here, '..')
const hachimiRepo = process.env.HACHIMI_REPO || '/home/tailolicon/Projects/hachimi-tl-vi'
const runtimeState = process.env.SHIRO_RUNTIME_STATE || '/home/tailolicon/Projects/.ShiroRuntime/state'
const statusFile = path.join(runtimeState, 'hachimi-continuous-supervisor-status.json')
const runner = path.join(shiroRoot, 'scripts', 'Run-Hachimi-Temporary-Fleet.mjs')
const promptFile = path.join(shiroRoot, 'scripts', 'Hachimi-Continuous-Worker.prompt.txt')
const fleetStatusName = 'hachimi-continuous-20260913.json'
const pollMs = 5 * 60_000
const restartDelayMs = 5_000

let child = null
let stopping = false
let terminalSeen = false
let restartCount = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function writeStatus(extra = {}) {
  await fs.mkdir(runtimeState, { recursive: true })
  const payload = {
    schema_version: 1,
    service: 'hachimi-tl-vi-continuous-supervisor',
    pid: process.pid,
    runner_pid: child?.pid ?? null,
    running: !stopping,
    terminal_seen: terminalSeen,
    restart_count: restartCount,
    updated_at: new Date().toISOString(),
    ...extra,
  }
  await fs.writeFile(statusFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function liveState() {
  const fetch = spawnSync('git', ['-C', hachimiRepo, 'fetch', 'origin', 'main', '--quiet'], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (fetch.status !== 0) {
    throw new Error(`git fetch failed: ${(fetch.stderr || fetch.stdout || '').trim()}`)
  }
  const show = spawnSync('git', ['-C', hachimiRepo, 'show', 'origin/main:work/orchestration/state.json'], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (show.status !== 0) {
    throw new Error(`git show state failed: ${(show.stderr || show.stdout || '').trim()}`)
  }
  return JSON.parse(show.stdout)
}

async function checkTerminal() {
  try {
    const state = liveState()
    terminalSeen = state?.terminal === true
    await writeStatus({
      last_state_check_at: new Date().toISOString(),
      live_phase: state?.phase ?? null,
      live_task_id: state?.active_task?.task_id ?? null,
    })
    return terminalSeen
  } catch (error) {
    console.error(`[supervisor] live-state check failed: ${error.message}`)
    await writeStatus({ last_state_error: error.message }).catch(() => {})
    return false
  }
}

function runnerArgs() {
  return [
    runner,
    `--prompt-file=${promptFile}`,
    '--fleet-size=7',
    '--interval-minutes=27',
    '--max-session-runs=1',
    '--personalized-temporary',
    '--close-after-round',
    `--status-name=${fleetStatusName}`,
    '--resume-status',
  ]
}

async function startRunner() {
  if (stopping || terminalSeen) return
  child = spawn(process.execPath, runnerArgs(), {
    cwd: shiroRoot,
    env: process.env,
    stdio: 'inherit',
  })
  console.log(`[supervisor] runner started pid=${child.pid}`)
  await writeStatus({ runner_started_at: new Date().toISOString() })

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const result = await exited
  console.log(`[supervisor] runner exited code=${result.code} signal=${result.signal || ''}`)
  child = null
  await writeStatus({ runner_exit: result }).catch(() => {})

  if (!stopping && !terminalSeen) {
    restartCount += 1
    await sleep(restartDelayMs)
    if (!(await checkTerminal())) await startRunner()
  }
}

async function monitorTerminal() {
  while (!stopping && !terminalSeen) {
    await sleep(pollMs)
    if (stopping) break
    if (await checkTerminal()) {
      console.log('[supervisor] terminal=true on origin/main; stopping runner.')
      stopping = true
      child?.kill('SIGTERM')
      break
    }
  }
}

async function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`[supervisor] ${signal}; stopping runner.`)
  child?.kill('SIGTERM')
  await writeStatus({ running: false, stopped_by: signal }).catch(() => {})
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

if (await checkTerminal()) {
  stopping = true
  await writeStatus({ running: false, stop_reason: 'terminal_state_already_true' })
  process.exit(0)
}

await Promise.all([startRunner(), monitorTerminal()])
await writeStatus({ running: false, stop_reason: terminalSeen ? 'terminal_state_true' : 'supervisor_stopped' }).catch(() => {})
