/**
 * `agentproto preset` — CRUD for user-owned session presets.
 *
 * Singular on purpose: `agentproto presets` remains the read-only catalogue
 * of static provider gateway presets; this command manages combinations a
 * user has saved for their own spawns.
 */

import { parseArgs } from "node:util"
import {
  deleteUserPreset,
  getUserPreset,
  listUserPresets,
  saveUserPreset,
  type UserPreset,
} from "@agentproto/runtime/user-presets"

const USAGE = `agentproto preset — manage saved spawn configurations

Usage:
  agentproto preset list [--json]
  agentproto preset show <id> [--json]
  agentproto preset add <id> --label <label> [axis flags]
  agentproto preset delete <id>

Axis flags for add:
  --adapter <slug>          harness (e.g. hermes)
  --model <ref>             model identity/ref
  --gateway <id>            billing gateway/route
  --base-url <url>          custom gateway URL (requires --gateway)
  --profile <profileRef>    named auth profile
  --posture <value>         default|plan|accept-edits|bypass|read-only
  --effort <value>          low|medium|high|xhigh|max|ultracode
  --context <profile>       full|lean or an adapter-specific profile

Examples:
  agentproto preset add fast-deepseek --label "Fast DeepSeek" \\
    --adapter hermes --model deepseek/deepseek-v4-pro --gateway openrouter \\
    --profile openrouter-api --posture bypass --effort high
  agentproto preset list
`

export async function runPreset(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  if (sub === "list") return list(args.slice(1))
  if (sub === "show") return show(args.slice(1))
  if (sub === "add") return add(args.slice(1))
  if (sub === "delete") return remove(args.slice(1))
  process.stderr.write(sub ? `agentproto preset: unknown subcommand "${sub}"\n` : USAGE)
  return 2
}

async function list(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: { json: { type: "boolean" } },
  })
  const presets = await listUserPresets()
  if (values.json) {
    process.stdout.write(JSON.stringify(presets, null, 2) + "\n")
    return 0
  }
  if (presets.length === 0) {
    process.stdout.write("No user presets. Add one with `agentproto preset add <id> --label <label>`.\n")
    return 0
  }
  process.stdout.write(`${"ID".padEnd(22)}  ${"LABEL".padEnd(28)}  ADAPTER        MODEL\n`)
  for (const preset of presets) {
    process.stdout.write(
      `${preset.id.padEnd(22)}  ${preset.label.padEnd(28)}  ` +
        `${(preset.adapter ?? "—").padEnd(13)}  ${preset.model ?? "—"}\n`,
    )
  }
  return 0
}

async function show(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: "boolean" } },
  })
  const id = positionals[0]
  if (!id || positionals.length > 1) return missingId("show")
  const preset = await getUserPreset(id)
  if (!preset) {
    process.stderr.write(`agentproto preset show: no preset "${id}".\n`)
    return 1
  }
  if (values.json) process.stdout.write(JSON.stringify(preset, null, 2) + "\n")
  else {
    process.stdout.write(`${preset.label} (${preset.id})\n`)
    for (const [key, value] of Object.entries(preset)) {
      if (key !== "id" && key !== "label" && value !== undefined) {
        process.stdout.write(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`)
      }
    }
  }
  return 0
}

async function add(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      label: { type: "string" },
      adapter: { type: "string" },
      model: { type: "string" },
      gateway: { type: "string" },
      "base-url": { type: "string" },
      profile: { type: "string" },
      posture: { type: "string" },
      effort: { type: "string" },
      context: { type: "string" },
    },
  })
  const id = positionals[0]
  if (!id || positionals.length > 1) return missingId("add")
  if (!values.label) {
    process.stderr.write("agentproto preset add: --label is required.\n")
    return 2
  }
  if (values["base-url"] && !values.gateway) {
    process.stderr.write("agentproto preset add: --base-url requires --gateway.\n")
    return 2
  }
  const preset: UserPreset = {
    id,
    label: values.label,
    ...(values.adapter ? { adapter: values.adapter } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.gateway
      ? { route: { gateway: values.gateway, ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}) } }
      : {}),
    ...(values.profile ? { access: { profileRef: values.profile } } : {}),
    ...(values.posture ? { posture: values.posture as UserPreset["posture"] } : {}),
    ...(values.effort ? { effort: values.effort as UserPreset["effort"] } : {}),
    ...(values.context ? { contextProfile: values.context } : {}),
  }
  try {
    await saveUserPreset(preset)
  } catch (error) {
    process.stderr.write(`agentproto preset add: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  process.stdout.write(`Saved preset "${id}".\n`)
  return 0
}

async function remove(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({ args: [...args], strict: true, allowPositionals: true })
  const id = positionals[0]
  if (!id || positionals.length > 1) return missingId("delete")
  if (!(await deleteUserPreset(id))) {
    process.stderr.write(`agentproto preset delete: no preset "${id}".\n`)
    return 1
  }
  process.stdout.write(`Deleted preset "${id}".\n`)
  return 0
}

function missingId(command: "add" | "show" | "delete"): number {
  process.stderr.write(`agentproto preset ${command}: expected exactly one preset id.\n`)
  return 2
}
