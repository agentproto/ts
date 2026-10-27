/**
 * Canonical posture → opencode `permission` config (SPEC §3.4a, risk Rw).
 *
 * opencode's ACP server advertises only its `build`/`plan` agents as session
 * modes, so a canonical posture with no native mode (`bypass`, `accept-edits`,
 * `read-only`) used to reach an opencode session as an ADVISORY system-prompt
 * preamble only — `posture: "bypass"` still showed opencode's own permission
 * prompts. This module turns those postures into a real boundary the same way
 * claude-code gets one (`permissions.defaultMode` in its isolated
 * `CLAUDE_CONFIG_DIR`): a `permission` block layered into the session's own
 * `OPENCODE_CONFIG_CONTENT` — the per-session, highest-precedence config layer
 * (deep-merged over the user's global and project config, never written to
 * them).
 *
 * Shape verified against the pinned opencode (1.18.x) bundle: `permission` is
 * `"allow"|"ask"|"deny"` or an object keyed by permission name (plus `*` and
 * arbitrary extra keys), each value an action or a `{ pattern: action }`
 * object. Rules are flattened in key order and the LAST match wins, and the
 * config-level block is merged AFTER every built-in agent's defaults — so a key
 * set here overrides opencode's own `ask` defaults (`doom_loop`,
 * `external_directory`, `*.env` reads) and the user's config for that key.
 *
 * `plan` maps to nothing here on purpose: opencode advertises a native `plan`
 * agent, which the runtime switches to via `setSessionMode` (a real boundary
 * already), and a config-level `edit: "deny"` would override that agent's own
 * allowance for writing its plan file. `default` is neutral.
 *
 * Known limits (documented, not silent): a user's per-agent
 * `agent.<name>.permission` block is merged after the config-level one and can
 * still re-introduce a prompt; `read-only` denies opencode's own mutating tools
 * (`edit`/`write`/`apply_patch`, `bash`) but not an MCP server's tools.
 */

/** opencode's well-known permission keys (1.18.x `PermissionConfig`). */
const OPENCODE_PERMISSION_KEYS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
] as const

type OpencodePermissionAction = "allow" | "ask" | "deny"
export type OpencodePermissionBlock = Readonly<Record<string, OpencodePermissionAction>>

/**
 * canonical posture → the `permission` block it writes. `bypass` leads with
 * `*` (catches any permission, including tool names this list doesn't know)
 * and then names every well-known key explicitly, so a user config that set
 * one of them to `ask` (or to a pattern object) is replaced rather than left
 * ahead of the wildcard.
 */
const OPENCODE_POSTURE_PERMISSIONS: Readonly<Record<string, OpencodePermissionBlock>> = {
  bypass: {
    "*": "allow",
    ...Object.fromEntries(OPENCODE_PERMISSION_KEYS.map(key => [key, "allow" as const])),
  },
  "accept-edits": { edit: "allow" },
  "read-only": { edit: "deny", bash: "deny" },
}

/** The canonical postures this module turns into a real opencode boundary. */
export const OPENCODE_SPAWN_ENFORCED_POSTURES: readonly string[] = Object.keys(
  OPENCODE_POSTURE_PERMISSIONS,
)

/**
 * The opencode `permission` block a canonical posture enforces, or `undefined`
 * when the posture has no config mapping (`default`, `plan` — see the module
 * doc — an unknown value, or none requested).
 */
export function opencodePermissionForPosture(
  posture: string | undefined,
): OpencodePermissionBlock | undefined {
  if (!posture) return undefined
  return OPENCODE_POSTURE_PERMISSIONS[posture]
}

/**
 * Layer a posture's `permission` block into an inline opencode config JSON
 * string (`OPENCODE_CONFIG_CONTENT`'s current value, possibly absent) and return
 * the new JSON. Every other config key (`instructions`, `small_model`, `mcp`, a
 * provider block) is preserved; an existing inline `permission` object keeps
 * its other keys, while each posture key is removed and re-added so it sits
 * LAST in key order (opencode's last-match-wins evaluation).
 *
 * Throws when the existing value is not a JSON object: the caller asked for a
 * permission boundary, and spawning without it would be the silent advisory
 * fallback this exists to remove.
 */
export function mergeOpencodePermission(
  prior: string | undefined,
  permission: OpencodePermissionBlock,
  envName: string,
): string {
  let inline: Record<string, unknown> = {}
  if (prior !== undefined && prior !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(prior)
    } catch {
      parsed = undefined
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `opencode posture: ${envName} is not a JSON object, so the requested ` +
          "permission posture cannot be enforced — refusing to spawn with an advisory-only posture.",
      )
    }
    inline = parsed as Record<string, unknown>
  }
  const existing = inline.permission
  const merged: Record<string, unknown> =
    typeof existing === "string"
      ? { "*": existing }
      : existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}
  for (const [key, action] of Object.entries(permission)) {
    delete merged[key]
    merged[key] = action
  }
  return JSON.stringify({ ...inline, permission: merged })
}
