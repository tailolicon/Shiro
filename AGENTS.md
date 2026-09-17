# Shiro workspace and storage policy

Start in the existing target workspace using `workspace_open`. A ChatGPT session,
research/review worker, translation worker or video task does NOT need another Git
checkout. Do not clone projects inside Shiro or create `.tmp-*` workspaces by default.

Only simultaneous source writers or genuinely conflicting build outputs justify a
worktree. Explain the reason; use `worktree_create` with sparse source paths for large
data repositories. Defaults are at most four linked checkouts and 1 GiB materialized
content per checkout. Explicit repository settings can adjust a real exceptional need;
do not raise limits merely to avoid retiring completed work.

Keep shared models, media, dependencies and large runtime data outside worker checkouts.
Prefer one source writer and read-only collaborators that return patches/results. Media
jobs use the existing OmniCast Studio, not a source worktree per video or session.

Finish by retaining commits/uncommitted results, then removing only the owned checkout.
Never delete a dirty checkout or unknown ignored content to make disk statistics look good.
The maintenance command is dry-run first:
`node scripts/Worktree-Maintenance.mjs --repo <repo>`.
Only lease-expired, clean, merged, inactive tool-owned checkouts with no ignored data can
be automatically retired with `--apply`. Branches and a recovery ref are retained.

All new ChatGPT workers must use `Run-Hachimi-Temporary-Fleet`. This policy does not
start workers, resume stopped fleets, or justify allocating a worktree to every worker.
