# Game-development connector tools — 2026-09-10

## Deployment state

The working tree contains direct-action catalog **version 5**, with `GAME_TOOLS_VERSION = 1` and eleven new actions. The already-running Shiro backend still reports catalog version 4 until the operator restarts the backend. Refreshing only the ChatGPT connector catalog does not reload JavaScript in the existing backend process.

This increment adds operational tooling. It does not certify a complete game, human playtesting, production-quality art/audio, Steam publishing rights, cloud service credits, or all supported operating systems.

## New actions

All paths are relative to the selected workspace. Pass `workspace: "doomsday-prepper"` for the game rather than the primary Shiro repository.

| Action | Function and important limit |
| --- | --- |
| `game_toolchain_status` | Discover Unity, Blender, Python, FFmpeg/FFprobe and desktop prerequisites. Installation is not execution proof. |
| `unity_command` | Call the official live Unity CLI with structured parameters, exact project targeting, optional managed-service-to-Flatpak resolution, and fresh disk receipts. It never starts a second Editor. |
| `blender_run` | Run an explicitly selected workspace Python script or blend file with embedded auto-execution disabled. Background mode returns a process ID, not a completion claim. |
| `blender_inspect` | Inspect real mesh, triangle, material, rig/action and missing-image properties of supported 3D assets. |
| `blender_render` | Render an asset to a new PNG through CPU Cycles, preserving the original asset. |
| `media_probe` | Inspect local audio/video formats and streams with FFprobe; network input protocols are disabled. |
| `audio_analyze` | Measure PCM WAV duration, RMS, peak, DC offset, clipping and checksums. It is not a listening/mastering review. |
| `desktop_windows` | List the current Hyprland window addresses and geometry for explicit targeting. |
| `desktop_capture` | Capture a requested visible window region or explicitly requested full desktop. Occluding windows can appear; this is not an isolated offscreen capture. |
| `desktop_input` | Targeted focus and keyboard input. Native mouse clicks on the current Lua-based Hyprland backend are explicitly unsupported, not reported as successful. |
| `reload_readiness` | Inspect bridge-owned processes, terminals and active Harness turns without stopping them. Also check `bridge_status.fleets.running` before restart because this action does not drain scheduled fleets. |

## Unity configuration and examples

The game workspace contains `.shiro/game-dev.json`:

```json
{
  "schema_version": 1,
  "unity_project": "prototype",
  "unity_service": "doomsday-prepper-unity-editor.service"
}
```

After reloading the backend and refreshing tool discovery:

```json
{"workspace":"doomsday-prepper","command":"editor_status"}
```

Use `unity_command` with `command: ""` to discover the exact installed command catalog. For a fresh compile, call `recompile`, then poll `recompile_status` until complete and inspect `failed`. For tests, call the discovered `run_tests` parameters and inspect `test_status`. A queued/running result is not a passing test, and the wrapper handles nested failure flags even when the CLI exits zero.

Example targeted test request, only when no concurrent scene authoring is running:

```json
{
  "workspace":"doomsday-prepper",
  "command":"run_tests",
  "parameters":{
    "mode":"editor",
    "filter":"Dps.Game.Tests",
    "filter_type":"assembly",
    "async_tests":true
  }
}
```

Do not hard-code a Flatpak instance or PID. The wrapper resolves the current managed service, verifies the project path and selects its unique UnityHub instance each time.

## Blender and audio

Blender **5.2.0 LTS** was installed through the signed Arch package repository. The Unity editor and its pinned packages were not upgraded. The verified CPU render path does not require a GPU-driver change.

`blender_run` accepts a workspace `.py` script, optional `.blend` and literal argument array. Scripts can implement modeling, material construction, rigging, animation, baking and exports using installed Blender APIs; this increment does not claim that an arbitrary character rig or animation has already been generated and accepted.

