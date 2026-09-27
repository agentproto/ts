/**
 * `agentproto review <run | verify | init>` — the CLI surface of the review
 * primitive (`@agentproto/review` + the daemon's `review_*` tools).
 *
 *   run     run a REVIEW.md binding and exit on its verdict. By default it
 *           rides the daemon's `/mcp` endpoint (`review_run` wait:false, then
 *           `review_status` polls — a review can outlast one HTTP request),
 *           so agent lanes get reviewer sessions and the verdict lands in the
 *           daemon's ledger. `--headless` runs the same engine IN-PROCESS
 *           with no daemon and no reviewer host: command lanes run, agent
 *           lanes settle `skipped` ⇒ verdict `incomplete` — the CI mode.
 *   verify  check an exported attestation (`review_export` /
 *           `verdict.exportDir`) against the manifest + range THIS checkout
 *           sees (`verifyAttestation`).
 *   init    scaffold REVIEW.md + a pre-push hook (+ a GitHub Actions shim),
 *           see ./review-init.ts.
 *
 * Exit codes are the trinary verdict, so hooks and CI can tell a rejection
 * from a review that never reached one:
 *   0 pass · 1 block · 2 incomplete (incl. no daemon reachable) · 3 the
 *   review could not run (bad REVIEW.md, git error) · 64 usage.
 */

import { readdir, readFile, mkdtemp } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { parseArgs } from "node:util"
import {
  parseReviewManifest,
  verifyAttestation,
  type Attestation,
  type ReviewPrRef,
} from "@agentproto/review"
import { mcpToolCall, withDaemon } from "./workflow.js"
import { runReviewInit } from "./review-init.js"

const USAGE = `agentproto review — run, verify and scaffold REVIEW.md reviews

Usage:
  agentproto review run [--binding <name>] [--cwd <dir>] [--manifest <path>]
                        [--base <ref>] [--head <ref>] [--nocache] [--supersede]
                        [--pr <github-pr-url>] [--headless] [--annotate github]
                        [--json]
  agentproto review verify [<attestation.json | dir>] [--cwd <dir>]
                        [--manifest <path>] [--base <ref>] [--head <ref>]
                        [--binding <name>] [--verdict pass|block|incomplete|any]
                        [--if-exported] [--annotate github] [--json]
  agentproto review init [--cwd <dir>] [--ci github] [--json]
  agentproto review --help

run:
  Runs the binding over merge-base(<target.base>, HEAD)..HEAD (or --base/
  --head) and exits on the verdict: 0 pass, 1 block, 2 incomplete, 3 could
  not run (bad REVIEW.md, range). An unreachable daemon is 'incomplete'
  (2), never a pass. Goes through the local daemon (agent lanes spawn
  reviewer sessions; the attestation lands in the daemon ledger). --supersede cancels
  the daemon's in-flight review of an OLDER head of the same range base —
  what a pre-push gate wants. --headless runs in-process without a daemon:
  command lanes only, agent lanes settle 'skipped' (verdict incomplete).
  --annotate github also prints GitHub Actions ::error/::warning lines.

verify:
  Verifies an exported attestation against this checkout: manifest sha of
  REVIEW.md, the range (default merge-base(<target.base>, HEAD)..HEAD),
  repo remote, and the verdict (default pass). With a directory (default:
  the manifest's verdict.exportDir) it picks the attestation whose head is
  the range head — or HEAD^ when HEAD only adds files under that directory
  (the "commit the export" convention). Exit 0 verified, 1 invalid, 4 no
  attestation for the range, 5 (--if-exported) no exportDir declared.

init:
  Scaffolds REVIEW.md (if absent) and installs a pre-push hook running
  \`agentproto review run --binding local --supersede\` — chained after an
  existing hook, never overwriting it; honours core.hooksPath. --ci github
  also writes .github/workflows/review.yml. Idempotent.
`

export const EXIT = { pass: 0, block: 1, incomplete: 2, error: 3, usage: 64 } as const

const git = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`))
      else resolvePromise(String(stdout).trim())
    })
  })

export async function runReview(args: readonly string[]): Promise<number> {
  const sub = args[0]
  if (sub === undefined || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE)
    return 0
  }
  const rest = args.slice(1)
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    switch (sub) {
      case "run":
        return await runRun(rest)
      case "verify":
        return await runVerify(rest)
      case "init":
        return await runReviewInit(rest)
      default:
        process.stderr.write(`agentproto review: unknown subcommand "${sub}"\n  Known: run | verify | init\n`)
        return EXIT.usage
    }
  } catch (err) {
    if (err instanceof TypeError && /option|argument/i.test(err.message)) {
      process.stderr.write(`agentproto review ${sub}: ${err.message}\n`)
      return EXIT.usage
    }
    process.stderr.write(`agentproto review ${sub}: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.error
  }
}

