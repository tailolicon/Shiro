# Shiro upgrade audit

Audit date: 2026-08-24

Sources reviewed:

- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin at `ca57824`
- https://github.com/topics/dsh-plugin
- Ten shortlisted repositories cloned and inspected at fixed revisions.

The GitHub topic is a discovery feed, not a trust signal. It currently mixes many unrelated repositories, so popularity or topic membership was never treated as approval to install code.

## Accepted

### Native effort and speed routing

Implemented in `bridge/src/index.js` instead of installing a model-selector replacement. This uses Harness's native `reasoning.efforts` contract and avoids competing UI plugins.

Checks:

- Three model profiles: `fast`, `balanced`, `deep`.
- Four effort levels: `light`, `standard`, `high`, `max`.
- Both fields are required by `harness_start` and echoed in every relayed request.
- `harness_profiles` exposes exact values/defaults.
- Unknown model IDs are rejected.

### dsh-auto-continue

Pinned revision: `e865b0b179331769cdce4a1e407a488056c1633d`.

Why accepted: transient-error recovery, exponential backoff, max-token continuation, idempotency hints, explicit pause, bounded retries and loop detection. Source only posts to its own local API routes and uses Harness follow-up/cancel APIs.

Verification: its standalone suite passed all 15 scenarios, including user abort, permanent errors, retry cap, pending-tool guard and loop breaker.

Integration finding: the first bridge version reported `completed` as soon as a max-token turn ended, before the plugin's delayed follow-up appeared. The bridge now holds retryable turn endings for a bounded grace period and ignores an older turn end once a newer turn has started. A dedicated MCP smoke proves `max-tokens → plugin follow-up → bridge resume → completed`.

### dsh-subagent-monitor

Pinned revision: `125278d445e42705354e039a45d1321499d6be32`.

Why accepted: adds missing visibility for nested/parallel work with a small read-only status surface. It does not spawn commands or contact external services.

Verification: dependency install, TypeScript typecheck, production build and documentation consistency check passed. Runtime route returned an empty valid snapshot for a missing session after being mounted.

### Bridge secret redaction

The catalog's `dsh-secret-redactor` design was reviewed at `48110ca2779b59d36edec46c8aff97b6a50322aa`. Shiro uses an adapted bridge-local subset that masks high-confidence vendor keys, bearer/JWT/private-key material, credential-bearing URLs, contextual key/value secrets and secret-named environment values before model requests leave for ChatGPT Web. It does not read SSH config or any file outside the project and preserves binary image/audio fields.

### ChatGPT browser model relay

Pinned revision: `b6b9146` (`chatgpt-browser-bridge-node` 6.3.14, extension 2.3.11).

Why accepted: this supplies the missing DSH-to-ChatGPT direction while preserving the native DeepSeek Harness UI and agent loop. Shiro uses only its loopback chat transport; project apply, workflow command execution and Git surfaces from the third-party package are not called. API and browser tokens are separate, the HTTP/WebSocket server binds to `127.0.0.1`, and extension host permissions are limited to ChatGPT plus loopback.

The next upstream commit was rejected because it added an unavailable `zipflow@1.9.0` package and duplicated DSH workflow ownership. The pinned dependency graph is hardened after install to patched `tar` and `undici` transitive releases, then the original pinned manifests are restored so the submodule stays reproducible.

Verification: 41 focused upstream API, transport, extension-auth, model-selection and browser-safety tests passed. Shiro adds tests for loopback URL enforcement, unknown-tool rejection, effort mapping, plain-text fallback and direct adapter routing without MCP handoff. Live browser verification remains required after the one-time extension connection.

## Rejected or deferred

- Effort/reasoning slider variants: redundant with the native Harness model contract and likely to conflict with one another.
- `dsh-at-file`: Shiro already ships Harness file-reference support; the shortlisted revision failed clean build/typecheck against its declared checkout layout.
- `dsh-injection-guard`: useful design, but the audited source checkout could not resolve an unpublished `@deepseek-ai/dsh-type-meta` dependency. Shiro keeps the fixed project-root boundary, no-network container and approval gates instead of installing an unverifiable build.
- `dsh-guardwall`: 67 source tests passed, but its vet tools can clone packages, execute npm/git and inspect arbitrary local specs, while its default audit path is outside the project. Its runtime ideas were not worth exposing that broader agent tool surface; Shiro uses fixed-root isolation, approvals and bridge redaction instead.
- `dsh-continual-harness`: writes reusable state/skills under `DSH_HOME`, outside the selected project root by design. Deferred until it can be configured and proved to stay inside Shiro's project boundary.
- Better Sidebar and Skills Hub: large supply-chain/permission surface (terminal, browser, credentials or arbitrary package/skill installation) and overlap with Shiro's existing UI/runtime.

## Mandatory final gates

- Unit tests and `git diff --check`.
- MCP authentication, required profile fields and profile echo.
- Real read/write/edit, isolated test execution and Git status.
- Outside-root write denial.
- Smoke fixtures are removed in `finally`, including failed runs.
- Durable resume, question/approval relay and rejection.
- Goal, foreground subagent and two-child parallel workflow.
- Plugin composition/runtime endpoint checks.
- Auto-continue handoff through the real MCP bridge after a max-token finish.
- Secret scan and clean working tree after a local commit.
- No push or merge.

## Known platform boundary

Shiro can expose and enforce its requested operating profile, but an MCP server cannot guarantee a different ChatGPT service tier, quota or backend compute allocation. Those remain controlled by ChatGPT Web. The UI and tool contract state this explicitly instead of claiming a remote capability that cannot be verified locally.

The browser relay is an unofficial UI adapter, so a future ChatGPT DOM/model-picker change can require an extension update. It fails closed on unknown model/tool structures and falls back to the authenticated MCP handoff instead of bypassing Harness.
