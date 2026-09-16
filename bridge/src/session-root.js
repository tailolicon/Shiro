import { isAbsolute, resolve } from 'node:path'

// Which directory a Shiro-registered engine tool acts on.
//
// The workspace-scoped tools Shiro adds to the Harness engine (shiro-git-tool,
// shiro-container-tool, shiro-document-tool) used to bind one workspaceRoot at plugin apply() time.
// That was correct while every session lived in the fixed project root, and
// silently wrong the moment a session is anchored somewhere else: the agent
// would read files from workspace B with the engine's own fs tools and then
// commit them in the Shiro repository.
//
// The engine already solved this for its own tools. dsh-tool-fs derives the
// working directory from `exec.agent.session.header.cwd` -- "so each session's
// read/write/edit act on ITS workspace, not the server's launch dir"
// (packages/fs/tool-fs/src/session-cwd.ts) -- and dsh-tool-bash defaults a
// workdir the same way. Shiro's tools follow exactly that rule, so all of a
// session's tools agree on where they are.
//
// This is not a widening: the session cwd is fixed when the session is created,
// by the human in the engine UI or by the bridge from an allowlisted workspace,
// and nothing an agent does mid-turn can change it. Confinement is unchanged --
// paths are still confined, just to the root the session actually occupies.
//
// Dependency-free on purpose: @deepseek-ai/dsh-tools is a profile-only peer, so
// keeping the rule here is what makes it unit-testable (same split as
// git-commands.js vs git-tool.js).

/**
 * The root one tool call operates on.
 * @param exec tool execution context; only `agent.session.header.cwd` is read.
 * @param fallbackRoot configured project root, used for non-agent callers.
 */
export function sessionRoot(exec, fallbackRoot) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string') return fallbackRoot
  const trimmed = cwd.trim()
  // A relative or empty cwd would silently reanchor the tool on the bridge
  // process's own working directory, which is never what the session meant.
  if (trimmed === '' || !isAbsolute(trimmed) || trimmed.includes('\0')) return fallbackRoot
  return resolve(trimmed)
}
