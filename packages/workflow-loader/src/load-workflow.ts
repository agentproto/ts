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
  const entry = manifest.frontmatter.entry
  if (!entry) return workflowFromManifest(manifest)
  const handle = await importEntryHandle(workflowMdPath, entry)
  reconcileEntry(manifest, handle)
  return handle
}
