/**
 * `agentproto review init` — wire a repo into the review primitive:
 *
 *   1. REVIEW.md at the repo root, if absent: one command lane, one
 *      commented-out agent lane, a `local` binding on pre-push (+ a `ci`
 *      binding with `--ci github`). An existing REVIEW.md is never touched.
 *   2. A pre-push hook in the repo's hooks dir (`core.hooksPath` when set,
 *      else git's own — worktree-aware via `rev-parse --git-path hooks`).
 *      The gate itself lives in a managed sibling script,
 *      `agentproto-review-pre-push`; `pre-push` only CALLS it, inside a
 *      marked block. A pre-existing shell `pre-push` gets that block
 *      appended (chained — the original runs first, untouched); a non-shell
 *      one is left alone with instructions.
 *   3. `--ci github`: `.github/workflows/review.yml`, a shim that runs the
 *      `ci` binding's lanes headless on `pull_request` and verifies an
 *      exported attestation when the repo exports them.
 *   4. `--pack <ref> [--as <ns>]`: adds a `uses: [{pack: <ref>, as: <ns>}]`
 *      entry to REVIEW.md (creating it first if absent). `--as` defaults to
 *      a slug derived from `<ref>`. Idempotent by `pack` value — a second
 *      `--pack` with the same ref is a no-op regardless of `--as`. Edits the
 *      frontmatter textually, never a full YAML re-serialization, so a
 *      hand-authored REVIEW.md's comments and formatting survive.
 *
 * Idempotent: every step compares before it writes, and a second run
 * reports "already initialized — nothing to do".
 */

import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import matter from "gray-matter"

export const HOOK_SCRIPT = "agentproto-review-pre-push"
export const BLOCK_START = "# >>> agentproto review >>>"
export const BLOCK_END = "# <<< agentproto review <<<"

const git = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile("git", [...args], { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`))
      else resolvePromise(String(stdout).trim())
    })
  })

// ── templates ────────────────────────────────────────────────────────

/** The managed gate script the pre-push hook calls. Runs the `local`
 *  binding over merge-base(<remote's default branch>, HEAD)..HEAD through the
 *  daemon, superseding this checkout's own stale review of an older head.
 *  The CLI prints the trinary verdict and exits 0/1/2/3; any nonzero blocks. */
export const HOOK_BODY = `#!/bin/sh
# Managed by \`agentproto review init\` — rewritten by it; edit REVIEW.md instead.
# Pre-push review gate: runs the REVIEW.md \`local\` binding and blocks the push
# unless the verdict is pass. Bypass once: git push --no-verify
#   exit 1 = block (a lane found a problem)
#   exit 2 = incomplete (a lane or the daemon could not run — NOT a rejection)
#   exit 3 = the review could not run at all (bad REVIEW.md, git error)
remote="$1"
if ! command -v agentproto >/dev/null 2>&1; then
  echo "[review] ✗ 'agentproto' is not on PATH — the pre-push review cannot run." >&2
  echo "[review]   incomplete ≠ rejection — install the CLI and retry, or bypass once: git push --no-verify" >&2
  exit 2
fi
# Range base: merge-base with the remote's default branch (AGENTPROTO_REVIEW_BASE
# overrides the ref); fall back to REVIEW.md's target.base.
base_ref="\${AGENTPROTO_REVIEW_BASE:-}"
if [ -z "$base_ref" ] && [ -n "$remote" ]; then
  base_ref=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null)
fi
if [ -n "$base_ref" ] && base=$(git merge-base "$base_ref" HEAD 2>/dev/null); then
  exec agentproto review run --binding local --supersede --base "$base"
fi
exec agentproto review run --binding local --supersede
`

/** The block chained into `pre-push`. */
export const HOOK_BLOCK = `${BLOCK_START}
# Added by \`agentproto review init\`: the REVIEW.md pre-push review gate.
"$(dirname "$0")/${HOOK_SCRIPT}" "$@" || exit $?
${BLOCK_END}
`

type PackageManager = "pnpm" | "yarn" | "npm" | undefined

async function detectPackageManager(root: string): Promise<{ pm: PackageManager; hasTest: boolean }> {
  let hasTest = false
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }
    hasTest = typeof pkg.scripts?.["test"] === "string" && !/no test specified/.test(pkg.scripts["test"]!)
  } catch {
    return { pm: undefined, hasTest: false }
  }
  const pm: PackageManager = existsSync(join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(root, "yarn.lock"))
      ? "yarn"
      : "npm"
  return { pm, hasTest }
}

const reviewId = (root: string): string => {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
  return slug || "review"
}

export function reviewTemplate(opts: { id: string; base: string; command: string; ci: boolean }): string {
  const bindings = [
    "bindings:",
    "  local:",
    "    on: pre-push",
    "    checks: [tests]",
    ...(opts.ci ? ["  ci:", "    on: pull_request", "    checks: [tests]"] : []),
  ]
  return [
    "---",
    "kind: review",
    `id: ${opts.id}`,
    `target: {kind: git-range, base: ${opts.base}}`,
    "checks:",
    "  - id: tests",
    "    kind: command",
    `    run: ${JSON.stringify(opts.command)}`,
    "    description: The repo's own checks over the reviewed range.",
    "  # An agent reviewer lane: a child session under a harness preset reads the",
    "  # range against a rubric. Uncomment, add the rubric file, and list",
    "  # `correctness` in a binding's checks.",
    "  # - id: correctness",
    "  #   kind: agent",
    "  #   preset: <harness-preset-id>   # see `agentproto presets`",
    "  #   rubric: ./review/correctness.md",
    "  #   blockOn: high",
    ...bindings,
    "# Export attestations so CI can verify the local verdict (review_export):",
    "# verdict:",
    "#   exportDir: .reviews",
    "---",
    "",
    `# ${opts.id} review`,
    "",
    "Declared by `agentproto review init`. The `local` binding runs on every",
    "`git push` (pre-push hook); verdicts are `pass`, `block`, or `incomplete`",
    "(a lane couldn't run — not a rejection).",
    "",
  ].join("\n")
}

