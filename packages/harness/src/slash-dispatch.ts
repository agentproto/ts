/**
 * Generic slash-command dispatch — the pure decision layer behind the
 * "on récupère les commandes de l'adapter" contract.
 *
 * Upstream ACP already gives every adapter two halves of the same feature:
 *
 *   1. `available_commands_update` (agent → client notification, AIP-44 §5
 *      profile of upstream ACP) — the ADAPTER's own command list, never host
 *      commands. harnesses speak the exact same wire name:
 *      - hermes: `acp_adapter/commands.py` `SlashCommandsMixin`
 *        (`_send_available_commands_update`, advertised right after session
 *        new/load),
 *      - claude-code: `@agentclientprotocol/claude-agent-acp`
 *        `sendAvailableCommandsUpdate` + wire-forward (0.84.0),
 *      - opencode: ACP-directory snapshot = `command.list()` + skills,
 *        re-announced on session start.
 *   2. prompt transport — the adapter wants the user's text VERBATIM as the
 *      first content block of `session/prompt` and dispatches it itself:
 *      hermes matches `_handle_slash_command` (unknown `/x` falls through to
 *      the LLM), opencode matches `detectSlashCommand` then routes known
 *      names to `session.command` (and `/compact` to `session.summarize`).
 *
 * There is no host-side command registry and none should be invented: this
 * module only PARSES + MATCHES against `availableCommands` — the same list
 * the runtime already mirrors onto `SessionDescriptor.availableCommands` —
 * so prompt-transport code can (a) know whether text like "/compact" is a
 * command the ADAPTER said it supports and (b) keep that text UNPREFIXED
 * through the transport.
 *
 * That last point is the bug this exists for: slash dispatch on both hermes
 * and opencode is anchored on `text.startsWith("/")` of the FIRST text
 * block. Anything the host glues in front (`MESSAGE_PREAMBLE` on a message
 * turn, an fyi `renderInboxDigest`, a pending resume-context digest — all
 * prepended in `runAgentTurn` before `send`) silently breaks dispatch: the
 * prefixed `/model`/`/compact`/`/compress` text reaches the agent as plain
 * prose, the agent answers conversationally, and the command "does nothing"
 * with no error anywhere.
 *
 * Pure module: no registry, no I/O, no session state, never spawns or
 * rewrites payloads. Returns decisions and transport-ready blocks; callers
 * stay in charge of what they send.
 */

/** One entry of an `available_commands_update` payload — exactly the shape
 *  `@agentproto/acp`'s `available-commands` StreamEvent (and hence
 *  `SessionDescriptor.availableCommands`) carries. Loose `unknown`-safe: a
 *  caller can pass the raw translated objects without re-fielding them. */
export interface SlashCommandEntry {
  name: string
  description?: string
  input?: { hint?: string } | null
  _meta?: { scope?: string; path?: string; bareName?: string; qualifiedName?: string }
}

/** A parsed leading `/name rest…` invocation. */
export interface SlashInvocation {
  /** Command word after the slash, verbatim (case NOT resolved — see
   *  `matchSlashCommand` which compares case-insensitively). */
  name: string
  /** Everything after the first whitespace, trimmed. Empty string when the
   *  invocation was the bare command word. */
  args: string
}

/** Outcome of classifying a prompt against an adapter's command list. */
export type SlashDispatchDecision =
  | { kind: "none"; text: string }
  /** `"/foo bar"` shape, but `/foo` is NOT in the adapter's
   *  `availableCommands`. Callers MUST still send it verbatim — adapters
   *  define unknown-slash semantics themselves (hermes: fall through to the
   *  LLM; cf `_handle_slash_command`'s `None` path), so deciding here that
   *  an unknown slash "isn't a command at all" would change behavior the
   *  adapter owns. */
  | { kind: "unknown-slash"; invocation: SlashInvocation; text: string }
  /** `/foo bar` AND `/foo` is in the command list. Transport must deliver
   *  `text` verbatim as the first text content block or the adapter's own
   *  dispatcher won't see the leading slash. */
  | {
      kind: "known"
      invocation: SlashInvocation
      /** The MATCHED entry (canonical `name` may differ in case from the
       *  invocation's). */
      command: SlashCommandEntry
      /** `true` when the entry declared an input hint and no args were
       *  given. Advisory only — adapters resolve (or complain) on their
       *  own; the host merely wants a heads-up before a turn that is
       *  certain not to do what the operator typed. Args-less dispatch is
       *  still sent verbatim — adapters resolve (or complain) on their own. */
      argsMissing: boolean
      text: string
    }

/**
 * Parse a leading slash invocation out of plain prompt text.
 *
 * Deliberately NARROW (mirrors opencode's ACP `detectSlashCommand` and
 * hermes' `_handle_slash_command` split): an optional leading BOM+whitespace
 * is tolerated, the command word must be `/` + at least one non-whitespace
 * char, and everything after the first whitespace run is `args` (newlines
 * included in the args text, trimmed of the leading run). No fancier
 * shell-like tokenising — args travel verbatim, adapters own their grammar.
 */
export function parseSlashInvocation(text: string): SlashInvocation | undefined {
  const first = /^\/(?!\/)([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!first) return undefined
  return {
    name: "/" + first[1],
    args: (first[2] ?? "").trim(),
  }
}

/**
 * Resolve an invocation's name against the adapter's `availableCommands`.
 * Matches, in order: exact `name`, case-insensitive `name`, and the
 * claude-code `_meta` qualified/bare spellings (`bareName` for
 * `agent:command`-style entries agents send to disambiguate scoped skills).
 * Empty/absent list → `undefined` (an adapter that never advertised is not
 * a match against nothing).
 */
export function matchSlashCommand(
  name: string,
  commands: readonly SlashCommandEntry[] | undefined,
): SlashCommandEntry | undefined {
  if (!commands?.length) return undefined
  // Accept both spellings callers use — the invocation carries the `/`
  // prefix, entries never do. Strip exactly one leading slash.
  const bare = name.startsWith("/") ? name.slice(1) : name
  const lower = bare.toLowerCase()
  for (const c of commands) {
    if (c.name === bare || c.name.toLowerCase() === lower) return c
    const meta = c._meta
    if (meta?.bareName === bare || meta?.qualifiedName?.toLowerCase() === lower) return c
  }
  return undefined
}

/**
 * The one-shot classification prompt-transport code asks for: given the
 * user's (raw, unprefixed) text and the adapter's advertised commands,
 * decide how the text should travel. Never throws.
 */
export function classifySlashPrompt(
  text: string,
  availableCommands: readonly SlashCommandEntry[] | undefined,
): SlashDispatchDecision {
  if (typeof text !== "string" || text === "") return { kind: "none", text: "" }
  const invocation = parseSlashInvocation(text)
  if (!invocation) return { kind: "none", text }
  const command = matchSlashCommand(invocation.name, availableCommands)
  if (!command) return { kind: "unknown-slash", invocation, text }
  return {
    kind: "known",
    invocation,
    command,
    argsMissing:
      typeof command.input?.hint === "string" && command.input.hint.length > 0
        ? invocation.args === ""
        : false,
    text,
  }
}

/**
 * Transport shape for an ACP `session/prompt` message — the text verbatim
 * as the single first text block. Slash dispatch is anchored on the leading
 * character of the first text block's `text`, so this is the whole trick
 * that keeps host prepends from breaking dispatch: build the turn's ACP
 * content from these blocks directly and attach system-side context
 * (digests, preambles) as separate channels instead of concatenating.
 */
export function asSlashPromptBlocks(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }]
}
