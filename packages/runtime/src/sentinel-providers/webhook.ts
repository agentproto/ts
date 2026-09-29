/**
 * `webhook` — push-only sentinel provider over GitHub repo webhooks (AIP-60
 * §5). Watching = one `POST /repos/o/r/hooks` pointing at the daemon's public
 * URL; GitHub then calls `POST /inbound/sentinel-<hookKey>` and
 * `parseInbound` verifies + normalizes the delivery.
 *
 * One hook per repo, shared by every sentinel on that repo (refcounted in
 * {@link WebhookHookStore}): subjects `github:o/r*` and `github:o/r#N` both map
 * to the repo's single hook and the runtime's matcher filters per sentinel.
 * The hook is deleted when the last sentinel cancels.
 *
 * Secrets: the HMAC secret is generated here, persisted 0600 in the hook store
 * (never in the `SentinelHandle`, never in argv — the hook body goes to `gh`
 * on stdin — never logged). The handle carries only `{repo, hookKey, holder}`.
 *
 * No silent fallback: with no public URL, or a `gh` token that can't manage
 * hooks, `readiness()` reports why and `create` throws a
 * {@link WebhookSetupError} naming the fix. `attach` (daemon boot) is the one
 * tolerant path — see its doc.
 *
 * Deduplication is the runtime's persisted per-sentinel `seen` window, keyed on
 * the event id `evt_<X-GitHub-Delivery>`, so a GitHub redelivery is a no-op and
 * a delivery that failed mid-way (5xx) is still retryable.
 */

import { randomBytes } from "node:crypto"
import { execFile } from "node:child_process"

import { verifyInboundSignature } from "../inbound-adapters.js"
import { PrLookupError, type GhRunner } from "../review-pr.js"
import { GITHUB_DEFAULT_PR_TYPES, normalizeGithubEvent } from "../sentinel-github-normalize.js"
import { resolveSentinelPublicUrl, type SentinelPublicUrl } from "../sentinel-public-url.js"
import { getSharedWebhookHookStore, type WebhookHookRecord, type WebhookHookStore } from "./webhook-hooks.js"
import type {
  DeliveryPreference,
  SentinelEvent,
  SentinelHandle,
  SentinelProviderHandle,
  SentinelProviderReadiness,
  SentinelSpec,
} from "./types.js"

export const WEBHOOK_SLUG = "webhook"

/** Route prefix: GitHub calls `/inbound/${WEBHOOK_ROUTE_PREFIX}<hookKey>`. */
export const WEBHOOK_ROUTE_PREFIX = "sentinel-"

const HOOK_EVENTS = ["pull_request", "pull_request_review", "check_suite", "workflow_run", "issue_comment"] as const
const ACCEPTED_SCOPES: readonly string[] = ["admin:repo_hook", "write:repo_hook", "repo"]

/** `gh` runner that can also feed stdin — the hook body carries the HMAC
 *  secret and must never appear in argv. A plain `GhRunner` (one arg) stays
 *  assignable. */
export type WebhookGhRunner = (args: readonly string[], opts?: { input?: string }) => Promise<string>

export const execGhWebhook: WebhookGhRunner = (args, opts) =>
  new Promise((resolvePromise, reject) => {
    const child = execFile("gh", [...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new PrLookupError("gh_unavailable", "the GitHub CLI (`gh`) is not installed or not on the daemon's PATH"))
          return
        }
        reject(new PrLookupError("gh_failed", `gh ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`))
        return
      }
      resolvePromise(stdout)
    })
    if (opts?.input !== undefined) child.stdin?.end(opts.input)
  })

/** Provider setup problem with an actionable message (no public URL, token
 *  scope, no repo admin). Surfaces as `provider_create_failed`. */
export class WebhookSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookSetupError"
  }
}

// ── Subjects ────────────────────────────────────────────────────────────

