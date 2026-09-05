/**
 * loadWorkflowHandle — read a WORKFLOW.md off disk into a WorkflowHandle.
 *
 * The pure packages stop at the page boundary: `@agentproto/workflow` parses a
 * manifest *string*, `@agentproto/workflow-runtime` compiles an in-memory
 * handle. Neither touches the filesystem. This is the host-side seam that does:
 *
 *   read file → parse manifest → (if `entry`) import the module + reconcile
 *
 * With no `entry`, the manifest IS the workflow (purely-declarative path). With
 * an `entry`, its default-exported handle is the source of truth for runtime
 * step logic and the manifest is reconciled against it — the two MUST agree.
 *
 * The entry import mirrors the CLI's adapter loader: resolve relative to the
 * manifest's directory, import via a `file://` URL so an absolute path works
 * without an `exports` declaration.
 */

import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  parseWorkflowManifest,
  workflowFromManifest,
  type WorkflowManifest,
} from "@agentproto/workflow/manifest"
import type { WorkflowHandle } from "@agentproto/workflow"

import { reconcileEntry } from "./reconcile.js"

export class WorkflowLoadError extends Error {
  constructor(message: string) {
    super(`loadWorkflow: ${message}`)
    this.name = "WorkflowLoadError"
  }
}

/** A handle is a plain object carrying an `id` and a `steps` array. */
function isWorkflowHandle(v: unknown): v is WorkflowHandle {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    Array.isArray((v as { steps?: unknown }).steps)
  )
}

/**
 * Translate a declarative `subworkflow` step's `with:` block into the `inputs`
 * projection the runtime compiler threads into `step.input(b)` (AIP-16 ref
 * grammar: `$input.*`, `$steps.<id>.*`, literals — resolved against the
 * PARENT's bindings). Without this, a manifest `with:` is dead documentation:
 * the child receives the parent's raw input verbatim. Steps without `with:`
 * are left untouched. Nested step lists (map / loop / parallel bodies and
 * branch arms) are walked too.
 */
function translateSubworkflowWith(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: unknown,
  knownStepIds: ReadonlySet<string>,
): void {
  if (!Array.isArray(steps)) return
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue
    const s = step as Record<string, unknown>
    if (s.kind === "subworkflow" && s.with !== undefined) {
      const id = typeof s.id === "string" ? s.id : "(unid)"
      if (s.inputs !== undefined) {
        throw new WorkflowLoadError(
          `subworkflow step '${id}' declares both 'with' and 'inputs' — use one`,
        )
      }
      assertWithStepRefs(s.with, `subworkflow step '${id}' with`, knownStepIds)
      s.inputs = s.with
      delete s.with
    }
    translateSubworkflowWith(s.steps, knownStepIds)
    if (Array.isArray(s.branches)) {
      for (const br of s.branches)
        translateSubworkflowWith((br as Record<string, unknown>)?.steps, knownStepIds)
    }
  }
}

/** Statically reject a `$steps.<id>` ref in a `with:` block that names a step
 *  id this workflow doesn't declare — at load time, naming the step + key. */
function assertWithStepRefs(
  node: unknown,
  label: string,
  knownStepIds: ReadonlySet<string>,
): void {
  if (typeof node === "string") {
    if (node.startsWith("$$")) return
    const m = node.match(/^\$steps\.([^.]+)/)
    if (m && !knownStepIds.has(m[1]!)) {
      throw new WorkflowLoadError(
        `${label} references unknown step '${m[1]}' via '${node}' — ` +
          `no step with that id exists in this workflow`,
      )
    }
    return
  }
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertWithStepRefs(n, `${label}[${i}]`, knownStepIds))
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>))
      assertWithStepRefs(v, `${label}.${k}`, knownStepIds)
  }
}

/**
 * Resolve every `kind: "agent"` step's `harness.promptFile` (AIP-15 P2),
 * relative to the WORKFLOW.md's own directory: read the file's raw bytes,
 * use its decoded text as the step's `prompt` (replacing any inline one),
 * and record `harness.promptSha` (sha256 hex of the raw bytes) on the step
 * so a consumer can verify exactly which prompt version a run used. Nested
 * step lists (map / loop / parallel bodies, branch arms) are walked too —
 * same traversal shape as {@link translateSubworkflowWith}.
 */
