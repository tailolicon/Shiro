# Claude task: Shiro connector direct-action parity upgrade

You are the PRIMARY coding agent for this task. Work directly in `/home/tailolicon/Projects/Shiro`. Do not stop at a plan: inspect the current implementation, edit the actual code, add/update tests, run them, fix failures, and leave a working implementation. Do not modify unrelated user projects. Do not push/publish externally unless current repo policy explicitly requires it and existing permissions allow it.

## Mission
Upgrade the Shiro connector so its day-to-day ergonomics and action coverage approach the maturity of the GitHub connector. The lesson from GitHub is not to copy GitHub APIs; it is that common operations are exposed as explicit, typed, low-latency actions instead of forcing every small operation through a long generic agent loop. Shiro currently exposes only 12 public connector actions and too much routine work routes through `harness_start` plus model-request loops. Keep Harness as the powerful fallback for complex coding tasks, but add direct packaged actions for high-frequency deterministic operations so ChatGPT can perform them in one connector call whenever possible.

## Current Shiro public actions (12)
1. `harness_profiles`
2. `fleet_start`
3. `fleet_status`
4. `fleet_stop`
5. `harness_start`
6. `harness_sessions`
7. `harness_get_request`
8. `harness_continue`
9. `harness_status`
10. `harness_respond`
11. `harness_get_artifact`
12. `harness_cancel`

## Reference maturity benchmark: current GitHub connector exposes 89 packaged actions
Treat this inventory as the benchmark for granularity, clear schemas, specialized reads/writes, normalized return shapes, pagination, safety, and action-level documentation. Do NOT implement GitHub-specific functionality in Shiro. Use the patterns to identify equivalent local developer-environment capabilities.

Observed GitHub action inventory:
- `add_comment_to_issue`
- `add_issue_assignees`
- `add_issue_labels`
- `add_reaction_to_issue_comment`
- `add_reaction_to_pr`
- `add_reaction_to_pr_review_comment`
- `add_review_to_pr`
- `compare_commits`
- `convert_pull_request_to_draft`
- `create_blob`
- `create_branch`
- `create_commit`
- `create_file`
- `create_issue`
- `create_pull_request`
- `create_tree`
- `delete_file`
- `dismiss_pull_request_review`
- `download_user_content`
- `download_workflow_artifact`
- `enable_auto_merge`
- `fetch`
- `fetch_blob`
- `fetch_commit`
- `fetch_commit_workflow_runs`
- `fetch_file`
- `fetch_issue`
- `fetch_issue_comments`
- `fetch_pr`
- `fetch_pr_comments`
- `fetch_pr_file_patch`
- `fetch_pr_patch`
- `fetch_workflow_job_logs`
- `fetch_workflow_job_steps`
- `fetch_workflow_run_artifacts`
- `fetch_workflow_run_jobs`
- `get_commit_combined_status`
- `get_issue_comment_reactions`
- `get_pr_diff`
- `get_pr_info`
- `get_pr_reactions`
- `get_pr_review_comment_reactions`
- `get_profile`
- `get_repo`
- `get_repo_collaborator_permission`
- `get_user_login`
- `get_users_recent_prs_in_repo`
- `label_pr`
- `list_installations`
- `list_installed_accounts`
- `list_pr_changed_filenames`
- `list_pull_request_review_threads`
- `list_pull_request_reviews`
- `list_recent_issues`
- `list_repositories`
- `list_repositories_by_affiliation`
- `list_repositories_by_installation`
- `list_user_org_memberships`
- `list_user_orgs`
- `lock_issue_conversation`
- `mark_pull_request_ready_for_review`
- `merge_pull_request`
- `remove_issue_assignees`
- `remove_issue_label`
- `remove_pull_request_reviewers`
- `remove_reaction_from_issue_comment`
- `remove_reaction_from_pr`
- `remove_reaction_from_pr_review_comment`
- `reply_to_review_comment`
- `request_pull_request_reviewers`
- `rerun_failed_workflow_run_jobs`
- `rerun_workflow_job`
- `resolve_review_thread`
- `search`
- `search_branches`
- `search_commits`
- `search_installed_repositories_streaming`
- `search_installed_repositories_v2`
- `search_issues`
- `search_prs`
- `search_repositories`
- `unlock_issue_conversation`
- `unresolve_review_thread`
- `update_file`
- `update_issue`
- `update_issue_comment`
- `update_pull_request`
- `update_ref`
- `update_review_comment`

## What parity means for Shiro
Expose explicit typed actions for common local coding-agent operations currently hidden behind generic Harness turns. Goals: lower latency, fewer repeated model inferences, less discovery overhead, less context bloat. Direct actions must remain within Shiro’s fixed sandbox/project-root security model and should reuse existing internal helpers rather than duplicate logic.

