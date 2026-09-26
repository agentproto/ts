/**
 * auth — existing auth profiles, and local credentials that `auth discover`
 * finds but that haven't been imported as a profile yet. Only origins,
 * endpoints and presence are ever reported — never a secret value.
 */

import { PROVIDER_ENV_VARS } from "@agentproto/runtime/providers-store"
import type { OnboardingStep, SetupAction, StepCheck } from "../types.js"
import { errorMessage } from "./_util.js"

export const authStep: OnboardingStep = {
  id: "auth",
  title: "Auth",
  required: false,
  async detect(ctx) {
    const checks: StepCheck[] = []
    let profiles
    try {
      profiles = await ctx.sources.listAuthProfiles()
    } catch (err) {
      return [{ id: "auth.profiles", title: "Auth profiles", status: "broken", detail: errorMessage(err) }]
    }
    const enabled = profiles.filter((p) => p.disabled !== true)
    checks.push(
      profiles.length === 0
        ? {
            id: "auth.profiles",
            title: "Auth profiles",
            status: "warn",
            detail: "none configured",
            fix: "agentproto auth discover",
            data: { count: 0, enabled: [] },
          }
        : {
            id: "auth.profiles",
            title: "Auth profiles",
            status: enabled.length > 0 ? "ok" : "warn",
            detail: `${profiles.length} profile(s), ${enabled.length} enabled${
              enabled.length > 0 ? `: ${enabled.map((p) => p.id).join(", ")}` : ""
            }`,
            data: { count: profiles.length, enabled: enabled.map((p) => p.id) },
          },
    )

    let discovered
    try {
      discovered = await ctx.sources.discoverCredentials()
    } catch (err) {
      checks.push({
        id: "auth.discover",
        title: "Discoverable credentials",
        status: "warn",
        detail: `not checked: ${errorMessage(err)}`,
      })
      return checks
    }
    // An import records its `origin`; a source-backed claude-code profile
    // created by hand resolves the very same credential, so it counts too.
    const imported = new Set(
      profiles.map((p) => {
        const origin = p.origin ?? (p.source === "claude-code-oauth" ? "claude-code" : "")
        return `${origin}\u0000${p.endpoint}`
      }),
    )
    const pending = discovered.filter((c) => !imported.has(`${c.origin}\u0000${c.endpoint}`))
    for (const c of pending) {
      checks.push({
        id: `auth.discover.${c.origin}.${c.endpoint}`,
        title: `Credential not imported: ${c.endpoint}`,
        status: "warn",
        detail: `${c.method} found (${c.origin})`,
        fix: `agentproto auth profile import ${c.origin} ${c.endpoint}`,
        data: { origin: c.origin, endpoint: c.endpoint, method: c.method },
      })
    }
    if (pending.length === 0) {
      checks.push({
        id: "auth.discover",
        title: "Discoverable credentials",
        status: "ok",
        detail:
          discovered.length === 0 ? "none found on this host" : `all ${discovered.length} already imported`,
        data: { discovered: discovered.length },
      })
    }
    return checks
  },
  async plan(checks) {
    const pending = checks.flatMap((c) => {
      const origin = c.data?.origin
      const endpoint = c.data?.endpoint
      return c.id.startsWith("auth.discover.") && typeof origin === "string" && typeof endpoint === "string"
        ? [{ origin, endpoint, method: typeof c.data?.method === "string" ? c.data.method : "" }]
        : []
    })
    const actions: SetupAction[] = []
    if (pending.length > 0) {
      actions.push({
        id: "auth.import",
        title: "Import the credentials found on this machine as auth profiles",
        default: true,
        choices: pending.map((p) => ({
          value: `${p.origin} ${p.endpoint}`,
          label: `${p.endpoint} from ${p.origin}`,
          ...(p.method ? { hint: p.method } : {}),
          default: true,
        })),
        async apply(io, selected = []) {
          const failed: string[] = []
          for (const value of selected) {
            const [origin = "", endpoint = ""] = value.split(" ")
            if ((await io.verbs.auth(["profile", "import", origin, endpoint])) !== 0) failed.push(value)
          }
          return failed.length === 0
            ? { ok: true, detail: `imported ${selected.length} credential(s)` }
            : { ok: false, detail: `failed: ${failed.join(", ")}` }
        },
      })
    }
    actions.push({
      id: "auth.api-key",
      title: "Add a provider API key",
      default: false,
      needsSecret: true,
      streamsOutput: true,
      async apply(io) {
        const provider = await io.prompts.select(
          "Provider",
          Object.keys(PROVIDER_ENV_VARS).map((p) => ({ value: p, label: p, hint: PROVIDER_ENV_VARS[p] })),
        )
        if (provider === null) return { ok: false, detail: "cancelled" }
        const key = await io.prompts.password(`${provider} API key`)
        if (key === null || key.trim() === "") return { ok: false, detail: "cancelled" }
        const code = await io.verbs.auth(["provider", "set", provider, key.trim()])
        return code === 0 ? { ok: true, detail: `stored the ${provider} key` } : { ok: false, detail: `auth provider set exited ${code}` }
      },
    })
    return actions
  },
  async report(io) {
    const rows = await io.verbs.modelsSummary()
    return rows.map((r) => `${r.slug}: ${r.runnable}/${r.total} models runnable with your keys`)
  },
}
