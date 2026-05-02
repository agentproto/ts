/**
 * `createTool(params, opts)` — write a TOOL.md to disk.
 *
 * Symmetric to `parseToolManifest` (.md → handle) and `defineTool`
 * (params → handle): this takes params, validates via defineTool
 * (single source of truth — same zod schema, same cross-AIP
 * invariants), then serialises the validated frontmatter to YAML
 * and writes it under `<dir>/<id>/TOOL.md`.
 *
 * The author's body markdown is preserved verbatim in `opts.body`.
 * Pass `dryRun: true` to get the rendered string without touching
 * disk — useful for tests, the MCP server's preview, and CI lints.
 *
 * Non-frontmatter values that can't appear in YAML (zod schemas,
 * function bodies) are filtered out by `filterSerializable` from
 * `@agentproto/define-doctype`; the resulting frontmatter matches
 * what `parseToolManifest` would consume on the way back in.
 */

import { filterSerializable } from "@agentproto/define-doctype"
import matter from "gray-matter"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { defineTool } from "./define-tool.js"
import type { ToolContext, ToolDefinition, ToolHandle } from "./types.js"

export interface CreateToolOptions {
  /** Workspace-relative or absolute directory under which to write `<id>/TOOL.md`. */
  dir: string
  /** Body markdown after the frontmatter. Defaults to a one-line stub. */
  body?: string
  /** Render only — don't write. Returns the rendered string. */
  dryRun?: boolean
}

export interface CreateToolResult<
  TInput,
  TOutput,
  TContext extends ToolContext,
> {
  /** The path where the file was (or would be) written. */
  path: string
  /** The validated handle returned by defineTool. */
  handle: ToolHandle<TInput, TOutput, TContext>
  /** The full rendered file contents (frontmatter + body). */
  rendered: string
}

export async function createTool<
  TInput,
  TOutput,
  TContext extends ToolContext = ToolContext,
>(
  params: ToolDefinition<TInput, TOutput, TContext>,
  opts: CreateToolOptions,
): Promise<CreateToolResult<TInput, TOutput, TContext>> {
  const handle = defineTool<TInput, TOutput, TContext>(params)
  const path = join(opts.dir, handle.id, "TOOL.md")
  const frontmatter = filterSerializable({
    schema: "agentproto/tool/v1",
    ...params,
  }) as Record<string, unknown>
  const rendered = matter.stringify(
    opts.body ?? `# ${handle.name}\n\n${handle.description}\n`,
    frontmatter,
  )
  if (!opts.dryRun) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, rendered, "utf8")
  }
  return { path, handle, rendered }
}
