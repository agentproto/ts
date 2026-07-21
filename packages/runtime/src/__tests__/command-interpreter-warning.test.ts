/**
 * `command_execute`'s allowlist is by basename and its cwd anchor bounds only
 * the working directory — so allowlisting an interpreter (bash/node/python…)
 * grants arbitrary host code execution + unrestricted FS read. We don't block
 * it (that'd break legit interpreter-driven flows) but we DO flag it. This
 * pins the interpreter predicate that drives that warning.
 */

import { describe, it, expect } from "vitest"
import {
  isInterpreterBasename,
  interpreterExecWarning,
} from "../command-tools.js"

describe("isInterpreterBasename", () => {
  it("flags code interpreters", () => {
    for (const name of [
      "bash",
      "sh",
      "zsh",
      "node",
      "deno",
      "bun",
      "python",
      "python3",
      "ruby",
      "perl",
      "php",
      "npx",
      "env",
      "make",
      "uvx",
    ]) {
      expect(isInterpreterBasename(name)).toBe(true)
    }
  })

  it("is case-insensitive (Rscript, OSASCRIPT)", () => {
    expect(isInterpreterBasename("Rscript")).toBe(true)
    expect(isInterpreterBasename("OSASCRIPT")).toBe(true)
  })

  it("does not flag ordinary tools", () => {
    for (const name of ["gh", "git", "pnpm", "ls", "cat", "rg", "tsc"]) {
      expect(isInterpreterBasename(name)).toBe(false)
    }
  })

  it("warning names the offending interpreter", () => {
    expect(interpreterExecWarning("python3")).toContain("python3")
  })
})