## Required audit before editing
Inspect current Shiro code and determine:
- Where MCP/tool schemas are registered.
- How fixed root `/home/tailolicon/Projects/Shiro` is enforced.
- Which internal primitives already exist for filesystem, shell/processes, git, tests, sessions, browser/fleet control, artifacts, approvals, bridge reload/health.
- Which capabilities exist internally but are not publicly exposed as connector actions.
- Which current operations are slow because they require a Harness LLM round-trip rather than deterministic execution.
- Which abstractions can safely be promoted to public typed actions.
Do not spend excessive time on broad history; inspect the minimum architecture needed and begin useful implementation quickly.

## Design principles
1. Direct deterministic action first; Harness fallback second.
2. Every action gets strict JSON schema, concise description, stable normalized response, explicit error cases.
3. No path escape. All filesystem paths resolve under fixed project root unless existing explicitly-approved policy says otherwise.
4. No arbitrary privilege escalation. Preserve current approval gates.
5. Idempotency where sensible: create operations should no-op safely or return explicit conflict.
6. Optimistic concurrency for writes where possible: expected hash/mtime/current content hash/SHA.
7. Pagination/limits for potentially large lists and logs.
8. Bounded outputs with truncation metadata/cursors, never unlimited dumps.
9. Distinguish Harness durable session id, root operation id, process id, fleet name/id, browser client id, browser tab id.
10. Prefer one connector call for routine work that does not need model reasoning.
11. Preserve all existing public actions/backward compatibility unless strong security/bug reason.
12. Add tests for schemas, sandbox boundaries, happy paths, failures, concurrency/idempotency, response normalization.
13. Add capability/version discovery so clients can feature-detect.
14. Simple file/git/status actions must not invoke an LLM.

# Target action families
Names may be adjusted to project conventions, but preserve clear typed semantics. Prioritize P0 first, then P1.

## P0 — Bridge / health / capabilities
### `bridge_status`
Return bridge/server version, project root, uptime if available, active root turns, active fleets, active bridge-owned local processes, basic health flags. No Harness inference.

### `bridge_capabilities`
Return action names, versions/feature flags, supported profiles, relevant limits such as max concurrent root turns, max fleet size, max output bytes.

### Controlled reload/restart
Implement `bridge_reload` or `bridge_restart` only if safe in-band. If the request would die mid-flight, use a staged `bridge_prepare_reload` plus external-safe mechanism, or document why unsupported. Never fake success.

## P0 — Filesystem direct actions
### `fs_read`
Inputs: path, optional start_line/end_line or byte range, text encoding. Return normalized text, size, mtime, content hash, truncation/next cursor.

### `fs_list`
Inputs: path, recursive, depth, glob/filter, limit, cursor. Return entries with type, relative path, size, mtime.

### `fs_stat`
Path metadata and hash when cheap/requested.

### `fs_search`
Inputs: query/pattern, path scope, glob/includes/excludes, regex/literal, case sensitivity, max results. Use ripgrep/internal equivalent. Return bounded snippets.

### `fs_create_file`
Inputs: path, full content, create_parents optional, fail_if_exists default true.

### `fs_update_file`
Full replacement and optionally patch mode if architecture supports it; optional expected hash/mtime. Use atomic temp-write + rename where appropriate.

### `fs_delete`
Path, optional expected type/hash, recursive default false. Never delete outside fixed root.

### `fs_mkdir`
Path, parents, exist_ok.

### `fs_move`, `fs_copy`
src/dst, overwrite false by default; sandbox validate both sides.

Do not expose unrestricted host filesystem access.

## P0 — Shell / process direct actions
### `exec_run`
Prefer command as argv array, cwd relative to fixed root, environment allowlist/overlay, timeout, max output bytes. Return exit_code, stdout, stderr, duration_ms, timed_out, truncation flags. Avoid shell interpolation by default. If `shell=true` exists, clearly mark/gate it under current security policy.

### `process_start`
Start a long-running process under fixed root; return stable process_id, pid if appropriate, start time, command summary.

### `process_status`
process_id, state, exit code, recent bounded output.

### `process_logs`
process_id, stream selection, cursor/from_offset, max bytes.

### `process_stop`
process_id, graceful timeout, optional explicit force.

### `process_list`
Only bridge-owned processes; never arbitrary system-wide process enumeration unless current policy already supports it.

These direct actions should replace agent loops for simple test commands, git status, dev server lifecycle, etc., while retaining approval/sandbox rules.