The built-in inspection/render paths support `.blend`, `.glb`, `.gltf`, `.fbx`, `.obj` and `.stl`. Existing outputs are refused rather than silently overwritten. Asset source rights and downstream redistribution still belong in the game's provenance register.

The game already has an original deterministic audio generator at `tools/generate_original_audio.py`. `audio_analyze` and `media_probe` now expose technical checking directly through Shiro. They do not provide a paid audio-generation account or infer artistic quality from a valid WAV.

## Desktop environment and safeguards

The shared child environment builder now discovers a bounded allowlist of the current user's Linux desktop connection metadata. This applies to normal commands, registered processes and terminals. It excludes bridge tokens, cloud keys and arbitrary systemd environment values; it does not copy all of `process.env`.

The current host uses Hyprland 0.56.2 with a Lua dispatcher API. Focus and F8 delivery were observed on a temporary test-owned Qt window. The final wrapper uses that verified structured API. Native mouse delivery returned success from one dispatcher while no click was observed, so the connector fails explicitly instead of pretending a click occurred. Do not bypass platform tool refusals or add privileged input injection to conceal this limitation.

The final `desktop_capture` wrapper contains the compatible focus change, but its end-to-end GUI rerun was not executed after a platform tool safety block. Initial capture failure and subsequent focus/keyboard probe evidence are preserved separately. Use the existing Unity screenshot command for engine-controlled capture where appropriate.

## Persistent evidence and reload

New game-tool jobs write unique `.shiro/game-tools/<timestamp>-<label>-<id>/` directories containing `spec.json`, `result.json`, `stdout.log` and `stderr.log`. Results include timestamps, exit status and hashes; logs retain up to 64 MiB per stream with explicit truncation accounting instead of relying only on the connector's 1 MiB ring buffer.

Disk receipts survive a reload. Active jobs do not: stop or let jobs finish, preserve the worktree and resume from the recorded state afterward. A receipt saying running/interrupted/timeout is not permission to replay an uncertain side effect automatically.

The existing command/permission/confinement infrastructure remains in force. Full permission means an operation may run unconfined, not that it has an invisible OS sandbox. The new wrappers do not widen a narrowed profile or inherit credential variables.

## Verification actually performed

- Initial focused suite: **68/68**, no failures or skips.
- Initial full bridge suite: **576/576**, no failures or skips.
- Final declared repository test task after the Hyprland compatibility patch: **578/578**, no failures or skips, exit 0. This includes package closure and a packed-tarball install/import test.
- Fresh live checks passed: toolchain discovery; Unity Editor status; Blender create/save/GLB export/PNG render; GLB inspection; GLB re-import/render; actual game WAV analysis; FFprobe audio inspection.
- The GLB roundtrip render was opened and visually inspected: the expected cube is present in the resulting PNG.
- Targeted Hyprland focus and keyboard delivery were observed in the owned GUI probe. Native mouse delivery is not accepted. Final combined GUI smoke v2 was not run due a platform tool safety block.

Evidence root: `.shiro/evidence/game-toolchain-20260910/`. `full-tests.tap` is the earlier 576-test run; `final-test-summary.json` summarizes the later 578-test tool response and is not a fabricated raw TAP transcript.

## Source and rollback

New files: `bridge/src/desktop-environment.js`, `game-dev-actions.js`, `game-job.py`, `blender-tools.py`, `audio-analyze.py`, and `bridge/tests/game-dev-actions.test.js`.

Existing files changed for integration: `bridge/src/exec-actions.js`, `direct-actions.js`, `index.js`, `bridge/package.json`, and the expected action list in `bridge/tests/direct-actions-surface.test.js`. Packaging also explicitly includes the existing PTY helper.

Pre-change copies of selected existing files are in `.shiro/evidence/game-toolchain-20260910/before/`; they preserve the user's already-dirty versions, not a reset to Git HEAD. Reconcile against those copies if rollback is needed. Do not use a broad git reset/clean or overwrite unrelated work. No commit, push or backend restart was performed by this connector upgrade.
