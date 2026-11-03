/**
 * Pure summary builder for the supervised PR-review workflow run.
 *
 * The pr-review lane is ONE supervised workflow: `review` -> (when changes
 * are requested) `fix` -> `review` again, bounded by `maxFixIterations`.
 * Everything that renders that loop outside the daemon (the CI job's check
 * run, the `agentproto-run` driver's step summary, the entry tests) uses this
 * module so the stage names, the diagram and the verdict wording exist once.
 *
 * Input is the `workflow_status` run record (full form, with step outputs) or
 * any object with the same `{ status, stages: [{ steps: [{ id, status,
 * output }] }] }` shape. Nothing here throws on a partial/odd record: an
 * unknown shape degrades to the run status, never to a false approval.
 */

export const REVIEW_STEP_ID = "review"
export const FIX_STEP_ID = "fix"

/** Human-readable control-flow diagram for the supervised loop. */
export function stageDiagram(maxFixIterations = 3) {
  const n = Number.isInteger(maxFixIterations) && maxFixIterations >= 0 ? maxFixIterations : 3
  return [
    "review",
    `  -> changes requested? -> fix -> re-review`,
    `  -> repeat until approved or ${n} fix round(s) exhausted`,
  ].join("\n")
}

/** Normalize a step key: `review[2]` (a map item) -> `review`. */
export function normalizeStepId(id) {
  return String(id ?? "").replace(/\[[^\]]*\]$/, "")
}

const POSTED_REVIEW_LINE = /^\s*Review posted\b.*\((APPROVE|APPROVED|REQUEST[_ ]CHANGES|CHANGES[_ ]REQUESTED)\)[.\s]*$/im

/**
 * The verdict of an agent step that has no `outputSchema` (the single-step
 * pr-review lane): its output is `{ sessionId, text }`, `text` being the
 * agent's final message. Two shapes are recognized, both anchored so prose
 * that merely mentions a verdict never reads as one: a JSON verdict object
 * (the "local" placement's contract) and the "Review posted: <url> (APPROVE)"
 * line the reviewer ends with after posting through `gh` / REST.
 */
function verdictFromText(text) {
  if (typeof text !== "string" || !text.trim()) return undefined
  const trimmed = text.trim()
  // The verdict object may be followed by prose and preceded by other braces:
  // try each `{` up to the last `}`.
  const end = trimmed.lastIndexOf("}")
  for (let i = trimmed.indexOf("{"); i !== -1 && i < end; i = trimmed.indexOf("{", i + 1)) {
    try {
      const verdict = verdictFromValue(JSON.parse(trimmed.slice(i, end + 1)))
      if (verdict) return verdict
    } catch {
      // not a JSON object from here - keep looking, then the posted-review line
    }
  }
  const m = POSTED_REVIEW_LINE.exec(trimmed)
  if (!m) return undefined
  const conclusion = /^APPROVE/i.test(m[1]) ? "approve" : "request_changes"
  return { conclusion, summary: "", findings: [] }
}

function verdictFromValue(value) {
  const conclusion = value?.conclusion
  if (conclusion === "approve" || conclusion === "request_changes") {
    return {
      conclusion,
      summary: typeof value.summary === "string" ? value.summary : "",
      findings: Array.isArray(value.findings) ? value.findings : [],
    }
  }
  return undefined
}

/** The review verdict carried by one step record, when it has one. */
export function reviewVerdictOf(step) {
  const out = step?.output
  if (!out || typeof out !== "object") return undefined
  // An agent step's output is `{ sessionId, output: <schema value> }`.
  const value = out.output && typeof out.output === "object" ? out.output : out
  return verdictFromValue(value) ?? verdictFromText(out.text)
}

function stepsOf(run) {
  const stages = Array.isArray(run?.stages) ? run.stages : []
  const steps = []
  for (const stage of stages) {
    for (const step of Array.isArray(stage?.steps) ? stage.steps : []) steps.push(step)
  }
  return steps
}

/** The ordered review/fix stage log, one entry per executed step. */
export function reviewStages(run) {
  const entries = []
  for (const step of stepsOf(run)) {
    const id = normalizeStepId(step?.id ?? step?.label)
    if (id !== REVIEW_STEP_ID && id !== FIX_STEP_ID) continue
    const verdict = id === REVIEW_STEP_ID ? reviewVerdictOf(step) : undefined
    entries.push({
      id,
      status: step?.status ?? "unknown",
      ...(step?.error ? { error: String(step.error) } : {}),
      ...(verdict
        ? { conclusion: verdict.conclusion, summary: verdict.summary, findings: verdict.findings }
        : {}),
    })
  }
  return entries
}