// ── rendering ────────────────────────────────────────────────────────

/** The part of a `review_run`/`review_status` view the renderer reads. */
export interface ReviewRunView {
  runId?: string
  status: string
  error?: string
  cached?: boolean
  supersededBy?: string
  attestation?: Attestation
}

const LANE_MARK: Record<string, string> = { pass: "✓", fail: "✗", timeout: "⏱", skipped: "–" }
const short = (sha: string) => sha.slice(0, 10)
const secs = (ms?: number) => (ms === undefined ? "" : ` ${(ms / 1000).toFixed(1)}s`)
const ghEscape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const ghProp = (s: string) => ghEscape(s).replace(/:/g, "%3A").replace(/,/g, "%2C")

/**
 * Map a finished run view onto an exit code + human lines — the same trinary
 * messaging the studio pre-push gate uses: `block` names the failing lanes,
 * `incomplete` names the lanes that never produced a result and says so
 * plainly (incomplete ≠ rejection). `annotate: "github"` adds workflow
 * commands so Actions shows block and incomplete as DISTINCT annotations.
 */
export function renderVerdict(view: ReviewRunView, opts: { annotate?: "github" } = {}): { code: number; lines: string[] } {
  const out: string[] = []
  const gh = opts.annotate === "github"
  if (!view.attestation) {
    if (view.status === "cancelled") {
      out.push(
        `[review] – run ${view.runId ?? ""} was cancelled${view.supersededBy ? ` (superseded by ${view.supersededBy})` : ""} — no verdict recorded.`,
      )
    } else {
      out.push(
        `[review] ✗ the review could not run: ${view.error || `status ${view.status}, no attestation`}.`,
        `[review]   This is NOT a verdict on the code — fix the above (REVIEW.md? range? daemon?) and re-run.`,
      )
    }
    if (gh) out.push(`::error title=review could not run::${ghEscape(view.error ?? `status ${view.status}`)}`)
    return { code: view.status === "cancelled" ? EXIT.incomplete : EXIT.error, lines: out }
  }
  const att = view.attestation
  const cached = view.cached ? " (cached — ledger hit)" : ""
  out.push(
    `[review] ${att.reviewId}/${att.binding} ${short(att.target.baseSha)}..${short(att.target.headSha)} → ${att.verdict}${cached}`,
  )
  for (const l of att.lanes) {
    const tag = l.blocking ? "" : " (advisory)"
    const [errHead] = String(l.error ?? "").split("\n")
    const extra = l.error ? ` — ${errHead}` : l.summary ? ` — ${l.summary}` : ""
    const who = l.model ? ` [${l.preset ?? "?"}/${l.model}]` : l.preset ? ` [${l.preset}]` : ""
    out.push(`[review]   ${LANE_MARK[l.status] ?? "?"} ${l.id}${tag} ${l.status}${secs(l.durationMs)}${who}${extra}`)
    for (const f of l.findings) {
      const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""
      out.push(`[review]       [${f.severity}]${where} ${f.title}`)
      const detail = String(f.detail ?? "")
        .split("\n")
        .filter((s) => s.trim())
        .slice(l.kind === "command" ? -15 : 0, l.kind === "command" ? undefined : 4)
      for (const d of detail) out.push(`[review]         ${d}`)
      if (gh && l.blocking && l.status === "fail") {
        const loc = f.file ? ` file=${ghProp(f.file)}${f.line ? `,line=${f.line}` : ""},` : " "
        out.push(`::error${loc}title=${ghProp(`review ${l.id}: ${f.title}`)}::${ghEscape(f.detail || f.title)}`)
      }
    }
    if (l.sessionId) out.push(`[review]       replay: agentproto sessions export ${l.sessionId}`)
  }
  const advisoryRed = att.lanes.filter((l) => !l.blocking && l.status !== "pass")
  if (advisoryRed.length) {
    out.push(`[review] ⚠ advisory lane(s) not green: ${advisoryRed.map((l) => `${l.id} ${l.status}`).join(", ")} — non-blocking.`)
  }
  if (att.verdict === "pass") {
    out.push(`[review] ✓ passed${cached}.`)
    return { code: EXIT.pass, lines: out }
  }
  if (att.verdict === "block") {
    const red = att.lanes.filter((l) => l.blocking && l.status === "fail")
    out.push(`[review] ✗ blocked by: ${red.map((l) => l.id).join(", ")}.`)
    if (gh) out.push(`::error title=review blocked::${ghEscape(`blocking lane(s) failed: ${red.map((l) => l.id).join(", ")}`)}`)
    return { code: EXIT.block, lines: out }
  }
  const missing = att.lanes.filter((l) => l.blocking && l.status !== "pass" && l.status !== "fail")
  out.push(`[review] ✗ review INCOMPLETE — no verdict on the code:`)
  for (const l of missing) {
    out.push(
      `[review]     ${l.id} ${l.status === "timeout" ? `timed out${secs(l.durationMs)}` : "was skipped"}${l.error ? ` (${l.error.split("\n")[0]})` : ""}`,
    )
  }
  out.push(`[review]   incomplete ≠ rejection — daemon/lane failed, fix and retry (or raise the lane's timeoutMs in REVIEW.md).`)
  if (gh) {
    out.push(
      `::warning title=review incomplete::${ghEscape(
        `no verdict — ${missing.map((l) => `${l.id} ${l.status}${l.error ? ` (${l.error.split("\n")[0]})` : ""}`).join("; ")}. ` +
          `Incomplete is not a rejection: agent lanes need a reviewer (run the review locally and export the attestation).`,
      )}`,
    )
  }
  return { code: EXIT.incomplete, lines: out }
}

