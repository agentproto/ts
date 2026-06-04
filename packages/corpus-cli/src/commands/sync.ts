/**
 * `corpus sync [workspace] --config <sink.json> [--tags a,b --kind k --throttle ms]`
 *
 * Pushes refined entries to an external store via a config-driven MCP sink.
 * Host-agnostic: the sink manifest names the endpoint + tool + entry→args
 * mapping (a Guilde guild KB, a vector store, …) — the CLI knows none of it.
 *
 * Sink manifest (JSON):
 *   { "endpoint": "https://…/mcp", "tool": "ingest_knowledge",
 *     "headers": { "authorization": "Bearer …" },
 *     "args": { "guildId": "…", "knowledgeBaseId": "…", "kind": "text",
 *               "title": "${title}", "content": "${body}", "uri": "${uri}",
 *               "metadata": { "sources": "${sources}", "access": "${access}" } } }
 */

import { readFile } from "node:fs/promises"
import {
  SyncRunner,
  isRefinedKind,
  type KnowledgeQuery,
  type RefinedKind,
} from "@agentproto/corpus"
import { McpSink, SINK_CONFIG_SCHEMA } from "../ports/mcp-sink.adapter.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runSync(args: readonly string[]): Promise<ExitCode> {
  let workspace: string | undefined
  let configPath: string | undefined
  const tags: string[] = []
  const kinds: RefinedKind[] = []
  let throttleMs = 500

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--config": configPath = next(); break
      case "--tags": { const v = next(); if (v) tags.push(...v.split(",").map(s => s.trim()).filter(Boolean)); break }
      case "--kind": { const v = next(); if (v && isRefinedKind(v)) kinds.push(v); break }
      case "--throttle": { const v = next(); if (v) throttleMs = Number(v); break }
      default: if (!a.startsWith("-") && workspace === undefined) workspace = a
    }
  }

  const target = resolveWorkspacePath(workspace)
  if (!configPath) return fail("sync needs --config <sink-manifest.json>.", 2)

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath, "utf-8"))
  } catch (e) {
    return fail(`could not read sink config: ${e instanceof Error ? e.message : String(e)}`, 2)
  }
  const parsedConfig = SINK_CONFIG_SCHEMA.safeParse(raw)
  if (!parsedConfig.success) {
    return fail(
      `invalid sink config (needs endpoint, tool, args): ${parsedConfig.error.issues[0]?.message ?? "schema mismatch"}`,
      2
    )
  }
  const config = parsedConfig.data

  const select: KnowledgeQuery = {
    ...(tags.length ? { tags } : {}),
    ...(kinds.length ? { kinds } : {}),
  }
  const report = await new SyncRunner({
    fs: new NodeFsAdapter({ root: target }),
    sink: new McpSink(config),
    select,
    throttleMs,
  }).run()

  process.stdout.write(
    `sync → ${config.endpoint} (tool: ${config.tool})\n` +
      `  pushed: ${report.pushed} · skipped: ${report.skipped} · failed: ${report.failed}\n`
  )
  for (const r of report.results.filter(r => !r.ok).slice(0, 10)) {
    process.stdout.write(`  ! ${r.uri} — ${r.error}\n`)
  }
  return report.failed > 0 && report.pushed === 0 ? 1 : 0
}
