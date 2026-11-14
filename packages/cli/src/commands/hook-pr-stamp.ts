/**
 * `agentproto hook pr-stamp`
 *
 * A Claude Code PostToolUse hook (matcher `Bash`) for sessions the daemon did
 * not spawn: Claude desktop's Code tab, a plain `claude` CLI. When the tool
 * call was a successful `gh pr create`, it appends the `@agentproto-bot`
 * provenance footer to the created PR's body, naming the harness's own
 * session id, the host and the cwd. The hook stamps, never the model.
 *
 * Skips a daemon-spawned session (`AGENTPROTO_SESSION_ID=sess_...`): the
 * daemon's gh shim and reconciler stamp those with a richer footer, and a
 * thinner one landing first would block it. Idempotent on a rendered footer.
 * Any failure is silent and exits 0: a hook must never break the session.
 */
import { spawn } from "node:child_process"
import { hostname } from "node:os"
import { appendFooterOnce, buildFooter, hasProvenanceFooter } from "@agentproto/runtime/pr-provenance"

export const PR_STAMP_HOOK_COMMAND = "agentproto hook pr-stamp"

const GH_PR_CREATE_RE = /(?:^|[\s;&|(])gh\s+pr\s+create(?:\s|$)/
const PR_URL_RE = /https:\/\/github\.com\/[^/\s"\\]+\/[^/\s"\\]+\/pull\/\d+/

export interface PrStampPayload {
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { command?: unknown }
  tool_response?: unknown
}

export type GhRun = (args: readonly string[], cwd: string | undefined) => Promise<{ exitCode: number; stdout: string }>

export interface PrStampDeps {
  run?: GhRun
  host?: string
  env?: Record<string, string | undefined>
}

/** The created PR's url when the payload is a `gh pr create` Bash call that printed one. Pure. */
export function prUrlFromPayload(payload: PrStampPayload): string | undefined {
  if (payload.tool_name !== "Bash") return undefined
  const command = payload.tool_input?.command
  if (typeof command !== "string" || !GH_PR_CREATE_RE.test(command)) return undefined
  const response = payload.tool_response
  // `gh pr create` prints the url on stdout: read that first, so a PR url
  // quoted on stderr (a warning, a template) is never the one edited.
  const stdout = (response as { stdout?: unknown } | null | undefined)?.stdout
  const fromStdout = typeof stdout === "string" ? PR_URL_RE.exec(stdout)?.[0] : undefined
  if (fromStdout) return fromStdout
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "")
  return PR_URL_RE.exec(text)?.[0]
}

/** The footer for a PR opened by a session outside the daemon. Pure. */
export function externalPrFooter(payload: PrStampPayload, host: string): string {
  return buildFooter({
    kind: "PR",
    prov: {
      ...(payload.session_id ? { sessionId: payload.session_id } : {}),
      label: "external",
      adapter: "claude-code",
      source: "local",
      host,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
    },
  })
}

const realGh: GhRun = (args, cwd) =>
  new Promise(resolve => {
    let stdout = ""
    const child = spawn("gh", [...args], { ...(cwd ? { cwd } : {}), shell: false })
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.on("error", () => resolve({ exitCode: 1, stdout }))
    child.on("close", code => resolve({ exitCode: code ?? 1, stdout }))
  })

export async function runPrStamp(raw: string, deps: PrStampDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  // Every daemon-spawned session id comes from `mintSessionId()` in
  // packages/runtime/src/sessions.ts (`sess_` + 8 hex). A desktop session
  // carries the id `hook install` wrote (`claude-desktop` unless `--session`
  // names another), so keep that prefix out of `--session` values.
  if (env.AGENTPROTO_SESSION_ID?.startsWith("sess_")) return 0
  let payload: PrStampPayload
  try {
    payload = JSON.parse(raw) as PrStampPayload
  } catch {
    return 0
  }
  const url = prUrlFromPayload(payload)
  if (!url) return 0
  const run = deps.run ?? realGh
  const view = await run(["pr", "view", url, "--json", "body", "--jq", ".body"], payload.cwd)
  if (view.exitCode !== 0) return 0
  const body = view.stdout.replace(/\n+$/, "")
  if (hasProvenanceFooter(body)) return 0
  const footer = externalPrFooter(payload, deps.host ?? hostname())
  await run(["pr", "edit", url, "--body", appendFooterOnce(body, footer)], payload.cwd)
  return 0
}