## P0 — Git direct actions
Implement typed local git operations instead of requiring Harness turns:
- `git_status`: repo path default root; normalized changes; branch/head/upstream/ahead/behind.
- `git_diff`: staged/unstaged, path filters, base/head refs as appropriate, bounded output.
- `git_log`: ref, limit, path filter, normalized summaries.
- `git_show`: ref metadata and bounded diff.
- `git_branch_list`: local/remote/current/upstream.
- `git_branch_create`: name/start_point/checkout optional.
- `git_checkout`: existing ref; explicit create semantics if combined.
- `git_add`: explicit paths; no implicit `-A` unless explicitly requested.
- `git_commit`: message, optional expected head; return SHA.
- `git_restore`: explicit paths, staged/worktree mode; clearly destructive.
- `git_reset`: only if safely modeled; default non-destructive mixed; hard must be explicit and approval-gated if policy requires.
- `git_merge`: constrained supported options; detect/report conflicts.
- `git_rebase`: if safe under existing approval model.
- `git_tag_list`, `git_tag_create` if low cost.
- `git_remote_list`.
- `git_fetch`, `git_pull`, `git_push` only under current network/credential/approval policy. Preserve approval and surface exact request for remote writes.
- `git_compare`: compare two refs with per-file stats + bounded diff metadata, analogous to GitHub `compare_commits`.
- `git_repo_info`: root, branch, head SHA, dirty state, remotes with embedded credentials redacted.

## P0 — Test/task runner actions
### `test_run`
Typed wrapper for configured/discovered repository tests; target/filter, timeout, bounded logs. If no configured runner, return a discoverable error and available scripts; do not guess dangerous commands.

### `task_list`
Expose package scripts, Make targets, or explicit project task definitions where cheaply discoverable.

### `task_run`
Run one declared task by name without arbitrary shell text; return structured process result.

Many coding-agent steps are just “run tests/lint/build” and should not require model inference.

## P1 — Harness session lifecycle quality-of-life
- `harness_session_create` explicit alias/setup if useful.
- `harness_session_get`: metadata, last activity, pending state, current operation.
- `harness_session_delete` or archive if safe. Distinguish deleting history from canceling active turn; refuse unsafe active deletes unless force semantics are explicit.
- `harness_session_prune`: older_than/max_count/status; dry_run default true.
- `harness_operation_list`: active/recent operations.
- `harness_operation_get`: compact full state for one operation.
- `harness_wait`: bounded wait for one operation transition if it meaningfully simplifies polling.
Do not remove existing request/continue mechanism.

## P1 — Fleet lifecycle improvements
- `fleet_list`: all server-owned fleets with compact state.
- `fleet_update`: update interval/prompt/max_session_runs/stagger with clear effective timing.
- `fleet_delete`: permanently remove stopped fleet state/history if safe, distinct from stop.
- `fleet_runs`: paginated recent run summaries per slot/session.
- `fleet_worker_status`: detail for one slot.
- `fleet_worker_restart` / recycle: safely close/recreate one owned tab while preserving slot identity where practical.
- `fleet_prune_sessions`: safe cleanup of old worker conversations/history after N runs if browser/chat integration supports it.

Important UX: user wants patterns like “each worker may run 4 times, then recycle/delete the old conversation and create a fresh one” to prevent history bloat. Existing `max_session_runs` is a start; cleanup/recycle semantics must be explicit and observable.

## P1 — Browser/tab direct control, verified owned tabs only
If Shiro already has browser automation internals, expose constrained owned-tab primitives rather than arbitrary browser takeover:
- `browser_owned_tabs`: only tabs registered/owned by Shiro, with client/tab id, URL/title, fleet association, busy/idle/verification state.
- `browser_tab_close`: close verified Shiro-owned idle tab; refuse foreign/unverified/busy unless explicit existing force policy.
- `browser_tab_reload`.
- `browser_tab_focus` if reliable.
- `browser_tab_screenshot` returning bounded artifact/attachment if already supported.
- `browser_tab_send_prompt`: low-level prompt primitive for verified ChatGPT-owned tab; fleet scheduling remains preferred high-level API.
No arbitrary personal-browser takeover.

## P1 — Artifacts
- `artifact_list`: bounded list of produced artifacts under fixed root / registered outputs.
- `artifact_get`: generic retrieval if file already exists; existing `harness_get_artifact` may be reusable.
- `artifact_metadata`: size/hash/type/path/producer if tracked.
- `artifact_delete`: safe cleanup under root on explicit request.

## P1 — Config/introspection
- `config_get`: non-secret effective config/limits; redact credentials/tokens.
- `config_validate`: validate config without applying.
- `config_set`: only tightly allowlisted safe mutable settings if architecture supports it; no arbitrary config write.
- `logs_tail`: bounded cursor-based bridge/service logs, secret-redacted.
- `metrics_snapshot`: optional counters/latencies/errors if cheap/current instrumentation supports it.

