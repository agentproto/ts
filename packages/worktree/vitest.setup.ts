// Package-wide: turn off git's background auto-maintenance for every git
// process these tests spawn (fixture helpers, the code under test, and
// `receive-pack` on bare origins alike). Since git 2.4x, `git commit` /
// `merge` / `fetch` / `receive-pack` kick off a detached
// `git maintenance run --auto --detach` that outlives the command and takes
// `objects/maintenance.lock` (and may gc/pack) inside the fixture's `.git`.
// When that lands while an afterEach `rm(repo, { recursive: true })` walks
// the tree, cleanup fails with `ENOTEMPTY: rmdir '<tmp>/.git'` even though
// the test passed (CI run 36410781204). Env-level `GIT_CONFIG_*` covers every
// fixture repo at once instead of each `makeRepo()` having to remember a
// per-repo `git config`.
const overrides: Array<[string, string]> = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
]

// Append to any `GIT_CONFIG_*` pairs the environment already carries; skip
// pairs already present so a reused worker doesn't stack duplicates.
let count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
const present = new Set(
  Array.from({ length: count }, (_, i) => process.env[`GIT_CONFIG_KEY_${i}`]),
)
for (const [key, value] of overrides) {
  if (present.has(key)) continue
  process.env[`GIT_CONFIG_KEY_${count}`] = key
  process.env[`GIT_CONFIG_VALUE_${count}`] = value
  count++
}
process.env.GIT_CONFIG_COUNT = String(count)
