# Action-gap feedback loop

Shiro has a local feedback loop for recurring connector friction. Its goal is to reduce the number of tool calls and failure-prone workarounds needed for the same task, not to maximize the number of actions.

## Agent actions

Use `report_action_gap` only when there is evidence of recurring or material friction:

- `missing_action`: no existing direct action cleanly expresses a useful capability.
- `bad_action_design`: an existing action is unnecessarily hard to call or returns an awkward shape.
- `composite_action`: the same multi-action chain is repeatedly used as one logical operation.
- `agent_misuse`: Shiro already has the capability, but action discovery/routing made the agent miss it.

Do **not** report ordinary multi-step work merely because it has several legitimate steps, one-off user-specific complexity, or a normal permission refusal that correctly enforced policy. Prefer one concise report for a recurring pattern instead of reporting every tool call.

Reports are redacted with Shiro's existing secret redactor and appended to `.shiro/action-gaps/reports.jsonl` under the primary Shiro project root. The storage path is fixed by the bridge; callers cannot choose a path. Appends are serialized inside the bridge and fsynced before success is returned.

`report_action_gap` returns a deterministic fingerprint and friction score. When `suggested_action` exactly matches an already-registered action, the result also returns `existing_action_matches` and `possible_agent_misuse=true` for a `missing_action` report. This is intentionally exact-name matching rather than fuzzy/LLM search so it cannot hallucinate capability equivalence.

## Friction score

All counters are optional. Missing counters are zero.

| Counter | Weight |
|---|---:|
| unnecessary tool calls | 1 |
| retries | 3 |
| permission failures | 2 |
| shell workarounds | 2 |
| schema errors | 3 |
| agent confusion | 2 |

The score is evidence for prioritization, not a confidence probability and not an instruction to create an action automatically.

## Operator review

Call `action_gap_summary` to read the durable queue. It groups reports by a deterministic normalized fingerprint and returns count, first/last seen, maximum severity, total/mean friction, estimated call savings, possible-misuse count, and one representative report.

A practical review order is:

1. High-frequency, high-friction groups.
2. `agent_misuse` or `possible_agent_misuse` groups first: improve descriptions/discovery before adding duplicate capabilities.
3. Repeated `bad_action_design` groups: simplify schemas or outputs.
4. Stable `composite_action` chains: consider a workflow action only when the composition is genuinely atomic from the user's perspective.
5. True `missing_action` groups last, backed by repeated evidence.

This version deliberately does not generate code, install plugins, mutate the action registry, or promote proposals automatically. The operator reviews the evidence and decides what to implement.