// ── run ──────────────────────────────────────────────────────────────

/** `https://github.com/o/r/pull/7` → the attestation's `pr` shape. */
export function prRefFromUrl(url: string): ReviewPrRef | undefined {
  const m = url.trim().match(/^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/)
  if (!m) return undefined
  return { provider: "github", repo: m[1]!, number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` }
}

const POLL_MS = 1_500

async function runRun(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      binding: { type: "string" },
      cwd: { type: "string" },
      manifest: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      nocache: { type: "boolean" },
      supersede: { type: "boolean" },
      pr: { type: "string" },
      headless: { type: "boolean" },
      annotate: { type: "string" },
      json: { type: "boolean" },
    },
  })
  if (values.annotate !== undefined && values.annotate !== "github") {
    process.stderr.write(`agentproto review run: --annotate only supports 'github'\n`)
    return EXIT.usage
  }
  let pr: ReviewPrRef | undefined
  if (values.pr) {
    pr = prRefFromUrl(values.pr)
    if (!pr) {
      process.stderr.write(`agentproto review run: --pr must be https://github.com/<owner>/<repo>/pull/<n>\n`)
      return EXIT.usage
    }
  }
  const cwd = resolve(values.cwd ?? process.cwd())
  const requester = process.env["AGENTPROTO_SESSION_ID"]
  const input = {
    cwd,
    ...(values.manifest !== undefined ? { manifestPath: values.manifest } : {}),
    ...(values.binding !== undefined ? { binding: values.binding } : {}),
    ...(values.base !== undefined ? { base: values.base } : {}),
    ...(values.head !== undefined ? { head: values.head } : {}),
    ...(values.nocache ? { nocache: true } : {}),
    ...(values.supersede ? { supersede: true } : {}),
    ...(pr ? { pr } : {}),
    ...(requester ? { requesterSessionId: requester } : {}),
  }

  let view: ReviewRunView
  if (values.headless) {
    view = await runHeadless(input)
  } else {
    const viaDaemon = await runViaDaemon(input)
    if ("daemonDown" in viaDaemon) {
      const lines = daemonDownLines(viaDaemon.daemonDown)
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ status: "daemon_unreachable", error: viaDaemon.daemonDown, exitCode: EXIT.incomplete })}\n`)
      } else {
        process.stderr.write(`${lines.join("\n")}\n`)
        if (values.annotate === "github") {
          process.stderr.write(`::warning title=review incomplete::${ghEscape(`no daemon reachable — ${viaDaemon.daemonDown}`)}\n`)
        }
      }
      return EXIT.incomplete
    }
    view = viaDaemon
  }
  const rendered = renderVerdict(view, values.annotate === "github" ? { annotate: "github" } : {})
  if (values.json) process.stdout.write(`${JSON.stringify({ ...view, exitCode: rendered.code })}\n`)
  else process.stderr.write(`${rendered.lines.join("\n")}\n`)
  return rendered.code
}

type RunInput = {
  cwd: string
  manifestPath?: string
  binding?: string
  base?: string
  head?: string
  nocache?: boolean
  supersede?: boolean
  pr?: ReviewPrRef
  requesterSessionId?: string
}

/** In-process engine, no daemon: command lanes run, agent lanes are
 *  `skipped` (no reviewer host). The ledger is a throwaway temp dir — a
 *  headless verdict is for this process's exit code, not for reuse. */
async function runHeadless(input: RunInput): Promise<ReviewRunView> {
  const { createReviewRunner, createReviewLedger } = await import("@agentproto/runtime")
  const root = await mkdtemp(join(tmpdir(), "agentproto-review-headless-"))
  const runner = createReviewRunner({
    ledger: createReviewLedger({ root }),
    daemonId: `agentproto-cli-headless@${hostname()}`,
  })
  const run = runner.start(input)
  const onSig = () => runner.cancel(run.runId)
  process.once("SIGINT", onSig)
  process.once("SIGTERM", onSig)
  try {
    const done = (await runner.wait(run.runId)) ?? run
    return done as ReviewRunView
  } finally {
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }
}

/** The daemon was not found or did not answer: nothing was reviewed. */
export function daemonDownLines(detail: string): string[] {
  return [
    `[review] ✗ review INCOMPLETE — the daemon is not reachable (${detail}), so nothing was reviewed.`,
    `[review]   incomplete ≠ rejection — daemon/lane failed, fix and retry (\`agentproto daemon start\`).`,
  ]
}

