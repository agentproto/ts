/**
 * Help-completeness gate: every flag a verb's parseArgs actually accepts
 * must appear in the help output that verb prints for `--help`.
 *
 * Data-driven on purpose — the bug class this guards against is a flag
 * someone ADDS next week whose `options: {}` entry never makes it into the
 * usage string. The test re-derives the accepted-flag set straight from the
 * command source (extracting every parseArgs `options` block) and asserts
 * each `--key` shows up in the verb's own help output, so a new flag fails
 * this test until its help line exists.
 *
 * `install` is one case covering all three of its flag surfaces (adapter /
 * runtime-profile / skill) in one combined usage block — runInstall routes
 * by slug before parsing, so a flat per-surface split wouldn't be truthful.
 */
import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { runAuth } from "../commands/auth.js"
import { runSessions } from "../commands/sessions.js"
import { runInstall } from "../commands/install.js"
import { runPermissions } from "../commands/permissions.js"
import { runAdapters } from "../commands/adapters.js"
import { runAcp } from "../commands/acp.js"
import { runTask } from "../commands/task.js"

const here = dirname(fileURLToPath(import.meta.url))

/** Extract every key declared inside a parseArgs `options: { … }` block in a
 *  command source file. Brace-matching keeps multi-block files (sessions.ts
 *  has ~10) fully covered; the `: { type:` guard skips non-parseArgs
 *  occurrences of the word `options`. */
function extractOptionKeys(file: string): string[] {
  const src = readFileSync(join(here, file), "utf8")
  const keys = new Set<string>()
  const needle = "options: {"
  let idx = src.indexOf(needle)
  while (idx !== -1) {
    const open = idx + needle.length - 1
    let depth = 0
    let end = open
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const body = src.slice(open + 1, end)
    const keyRe =
      /(?:"([\w.-]+)"|'([\w.-]+)'|([a-zA-Z][\w-]*)):\s*\{\s*type:/g
    for (const m of body.matchAll(keyRe)) {
      keys.add(m[1] ?? m[2] ?? m[3]!)
    }
    idx = src.indexOf(needle, end)
  }
  return [...keys]
}

const CASES: Array<{
  verb: string
  file: string
  help: () => Promise<number>
}> = [
  { verb: "auth", file: "../commands/auth.ts", help: () => runAuth(["--help"]) },
  { verb: "sessions", file: "../commands/sessions.ts", help: () => runSessions(["--help"]) },
  { verb: "install", file: "../commands/install.ts", help: () => runInstall(["--help"]) },
  { verb: "permissions", file: "../commands/permissions.ts", help: () => runPermissions(["--help"]) },
  { verb: "adapters", file: "../commands/adapters.ts", help: () => runAdapters(["--help"]) },
  { verb: "acp", file: "../commands/acp.ts", help: () => runAcp(["--help"]) },
  { verb: "task", file: "../commands/task.ts", help: () => runTask(["--help"]) },
]

describe("help completeness (every implemented flag appears in --help)", () => {
  for (const { verb, file, help } of CASES) {
    it(`agentproto ${verb}: all parseArgs options appear in --help`, async () => {
      const writes: string[] = []
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
        chunk: string | Uint8Array,
      ) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
      try {
        const code = await help()
        expect(code).toBe(0)
      } finally {
        spy.mockRestore()
      }
      const out = writes.join("")
      const keys = extractOptionKeys(file)
      // Sanity: the extractor must have found the verb's flags at all —
      // otherwise a broken regex would green-light a verb with zero flags.
      expect(keys.length).toBeGreaterThan(0)
      const missing = keys.filter((k) => !out.includes(`--${k}`))
      expect(
        missing,
        `${verb}: flags implemented in ${file} but absent from its --help`,
      ).toEqual([])
    })
  }
})
