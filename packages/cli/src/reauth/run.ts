/**
 * `agentproto auth reauth <profile|parent>`: log the PARENT account behind a
 * profile in again, verify the result, say what it changed.
 *
 * A login belongs to the parent (a console login, a Claude login, …), never to a
 * sub-account: one reauth fixes every sub-account profile under it. The login
 * itself stays interactive (run with inherited stdio); everything around it,
 * the before/after reads, the verification and the report, is automated. The
 * per-source work lives in a `ReauthAdapter` (see `./register.ts`).
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import {
  deriveAuthState,
  findReauthAdapter,
  getAuthProfile,
  listAuthProfiles,
  listReauthAdapters,
  type AuthProfile,
  type ParentAccountInfo,
  type ReauthAdapter,
  type ReauthLoginPlan,
  type ReauthVerification,
} from "@agentproto/auth"
import { registerBuiltinReauthAdapters } from "./register.js"

export const REAUTH_USAGE = `agentproto auth reauth — log a profile's parent account in again

Usage:
  agentproto auth reauth <profile|parent> [--check] [--json]

<profile>  an auth profile id: the parent account behind its source is logged in
           again (a sub-account profile re-logs its PARENT: the login belongs to
           the parent, so one reauth fixes every sub-account under it, and
           switching sub-account never needs a re-login).
<parent>   a source name instead (opencode-console, claude-code-oauth, codex,
           gemini): logs that parent in again.

The provider's own login runs interactively (browser sign-in); the rest is
automated: the stored login is read before and after, the result is verified
and the report says what was checked, what could not be, and what else the
login changed (for instance the provider's active account). Other stored
accounts are not touched.

  --check   read-only: show the parent account, its expiry and state, and the
            login command that would run. Exits 1 when the login is expired or
            missing.
  --json    machine-readable report on stdout (the login's own output goes to
            stderr).

Exit codes: 0 verified, 1 login or verification failed, 2 usage error,
3 a manual step is needed (re-run with --check afterwards).
`

export interface ReauthRunDeps {
  /** Run the provider's login with the terminal attached. Resolves its exit code. */
  runLogin?: (plan: Extract<ReauthLoginPlan, { kind: "command" }>, opts: { json: boolean }) => Promise<number>
  /** Wait for the operator to finish a manual login. false ⇒ no terminal to ask on. */
  confirmManual?: (instructions: string) => Promise<boolean>
  now?: () => number
}

let testDeps: ReauthRunDeps | undefined
export function setReauthRunDepsForTests(deps: ReauthRunDeps | undefined): void {
  testDeps = deps
}

const out = (s: string) => process.stdout.write(s)
const err = (s: string) => process.stderr.write(s)

function defaultRunLogin(
  plan: Extract<ReauthLoginPlan, { kind: "command" }>,
  opts: { json: boolean },
): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(plan.command, plan.args, {
      stdio: ["inherit", opts.json ? 2 : "inherit", "inherit"],
    })
    child.on("error", e => {
      err(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? `agentproto auth reauth: \`${plan.command}\` is not installed or not on PATH; install it, then re-run.\n`
          : `agentproto auth reauth: could not run \`${plan.command}\`: ${e.message}\n`,
      )
      resolve(127)
    })
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
}

async function defaultConfirmManual(instructions: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  err(`${instructions}\n`)
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    await rl.question("Press Enter once you have logged in (Ctrl-C to abort)... ")
    return true
  } finally {
    rl.close()
  }
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString())

/** What leaves this process about a parent: never a fingerprint or a token. */
function publicParent(info: ParentAccountInfo, now: number) {
  return {
    ...(info.id !== undefined ? { id: info.id } : {}),
    ...(info.label !== undefined ? { label: info.label } : {}),
    loggedIn: info.loggedIn,
    expiresAt: iso(info.expiresAtMs),
    state: !info.loggedIn ? "expired" : info.selfRefreshing ? "unknown" : deriveAuthState(info.expiresAtMs, now),
    ...(info.activeAccountId !== undefined ? { activeAccountId: info.activeAccountId } : {}),
    ...(info.note !== undefined ? { note: info.note } : {}),
  }
}

function describeParent(p: ReturnType<typeof publicParent>): string {
  if (!p.loggedIn) return `not logged in${p.note ? ` (${p.note})` : ""}`
  const who = p.label ?? p.id ?? "an account"
  return `${who}, ${p.expiresAt ? `session expires ${p.expiresAt}` : "no expiry known"} [${p.state}]${p.note ? ` (${p.note})` : ""}`
}

function resolveTarget(
  arg: string,
  profile: AuthProfile | undefined,
): { adapter: ReauthAdapter; profile?: AuthProfile } | { error: string } {
  if (profile) {
    const adapter = findReauthAdapter(profile.source)
    if (!adapter) {
      return {
        error:
          profile.source === undefined
            ? `profile "${profile.id}" holds a stored key, not a login: there is nothing to log in again. ` +
              `Replace the key (agentproto auth profile rm ${profile.id}, then create it again).`
            : `profile "${profile.id}" has source "${profile.source}", which has no re-login adapter. ` +
              `Known: ${listReauthAdapters().map(a => a.source).join(", ")}.`,
      }
    }
    return { adapter, profile }
  }
  const adapter = findReauthAdapter(arg)
  if (adapter) return { adapter }
  return {
    error:
      `no auth profile or parent named "${arg}". Parents: ${listReauthAdapters().map(a => a.source).join(", ")}. ` +
      `Profiles: agentproto auth profile list.`,
  }
}