/**
 * The ordered stage log from the run's AIP-58 EVENT LOG - one row per
 * EXECUTION, so a loop that re-ran `review` three times reads as
 * `review`, `fix`, `review`, `fix`, `review` instead of the run record's
 * one deduped row per step id. `events` is the `run_events` page; only
 * `step.started` / `step.succeeded` / `step.failed` for the review/fix ids
 * are used. Its rows carry no per-iteration verdict (the verdict JSON is on
 * the run's step output, which holds the LAST pass); the final verdict is
 * still folded from `reviewVerdictOf` over the run's step rows.
 */
export function reviewStagesFromEvents(events) {
  const entries = []
  for (const ev of Array.isArray(events) ? events : []) {
    const id = normalizeStepId(ev?.stepId ?? ev?.id)
    if (id !== REVIEW_STEP_ID && id !== FIX_STEP_ID) continue
    if (ev.type === "step.started") {
      entries.push({ id, status: "started" })
    } else if (ev.type === "step.succeeded" || ev.type === "step.failed") {
      const row = entries.filter((e) => e.id === id).at(-1)
      const status = ev.type === "step.succeeded" ? "done" : "failed"
      if (row && row.status === "started") row.status = status
      else entries.push({ id, status, ...(ev.data?.message ? { error: String(ev.data.message) } : {}) })
    }
  }
  return entries
}

/**
 * Fold a run record into the check-run title + markdown summary.
 *
 * Returns `{ title, summary, verdict, reviews, fixes }` where `verdict` is
 * `"approved" | "changes_requested" | "failed" | "incomplete"` and `reviews` /
 * `fixes` are the counts of executed review / fix steps. `verdict` follows the
 * LAST review verdict when one exists, else the run status - an absent output
 * is never read as approval.
 */
export function buildReviewSummary(run, { maxFixIterations = 3, events } = {}) {
  const recordEntries = reviewStages(run)
  const eventEntries = reviewStagesFromEvents(events)
  const entries = eventEntries.length > 0 ? eventEntries : recordEntries
  const reviews = entries.filter(e => e.id === REVIEW_STEP_ID)
  const fixes = entries.filter(e => e.id === FIX_STEP_ID)
  // The verdict always comes from the run record's LAST review output (the
  // event log carries no payload); counts/rows may come from the events.
  const recordReviews = recordEntries.filter(e => e.id === REVIEW_STEP_ID)
  const lastReview =
    recordReviews.length > 0 ? recordReviews[recordReviews.length - 1] : undefined

  let verdict = "incomplete"
  if (lastReview?.conclusion === "approve") verdict = "approved"
  else if (lastReview?.conclusion === "request_changes") verdict = "changes_requested"
  else if (run?.status === "failed" || run?.status === "cancelled") verdict = "failed"

  const title =
    verdict === "approved"
      ? "Agentic review: approved"
      : verdict === "changes_requested"
        ? "Agentic review: changes requested"
        : verdict === "failed"
          ? "Agentic review: run failed"
          : "Agentic review: incomplete"

  // Annotate the last review row with the folded verdict so the table names
  // the outcome even when the rows came from the event log.
  if (lastReview && entries.length > 0) {
    const lastIdx = entries.map((e) => e.id).lastIndexOf(REVIEW_STEP_ID)
    if (lastIdx !== -1 && !entries[lastIdx].conclusion) {
      entries[lastIdx] = {
        ...entries[lastIdx],
        conclusion: lastReview.conclusion,
        summary: lastReview.summary,
      }
    }
  }

  const lines = [
    `### ${title}`,
    "",
    "Stage diagram:",
    "",
    "```",
    stageDiagram(maxFixIterations),
    "```",
    "",
    `- run status: ${run?.status ?? "unknown"}`,
    `- reviews: ${reviews.length}`,
    `- fixes: ${fixes.length}`,
    `- final verdict: ${verdict.replaceAll("_", " ").toUpperCase()}`,
    "",
    "| stage | step | status | verdict |",
    "| --- | --- | --- | --- |",
  ]
  for (const entry of entries) {
    const detail = entry.conclusion
      ? `${entry.conclusion}${entry.summary ? ` - ${entry.summary}` : ""}`
      : (entry.error ?? "")
    lines.push(
      `| ${entry.id === REVIEW_STEP_ID ? "review" : "fix"} | ${entry.id} | ${entry.status} | ${escapeCell(detail)} |`,
    )
  }
  if (entries.length === 0) lines.push("| - | - | - | no review step ran |")
  if (run?.error) {
    lines.push("", `Run error: \`${String(run.error).slice(0, 400)}\``)
  }
  return { title, summary: lines.join("\n"), verdict, reviews: reviews.length, fixes: fixes.length }
}

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .slice(0, 300)
}