async function runViaDaemon(input: RunInput): Promise<ReviewRunView | { daemonDown: string }> {
  const d = await withDaemon("review run")
  if (!d.ok) return { daemonDown: "no running daemon found" }
  const { cwd, manifestPath, ...rest } = input
  let started: { runId: string; status: string }
  try {
    started = (await mcpToolCall(d.endpoint, "review_run", {
      cwd,
      ...(manifestPath !== undefined ? { manifestPath } : {}),
      ...rest,
      wait: false,
    })) as { runId: string; status: string }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A tool-level error (bad input) is the daemon answering: surface it as
    // a could-not-run; a transport failure is the daemon being down.
    if (/^(HTTP \d|daemon replied|\{)/.test(msg)) return { status: "failed", error: msg }
    return { daemonDown: `${d.endpoint.url}: ${msg}` }
  }
  let cancelled = false
  const onSig = () => {
    if (cancelled) return
    cancelled = true
    void mcpToolCall(d.endpoint, "review_cancel", { runId: started.runId }).catch(() => undefined)
  }
  process.once("SIGINT", onSig)
  process.once("SIGTERM", onSig)
  try {
    for (;;) {
      const view = (await mcpToolCall(d.endpoint, "review_status", { runId: started.runId })) as ReviewRunView
      if (view.status !== "running") return view
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  } finally {
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }
}

// ── verify ───────────────────────────────────────────────────────────

export const VERIFY_EXIT = { ok: 0, invalid: 1, notFound: 4, notExported: 5 } as const

async function readAttestation(path: string): Promise<Attestation | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Attestation
    return parsed && typeof parsed === "object" && parsed.target ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Attestations in `dir` whose target is exactly `baseSha..headSha`. */
async function findInDir(dir: string, baseSha: string, headSha: string, binding?: string): Promise<Array<{ path: string; att: Attestation }>> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: Array<{ path: string; att: Attestation }> = []
  for (const n of names) {
    const path = join(dir, n)
    const att = await readAttestation(path)
    if (!att) continue
    if (att.target.baseSha !== baseSha || att.target.headSha !== headSha) continue
    if (binding !== undefined && att.binding !== binding) continue
    out.push({ path, att })
  }
  return out.sort((a, b) => b.att.createdAt.localeCompare(a.att.createdAt))
}

/** True when `sha`'s commit only touches paths under `relDir`. */
async function onlyTouches(root: string, sha: string, relDir: string): Promise<boolean> {
  const files = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).catch(() => "")).split("\n").filter(Boolean)
  const prefix = relDir.replace(/^\.\//, "").replace(/\/+$/, "") + "/"
  return files.length > 0 && files.every((f) => f.startsWith(prefix))
}

const normalizeRemote = (url: string): string => {
  let s = url.trim()
  const scp = s.match(/^[^@/]+@([^:/]+):(.+)$/)
  if (scp) s = `${scp[1]}/${scp[2]}`
  else s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "")
  return s.replace(/\.git$/, "").replace(/\/+$/, "")
}