/** Default `as` namespace for a `--pack <ref>` with no `--as`: the ref's
 *  last path segment, an npm scope/`review-pack-` prefix stripped, and a
 *  `git+...#sha` reduced to its repo name. `@agentproto/review-pack-core`
 *  → `core`; `./packs/security-extra` → `security-extra`. */
export function defaultPackNamespace(ref: string): string {
  let name = ref
  if (name.startsWith("git+")) {
    name = name.slice("git+".length).split("#")[0]!.replace(/\.git$/, "")
  }
  name = name.split("/").filter(Boolean).pop() ?? name
  name = name.replace(/^review-pack-/, "")
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "pack"
}

/**
 * Add a `uses[]` entry for `entry.pack` to a REVIEW.md source string —
 * idempotent by `pack` value (a second call with the same ref is a no-op,
 * regardless of `as`). Edits the frontmatter TEXTUALLY (never a full
 * YAML re-serialization) so a hand-authored REVIEW.md's comments and
 * formatting survive untouched — gray-matter's `data` is only read here, to
 * decide idempotency, never written back wholesale.
 */
export function addUsesEntry(source: string, entry: { pack: string; as: string }): { source: string; changed: boolean } {
  const parsed = matter(source)
  const existingUses = Array.isArray(parsed.data["uses"]) ? (parsed.data["uses"] as Array<{ pack?: unknown }>) : []
  if (existingUses.some((u) => u && u.pack === entry.pack)) {
    return { source, changed: false }
  }
  const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) throw new Error("addUsesEntry: REVIEW.md has no frontmatter block")
  const fmText = fmMatch[1]!
  const usesItem = `  - pack: ${JSON.stringify(entry.pack)}\n    as: ${entry.as}`
  let newFmText: string
  if (/^uses:\s*$/m.test(fmText)) {
    newFmText = fmText.replace(/^uses:\s*$/m, `uses:\n${usesItem}`)
  } else {
    // No uses: key yet — declare it right after `kind: review`.
    newFmText = fmText.replace(/^(kind:\s*review\s*)$/m, `$1\nuses:\n${usesItem}`)
  }
  return { source: source.replace(fmText, newFmText), changed: true }
}