# Schema/response requirements
- Typed enums rather than free-form strings where practical.
- Every action doc string explains purpose, scope/sandbox, important side effects, related action.
- Normalize errors with stable codes when not using MCP-native errors. At minimum distinguish: `NOT_FOUND`, `ALREADY_EXISTS`, `CONFLICT`, `INVALID_ARGUMENT`, `OUTSIDE_SANDBOX`, `PERMISSION_REQUIRED`, `TIMEOUT`, `PROCESS_FAILED`, `GIT_CONFLICT`, `BUSY`, `UNSUPPORTED`, `INTERNAL`.
- Prefer relative paths in public payloads; reporting fixed root from bridge_status is acceptable because it is public contract.
- Large outputs: `truncated`, `next_cursor` or offsets.
- Writes return metadata for sequential safe updates: hash/mtime/new HEAD, etc.
- Document deterministic vs approval-triggering behavior.

# Performance acceptance criteria
By code-path inspection and preferably tests/benchmarks:
- `bridge_status`, `fs_stat`, small `fs_read`, `git_status`, `task_list`, `process_status`, `fleet_status` must not invoke an LLM.
- Common direct actions must not create a Harness durable session.
- Simple operations should be one MCP round-trip from ChatGPT.
- Avoid heavyweight subprocesses when metadata can use existing internal helpers/library primitives.

# Security acceptance criteria
- Test `..`, absolute paths, symlink chains, and relevant race-prone escape attempts; anything escaping `/home/tailolicon/Projects/Shiro` must fail.
- Process cwd sandbox validation mandatory.
- Do not dump entire environment/secrets by default.
- Redact secrets in logs/config output.
- Redact embedded credentials in git remote URLs.
- Destructive delete/move/restore/reset/rebase/push/reload operations preserve current approval philosophy and cannot silently widen permissions.
- Browser actions only operate on verified Shiro-owned tabs.

# Tests required
At minimum add/update tests for:
1. Public tool registry contains new actions and schemas validate.
2. Fixed-root path enforcement and symlink escape rejection.
3. Filesystem read/create/update/delete conflict behavior and atomicity where relevant.
4. `exec_run` timeout/truncation/nonzero-exit behavior.
5. Process start/status/logs/stop lifecycle.
6. Git status/diff/branch/commit against temporary repository fixtures.
7. Dangerous git/network operations preserve approvals or remain unexposed if unsafe.
8. Task discovery/run on fixture project.
9. Fleet list/update/delete/recycle semantics if implemented.
10. Session prune/delete dry-run and active-session safety if implemented.
11. Output pagination/truncation.
12. Bridge capabilities/status endpoints.
13. Backward compatibility of all original 12 public actions.

# Documentation required
Update README/docs/tool reference with new direct actions.
Add architecture note **Direct Actions vs Harness Agent** explaining when clients should use deterministic direct actions vs `harness_start`.
Add a client migration/intent table, including at least:
- read file → `fs_read`
- inspect repo status → `git_status`
- run tests → `test_run` / `task_run`
- run one command → `exec_run`
- start long-running server → `process_start`
- complex multi-step coding/refactor → `harness_start`
- recurring ChatGPT workers → `fleet_start`
Add capability/version discovery guidance so clients do not assume every deployment exposes identical actions.

# Delivery strategy
Do not perform a giant unsafe rewrite. Implement coherent vertical slices and keep tests green.

## Phase 1 — must deliver now if architecture permits
Bridge status/capabilities; filesystem direct read/list/stat/search + safe writes; `exec_run`; process lifecycle; git status/diff/log/branch/info plus safe core mutations; task/test wrappers.

## Phase 2 — deliver now where reasonable
Session lifecycle/pruning; richer fleet lifecycle; artifact/config/log helpers.

## Phase 3 — only when ownership model is already reliable
Owned browser-tab primitives and safe reload/restart controls.

If constraints prevent everything, prioritize complete tested P0 implementations over stubs. Never add fake actions that return success without real work. Leave precise TODO/roadmap for genuinely deferred items.

# User experience target
Routine Shiro management currently feels much slower than GitHub connector calls. Setting up, inspecting, changing, or stopping a few sessions/fleets should feel like explicit GitHub actions: one action, immediate normalized result, minimal orchestration. Generic Harness is for real reasoning/coding, not routine CRUD/control-plane operations.

# Required final validation/report
Before completion:
1. Enumerate final public Shiro action count and exact action names exposed.
2. Compare against 12-action baseline.
3. State which routine workflows no longer require Harness inference.
4. List tests run and exact pass/fail result.
5. Summarize security hardening.
6. List exact files changed.
7. State anything deferred and why.

You must implement, not just recommend.