async function runVerify(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      manifest: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      binding: { type: "string" },
      verdict: { type: "string" },
      "if-exported": { type: "boolean" },
      annotate: { type: "string" },
      json: { type: "boolean" },
    },
  })
  const gh = values.annotate === "github"
  const cwd = resolve(values.cwd ?? process.cwd())
  const root = await git(cwd, ["rev-parse", "--show-toplevel"])
  const manifestPath = values.manifest ? resolve(cwd, values.manifest) : join(root, "REVIEW.md")
  const source = await readFile(manifestPath, "utf8")
  const manifest = parseReviewManifest(source)
  const wantVerdict = values.verdict ?? "pass"
  if (!["pass", "block", "incomplete", "any"].includes(wantVerdict)) {
    process.stderr.write(`agentproto review verify: --verdict must be pass|block|incomplete|any\n`)
    return EXIT.usage
  }
  const headSha = await git(root, ["rev-parse", "--verify", `${values.head ?? "HEAD"}^{commit}`])
  const baseSha = values.base
    ? await git(root, ["rev-parse", "--verify", `${values.base}^{commit}`])
    : await git(root, ["merge-base", manifest.target.base, headSha])
  const remoteUrl = await git(root, ["remote", "get-url", "origin"]).catch(() => undefined)
  const repoRemote = remoteUrl ? normalizeRemote(remoteUrl) : `local:${root}`

  const report = (code: number, payload: Record<string, unknown>, lines: string[]): number => {
    if (values.json) process.stdout.write(`${JSON.stringify({ ...payload, exitCode: code })}\n`)
    else process.stderr.write(`${lines.join("\n")}\n`)
    return code
  }

  let target = positionals[0] ? resolve(cwd, positionals[0]) : undefined
  if (!target) {
    if (!manifest.verdict.exportDir) {
      const msg = "REVIEW.md declares no verdict.exportDir — nothing exported to verify"
      if (values["if-exported"]) return report(VERIFY_EXIT.notExported, { ok: false, reason: "not_exported" }, [`[review] – ${msg}.`])
      process.stderr.write(`agentproto review verify: ${msg}; pass a path\n`)
      return EXIT.usage
    }
    target = isAbsolute(manifest.verdict.exportDir) ? manifest.verdict.exportDir : resolve(root, manifest.verdict.exportDir)
  }

  let found: { path: string; att: Attestation } | undefined
  let checkedHead = headSha
  if (target.endsWith(".json")) {
    const att = await readAttestation(target)
    if (att) found = { path: target, att }
  } else {
    found = (await findInDir(target, baseSha, headSha, values.binding))[0]
    // "Commit the export": HEAD only adds the attestation file(s), so the
    // attested head is HEAD^.
    const rel = target.startsWith(root + "/") ? target.slice(root.length + 1) : undefined
    if (!found && !values.head && rel && (await onlyTouches(root, headSha, rel))) {
      const parent = await git(root, ["rev-parse", `${headSha}^`]).catch(() => undefined)
      if (parent) {
        found = (await findInDir(target, baseSha, parent, values.binding))[0]
        if (found) checkedHead = parent
      }
    }
  }
  if (!found) {
    const msg = `no exported attestation for ${short(baseSha)}..${short(headSha)} in ${target}`
    return report(VERIFY_EXIT.notFound, { ok: false, reason: "not_found", baseSha, headSha }, [
      `[review] ✗ ${msg}.`,
      `[review]   Run the review locally (agentproto review run) and export it (review_export) into ${manifest.verdict.exportDir ?? target}.`,
      ...(gh ? [`::error title=review attestation missing::${ghEscape(msg)}`] : []),
    ])
  }
  const result = verifyAttestation(found.att, {
    manifestSource: source,
    baseSha,
    headSha: checkedHead,
    repoRemote,
    ...(values.binding !== undefined ? { binding: values.binding } : {}),
    ...(wantVerdict !== "any" ? { verdict: wantVerdict as Attestation["verdict"] } : {}),
  })
  const payload = { ok: result.ok, problems: result.problems, path: found.path, runId: found.att.runId, verdict: found.att.verdict }
  if (result.ok) {
    return report(VERIFY_EXIT.ok, payload, [
      `[review] ✓ attestation verified: ${found.att.reviewId}/${found.att.binding} ${short(baseSha)}..${short(checkedHead)} → ${found.att.verdict} (${found.path})`,
    ])
  }
  return report(VERIFY_EXIT.invalid, payload, [
    `[review] ✗ attestation ${found.path} does NOT verify:`,
    ...result.problems.map((p) => `[review]     ${p}`),
    ...(gh ? [`::error title=review attestation invalid::${ghEscape(result.problems.join("; "))}`] : []),
  ])
}