export function workflowTemplate(pm: PackageManager, opts: { allowedSigners?: boolean } = {}): string {
  const verifyFlags = opts.allowedSigners ? ' --allowed-signers .agentproto/allowed_signers' : ""
  const setup =
    pm === "pnpm"
      ? ["      - uses: pnpm/action-setup@v4", "      - run: pnpm install --frozen-lockfile"]
      : pm === "yarn"
        ? ["      - run: yarn install --frozen-lockfile"]
        : pm === "npm"
          ? ["      - run: npm ci"]
          : ["      # Install whatever the `ci` binding's command lanes need here."]
  return [
    "# Managed by `agentproto review init --ci github`.",
    "#",
    "# Runs the REVIEW.md `ci` binding's lanes headless (no daemon): command",
    "# lanes run here; agent lanes have no reviewer in CI and settle `skipped`,",
    "# making the verdict `incomplete` — surfaced as its own annotation, not a",
    "# generic failure. When REVIEW.md exports attestations (verdict.exportDir),",
    "# the local review's exported attestation for this PR's range is verified",
    "# and stands in for the agent lanes.",
    "name: review",
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      AGENTPROTO: npx -y -p @agentproto/cli agentproto",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          ref: ${{ github.event.pull_request.head.sha }}",
    "          fetch-depth: 0",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    ...setup,
    "      - name: review (ci binding, headless)",
    "        env:",
    "          PR_URL: ${{ github.event.pull_request.html_url }}",
    "        run: |",
    "          set +e",
    '          $AGENTPROTO review run --headless --binding ci --annotate github --pr "$PR_URL"',
    "          lanes=$?",
    "          # 1 = block, 3+ = the review could not run: fail as-is.",
    '          case "$lanes" in 0|2) ;; *) exit "$lanes" ;; esac',
    `          $AGENTPROTO review verify --if-exported --annotate github${verifyFlags}`,
    "          verify=$?",
    '          if [ "$verify" -eq 0 ]; then exit 0; fi',
    "          # 5 = no exportDir declared, 4 = none exported for this range.",
    '          if [ "$verify" -eq 5 ] || [ "$verify" -eq 4 ]; then',
    '            if [ "$lanes" -eq 2 ]; then',
    '              echo "::error title=review incomplete::agent lanes cannot run in CI and no verified local attestation covers this range — run \\`agentproto review run\\` locally and export it (verdict.exportDir)."',
    "              exit 2",
    "            fi",
    "            exit 0",
    "          fi",
    '          exit "$verify"',
    "",
  ].join("\n")
}

// ── steps ────────────────────────────────────────────────────────────

export type StepResult = {
  path: string
  action: "created" | "unchanged" | "updated" | "chained" | "skipped"
  note?: string
}

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** Resolve the hooks directory: `core.hooksPath` (relative to the checkout
 *  root) if set, else git's own hooks dir (worktree-aware). */
export async function hooksDir(root: string): Promise<string> {
  const configured = await git(root, ["config", "--get", "core.hooksPath"]).catch(() => "")
  if (configured) {
    const dir = isAbsolute(configured) ? configured : resolve(root, configured)
    // husky v9 points hooksPath at its generated `.husky/_` wrappers, which
    // source the user's `.husky/<hook>` — that is where a hook belongs.
    return basename(dir) === "_" && basename(dirname(dir)) === ".husky" ? dirname(dir) : dir
  }
  const p = await git(root, ["rev-parse", "--git-path", "hooks"])
  return isAbsolute(p) ? p : resolve(root, p)
}

const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:sh|bash|dash|zsh|ksh)\b/

async function installHook(dir: string): Promise<StepResult[]> {
  await mkdir(dir, { recursive: true })
  const results: StepResult[] = []
  const scriptPath = join(dir, HOOK_SCRIPT)
  const current = await readMaybe(scriptPath)
  if (current !== HOOK_BODY) {
    await writeFile(scriptPath, HOOK_BODY)
    results.push({ path: scriptPath, action: current === undefined ? "created" : "updated" })
  } else {
    results.push({ path: scriptPath, action: "unchanged" })
  }
  await chmod(scriptPath, 0o755)

  const hookPath = join(dir, "pre-push")
  const existing = await readMaybe(hookPath)
  if (existing === undefined) {
    await writeFile(hookPath, `#!/bin/sh\n${HOOK_BLOCK}`)
    await chmod(hookPath, 0o755)
    results.push({ path: hookPath, action: "created" })
  } else if (existing.includes(BLOCK_START)) {
    results.push({ path: hookPath, action: "unchanged" })
  } else {
    const firstLine = existing.split("\n", 1)[0] ?? ""
    if (firstLine.startsWith("#!") && !SHELL_SHEBANG.test(firstLine)) {
      results.push({
        path: hookPath,
        action: "skipped",
        note: `existing pre-push is not a shell script (${firstLine}) — call "${scriptPath}" from it yourself`,
      })
    } else {
      const sep = existing.endsWith("\n") ? "" : "\n"
      await writeFile(hookPath, `${existing}${sep}\n${HOOK_BLOCK}`)
      await chmod(hookPath, 0o755)
      const unreachable = /^\s*(?:exec\s|exit(?:\s|$))/m.test(existing)
      results.push({
        path: hookPath,
        action: "chained",
        note: unreachable
          ? "existing hook has a top-level `exit`/`exec` — the appended review call may never run; move it above that line"
          : "appended after the existing hook (original preserved)",
      })
    }
  }
  return results
}

