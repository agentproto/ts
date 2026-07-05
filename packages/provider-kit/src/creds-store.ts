/**
 * Generic file-backed creds store (OQ-1, Option A with the escape hatch).
 *
 * Creds live at `~/.agentproto/<family>-creds/<slug>.json`, written with
 * mode 0600. The store is the kit's default implementation, but it is
 * injectable: families may pass any `CredsStore<TCreds>` impl into
 * `makeAdapterLister` / `makeAdapterWizard` (keychain, vault, env, …).
 *
 * Security contract (Appendix B): the value is never logged, never placed
 * in `TInfo`, never returned from any MCP tool. The only thing the status
 * engine learns is the boolean `exists()`.
 */

import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface CredsStore<TCreds> {
  /** Returns null when no creds file exists. */
  read(slug: string): Promise<TCreds | null>
  /** Writes with mode 0600; creates the parent dir if absent. */
  write(slug: string, creds: TCreds): Promise<void>
  /** True when the creds file exists (no value returned). */
  exists(slug: string): Promise<boolean>
}

export interface MakeCredsStoreOpts {
  /** Family path prefix, e.g. "tunnel", "agent-cli". */
  family: string
  /** Home dir override. Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
}

function resolveHome(home?: string): string {
  return home ?? process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
}

export function makeCredsStore<TCreds>(
  opts: MakeCredsStoreOpts
): CredsStore<TCreds> {
  const base = resolveHome(opts.home)
  const dir = join(base, `${opts.family}-creds`)
  const fileFor = (slug: string): string => join(dir, `${slug}.json`)

  return {
    async read(slug: string): Promise<TCreds | null> {
      try {
        const raw = await readFile(fileFor(slug), "utf8")
        return JSON.parse(raw) as TCreds
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
        throw err
      }
    },

    async write(slug: string, creds: TCreds): Promise<void> {
      await mkdir(dir, { recursive: true })
      const path = fileFor(slug)
      await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 })
      // writeFile's mode is masked by the process umask, so re-assert 0600
      // explicitly to guarantee the secret file is owner-only. Windows /
      // some mounted FSes ignore chmod — those paths are already per-user.
      await chmod(path, 0o600).catch(() => {})
    },

    async exists(slug: string): Promise<boolean> {
      try {
        await access(fileFor(slug))
        return true
      } catch {
        return false
      }
    },
  }
}