export async function runAuthReauth(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { check: { type: "boolean" }, json: { type: "boolean" } },
  })
  const json = values.json === true
  const arg = positionals[0]
  if (arg === undefined || positionals.length > 1) {
    err(`agentproto auth reauth: expected exactly one <profile|parent>.\n\n${REAUTH_USAGE}`)
    return 2
  }
  await registerBuiltinReauthAdapters()
  const deps = testDeps ?? {}
  const now = deps.now ?? Date.now
  const profile = await getAuthProfile(arg)
  const resolved = resolveTarget(arg, profile)
  if ("error" in resolved) {
    err(`agentproto auth reauth: ${resolved.error}\n`)
    return 2
  }
  const { adapter } = resolved
  const target = { source: adapter.source, ...(resolved.profile ? { profile: resolved.profile } : {}) }
  const siblings = (await listAuthProfiles())
    .filter(p => p.source === adapter.source && p.id !== resolved.profile?.id)
    .map(p => p.id)
  const affected = [...(resolved.profile ? [resolved.profile.id] : []), ...siblings]

  const before = await adapter.inspect(target)
  const plan = adapter.plan(target, before)
  const beforePublic = publicParent(before, now())
  const planPublic =
    plan.kind === "command"
      ? { kind: "command" as const, command: [plan.command, ...plan.args].join(" "), description: plan.description }
      : { kind: "manual" as const, instructions: plan.instructions }

  if (values.check) {
    const dead = beforePublic.state === "expired"
    if (json) {
      out(JSON.stringify({ target: arg, source: adapter.source, parent: beforePublic, login: planPublic, profiles: affected }, null, 2) + "\n")
    } else {
      out(
        `${adapter.displayName} (parent account): ${describeParent(beforePublic)}\n` +
          `login: ${planPublic.kind === "command" ? planPublic.command : "manual"}\n` +
          (plan.kind === "manual" ? `${plan.instructions}\n` : "") +
          (affected.length > 0 ? `profiles under this parent (fixed by one login): ${affected.join(", ")}\n` : "") +
          (dead ? `run: agentproto auth reauth ${arg}\n` : ""),
      )
    }
    return dead ? 1 : 0
  }

  const say = json ? err : out
  say(`Re-login for ${adapter.displayName} (the parent account${resolved.profile ? ` behind profile "${resolved.profile.id}"` : ""}).\n`)
  say(`Before: ${describeParent(beforePublic)}\n`)

  let ran: boolean
  let exitCode = 0
  if (plan.kind === "command") {
    say(`Running: ${planPublic.kind === "command" ? planPublic.command : ""}  (${plan.description})\n`)
    exitCode = await (deps.runLogin ?? defaultRunLogin)(plan, { json })
    ran = true
    if (exitCode !== 0) {
      err(`agentproto auth reauth: the login command exited ${exitCode}; nothing was verified, the stored login may be unchanged.\n`)
      if (json) out(JSON.stringify({ target: arg, source: adapter.source, ran, exitCode, verification: null, parent: { before: beforePublic } }, null, 2) + "\n")
      return 1
    }
  } else {
    const confirmed = await (deps.confirmManual ?? defaultConfirmManual)(plan.instructions)
    ran = false
    if (!confirmed) {
      err(`${plan.instructions}\nThen check it: agentproto auth reauth ${arg} --check\n`)
      if (json) out(JSON.stringify({ target: arg, source: adapter.source, ran, exitCode: null, verification: null, login: planPublic, parent: { before: beforePublic } }, null, 2) + "\n")
      return 3
    }
  }

  const verification: ReauthVerification = await adapter.verify(target, before)
  const afterPublic = verification.parent ? publicParent(verification.parent, now()) : undefined

  if (json) {
    out(
      JSON.stringify(
        {
          target: arg,
          source: adapter.source,
          ran,
          exitCode,
          parent: { before: beforePublic, ...(afterPublic ? { after: afterPublic } : {}) },
          verification: {
            status: verification.status,
            checked: verification.checked,
            notChecked: verification.notChecked,
            problems: verification.problems,
            sideEffects: verification.sideEffects,
          },
          profiles: affected,
        },
        null,
        2,
      ) + "\n",
    )
  } else {
    out(`After:  ${afterPublic ? describeParent(afterPublic) : "unknown"}\n`)
    out(`Verification: ${verification.status.toUpperCase()}\n`)
    for (const c of verification.checked) out(`  checked:     ${c}\n`)
    for (const c of verification.notChecked) out(`  not checked: ${c}\n`)
    for (const c of verification.problems) out(`  PROBLEM:     ${c}\n`)
    for (const c of verification.sideEffects) out(`  side effect: ${c}\n`)
    if (affected.length > 0) out(`Profiles under this parent: ${affected.join(", ")}\n`)
    if (adapter.scopeNote) out(`${adapter.scopeNote}\n`)
  }
  return verification.status === "failed" ? 1 : 0
}
