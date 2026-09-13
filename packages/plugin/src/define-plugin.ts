import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { pluginSchema } from "./schema.js"
import type { PluginDefinition, PluginHandle } from "./types.js"

export function definePlugin(dir: string, def: PluginDefinition): PluginHandle {
  const result = pluginSchema.safeParse(def)
  if (!result.success) {
    throw new Error(
      `definePlugin (Agent Plugins v1.0.0): ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }

  const skillsDir = join(dir, "skills")
  let skills: string[] = []
  if (existsSync(skillsDir)) {
    try {
      if (statSync(skillsDir).isDirectory()) {
        const entries = readdirSync(skillsDir, { withFileTypes: true })
        skills = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      }
    } catch {
      skills = []
    }
  }

  const hasMcp = existsSync(join(dir, "mcp.json"))
  const extensionDirs = Object.values(def.extensions ?? {}).map((e) => e.path)

  const handle: PluginHandle = {
    ...def,
    skills: Object.freeze(skills),
    hasMcp,
    extensionDirs: Object.freeze(extensionDirs),
  }

  return Object.freeze(handle)
}
