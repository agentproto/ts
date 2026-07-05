/**
 * Setup ledger (§2.5). Records that interactive setup completed for a slug.
 * Its presence promotes an adapter from `available` → `ready` when
 * `requiresSetup=true`.
 *
 * The agent-CLI family already uses this shape at
 * `~/.agentproto/setup/<slug>.json`; the kit formalises it and makes it
 * injectable. Records carry timestamps + step ids only — never cred values.
 */

import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SetupLedgerRecord } from "./types.js"

export interface SetupLedger {
  exists(slug: string): Promise<boolean>
  /** Writes the JSON record with mode 0600; creates the parent dir if absent. */
  write(slug: string, record: SetupLedgerRecord): Promise<void>
  read(slug: string): Promise<SetupLedgerRecord | null>
}

export interface MakeSetupLedgerOpts {
  /** Home dir override. Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
}

function resolveHome(home?: string): string {
  return home ?? process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
}

export function makeSetupLedger(opts: MakeSetupLedgerOpts = {}): SetupLedger {
  const dir = join(resolveHome(opts.home), "setup")
  const fileFor = (slug: string): string => join(dir, `${slug}.json`)

  return {
    async exists(slug: string): Promise<boolean> {
      try {
        await access(fileFor(slug))
        return true
      } catch {
        return false
      }
    },

    async write(slug: string, record: SetupLedgerRecord): Promise<void> {
      await mkdir(dir, { recursive: true })
      const path = fileFor(slug)
      await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 })
      await chmod(path, 0o600).catch(() => {})
    },

    async read(slug: string): Promise<SetupLedgerRecord | null> {
      try {
        const raw = await readFile(fileFor(slug), "utf8")
        return JSON.parse(raw) as SetupLedgerRecord
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
        throw err
      }
    },
  }
}