async function applyAgentHarnessPromptFiles(
  steps: unknown,
  workflowMdPath: string,
): Promise<void> {
  if (!Array.isArray(steps)) return
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue
    const s = step as Record<string, unknown>
    if (s.kind === "agent" && s.harness && typeof s.harness === "object") {
      const harness = s.harness as Record<string, unknown>
      const promptFile = harness.promptFile
      if (typeof promptFile === "string" && promptFile.length > 0) {
        const abs = isAbsolute(promptFile)
          ? promptFile
          : join(dirname(workflowMdPath), promptFile)
        let bytes: Buffer
        try {
          bytes = await readFile(abs)
        } catch (err) {
          const id = typeof s.id === "string" ? s.id : "(unid)"
          throw new WorkflowLoadError(
            `agent step '${id}': cannot read harness.promptFile '${promptFile}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
        s.prompt = bytes.toString("utf8").trim()
        harness.promptSha = createHash("sha256").update(bytes).digest("hex")
      }
      await applyAgentHarnessKnowledge(harness, s, workflowMdPath)
    }
    await applyAgentHarnessPromptFiles(s.steps, workflowMdPath)
    if (Array.isArray(s.branches)) {
      for (const br of s.branches) {
        await applyAgentHarnessPromptFiles((br as Record<string, unknown>)?.steps, workflowMdPath)
      }
    }
  }
}

/**
 * True when a selector string carries a `$…` run-time reference — such a
 * string is left untouched here and resolved per run by
 * `resolveKnowledgeSelectors` in `@agentproto/workflow-runtime`.
 */
function hasRef(s: string): boolean {
  return s.includes("$")
}

/**
 * Resolve every `harness.knowledge[]` selector's `workspace` (AIP-15 P2),
 * relative to the WORKFLOW.md's own directory — the same rule
 * `harness.promptFile` follows — rewriting it in place to the absolute path
 * so the runtime materializer never re-resolves against a different cwd. A
 * workspace directory that does not exist fails the load, as does a `mode`
 * other than the v1-only `"files"`.
 *
 * Exception: a selector whose `workspace` (or any tag/kind string) contains a
 * `$` carries run-time references (AIP-16 grammar) — its strings are left
 * verbatim, no relative resolution and no existence check happens here, and
 * the selector is flagged `deferred: true` (an internal field the runtime
 * consumes and strips; a user-authored `deferred` is rejected).
 */
async function applyAgentHarnessKnowledge(
  harness: Record<string, unknown>,
  step: Record<string, unknown>,
  workflowMdPath: string,
): Promise<void> {
  const knowledge = harness.knowledge
  if (!Array.isArray(knowledge)) return
  const id = typeof step.id === "string" ? step.id : "(unid)"
  for (const [i, sel] of knowledge.entries()) {
    if (sel === null || typeof sel !== "object") continue
    const selector = sel as Record<string, unknown>
    if (selector.mode !== undefined && selector.mode !== "files") {
      throw new WorkflowLoadError(
        `agent step '${id}': harness.knowledge[${i}].mode must be "files" (v1 supports no other mode); got ${
          typeof selector.mode === "string" ? `"${selector.mode}"` : String(selector.mode)
        }`,
      )
    }
    if (selector.deferred !== undefined) {
      throw new WorkflowLoadError(
        `agent step '${id}': harness.knowledge[${i}].deferred is an internal loader field and cannot be authored`,
      )
    }
    const workspace = selector.workspace
    if (typeof workspace !== "string" || workspace.length === 0) continue
    const tagStrings = [
      ...(Array.isArray(selector.anyOf) ? selector.anyOf : []),
      ...(Array.isArray(selector.allOf) ? selector.allOf : []),
      ...(Array.isArray(selector.kinds) ? selector.kinds : []),
    ].filter((t): t is string => typeof t === "string")
    if (hasRef(workspace) || tagStrings.some(hasRef)) {
      selector.deferred = true
      // A workspace without a ref still resolves (and is still existence-
      // checked) against the WORKFLOW.md dir even when only the tags/kinds
      // carry refs — otherwise a relative `./corpus` would be joined to the
      // run cwd at materialization time, which is not its base.
      if (hasRef(workspace)) continue
    }
    const abs = isAbsolute(workspace)
      ? workspace
      : join(dirname(workflowMdPath), workspace)
    let st
    try {
      st = await stat(abs)
    } catch {
      st = null
    }
    if (st === null || !st.isDirectory()) {
      throw new WorkflowLoadError(
        `agent step '${id}': harness.knowledge[${i}].workspace '${workspace}' does not name an existing directory (resolved to '${abs}')`,
      )
    }
    selector.workspace = abs
  }
}

/** Collect every step id declared anywhere in a manifest step list,
 *  including nested map / loop / parallel / branch bodies. */
function collectManifestStepIds(steps: unknown, ids: Set<string> = new Set()): Set<string> {
  if (!Array.isArray(steps)) return ids
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue
    const s = step as Record<string, unknown>
    if (typeof s.id === "string") ids.add(s.id)
    collectManifestStepIds(s.steps, ids)
    if (Array.isArray(s.branches)) {
      for (const br of s.branches)
        collectManifestStepIds((br as Record<string, unknown>)?.steps, ids)
    }
  }
  return ids
}

async function importEntryHandle(
  workflowMdPath: string,
  entry: string,
): Promise<WorkflowHandle> {
  const abs = isAbsolute(entry) ? entry : join(dirname(workflowMdPath), entry)

  // Cache-bust the ESM import by mtime so a long-lived daemon re-reads an edited
  // entry.mjs instead of serving Node's process-lifetime URL-cached module —
  // which, because the manifest IS re-read fresh, would otherwise fail
  // reconcileEntry with a spurious step-count mismatch after an edit. Fresh
  // daemons / CI boot cold, so they never need it — this only helps the dev loop.
  //
  // Skipped under the Vite/vitest transform (`process.env.VITEST`): Vite owns
  // import() resolution there and rejects a query on a file URL (and a failed
  // attempt poisons its resolver for the plain retry too), while a test process
  // never has the long-lived-daemon staleness this guards against.
  let href = pathToFileURL(abs).href
  if (!process.env.VITEST) {
    try {
      const url = pathToFileURL(abs)
      url.searchParams.set("v", String((await stat(abs)).mtimeMs))
      href = url.href
    } catch {
      // stat race with an in-flight edit — fall back to the plain URL.
    }
  }

  let mod: Record<string, unknown>
  try {
    mod = (await import(href)) as Record<string, unknown>
  } catch (err) {
    throw new WorkflowLoadError(
      `cannot import entry '${entry}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const exported = mod.default
  if (!isWorkflowHandle(exported)) {
    throw new WorkflowLoadError(
      `entry '${entry}' must default-export a WorkflowHandle (e.g. from defineWorkflow) ` +
        `carrying an 'id' + 'steps'; got ${exported === undefined ? "no default export" : typeof exported}.`,
    )
  }
  return exported
}

/**
 * Load and validate a WORKFLOW.md at `workflowMdPath` into a WorkflowHandle.
 * Throws {@link WorkflowLoadError} on a missing/unreadable file or a bad entry
 * module, the parser's error on invalid frontmatter, and
 * {@link WorkflowReconcileError} when an entry's graph disagrees with the
 * manifest. The returned handle still needs `compileWorkflow` + a tool registry
 * to run — this stops at the validated, in-memory handle.
 */
export async function loadWorkflowHandle(
  workflowMdPath: string,
): Promise<WorkflowHandle> {
  let source: string
  try {
    source = await readFile(workflowMdPath, "utf8")
  } catch (err) {
    throw new WorkflowLoadError(
      `cannot read '${workflowMdPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const manifest: WorkflowManifest = parseWorkflowManifest(source)
  // gray-matter memoizes its YAML parse by content — a second load of an
  // identical manifest would otherwise hand back the SAME objects a previous
  // load already rewrote in place (absolute workspaces, prompt text, the
  // internal `deferred` flag), breaking the authored-field rejection and
  // re-resolving against a stale base. Clone so every load starts clean.
  manifest.frontmatter = structuredClone(manifest.frontmatter)
  const entry = manifest.frontmatter.entry
  if (!entry) {
    const knownStepIds = collectManifestStepIds(manifest.frontmatter.steps)
    translateSubworkflowWith(manifest.frontmatter.steps, knownStepIds)
    await applyAgentHarnessPromptFiles(manifest.frontmatter.steps, workflowMdPath)
    return workflowFromManifest(manifest)
  }
  const handle = await importEntryHandle(workflowMdPath, entry)
  reconcileEntry(manifest, handle)
  return handle
}
