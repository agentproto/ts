#!/usr/bin/env node
/**
 * Writes `defaults.adapters.<adapter>.auth` into `~/.agentproto/config.json`
 * so the daemon this action boots resolves billing-auth for the spawn.
 *
 * Credentials MUST land here, never in the ambient shell env: the runtime's
 * auth resolver (`packages/runtime/src/spawn-defaults.ts`) reads
 * `defaults.adapters.<slug>.auth` from this file — an exported
 * CLAUDE_CODE_OAUTH_TOKEN in the calling workflow would be silently ignored,
 * and `authEnforce: "always"` on claude-code fails the spawn fast with no
 * credential. All values arrive via `env:` (never interpolated into a shell
 * command string) and are never logged.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`write-config: missing required env ${name}`)
    process.exit(1)
  }
  return v
}

const adapter = requireEnv("ADAPTER")
const mode = requireEnv("AUTH_MODE")
if (mode !== "subscription" && mode !== "api-key") {
  console.error(`write-config: auth-mode must be "subscription" or "api-key", got "${mode}"`)
  process.exit(1)
}

const token = process.env.OAUTH_TOKEN ?? ""
const apiKey = process.env.API_KEY ?? ""
if (mode === "subscription" && !token) {
  console.error("write-config: auth-mode=subscription requires oauth-token to be set")
  process.exit(1)
}
if (mode === "api-key" && !apiKey) {
  console.error("write-config: auth-mode=api-key requires api-key to be set")
  process.exit(1)
}

const configDir = join(homedir(), ".agentproto")
const configPath = join(configDir, "config.json")
await mkdir(configDir, { recursive: true })

let config = {}
if (existsSync(configPath)) {
  try {
    config = JSON.parse(await readFile(configPath, "utf8"))
  } catch (err) {
    console.error(`write-config: existing ${configPath} is not valid JSON: ${err.message}`)
    process.exit(1)
  }
}

config.defaults ??= {}
config.defaults.adapters ??= {}
config.defaults.adapters[adapter] ??= {}
config.defaults.adapters[adapter].auth = mode === "subscription" ? { mode, token } : { mode, apiKey }

await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
console.log(`write-config: wrote defaults.adapters.${adapter}.auth (mode=${mode}) to ${configPath}`)
