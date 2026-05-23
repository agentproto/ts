/**
 * CorpusEventEmitter — append-only writer for `_log.md`.
 *
 * The corpus' audit trail. Every state transition (candidate
 * discovered/analyzed/approved/rejected, entry promoted/deprecated,
 * playbook activated/archived, gap opened/resolved) appends one line
 * here.
 *
 * Line format (NDJSON-ish, but inside a markdown file for AIP-10
 * conformance — _log.md is the canonical AIP-10 log doctype):
 *
 *   - {ISO}  {kind}  by {actor}  payload={JSON}
 *
 * Concrete:
 *
 *   - 2026-05-22T14:30:00.000Z  corpus.entry.promoted  by ws://operators/corpus-curator  payload={"slug":"contrarian-short-form-hooks","kind":"pattern"}
 *
 * Why line-per-event (not blocks): every host needs to grep / tail /
 * stream the log without a markdown parser. Inside an .md file =
 * AIP-10 conformant; line-format = ops-friendly.
 *
 * Atomicity: relies on FsPort.appendFile being atomic against
 * concurrent appends. Hosts MUST honor that — cloud topology uses
 * append APIs (S3 Express, GCS), local topology uses POSIX append
 * (atomic up to PIPE_BUF).
 */

import type { FsPort } from "../ports/fs.port.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import type {
  CorpusEvent,
  CorpusEventKind,
} from "../types.js"

export interface CorpusEventEmitterOptions {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly identity: IdentityPort
  /**
   * Workspace root the emitter targets — `_log.md` is written
   * relative to this. Hosts that mount multiple corpora pass one
   * emitter per workspace root.
   */
  readonly workspaceRoot: string
}

export class CorpusEventEmitter {
  constructor(private readonly opts: CorpusEventEmitterOptions) {}

  /**
   * Emit one event. Returns the event as written (including the
   * ISO timestamp and actor resolved at emit time). The .md log file
   * is created on first append if missing.
   */
  async emit(
    kind: CorpusEventKind,
    payload: Readonly<Record<string, unknown>>
  ): Promise<CorpusEvent> {
    const identity = await this.opts.identity.resolve()
    const event: CorpusEvent = {
      kind,
      at: this.opts.clock.now().toISOString(),
      actor: identity.principal,
      payload,
    }
    const logPath = joinPath(this.opts.workspaceRoot, "_log.md")
    const line = formatLine(event) + "\n"

    // Initialize the log file with an AIP-10 conformant header on
    // first write, so a fresh corpus' _log.md is also a valid
    // markdown doc (not just a JSON-lines stream).
    if (!(await this.opts.fs.exists(logPath))) {
      await this.opts.fs.writeFile(
        logPath,
        "# Corpus activity log\n\n" +
          "Append-only AIP-10 log of corpus state transitions. Each line:\n" +
          "`- <iso>  <kind>  by <actor>  payload=<json>`\n\n"
      )
    }
    await this.opts.fs.appendFile(logPath, line)
    return event
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatLine(event: CorpusEvent): string {
  // Compact JSON keeps lines greppable. Sort keys for deterministic
  // diffs across emitters running on the same workspace.
  const payload = JSON.stringify(event.payload, [...Object.keys(event.payload).sort()])
  return `- ${event.at}  ${event.kind}  by ${event.actor}  payload=${payload}`
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  return a.endsWith("/") ? a + b : a + "/" + b
}
