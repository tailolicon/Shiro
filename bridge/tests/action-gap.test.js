import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActionGapCollector,
  actionGapFingerprint,
  calculateFrictionScore,
} from '../src/action-gap.js'

async function withCollector(run) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-action-gap-'))
  const stateDir = join(root, '.shiro', 'action-gaps')
  const collector = new ActionGapCollector({ stateDir })
  try {
    await run({ root, stateDir, collector })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('friction score is deterministic and missing counters are zero', () => {
  assert.equal(calculateFrictionScore(), 0)
  assert.equal(calculateFrictionScore({
    unnecessary_tool_calls: 4,
    retries: 2,
    permission_failures: 1,
    shell_workarounds: 3,
    schema_errors: 1,
    agent_confusion: 2,
  }), 25)
  assert.equal(calculateFrictionScore({ retries: -5, schema_errors: Number.NaN }), 0)
})

test('fingerprint clusters the same proposed capability across wording changes', () => {
  const first = actionGapFingerprint({
    problem_type: 'missing_action',
    task: 'Patch one exact string in a file',
    suggested_action: 'patch_file',
  })
  const second = actionGapFingerprint({
    problem_type: 'missing_action',
    task: 'Replace text without shell sed',
    suggested_action: ' PATCH FILE ',
  })
  assert.equal(first, second)

  const differentType = actionGapFingerprint({
    problem_type: 'bad_action_design',
    task: 'Replace text without shell sed',
    suggested_action: 'patch_file',
  })
  assert.notEqual(first, differentType)
})

test('collector persists redacted reports and spots exact existing action misuse', async () => {
  await withCollector(async ({ stateDir, collector }) => {
    const result = await collector.report({
      problem_type: 'missing_action',
      task: 'Need to patch a file with token sk-abcdefghijklmnop',
      severity: 'high',
      suggested_action: 'fs_update_file',
      friction: { unnecessary_tool_calls: 4, shell_workarounds: 1 },
    }, { knownActions: [{ name: 'fs_update_file' }, { name: 'fs_read' }] })

    assert.equal(result.queued, true)
    assert.equal(result.friction_score, 6)
    assert.deepEqual(result.existing_action_matches, ['fs_update_file'])
    assert.equal(result.possible_agent_misuse, true)

    const persisted = await readFile(join(stateDir, 'reports.jsonl'), 'utf8')
    assert.doesNotMatch(persisted, /sk-abcdefghijklmnop/)
    assert.match(persisted, /sk-\*\*\*/)
    const record = JSON.parse(persisted.trim())
    assert.equal(record.task, 'Need to patch a file with token sk-***')
    assert.equal(record.possible_agent_misuse, true)
  })
})

test('collector serializes concurrent appends without corrupting JSONL', async () => {
  await withCollector(async ({ stateDir, collector }) => {
    await Promise.all(Array.from({ length: 40 }, (_, index) => collector.report({
      problem_type: 'composite_action',
      task: `Routine ${index}`,
      attempted_actions: ['fs_read', 'fs_update_file', 'git_diff'],
      estimated_savings_calls: 2,
      friction: { unnecessary_tool_calls: 2 },
    })))

    const lines = (await readFile(join(stateDir, 'reports.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 40)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))

    const summary = await collector.summary()
    assert.equal(summary.total_reports, 40)
    assert.equal(summary.unique_gaps, 1)
    assert.equal(summary.items[0].count, 40)
    assert.equal(summary.items[0].total_estimated_savings_calls, 80)
    assert.equal(summary.items[0].mean_friction_score, 2)
  })
})

test('summary aggregates duplicates, filters, and never treats caller text as a path', async () => {
  await withCollector(async ({ root, collector }) => {
    await collector.report({
      problem_type: 'bad_action_design',
      task: 'Action requires too many fields',
      suggested_action: 'thing_do',
      severity: 'medium',
      repo_context: '../../../../etc/passwd',
      estimated_savings_calls: 1,
    })
    await collector.report({
      problem_type: 'bad_action_design',
      task: 'Schema is cumbersome',
      suggested_action: 'thing_do',
      severity: 'high',
      estimated_savings_calls: 3,
    })
    await collector.report({
      problem_type: 'missing_action',
      task: 'Another capability',
      suggested_action: 'other_action',
      severity: 'low',
    })

    const all = await collector.summary({ min_count: 2 })
    assert.equal(all.total_reports, 3)
    assert.equal(all.unique_gaps, 2)
    assert.equal(all.returned, 1)
    assert.equal(all.items[0].count, 2)
    assert.equal(all.items[0].max_severity, 'high')
    assert.equal(all.items[0].total_estimated_savings_calls, 4)

    const filtered = await collector.summary({ problem_type: 'missing_action' })
    assert.equal(filtered.total_reports, 1)
    assert.equal(filtered.unique_gaps, 1)
    assert.equal(filtered.items[0].problem_type, 'missing_action')

    // The caller can put path-looking text in context, but storage location is
    // fixed by the bridge and no path field is accepted by the collector.
    const outside = join(root, 'etc', 'passwd')
    await assert.rejects(readFile(outside, 'utf8'), { code: 'ENOENT' })
  })
})