const SUBJECT_RE = /^github:([^/#*\s]+\/[^/#*\s]+)(?:#(\d+)|(\*))?$/

function repoOfSubject(subject: string): string | undefined {
  return SUBJECT_RE.exec(subject)?.[1]
}

function repoOfSpec(spec: SentinelSpec): string {
  const repos = new Set<string>()
  for (const clause of spec.match) {
    const repo = repoOfSubject(clause.subject)
    if (!repo) {
      throw new Error(
        `${WEBHOOK_SLUG}: subject "${clause.subject}" is not supported — use "github:owner/repo", ` +
          `"github:owner/repo*", or "github:owner/repo#N"`,
      )
    }
    repos.add(repo)
  }
  if (repos.size !== 1) {
    throw new Error(`${WEBHOOK_SLUG}: all match clauses must be on one repository (got ${[...repos].join(", ") || "none"})`)
  }
  return [...repos][0]!
}

// ── Small helpers ───────────────────────────────────────────────────────

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isNotFound = (err: unknown): boolean => /HTTP 404|Not Found/i.test(errMsg(err))
const isForbidden = (err: unknown): boolean =>
  /HTTP (401|403)|Resource not accessible|admin rights|Must have admin/i.test(errMsg(err))

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

function callbackUrl(origin: string, key: string): string {
  return `${origin}/inbound/${WEBHOOK_ROUTE_PREFIX}${key}`
}

function hookBody(url: string, secret: string, opts: { includeName: boolean }): string {
  return JSON.stringify({
    ...(opts.includeName ? { name: "web" } : {}),
    active: true,
    events: HOOK_EVENTS,
    config: { url, content_type: "json", secret, insecure_ssl: "0" },
  })
}

function handleState(handle: SentinelHandle): { repo?: string; hookKey?: string; holder?: string } {
  const s = handle.state ?? {}
  return {
    ...(typeof s.repo === "string" ? { repo: s.repo } : {}),
    ...(typeof s.hookKey === "string" ? { hookKey: s.hookKey } : {}),
    ...(typeof s.holder === "string" ? { holder: s.holder } : {}),
  }
}

const NO_PUBLIC_URL =
  "the webhook provider needs a public URL for GitHub to call: set AGENTPROTO_PUBLIC_URL to the daemon's " +
  "public https origin, or start a named tunnel (`cloudflare-named`, stable hostname) forwarding to the daemon port"

// ── Provider ────────────────────────────────────────────────────────────

export interface WebhookProviderOptions {
  /** Injectable for tests — defaults to the real `gh` binary. */
  gh?: WebhookGhRunner | GhRunner
  /** Injectable public URL source — defaults to the daemon-wired resolver. */
  publicUrl?: () => SentinelPublicUrl | undefined
  /** Injectable hook store — defaults to the process-wide persisted store. */
  hooks?: WebhookHookStore
  now?: () => Date
}

export function webhookSentinelProvider(opts: WebhookProviderOptions = {}): SentinelProviderHandle {
  const gh = (opts.gh ?? execGhWebhook) as WebhookGhRunner
  const publicUrl = opts.publicUrl ?? resolveSentinelPublicUrl
  const now = opts.now ?? (() => new Date())
  const hooks = (): WebhookHookStore => opts.hooks ?? getSharedWebhookHookStore()

  async function ghCreateHook(repo: string, url: string, secret: string): Promise<number> {
    let out: string
    try {
      out = await gh(
        ["api", "-X", "POST", "-H", "Accept: application/vnd.github+json", "-H", "Content-Type: application/json", `repos/${repo}/hooks`, "--input", "-"],
        { input: hookBody(url, secret, { includeName: true }) },
      )
    } catch (err) {
      if (isForbidden(err) || isNotFound(err)) {
        throw new WebhookSetupError(
          `cannot create a webhook on ${repo}: ${isNotFound(err) ? "repository not found, or the gh token has no admin access to it" : "the gh token lacks permission"}. ` +
            "It needs admin rights on the repo and the admin:repo_hook scope (`gh auth refresh -s admin:repo_hook`).",
        )
      }
      throw err
    }
    const id = (JSON.parse(out) as { id?: unknown }).id
    if (typeof id !== "number") throw new Error(`${WEBHOOK_SLUG}: GitHub did not return a hook id for ${repo}`)
    return id
  }

  async function ghPatchHook(repo: string, hookId: number, url: string, secret: string): Promise<void> {
    await gh(
      ["api", "-X", "PATCH", "-H", "Accept: application/vnd.github+json", "-H", "Content-Type: application/json", `repos/${repo}/hooks/${hookId}`, "--input", "-"],
      { input: hookBody(url, secret, { includeName: false }) },
    )
  }

  /** Get-or-create the repo's hook and point it at `origin`. Caller holds the
   *  repo lock. `key` pins the route key when re-creating for an existing
   *  sentinel handle. */
  async function ensureHook(
    repo: string,
    origin: string,
    o: { verify: "strict" | "tolerant"; key?: string },
  ): Promise<WebhookHookRecord> {
    const store = hooks()
    let rec = store.getByRepo(repo)

    if (rec) {
      let deleted = false
      try {
        await gh(["api", "-H", "Accept: application/vnd.github+json", `repos/${rec.repo}/hooks/${rec.hookId}`])
      } catch (err) {
        // `tolerant` (daemon-boot attach): an unreachable/unauthorised GitHub
        // must not fail the re-attach — only a definite 404 triggers recreate.
        if (isNotFound(err)) deleted = true
        else if (o.verify === "strict") throw err
      }
      if (deleted) {
        // Deleted on GitHub behind our back — recreate, keeping the key and
        // holders so existing sentinels stay valid.
        const secret = randomBytes(32).toString("hex")
        const hookId = await ghCreateHook(repo, callbackUrl(origin, rec.key), secret)
        rec = { ...rec, hookId, secret, origin }
        store.put(rec)
        return rec
      }
    }

    if (!rec) {
      const key = o.key ?? randomBytes(16).toString("hex")
      const secret = randomBytes(32).toString("hex")
      const hookId = await ghCreateHook(repo, callbackUrl(origin, key), secret)
      rec = { key, repo, hookId, secret, origin, holders: [], createdAt: now().toISOString() }
      store.put(rec)
      return rec
    }

    if (rec.origin !== origin) {
      try {
        await ghPatchHook(repo, rec.hookId, callbackUrl(origin, rec.key), rec.secret)
      } catch (err) {
        if (!isNotFound(err)) throw err
        const secret = randomBytes(32).toString("hex")
        const hookId = await ghCreateHook(repo, callbackUrl(origin, rec.key), secret)
        rec = { ...rec, hookId, secret, origin }
        store.put(rec)
        return rec
      }
      rec = { ...rec, origin }
      store.put(rec)
    }
    return rec
  }

  function handleFor(rec: WebhookHookRecord, holder: string): SentinelHandle {
    return {
      provider: WEBHOOK_SLUG,
      remoteId: String(rec.hookId),
      state: { repo: rec.repo, hookKey: rec.key, holder },
    }
  }

  return {
    slug: WEBHOOK_SLUG,
    name: "GitHub Webhook",
    version: "0.1.0",
    description:
      "Push-based PR/repo watcher over a GitHub repository webhook — near-real-time, one shared hook per repo. " +
      "Needs a public daemon URL (named tunnel or AGENTPROTO_PUBLIC_URL) and a gh token with admin:repo_hook.",
    requiresSetup: false,
    capabilities: {
      subjects: ["github"],
      push: true,
      poll: false,
      durable: false,
      needsPublicUrl: true,
      // Uses the host's ambient `gh` auth, like local-gh.
      requiresAuth: false,
      typicalLatencyMs: 2_000,
    },

    async check(): Promise<boolean> {
      try {
        await gh(["auth", "status"])
        return true
      } catch {
        return false
      }
    },

    async readiness(): Promise<SentinelProviderReadiness> {
      if (!publicUrl()) return { ready: false, reason: NO_PUBLIC_URL }
      let out: string
      try {
        out = await gh(["api", "-i", "user"])
      } catch (err) {
        return {
          ready: false,
          reason:
            err instanceof PrLookupError && err.code === "gh_unavailable"
              ? "the GitHub CLI (`gh`) is not installed or not on the daemon's PATH"
              : `gh is not authenticated or GitHub is unreachable (${errMsg(err).slice(0, 200)}) — run \`gh auth login\``,
        }
      }
      const line = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(out)
      // No scopes header = fine-grained token or app auth: scopes can't be
      // checked up front, so let `create` surface a 403 if it lacks access.
      if (!line) return { ready: true }
      const scopes = line[1]!.split(",").map(s => s.trim()).filter(Boolean)
      if (scopes.some(s => ACCEPTED_SCOPES.includes(s))) return { ready: true }
      return {
        ready: false,
        reason:
          `the gh token lacks the admin:repo_hook scope (has: ${scopes.join(", ") || "none"}) — ` +
          "run `gh auth refresh -s admin:repo_hook`",
      }
    },

    async create(spec: SentinelSpec, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      const repo = repoOfSpec(spec)
      const pub = publicUrl()
      if (!pub) throw new WebhookSetupError(NO_PUBLIC_URL)
      const holder = `wh_${randomBytes(8).toString("hex")}`
      const store = hooks()
      return store.withRepoLock(repo, async () => {
        const rec = await ensureHook(repo, pub.url, { verify: "strict" })
        const withHolder = { ...rec, holders: [...new Set([...rec.holders, holder])] }
        store.put(withHolder)
        return handleFor(withHolder, holder)
      })
    },

    /**
     * Daemon-boot re-attach: re-points the hook when the public URL changed
     * since it was last set, re-creates it if the record is gone, and
     * re-registers this sentinel as a holder. Deliberately TOLERANT of "no
     * public URL yet" (returns the handle unchanged, no throw): a named
     * tunnel autostarts after the sentinel runtime boots, and throwing here
     * would mark every webhook sentinel `error` before the tunnel is up.
     * Known limitation: nothing re-points later on its own — restart the
     * daemon (or re-create the sentinel) once the URL is available.
     */
    async attach(handle: SentinelHandle, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      const { repo, hookKey, holder } = handleState(handle)
      if (!repo || !hookKey || !holder) return { ...handle }
      const pub = publicUrl()
      if (!pub) return { ...handle }
      const store = hooks()
      return store.withRepoLock(repo, async () => {
        const rec = await ensureHook(repo, pub.url, { verify: "tolerant", key: hookKey })
        const withHolder = rec.holders.includes(holder) ? rec : { ...rec, holders: [...rec.holders, holder] }
        if (withHolder !== rec) store.put(withHolder)
        return handleFor(withHolder, holder)
      })
    },

    /** Idempotent: removes this sentinel's holder; deletes the GitHub hook
     *  only when no holder remains. A failed delete keeps the (now unheld)
     *  record so a later `create` on the repo reuses it, and rethrows. */
    async cancel(handle: SentinelHandle): Promise<void> {
      const { repo, holder } = handleState(handle)
      if (!repo || !holder) return
      const store = hooks()
      await store.withRepoLock(repo, async () => {
        const rec = store.getByRepo(repo)
        if (!rec || !rec.holders.includes(holder)) return
        const remaining = rec.holders.filter(h => h !== holder)
        if (remaining.length > 0) {
          store.put({ ...rec, holders: remaining })
          return
        }
        store.put({ ...rec, holders: [] })
        try {
          await gh(["api", "-X", "DELETE", `repos/${repo}/hooks/${rec.hookId}`])
        } catch (err) {
          if (!isNotFound(err)) throw err
        }
        store.remove(repo)
      })
    },

    async status(handle: SentinelHandle): Promise<{ ok: boolean; detail?: string; pending?: number }> {
      const { repo, holder } = handleState(handle)
      const rec = repo ? hooks().getByRepo(repo) : undefined
      if (!repo || !rec || !holder || !rec.holders.includes(holder)) {
        return { ok: false, detail: "webhook record is missing — re-create the sentinel" }
      }
      try {
        const hook = JSON.parse(await gh(["api", "-H", "Accept: application/vnd.github+json", `repos/${repo}/hooks/${rec.hookId}`])) as {
          active?: boolean
          config?: { url?: string }
        }
        if (hook.active === false) return { ok: false, detail: `the GitHub hook on ${repo} is disabled` }
        if (hook.config?.url !== callbackUrl(rec.origin, rec.key)) {
          return { ok: false, detail: `the GitHub hook on ${repo} no longer points at this daemon` }
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, detail: isNotFound(err) ? `the GitHub hook on ${repo} was deleted` : errMsg(err) }
      }
    },

    parseInbound(req, handle): { ok: true; events: SentinelEvent[] } | { ok: false; reason: string } {
      const { hookKey } = handleState(handle)
      const rec = hookKey ? hooks().getByKey(hookKey) : undefined
      if (!rec) return { ok: false, reason: "unknown_hook" }

      const verified = verifyInboundSignature("sentinel", {
        rawBody: req.rawBody,
        headers: req.headers,
        secret: rec.secret,
        nowMs: now().getTime(),
      })
      if (!verified.ok) {
        return { ok: false, reason: verified.reason.startsWith("missing") ? "missing_signature" : "bad_signature" }
      }

      const event = headerValue(req.headers, "x-github-event")
      const deliveryId = headerValue(req.headers, "x-github-delivery")
      if (!event) return { ok: false, reason: "missing_event_header" }
      if (event === "ping") return { ok: true, events: [] }
      if (!deliveryId) return { ok: false, reason: "missing_delivery_header" }

      let payload: unknown
      try {
        payload = JSON.parse(req.rawBody)
      } catch {
        return { ok: false, reason: "invalid_json" }
      }
      const normalized = normalizeGithubEvent({
        event,
        deliveryId,
        payload,
        source: "//agentproto.local/sentinel/webhook",
        time: now().toISOString(),
      })
      if (normalized.ok) return { ok: true, events: [normalized.event] }
      // An event type we don't watch is ack-and-drop, not an error (GitHub
      // would otherwise show a red delivery for every unsupported event).
      if (normalized.reason.startsWith("unsupported_event:")) return { ok: true, events: [] }
      return { ok: false, reason: normalized.reason }
    },

    defaultTypes(subject: string): string[] {
      return repoOfSubject(subject) ? [...GITHUB_DEFAULT_PR_TYPES] : []
    },
  }
}
