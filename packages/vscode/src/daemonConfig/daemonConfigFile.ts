/**
 * Thin FS layer for `~/.agentproto/config.json` — the daemon's own defaults
 * file (runtime/src/config.ts). The extension runs in Node with FS access, so
 * for WRITES it edits this file directly rather than going through a daemon
 * route (there is no config-write route today): the change lands the same way
 * `agentproto config set` lands it, and the boot-time knobs it touches need a
 * daemon restart to apply either way, so writing the file the daemon reads at
 * boot is the simplest correct path.
 *
 * Pure JSON parse/serialize decisions live in daemonConfig.logic.ts; this
 * module is only the disk I/O (read, atomic write) so the logic stays testable
 * without touching the real home directory.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { serializeConfig } from "./daemonConfig.logic.js"

/** `~/.agentproto/config.json` — same path runtime/src/config.ts uses. */
export function configFilePath(home: string = homedir()): string {
  return join(home, ".agentproto", "config.json")
}

/**
 * Read + parse config.json. Returns an empty object (NOT null) when the file
 * is missing, malformed, or unreadable — mirrors runtime `loadConfig`, so
 * callers can narrow `daemon.*` without null-guards. A malformed file is
 * treated as empty rather than throwing so the surface still opens.
 */
export async function readConfigFile(
  path: string = configFilePath(),
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Atomically write config.json (tmp + rename), exactly as runtime `saveConfig`
 * does, so a concurrent read never sees a half-truncated file. The caller
 * passes the FULL desired object (read → mutate via setConfigKey → write) —
 * this does not deep-merge, matching runtime's deliberate "trust the caller's
 * snapshot so deletions work" contract.
 */
export async function writeConfigFile(
  next: Record<string, unknown>,
  path: string = configFilePath(),
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, serializeConfig(next), "utf8")
  await fs.rename(tmp, path)
}