async function writeIfAbsent(path: string, content: string, label: string): Promise<StepResult> {
  const existing = await readMaybe(path)
  if (existing === undefined) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return { path, action: "created" }
  }
  if (existing === content) return { path, action: "unchanged" }
  return { path, action: "unchanged", note: `${label} already exists — left as is` }
}

export interface ReviewInitResult {
  root: string
  steps: StepResult[]
  /** True when nothing was written. */
  noop: boolean
  warnings: string[]
}

export async function reviewInit(opts: { cwd: string; ci?: "github"; pack?: string; packAs?: string }): Promise<ReviewInitResult> {
  const root = await git(opts.cwd, ["rev-parse", "--show-toplevel"])
  const steps: StepResult[] = []
  const warnings: string[] = []

  const reviewPath = join(root, "REVIEW.md")
  const existingReview = await readMaybe(reviewPath)
  const isNewReview = existingReview === undefined
  let content: string
  if (isNewReview) {
    const { pm, hasTest } = await detectPackageManager(root)
    const defaultBranch = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(
      () => "origin/main",
    )
    content = reviewTemplate({
      id: reviewId(root),
      base: defaultBranch || "origin/main",
      command: pm && hasTest ? `${pm} test` : "git diff --check {base} HEAD",
      ci: opts.ci === "github",
    })
  } else {
    content = existingReview
  }

  let usesChanged = false
  if (opts.pack) {
    const as = opts.packAs ?? defaultPackNamespace(opts.pack)
    const added = addUsesEntry(content, { pack: opts.pack, as })
    content = added.source
    usesChanged = added.changed
  }

  if (isNewReview) {
    await writeFile(reviewPath, content)
    steps.push({ path: reviewPath, action: "created" })
  } else if (usesChanged) {
    await writeFile(reviewPath, content)
    steps.push({ path: reviewPath, action: "updated", note: `added uses[] entry for '${opts.pack}'` })
  } else {
    steps.push({ path: reviewPath, action: "unchanged", note: "exists — left as is" })
    if (!/^\s{2}local:/m.test(existingReview)) warnings.push("REVIEW.md declares no `local` binding — the pre-push hook runs `--binding local`")
    if (opts.ci === "github" && !/^\s{2}ci:/m.test(existingReview)) {
      warnings.push("REVIEW.md declares no `ci` binding — the GitHub workflow runs `--binding ci`")
    }
  }

  steps.push(...(await installHook(await hooksDir(root))))

  if (opts.ci === "github") {
    const { pm } = await detectPackageManager(root)
    const allowedSigners = existsSync(join(root, ".agentproto", "allowed_signers"))
    steps.push(
      await writeIfAbsent(
        join(root, ".github", "workflows", "review.yml"),
        workflowTemplate(pm, { allowedSigners }),
        "review.yml",
      ),
    )
  }

  return { root, steps, noop: steps.every((s) => s.action === "unchanged" || s.action === "skipped"), warnings }
}

export async function runReviewInit(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      cwd: { type: "string" },
      ci: { type: "string" },
      pack: { type: "string" },
      as: { type: "string" },
      json: { type: "boolean" },
    },
  })
  if (values.ci !== undefined && values.ci !== "github") {
    process.stderr.write(`agentproto review init: --ci only supports 'github'\n`)
    return 64
  }
  if (values.as !== undefined && !values.pack) {
    process.stderr.write(`agentproto review init: --as needs --pack\n`)
    return 64
  }
  const result = await reviewInit({
    cwd: resolve(values.cwd ?? process.cwd()),
    ...(values.ci === "github" ? { ci: "github" as const } : {}),
    ...(values.pack !== undefined ? { pack: values.pack } : {}),
    ...(values.as !== undefined ? { packAs: values.as } : {}),
  })
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  }
  const rel = (p: string) => (p.startsWith(result.root + "/") ? p.slice(result.root.length + 1) : p)
  for (const s of result.steps) {
    process.stdout.write(`  ${s.action.padEnd(9)} ${rel(s.path)}${s.note ? ` — ${s.note}` : ""}\n`)
  }
  for (const w of result.warnings) process.stdout.write(`  warning   ${w}\n`)
  process.stdout.write(
    result.noop
      ? "review init: already initialized — nothing to do.\n"
      : "review init: done. Edit REVIEW.md to declare your checks; `git push` now runs the `local` binding.\n",
  )
  return 0
}
