/**
 * AIP-41 routine runtime bridge — the piece that was missing before this
 * file existed: nothing read `.routines/<id>/ROUTINE.md` and turned it into a
 * live scheduled job. See `packages/routine/README.md` "Runtime bridge"
 * section for the full design writeup.
 *
 * `reconcile()` scans `<workspace>/.routines/<id>/ROUTINE.md`, validates each
 * with `@agentproto/routine`'s `parseRoutineManifest`, and for every
 * `enabled:true` + `schedule.kind:"cron"` routine registers (or updates) a
 * `CronScheduler` job tagged `label:"routine:<id>"`. `trigger()` fires a
 * routine's target immediately — bypassing both its schedule and its
 * `enabled` flag, same as `cron_run` bypasses an existing job's schedule —
 * without requiring a registered job to exist.
 *
 * Every target kind (tool / agent / workflow) resolves to the SAME
 * `{ tool, inputs }` pair before it ever reaches `CronScheduler` or
 * `dispatchTool` — one execution path, not three. `target.action` (AIP-39)
 * is validated but not dispatchable: no action resolver exists in this
 * runtime yet.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { parseRoutineManifest, type RoutineFrontmatter } from "@agentproto/routine"
import type { CronScheduler, CronAction } from "./cron-scheduler.js"

const JOB_LABEL_PREFIX = "routine:"

export interface RoutineDispatchTool {
  tool: string
  inputs: Record<string, unknown>
}

/**
 * Lowers a validated routine `target` to the one shape every execution path
 * understands. Throws a clear, caller-facing error for shapes this runtime
 * bridge doesn't dispatch yet (`action`, and the `ref`/`inline` forms of
 * `workflow` — see the SPEC for why).
 *
 * `routineId`, when passed, is stamped onto an `agent` target's `agent_start`
 * call as `origin: "routine:<id>"` — the same origin convention
 * `cron-scheduler.ts`'s native `kind:"agent"` action already uses for
 * `origin: "cron"` — so a routine-fired session is attributable back to its
 * routine in `session_list` / the sessions tree instead of looking like a
 * manual launch. `tool` / `workflow` targets pass inputs through verbatim
 * (unchanged): their tool handlers aren't guaranteed to accept `origin`.
 */
export function routineTargetToToolCall(
  target: RoutineFrontmatter["target"],
  routineId?: string,
): RoutineDispatchTool {
  if ("tool" in target) {
    return { tool: target.tool, inputs: (target.inputs as Record<string, unknown> | undefined) ?? {} }
  }
  if ("agent" in target) {
    const { adapter, prompt, model, cwd } = target.agent
    return {
      tool: "agent_start",
      inputs: {
        adapter,
        prompt,
        ...(model ? { model } : {}),
        ...(cwd ? { cwd } : {}),
        ...(routineId ? { origin: `${JOB_LABEL_PREFIX}${routineId}` } : {}),
      },
    }
  }
  if ("workflow" in target) {
    const w = target.workflow
    const file = typeof w === "string" ? w : w.file
    if (!file) {
      throw new Error(
        "target.workflow: only the 'file' form (or a bare string, treated as a file path) is " +
          "dispatchable by this runtime — 'ref'/'inline' forms have no saved-workflow registry to resolve against.",
      )
    }
    const inputs = (target.inputs as Record<string, unknown> | undefined) ?? undefined
    return { tool: "workflow_run_file", inputs: { path: file, ...(inputs ? { input: inputs } : {}) } }
  }
  // target.action — AIP-39 ACTION ref. Validated by the schema, not dispatchable here.
  throw new Error(
    `target.action ('${(target as { action: string }).action}') is not dispatchable by this runtime bridge — ` +
      "no AIP-39 action resolver is wired. Use target.tool instead.",
  )
}

interface ScheduleCronShape {
  kind: "cron"
  cron: string
  timezone?: string
}

function isScheduleCron(schedule: unknown): schedule is ScheduleCronShape {
  return (
    !!schedule &&
    typeof schedule === "object" &&
    (schedule as { kind?: unknown }).kind === "cron" &&
    typeof (schedule as { cron?: unknown }).cron === "string"
  )
}

interface ParsedRoutine {
  file: string
  frontmatter: RoutineFrontmatter
}

export interface ReconcileResult {
  /** Routine ids that now have a live cron job registered. */
  registered: string[]
  /** Routine ids parsed but not registered (disabled, or a non-cron schedule) with why. */
  skipped: Array<{ id: string; reason: string }>
  /** Cron jobs removed because their routine vanished, was disabled, or was superseded by a changed one. */
  removed: string[]
  /** Files that failed to parse/validate — collected, not fatal to the rest of the scan. */
  errors: Array<{ file: string; error: string }>
}

export interface RoutineRegistrar {
  /** Scan, validate, and reconcile cron jobs for every routine found. Safe to call repeatedly. */
  reconcile(): ReconcileResult
  /**
   * Re-parse one routine by id and fire its target immediately via
   * `dispatchTool` — bypasses the schedule AND the `enabled` flag, and
   * does not require `reconcile()` to have run first.
   */
  trigger(routineId: string): Promise<{ ok: boolean; summary: string }>
  /** Routine frontmatters known from the last `reconcile()` (parse errors excluded). */
  list(): RoutineFrontmatter[]
}

