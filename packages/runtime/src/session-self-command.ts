/**
 * `session_command_self` — decide whether a session may run a harness slash
 * command ON ITSELF, and build the exact prompt text to queue.
 *
 * Why it exists: a slash command ("/compact", "/clear", "/model x") is just a
 * prompt whose FIRST characters are the command; the harness's own dispatcher
 * recognises it (see `@agentproto/harness` slash-dispatch). A session cannot
 * type it into itself, and cannot run it mid-turn, so the daemon QUEUES it on
 * the caller's own prompt queue; it fires when the current turn ends.
 *
 * Policy, in order:
 *   1. the adapter MANIFEST allow-list (`capabilities.selfCommands`) — a
 *      command not listed is refused, whatever the harness could do;
 *   2. the session's live `availableCommands`: when the harness advertised a
 *      list, the command must be in it (an allow-listed command the installed
 *      harness version doesn't have is refused with the reason);
 *   3. the registry's own admission rules still apply at enqueue time
 *      (`contextContinuity.compactRequiresOperator` refuses a self-compaction).
 *
 * Pure: no registry, no I/O.
 */

/** Names are bare (`compact`), single tokens, no path or shell characters. */
const COMMAND_NAME_RE = /^[a-z][a-z0-9_:-]{0,39}$/i

/** Max args length: a command line, not a document. */
export const SELF_COMMAND_MAX_ARGS = 500

/** Harness-specific spelling of the compaction command (hermes: `compress`). */
export function compactCommandNameFor(harness: string | undefined): "compact" | "compress" {
  return (harness ?? "").includes("hermes") ? "compress" : "compact"
}

export type SelfCommandRefusalCode =
  | "invalid_command"
  | "invalid_args"
  | "no_self_commands"
  | "command_not_allowed"
  | "command_not_available"

export type SelfCommandPlan =
  | { ok: true; name: string; args: string; text: string }
  | { ok: false; code: SelfCommandRefusalCode; message: string; allowed: string[] }

export interface PlanSelfCommandInput {
  command: string
  args?: string
  harness: string | undefined
  /** Manifest `capabilities.selfCommands`. */
  allow: readonly string[] | undefined
  /** The session's live `availableCommands` names; empty/undefined = not advertised. */
  available: ReadonlyArray<{ name: string; _meta?: { bareName?: string } }> | undefined
}

export function planSelfCommand(input: PlanSelfCommandInput): SelfCommandPlan {
  const harness = input.harness ?? "this harness"
  const allowed = [...(input.allow ?? [])].map(a => a.toLowerCase())
  const refuse = (code: SelfCommandRefusalCode, message: string): SelfCommandPlan => ({
    ok: false,
    code,
    message,
    allowed,
  })
  let name = input.command.trim().replace(/^\//, "")
  if (!COMMAND_NAME_RE.test(name)) {
    return refuse("invalid_command", `session_command_self: "${input.command}" is not a command name (e.g. "compact").`)
  }
  name = name.toLowerCase()
  // Same intent, harness spelling: "/compact" on hermes is "/compress".
  if (name === "compact" || name === "compress") name = compactCommandNameFor(input.harness)
  const args = (input.args ?? "").trim()
  if (args.length > SELF_COMMAND_MAX_ARGS || /[\r\n]/.test(args)) {
    return refuse(
      "invalid_args",
      `session_command_self: args must be one line of at most ${SELF_COMMAND_MAX_ARGS} characters.`,
    )
  }
  if (allowed.length === 0) {
    return refuse(
      "no_self_commands",
      `session_command_self: ${harness} declares no commands a session may run on itself ` +
        `(adapter manifest \`capabilities.selfCommands\` is empty).`,
    )
  }
  if (!allowed.includes(name)) {
    return refuse(
      "command_not_allowed",
      `session_command_self: "/${name}" is not allowed on ${harness}. Allowed: ${allowed.map(a => `/${a}`).join(", ")}.`,
    )
  }
  if (input.available && input.available.length > 0) {
    const ok = input.available.some(c => c.name.toLowerCase() === name || c._meta?.bareName?.toLowerCase() === name)
    if (!ok) {
      return refuse(
        "command_not_available",
        `session_command_self: "/${name}" is allowed on ${harness} but this session's harness does not ` +
          `advertise it right now (version or mode). See session_commands.`,
      )
    }
  }
  return { ok: true, name, args, text: args ? `/${name} ${args}` : `/${name}` }
}
