import { type TaskRecord, readAll } from "@agentproto/collect"
import { type ExitCode, type Io, UsageError, out, outJson, table } from "../io"
import { parse, positional } from "../args"
import { storePathOf } from "../load"
import { open } from "./shared"

const STORE_OPTION = { store: { type: "string" } } as const

export async function runRuns(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, STORE_OPTION)
  positional(positionals, "none", 0)
  const store = await open(storePathOf(io, values.store))
  const rows = []
  for (const id of (await store.listRuns()).sort()) {
    const run = await store.getRun(id)
    const report = await store.readReport(id)
    rows.push({
      runId: id,
      name: run?.recipe.name,
      createdAt: run?.createdAt,
      state: report?.finishedAt ? "finished" : "unfinished",
      connectors: (report?.connectors ?? []).map((c) => ({ connector: c.connector, status: c.status })),
    })
  }
  if (values.json) outJson(io, rows)
  else if (rows.length === 0) out(io, "no runs yet")
  else {
    out(io, table([["run", "name", "created", "state"], ...rows.map((r) => [r.runId, r.name ?? "", r.createdAt ?? "", r.state])]))
  }
  return 0
}

export async function runStatus(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, STORE_OPTION)
  const [runId] = positional(positionals, "runId")
  const store = await open(storePathOf(io, values.store))
  const run = await store.getRun(runId!)
  if (!run) throw new UsageError(`unknown run ${runId}`)
  const report = await store.readReport(runId!)
  const latest = new Map<string, TaskRecord>()
  for (const t of (await readAll(store.tasks(runId!))).records) latest.set(`${t.connector}/${t.taskId}`, t)
  const byStatus: Record<string, number> = {}
  const failures: Record<string, number> = {}
  for (const t of latest.values()) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
    if (t.status === "failed") failures[t.cause ?? "other"] = (failures[t.cause ?? "other"] ?? 0) + 1
  }
  const state = report?.finishedAt ? "finished" : "unfinished"
  if (values.json) {
    outJson(io, { runId, name: run.recipe.name, createdAt: run.createdAt, state, tasks: byStatus, failures, report: report ?? null })
    return 0
  }
  out(io, `run ${runId}${run.recipe.name ? ` (${run.recipe.name})` : ""}: ${state}`)
  out(io, `tasks: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`)
  if (Object.keys(failures).length) out(io, `failures: ${Object.entries(failures).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  if (report) {
    out(io, table([["connector", "status", "new", "obs", "dup"], ...report.connectors.map((c) => [c.connector, c.status, String(c.newItems), String(c.observations), String(c.duplicates)])]))
  }
  if (state === "unfinished") out(io, `continue with: collect resume ${runId}`)
  return 0
}
