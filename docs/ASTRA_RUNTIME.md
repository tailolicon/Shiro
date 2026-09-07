# Astra session runtime foundation

Shiro owns durable control-plane state. The browser is an observed execution
binding, never the session store. The implemented execution lane remains
**Web model → Harness loop → Shiro tools**. There is no Codex app-server route
or parity claim in this slice.

## Storage and ownership

Node 22.13+ provides `node:sqlite`; no native npm dependency is added. The default
file is `$XDG_STATE_HOME/shiro/sessions.sqlite`, falling back to
`~/.local/state/shiro/sessions.sqlite`. Set `SHIRO_SESSION_STATE_PATH` or the bridge
`sessionStatePath` configuration field to use another runtime-state location.
Every claimed workspace is checked, including symlinks: its database must be
outside that coding root. Tests inject `sessionStatePath: ':memory:'`, a temporary
file, or a `sessionKernel` instance. The injector owns an injected kernel's lifetime.

Schema version 2 uses `PRAGMA user_version`, transactional initialization, WAL,
FULL synchronization, foreign keys, and a unique running-operation index. Version 1
is migrated transactionally: the old process-local workspace alias is replaced by
a stable identity derived from the canonical workspace root, and executor lease /
fencing columns are added. Unsupported newer versions fail closed; corrupt files
are not replaced or deleted. Future migrations must advance the version in the same
transaction as their DDL.

Session mode/owner pairs are immutable:

| Mode | Loop owner | Execution support |
| --- | --- | --- |
| `web-harness` | `harness` | Current bridge lane |
| `codex-native` | `codex` | Metadata only; future real app-server integration |
| `direct` | `direct` | Kernel metadata API; no new autonomous loop |

Changing mode, owner, or canonical workspace root requires a different session.
Workspace registry IDs are deliberately *not* durable identities: after restart,
rename, or open-order changes, a stored canonical root is remapped to the alias that
currently names that root. Every control-plane gate checks both the current alias
and canonical root, so an alias reused for another directory cannot expose the old
session. Ownership conflicts fail before model selection or prompt dispatch.
Requested model/effort are persisted independently of verified model/effort.
Selecting an engine model or asking the browser for a model does not constitute
browser verification.

Each executing session also carries a renewable executor lease and monotonically
increasing fencing token. A second bridge may inspect a live foreign owner but may
not recover or mutate it. Only an expired lease can be taken over; after takeover,
the old executor's operation writes and effect receipts fail with `FENCED`. The
bridge heartbeat renews owned leases while it is alive, and clean disposal releases
them without claiming that engine execution completed.

## Inspection and recovery

`session_runtime_status({session_id, workspace?})` returns an explicit safe
projection: ownership, requested/verified model and effort, redacted browser
binding metadata, operation IDs/states/checkpoints/timestamps, lease/fence status,
and effect IDs/names/states/timestamps. Raw operation JSON, assistant completion
text, effect arguments, raw effect receipts, verification evidence, and executor
IDs are never serialized. Textual fields and URLs are secret-redacted, and URL
credentials/query/fragment data are stripped. The action is read-only, permission
gated, and scoped to the currently opened workspace (default: `project`). A wrong
workspace alias or canonical root returns `NOT_FOUND`. `bridge_capabilities.features`
advertises `session_runtime_status` and current `durable_session_kernel`
availability.

Startup hydrates the primary workspace; other opened workspaces hydrate when
inspected or used. Recovery first has to acquire an expired executor lease. A live
foreign owner remains untouched. For an abandoned running turn, Shiro marks
started effects `uncertain` and the operation `interrupted-unverified`; it never
replays either automatically. Reconciliation to `completed` additionally requires
engine membership, a successful prompt-dispatch receipt, and gap-free history
coverage back through the operation's `afterSeq` baseline. History is paged
backwards with the engine's exclusive `beforeSeq` cursor and `hasMore` contract.
Missing pages, truncation, sequence gaps, multiple turn starts/ends (including
auto-continuation), or an uncovered baseline all remain unverified. This never
rebuilds lost broker requests, approvals, or model execution from browser DOM.

An operator may explicitly cancel potentially-live `interrupted` or
`dispatch-failed-or-uncertain` execution. That request is recorded as a durable,
idempotent `harness.cancel` effect, so a successful receipt prevents duplicate
cancel dispatch. The resulting state `cancellation-accepted-effects-unverified`
means only that the engine accepted cancellation; it does not claim that every
external side effect stopped. Wrong-workspace cancellation is rejected before the
engine is touched. Manual resolution beyond this explicit cancellation path is
deferred.

If storage cannot open, read/direct control-plane services remain available and
runtime inspection reports `storage-unavailable`. New harness starts fail closed.
Storage write failures likewise prevent further durable starts; this does not
claim that an already dispatched engine action has been cancelled.

## Browser binding and executable decisions

The relay uses the kernel binding API to record the selected client id and, when
available, tab id, URL, and conversation id. The binding includes observation time
and selection source. Missing observations remain null. These observations grant
no browser-control authority and do not replace existing browser ownership gates.
An internal caller can supply model verification only with observed evidence;
the current relay supplies no such evidence and leaves verified fields null.

Executable envelopes must parse strictly. Heuristic repair of any envelope
containing a tool call, including mixed text/tool blocks and legacy `tool_calls`,
is refused with the existing retryable `EMPTY_RESPONSE` classification. Nested
string arguments are parsed strictly and must yield an object. Text-only repair
remains supported. Streaming previews never authorize execution; settlement uses
the same strict parser.

## Effect ledger boundary

`SessionKernel.planEffect`, `transitionEffect`, `runEffect`, and `recoverEffects`
provide durable intent and receipts. Effect ids are unique; valid states are
`planned`, `started`, `succeeded`, `failed`, and `uncertain`. The caller must reuse
the same effect id for the same intent. `runEffect` records `started` before
calling the executor. An exception is conservatively uncertain, since it may
occur after the external effect. `failed` is available for an explicit known
failure receipt. Duplicate ids and attempts to restart uncertain effects fail.

The first integrations cover the shared `harness.prompt` dispatch seam and the
explicit `harness.cancel` recovery seam. Their receipts prove engine acceptance,
not completion of the coding task or reversal of external effects. Individual
engine tools and other direct actions are not yet wrapped; their existing
permission and sandbox enforcement remain in place. Extending receipt coverage,
manual uncertain-effect resolution, bounded ledger retention, and real
Codex-native execution are intentionally deferred.
