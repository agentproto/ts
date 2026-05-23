/**
 * `corpus events:emit <kind> --payload <json> [path]` — append to _log.md
 * `corpus events:tail [path]` — print _log.md
 */

import {
  CorpusEventEmitter,
  systemClock,
  type CorpusEventKind,
} from "@agentproto/corpus"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { OsIdentityAdapter } from "../ports/os-identity.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set<CorpusEventKind>([
  "corpus.candidate.discovered",
  "corpus.candidate.analyzed",
  "corpus.candidate.approved",
  "corpus.candidate.rejected",
  "corpus.entry.promoted",
  "corpus.entry.deprecated",
  "corpus.entry.archived",
  "corpus.gap.opened",
  "corpus.gap.resolved",
  "playbook.shadow.registered",
  "playbook.activated",
  "playbook.archived",
])

export async function runEventsEmit(
  args: readonly string[]
): Promise<ExitCode> {
  // First positional = kind, last positional = path (optional), rest in --flags
  const positionals: string[] = []
  let payloadStr: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--payload") {
      payloadStr = args[++i]
    } else if (a.startsWith("--payload=")) {
      payloadStr = a.slice("--payload=".length)
    } else if (a.startsWith("--")) {
      return fail(`events:emit: unknown flag ${a}`, 2)
    } else {
      positionals.push(a)
    }
  }

  const [kind, pathArg] = positionals
  if (!kind) {
    return fail(
      "events:emit requires a <kind> argument. Try `corpus events:emit corpus.entry.promoted --payload '{\"slug\":\"foo\"}'`.",
      2
    )
  }
  if (!KNOWN_EVENT_KINDS.has(kind)) {
    process.stderr.write(
      `corpus: warning — "${kind}" is not in the standard event taxonomy. Emitting anyway.\n`
    )
  }
  if (!payloadStr) {
    return fail(
      "events:emit requires --payload <json>. Pass at least `--payload '{}'`.",
      2
    )
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(payloadStr)
  } catch (e) {
    return fail(
      `events:emit: --payload must be valid JSON (${
        e instanceof Error ? e.message : String(e)
      })`,
      2
    )
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fail("events:emit: --payload must be a JSON object", 2)
  }

  const target = resolveWorkspacePath(pathArg)
  const fs = new NodeFsAdapter({ root: target })
  if (!(await fs.exists("KNOWLEDGE.md"))) {
    return fail(
      `events:emit: no KNOWLEDGE.md at ${target}. Run \`corpus init marketing\` first.`,
      1
    )
  }

  const emitter = new CorpusEventEmitter({
    fs,
    clock: systemClock,
    identity: new OsIdentityAdapter({ workspaceRoot: target }),
    workspaceRoot: "",
  })
  const event = await emitter.emit(kind as CorpusEventKind, payload)
  process.stdout.write(
    `corpus: emitted ${event.kind} at ${event.at} by ${event.actor}\n`
  )
  return 0
}

export async function runEventsTail(
  args: readonly string[]
): Promise<ExitCode> {
  const target = resolveWorkspacePath(args[0])
  const fs = new NodeFsAdapter({ root: target })
  if (!(await fs.exists("_log.md"))) {
    process.stdout.write(
      `corpus: _log.md does not exist yet at ${target}. Emit an event to create it.\n`
    )
    return 0
  }
  const content = await fs.readFile("_log.md")
  process.stdout.write(content)
  if (!content.endsWith("\n")) process.stdout.write("\n")
  return 0
}