function scanRoutineFiles(routinesDir: string): Array<{ id: string; file: string }> {
  if (!existsSync(routinesDir)) return []
  const entries: Array<{ id: string; file: string }> = []
  for (const dirent of readdirSync(routinesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const file = join(routinesDir, dirent.name, "ROUTINE.md")
    if (existsSync(file)) entries.push({ id: dirent.name, file })
  }
  return entries
}

/** Stable content signature — used to decide whether an already-registered job needs delete+recreate. */
function actionSignature(schedule: ScheduleCronShape, action: CronAction): string {
  return JSON.stringify({ schedule, action })
}

export function createRoutineRegistrar(opts: {
  workspace: string
  cronScheduler: CronScheduler
  dispatchTool: (name: string, inputs: Record<string, unknown>) => Promise<unknown>
}): RoutineRegistrar {
  const { workspace, cronScheduler, dispatchTool } = opts
  const routinesDir = join(workspace, ".routines")

  let lastParsed: ParsedRoutine[] = []

  const parseAll = (): { parsed: ParsedRoutine[]; errors: ReconcileResult["errors"] } => {
    const parsed: ParsedRoutine[] = []
    const errors: ReconcileResult["errors"] = []
    for (const { file } of scanRoutineFiles(routinesDir)) {
      try {
        const source = readFileSync(file, "utf8")
        const manifest = parseRoutineManifest(source)
        parsed.push({ file, frontmatter: manifest.frontmatter })
      } catch (err) {
        errors.push({ file, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { parsed, errors }
  }

  return {
    reconcile() {
      const { parsed, errors } = parseAll()
      lastParsed = parsed

      const registered: string[] = []
      const skipped: ReconcileResult["skipped"] = []
      const removed: string[] = []

      // routineId → existing job, from cron jobs this registrar owns (label prefix).
      const existingByRoutineId = new Map<string, ReturnType<CronScheduler["list"]>[number]>()
      for (const job of cronScheduler.list()) {
        if (job.label?.startsWith(JOB_LABEL_PREFIX)) {
          existingByRoutineId.set(job.label.slice(JOB_LABEL_PREFIX.length), job)
        }
      }

      const desiredIds = new Set<string>()

      for (const { frontmatter } of parsed) {
        const id = frontmatter.id
        if (!frontmatter.enabled) {
          skipped.push({ id, reason: "enabled: false" })
          continue
        }
        if (!isScheduleCron(frontmatter.schedule)) {
          const kind =
            frontmatter.schedule && typeof frontmatter.schedule === "object"
              ? String((frontmatter.schedule as { kind?: unknown }).kind ?? "unknown")
              : "unknown"
          skipped.push({ id, reason: `schedule.kind '${kind}' not yet supported by the runtime registrar — only 'cron' fires today` })
          continue
        }
        desiredIds.add(id)

        let call: RoutineDispatchTool
        try {
          call = routineTargetToToolCall(frontmatter.target, id)
        } catch (err) {
          skipped.push({ id, reason: err instanceof Error ? err.message : String(err) })
          continue
        }

        const schedule: ScheduleCronShape = {
          kind: "cron",
          cron: frontmatter.schedule.cron,
          ...(frontmatter.schedule.timezone ? { timezone: frontmatter.schedule.timezone } : {}),
        }
        const action: CronAction = { kind: "tool", tool: call.tool, inputs: call.inputs }
        const signature = actionSignature(schedule, action)

        const existing = existingByRoutineId.get(id)
        if (existing) {
          const existingSignature = actionSignature(
            { kind: "cron", cron: existing.schedule, ...(existing.timezone ? { timezone: existing.timezone } : {}) },
            existing.action,
          )
          if (existingSignature === signature) {
            // Unchanged — leave it alone.
            registered.push(id)
            continue
          }
          cronScheduler.delete(existing.id)
          removed.push(existing.id)
        }

        cronScheduler.create({
          label: `${JOB_LABEL_PREFIX}${id}`,
          schedule: schedule.cron,
          ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
          recurring: true,
          action,
        })
        registered.push(id)
      }

      // Any registrar-owned job whose routine no longer wants a schedule
      // (vanished, disabled, or a non-cron schedule now) gets removed.
      for (const [id, job] of existingByRoutineId) {
        if (!desiredIds.has(id)) {
          cronScheduler.delete(job.id)
          removed.push(job.id)
        }
      }

      return { registered, skipped, removed, errors }
    },

    async trigger(routineId) {
      const { parsed, errors } = parseAll()
      lastParsed = parsed
      const found = parsed.find(p => p.frontmatter.id === routineId)
      if (!found) {
        const parseError = errors.find(e => e.file.includes(`/${routineId}/`))
        throw new Error(
          parseError
            ? `routine '${routineId}' failed to parse: ${parseError.error}`
            : `routine '${routineId}' not found under ${routinesDir}`,
        )
      }
      const call = routineTargetToToolCall(found.frontmatter.target, routineId)
      const result = await dispatchTool(call.tool, call.inputs)
      const r = result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
      const text = (r?.content ?? []).map(c => c.text ?? "").join("\n").trim()
      const ok = !r?.isError
      return { ok, summary: text || (ok ? `tool '${call.tool}' ok` : `tool '${call.tool}' failed`) }
    },

    list() {
      return lastParsed.map(p => p.frontmatter)
    },
  }
}
