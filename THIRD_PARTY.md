# Third-party software

## DeepSeek Harness

- Source: https://github.com/deepseek-ai/deepseek-harness
- Imported revision: `b150a551`
- License: MIT (`engine/LICENSE`)

Shiro keeps the Harness source in `engine/` so its complete agent runtime can be inspected and modified locally.

## Pake

- Source: https://github.com/tw93/Pake
- License: GPL-3.0 with the Pake output exception

Pake is used as a build tool to produce Shiro's Windows desktop shell. Pake's stated output exception applies to applications produced by the unmodified official CLI.

## dsh-auto-continue

- Source: https://github.com/HsiangNianian/dsh-auto-continue
- Pinned revision: `e865b0b179331769cdce4a1e407a488056c1633d`
- License: MIT (`plugins/auto-continue/LICENSE`)

## dsh-subagent-monitor

- Source: https://github.com/Mombrane/dsh-subagent-monitor
- Pinned revision: `125278d445e42705354e039a45d1321499d6be32`
- License: MIT (`plugins/subagent-monitor/LICENSE`)

## awesome-dsh-plugin catalog snapshot

- Source: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- Pinned revision: `ca578248deeaaab94393cf4b9f20bbd5fc97c118`
- License: CC0-1.0 (`research/awesome-dsh-plugin/LICENSE`)
- Scope: unexecuted research/catalog data only.

## dsh-secret-redactor rule design

- Source: https://github.com/DamonKoy/dsh-plugins/tree/main/packages/dsh-secret-redactor
- Reviewed revision: `48110ca2779b59d36edec46c8aff97b6a50322aa`
- License: MIT
- Scope: Shiro's bridge redaction patterns are an adapted, filesystem-free subset. The third-party plugin itself is not executed.
