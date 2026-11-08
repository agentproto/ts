import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Private markers that must never ship in this public package.
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "Emploi", pattern: /Emploi/ },
  { name: 'JK"', pattern: /JK"/ },
  { name: "jak.kit", pattern: /jak\.kit/i },
  { name: "agstudio", pattern: /agstudio/i },
  { name: "openagentik", pattern: /openagentik/i },
  { name: "designkit", pattern: /designkit/i },
  { name: "Maquette", pattern: /Maquette/ },
]

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo"])
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// This file spells the markers out, so it is the one file not scanned.
const SELF = fileURLToPath(import.meta.url)

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : listFiles(full)
    return full === SELF ? [] : [full]
  })
}

function findLeaks(root: string): string[] {
  const leaks: string[] = []
  for (const file of listFiles(root)) {
    const text = readFileSync(file, "utf8")
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) leaks.push(`${relative(root, file)}: ${name}`)
    }
  }
  return leaks
}

describe("private brand guard", () => {
  it("finds no private marker in any file of the package", () => {
    expect(findLeaks(PACKAGE_ROOT)).toEqual([])
  })

  it("detects every marker (the guard itself works)", () => {
    const root = mkdtempSync(join(tmpdir(), "app-shell-guard-"))
    mkdirSync(join(root, "src"))
    for (const [i, { name }] of FORBIDDEN.entries()) {
      writeFileSync(join(root, "src", `leak-${i}.txt`), `x ${name} y`)
    }
    expect(findLeaks(root)).toHaveLength(FORBIDDEN.length)
  })
})
