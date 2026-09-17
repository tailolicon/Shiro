# Shiro storage policy — source isolation without checkout proliferation

## Operational default

One ChatGPT conversation is NOT one Git checkout. Research, audits, translation,
media editing and read-only collaborators use the existing addressable workspace.
Use a separate checkout only for concurrent source writers or truly conflicting
build outputs. Do not clone a project under Shiro to get another session.

The previous implementation comment described one checkout per task. The new
worktree action instead measures content before materializing it and defaults to:

- four linked worktrees per repository;
- at most 1 GiB of materialized checkout data;
- 2 GiB free-space reserve;
- sparse source directories for large data repositories;
- no nested worktree inside the main checkout;
- an exclusive creation lock and a 24-hour managed lease.

Explicit exceptional budgets are repository configuration values
`shiro.worktreeMaxLinked` and `shiro.worktreeMaxCheckoutBytes`; increasing them is
not a substitute for preserving and retiring completed work. The raw host shell
still has the operator's permissions: this is not a claim that arbitrary manual
`git clone` commands are impossible. Agent instructions require the managed route.

## Retirement

```bash
node scripts/Worktree-Maintenance.mjs --repo /absolute/project
node scripts/Worktree-Maintenance.mjs --repo /absolute/project --apply
```

Dry-run is the default. Only lease-expired, tool-owned, clean, merged, unlocked
checkouts without ignored files and without an active process are eligible.
Automatic removal never uses --force. A recovery ref and the branch remain.
Dirty/unmerged or unclassified ignored content requires explicit preservation.
No timer/fleet is started by this script. Run it as part of task finalization or
operator maintenance; it does not silently restart old AI work.

## Cleanup performed 2026-09-17

26 inactive linked worktrees and 8 generated independent clones were retired.
Every removal was preceded by a checked Git snapshot and exact changed/untracked
file preservation. Independent clones' full Git stores (including refs/reflogs)
were moved to the recovery archive rather than deleted. 34 snapshots were then
verified from their final Git-store locations. Ten stale registrations were
pruned only after pinning their HEADs, including detached ones.

Recovery index and instructions:
`/home/tailolicon/Projects/.storage-maintenance/20260917/RESTORE.md`.
Individual receipt.json files include snapshot IDs, Git-store paths and hashes.
Original staging indices are compressed as original.index.gz and hash-verified.

Large ambiguous dirty trees (`aiko-validation`, `.automation-live`) and orphaned
folders without usable Git registration are NOT presumed disposable. They remain
for reference-aware review. Canonical repositories and AnimalParty data were not
removed. A directory named tmp, work or cache is not proof its content is valueless.

Measured directory totals from du are logical/accounted file extents, not newly
freed physical storage. Btrfs compression and shared extents make them differ from
df/statvfs. Use before/after filesystem availability for the actual free-space result.

## Tests

`node --test bridge/tests/worktree-policy.test.js bridge/tests/worktree-actions.test.js
bridge/tests/direct-actions-surface.test.js bridge/tests/confinement.test.js
bridge/tests/workspaces.test.js` passed 80 tests in the cleanup run.

Primary references consulted: Git git-worktree manual; Btrfs deduplication and
filesystem usage documentation; Linux FIDEDUPERANGE manual; restic retention/prune
lifecycle documentation. No external service is involved in these maintenance tools.
