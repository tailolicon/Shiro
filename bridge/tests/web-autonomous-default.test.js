import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const launcher = readFileSync(new URL('../../scripts/Run-Shiro-Backend.sh', import.meta.url), 'utf8')
const windowsLauncher = readFileSync(new URL('../../scripts/Run-Shiro-Backend.ps1', import.meta.url), 'utf8')
const windowsStarter = readFileSync(new URL('../../scripts/Start-Shiro.ps1', import.meta.url), 'utf8')
const runtimePreparation = readFileSync(new URL('../../scripts/Prepare-Shiro-Runtime.mjs', import.meta.url), 'utf8')
const cordisPatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const fleetManager = readFileSync(new URL('../src/fleet-manager.js', import.meta.url), 'utf8')

test('launchers hard-default ChatGPT Web to Sol rather than Pro quota', () => {
  assert.match(launcher, /SHIRO_WEB_PROVIDER="\$\{SHIRO_WEB_PROVIDER:-shiro-web\}"/)
  assert.match(launcher, /export SHIRO_AUTONOMOUS_PROVIDER="\$SHIRO_WEB_PROVIDER"/)
  assert.match(launcher, /SHIRO_WEB_MODEL="\$\{SHIRO_WEB_MODEL:-gpt-5\.6-sol\}"/)
  assert.match(launcher, /export SHIRO_AUTONOMOUS_MODEL="\$SHIRO_WEB_MODEL"/)
  assert.match(launcher, /SHIRO_WEB_RELAY_MODEL="\$\{SHIRO_WEB_RELAY_MODEL:-GPT-5\.6 Sol\}"/)
  assert.doesNotMatch(launcher, /GPT-6 Pro|gpt-6-astra/)

  assert.match(windowsLauncher, /SHIRO_WEB_PROVIDER\)\) \{ \$env:SHIRO_WEB_PROVIDER = 'shiro-web'/)
  assert.match(windowsLauncher, /SHIRO_AUTONOMOUS_PROVIDER = \$env:SHIRO_WEB_PROVIDER/)
  assert.match(windowsLauncher, /SHIRO_AUTONOMOUS_MODEL = \$env:SHIRO_WEB_MODEL/)
  assert.match(windowsLauncher, /SHIRO_WEB_MODEL\)\) \{ \$env:SHIRO_WEB_MODEL = 'gpt-5\.6-sol'/)
  assert.match(windowsLauncher, /SHIRO_WEB_RELAY_MODEL\)\) \{ \$env:SHIRO_WEB_RELAY_MODEL = 'GPT-5\.6 Sol'/)
  assert.doesNotMatch(windowsLauncher, /GPT-6 Pro|gpt-6-astra/)

  assert.match(runtimePreparation, /SHIRO_AUTONOMOUS_MODEL \|\| process\.env\.SHIRO_WEB_MODEL \|\| 'gpt-5\.6-sol'/)
})

test('bridge config and fleets expose the Sol-only browser quota policy', () => {
  assert.match(cordisPatch, /webProvider: !!js process\.env\.SHIRO_WEB_PROVIDER \?\? 'shiro-web'/)
  assert.match(cordisPatch, /autonomousProvider: !!js process\.env\.SHIRO_AUTONOMOUS_PROVIDER/)
  assert.match(cordisPatch, /model: gpt-5\.6-sol/)
  assert.match(cordisPatch, /webModel: !!js process\.env\.SHIRO_WEB_MODEL \?\? 'gpt-5\.6-sol'/)
  assert.match(cordisPatch, /webRelayModel: !!js process\.env\.SHIRO_WEB_RELAY_MODEL \?\? 'GPT-5\.6 Sol'/)
  assert.match(fleetManager, /const FLEET_CHATGPT_MODEL = 'GPT-5\.6 Sol'/)
  assert.match(fleetManager, /const FLEET_CHATGPT_EFFORT = 'xhigh'/)
  assert.match(fleetManager, /model: FLEET_CHATGPT_MODEL/)
  assert.match(fleetManager, /effort: FLEET_CHATGPT_EFFORT/)
})


test('runtime profile enables Shiro-native Agent Teams peer mail', () => {
  assert.match(cordisPatch, /id: agent-team\n\s+name: '@deepseek-ai\/dsh-experimental-agent-team'/)
  assert.match(cordisPatch, /id: tool-agent-team\n\s+name: '@deepseek-ai\/dsh-experimental-tool-agent-team'/)
  assert.match(cordisPatch, /id: tool-subagent-control[\s\S]*?disabled: true/)
  assert.match(runtimePreparation, /'@deepseek-ai\/dsh-experimental-agent-team': link/)
  assert.match(runtimePreparation, /'@deepseek-ai\/dsh-experimental-tool-agent-team': link/)
  assert.match(windowsStarter, /'@deepseek-ai\/dsh-experimental-agent-team' = "link:\$EngineLink\/packages\/experimental\/agent-team"/)
  assert.match(windowsStarter, /'@deepseek-ai\/dsh-experimental-tool-agent-team' = "link:\$EngineLink\/packages\/experimental\/tool-agent-team"/)
})
