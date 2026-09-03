import { ActionError, fail } from './action-errors.js'

// OS-level confinement for everything the bridge spawns.
//
// The bridge used to check that a command's WORKING DIRECTORY was inside a
// workspace and then spawn it unconfined. That confines nothing: an absolute
// path, a `curl`, or a detached child walks straight out of the workspace. The
// path sandbox is about which paths an ACTION addresses; it was never a
// boundary around the process an action starts.
//
// The engine already owns that boundary. `dsh-sandbox-local` provides bwrap and
// landlock-run backends behind one seam -- `ctx.sandbox.confine(argv, policy)`
// returns the argv to spawn instead -- and `dsh-sandbox-policy` resolves the
// mode per session. The bridge does not reimplement any of that; it routes its
// own spawns through the same provider so a command started by a direct action
// and a command started by an agent turn land under the same policy.
//
// Two rules make this honest rather than decorative:
//   * when confinement is REQUESTED but unavailable, the command is refused --
//     never run unconfined while a narrowed profile is in force;
//   * every result reports which backend enforced it and how completely, so
//     "sandboxed" is an observation the caller can check, not a claim.

/** bridge permission profile -> engine sandbox mode. The vocabularies line up. */
const MODE_BY_PROFILE = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  full: 'danger-full-access',
})

export function sandboxModeForProfile(profile) {
  return MODE_BY_PROFILE[String(profile ?? '')] ?? 'danger-full-access'
}

/**
 * @param provider ctx.sandbox from the engine, or null when the bridge runs
 *   outside a host that provides one (tests, a bare `node src/index.js`).
 */
export class Confinement {
  constructor({ provider = null, policy = null } = {}) {
    this.provider = provider
    this.policy = policy
  }

  get available() {
    return this.provider !== null && typeof this.provider.confine === 'function'
  }

  /** The mode a call runs under: the caller's override, else the live profile. */
  modeFor(requested) {
    if (requested === undefined) return sandboxModeForProfile(this.policy?.profile)
    const mode = String(requested)
    if (!Object.values(MODE_BY_PROFILE).includes(mode)) {
      fail('INVALID_ARGUMENT', `sandbox mode must be one of ${Object.values(MODE_BY_PROFILE).join(', ')}`)
    }
    // A caller may only narrow, exactly as with the permission profile: a
    // command that could pick its own confinement has none.
    const ceiling = sandboxModeForProfile(this.policy?.profile)
    const rank = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
    if (rank[mode] > rank[ceiling]) {
      fail('PERMISSION_REQUIRED', `sandbox mode ${mode} is wider than the permission profile allows (${ceiling}); confinement can only be narrowed at runtime`)
    }
    return mode
  }

  /**
   * Wrap one spawn.
   * @param argv the exact argv about to be spawned. A shell line is passed as
   *   ['bash', '-c', line], which is what the seam's contract asks for.
   * @param workspaceRoot absolute root that workspace-write may write under.
   * @returns {{argv: string[], mode: string, enforcement: string, backend: string|null, denialSignatures: readonly string[]}}
   */
  confine(argv, { workspaceRoot, sessionId, mode: requested } = {}) {
    const mode = this.modeFor(requested)
    const original = [...argv]
    if (mode === 'danger-full-access') {
      // Nothing to enforce, and saying so is the point: the caller reports
      // `enforcement: 'none'` rather than implying a boundary that is absent.
      return { argv: original, mode, enforcement: 'none', backend: null, denialSignatures: [] }
    }
    if (!this.available) {
      // Fail closed. Running unconfined here is how a "read-only" run quietly
      // becomes a full-access one.
      throw new ActionError(
        'UNSUPPORTED',
        `this deployment cannot confine processes (no sandbox provider), so ${mode} cannot be honoured. Start Shiro inside the engine, which mounts dsh-sandbox-local, or set the permission profile to full to run unconfined deliberately.`,
      )
    }
    let confined
    try {
      confined = this.provider.confine(original, {
        mode,
        workspaceRoot,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
    } catch (error) {
      // SANDBOX_UNAVAILABLE from the provider means no backend is usable on
      // this host; it is a capability problem, not a command failure.
      throw new ActionError('UNSUPPORTED', `confinement is unavailable for ${mode}: ${error?.message ?? error}`)
    }
    return {
      argv: [...confined.argv],
      mode,
      enforcement: String(confined.enforcement ?? 'unknown'),
      backend: confined.argv?.[0] ?? null,
      denialSignatures: confined.denialSignatures ?? [],
    }
  }

  /** What the actions report so a caller can verify the boundary rather than trust it. */
  describe(result) {
    return {
      mode: result.mode,
      enforcement: result.enforcement,
      ...(result.backend === null ? {} : { backend: result.backend }),
    }
  }
}
