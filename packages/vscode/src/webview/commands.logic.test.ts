import { describe, expect, it } from "vitest"

import { commandQueryAt, filterCommands, leadingCommandEnd } from "./commands.logic.js"

describe("commandQueryAt", () => {
  it("opens on a bare / at the start", () => {
    expect(commandQueryAt("/", 1)).toEqual({ query: "", start: 0, end: 1 })
  })

  it("finds the command name the caret is typing into", () => {
    expect(commandQueryAt("/pla", 4)).toEqual({ query: "pla", start: 0, end: 4 })
  })

  it("does NOT open for a / that isn't the first character", () => {
    expect(commandQueryAt("hi /plan", 8)).toBeNull()
  })

  it("closes once whitespace follows the command name", () => {
    // caret is after the space — now typing arguments, not the command name
    expect(commandQueryAt("/plan ", 6)).toBeNull()
    expect(commandQueryAt("/plan foo", 9)).toBeNull()
  })

  it("stays open while the caret is still inside the name, even with trailing args", () => {
    expect(commandQueryAt("/plan foo", 4)).toEqual({ query: "pla", start: 0, end: 4 })
  })

  it("returns null for an out-of-range or zero caret", () => {
    expect(commandQueryAt("/plan", 0)).toBeNull()
    expect(commandQueryAt("/plan", 99)).toBeNull()
  })

  it("returns null for empty text", () => {
    expect(commandQueryAt("", 0)).toBeNull()
  })
})

describe("leadingCommandEnd", () => {
  it("stops at the first whitespace", () => {
    expect(leadingCommandEnd("/plan foo bar")).toBe(5)
  })

  it("runs to the end when there is no whitespace", () => {
    expect(leadingCommandEnd("/plan")).toBe(5)
  })

  it("is 1 for a bare /", () => {
    expect(leadingCommandEnd("/")).toBe(1)
  })
})

describe("filterCommands", () => {
  const commands = [
    { name: "plan", description: "Enter planning mode" },
    { name: "planReview", description: "Review the current plan" },
    { name: "compact", description: "Compact the conversation" },
    { name: "help", description: "Show help" },
  ]

  it("returns every command for an empty query", () => {
    expect(filterCommands(commands, "")).toEqual(commands)
  })

  it("ranks name-prefix above name-substring", () => {
    const out = filterCommands(commands, "plan")
    expect(out.map(c => c.name)).toEqual(["plan", "planReview"])
  })

  it("is case-insensitive", () => {
    expect(filterCommands(commands, "PLAN").map(c => c.name)).toEqual(["plan", "planReview"])
  })

  it("matches a substring anywhere in the name", () => {
    expect(filterCommands(commands, "act").map(c => c.name)).toEqual(["compact"])
  })

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(commands, "zzz")).toEqual([])
  })
})
