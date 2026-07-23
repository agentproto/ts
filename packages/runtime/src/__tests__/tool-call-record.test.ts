import { describe, expect, it } from "vitest"
import { extractCommandArgs } from "../tool-call-record.js"

describe("extractCommandArgs", () => {
  it("extracts command + args from a Bash-shaped input", () => {
    expect(extractCommandArgs({ command: "ls -la", args: ["-la"] })).toEqual({
      command: "ls -la",
      args: ["-la"],
    })
  })

  it("extracts command alone when args is absent", () => {
    expect(extractCommandArgs({ command: "pwd" })).toEqual({ command: "pwd" })
  })

  it("ignores a non-string-array args field", () => {
    expect(extractCommandArgs({ command: "ls", args: [1, 2] })).toEqual({ command: "ls" })
  })

  it("returns {} for a tool with no command field (e.g. Edit)", () => {
    expect(extractCommandArgs({ file_path: "/tmp/x.ts", old_string: "a", new_string: "b" })).toEqual({})
  })

  it("returns {} for null/undefined/primitive input", () => {
    expect(extractCommandArgs(undefined)).toEqual({})
    expect(extractCommandArgs(null)).toEqual({})
    expect(extractCommandArgs("just a string")).toEqual({})
    expect(extractCommandArgs(42)).toEqual({})
  })

  it("returns {} when command is present but not a string", () => {
    expect(extractCommandArgs({ command: 123 })).toEqual({})
  })
})
