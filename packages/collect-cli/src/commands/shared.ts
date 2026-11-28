import {
  type Connector,
  CollectRunError,
  type RunReport,
  type TaskRecord,
  StoreLockedError,
  StoreVersionError,
  createCollector,
} from "@agentproto/collect"
import { StoreMigrationError, StoreNotFoundError, openStore } from "@agentproto/collect/node"
import type { CollectStore } from "@agentproto/collect"
import { type ExitCode, type Io, UsageError, err, out, outJson, table } from "../io"
import { type LoadedConnectors, buildTransports, envSecrets, readRunSidecar, writeRunSidecar } from "../load"

/** Map a thrown error to an exit code and a message; `undefined` when it is not one of ours. */
export function classify(e: unknown): { code: ExitCode; message: string } | undefined {
  const cause = e instanceof CollectRunError ? e.cause : e
  if (cause instanceof UsageError) return { code: 2, message: cause.message }
  if (cause instanceof StoreLockedError) {
    const h = cause.holder
    return { code: 3, message: `store is locked${h ? ` by pid ${h.pid} since ${h.at}` : ""}; wait for the other run to end` }
  }
  if (cause instanceof StoreNotFoundError) return { code: 3, message: `${cause.message}; create it with: collect init <path>` }
  if (cause instanceof StoreVersionError || cause instanceof StoreMigrationError) return { code: 3, message: cause.message }
  if (cause && typeof cause === "object" && "code" in cause && ["EACCES", "EPERM", "ENOENT", "EISDIR", "ENOTDIR"].includes(String((cause as { code: unknown }).code))) {
    return { code: 3, message: `store unreadable: ${String((cause as { message?: unknown }).message)}` }
  }
  return undefined
}

export async function open(path: string): Promise<CollectStore> {
  return openStore(path)
}

/** Progress goes to stderr: human lines, or one JSON object per line with --json. */
export function progress(io: Io, json: boolean, quiet: boolean) {
  return (event: { type: string; at: string; runId: string; data?: Record<string, unknown> }) => {
    if (quiet) return
    if (json) return err(io, JSON.stringify(event))
    const d = event.data ? ` ${Object.entries(event.data).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}` : ""
    err(io, `[${event.type}]${d}`)
  }
}

/** A connector or task that did not finish cleanly makes the run a partial failure. */
export function reportExit(report: RunReport, interrupted: boolean, unexpectedSkips: number): ExitCode {
  if (interrupted || unexpectedSkips > 0) return 1
  const bad = report.connectors.some((c) => c.status === "failed" || c.status === "skipped" || c.tasks.failed > 0)
  return bad ? 1 : 0
}

/** Tasks left out for a reason other than a cap the user asked for. */
async function countUnexpectedSkips(store: CollectStore, runId: string): Promise<number> {
  const latest = new Map<string, TaskRecord>()
  for await (const t of store.tasks(runId)) latest.set(`${t.connector}/${t.taskId}`, t)
  let n = 0
  for (const t of latest.values()) {
    if (t.status === "pending" || t.status === "started") n++
    else if (t.status === "skipped" && !/cap reached/.test(t.reason ?? "")) n++
  }
  return n
}

export function renderReport(report: RunReport): string {
  const rows = [["connector", "status", "tasks done/failed/skipped", "new", "obs", "dup"]]
  for (const c of report.connectors) {
    rows.push([c.connector, c.status, `${c.tasks.done}/${c.tasks.failed}/${c.tasks.skipped} of ${c.tasks.planned}`, String(c.newItems), String(c.observations), String(c.duplicates)])
  }
  const lines = [`run ${report.runId}`, table(rows)]
  for (const c of report.connectors) {
    const why = [c.skippedReason, c.reason].filter(Boolean).join("; ")
    if (why) lines.push(`${c.connector}: ${why}`)
    const f = Object.entries(c.failures).map(([k, v]) => `${k}=${v}`).join(" ")
    if (f) lines.push(`${c.connector}: failures ${f}`)
    for (const e of c.escalations) lines.push(`${c.connector}: escalated ${e.from} -> ${e.to} (${e.count})`)
  }
  return lines.join("\n")
}

/** Run or resume with a collector over the CLI transports, then print the report. */
export async function execute(
  io: Io,
  opts: {
    storePath: string
    json: boolean
    quiet: boolean
    connectors: Connector[]
    loaded: LoadedConnectors
    modules: string[]
    rateMs?: number
    start: (collector: ReturnType<typeof createCollector>, onEvent: ReturnType<typeof progress>) => Promise<RunReport>
  },
): Promise<ExitCode> {
  const store = await open(opts.storePath)
  const collector = createCollector({
    store,
    transports: buildTransports(opts.connectors, opts.loaded, io.env, opts.rateMs),
    secrets: envSecrets(io.env),
    connectors: opts.loaded.registry,
  })
  const emit = progress(io, opts.json, opts.quiet)
  let sidecar: Promise<void> | undefined
  const report = await opts.start(collector, (event) => {
    sidecar ??= writeRunSidecar(opts.storePath, event.runId, opts.modules).catch(() => undefined)
    emit(event)
  })
  await sidecar
  const interrupted = io.signal?.aborted === true
  if (opts.json) outJson(io, { ...report, interrupted })
  else {
    out(io, renderReport(report))
    if (interrupted) out(io, `interrupted: continue with: collect resume ${report.runId}`)
  }
  return reportExit(report, interrupted, await countUnexpectedSkips(store, report.runId))
}

export { readRunSidecar }
