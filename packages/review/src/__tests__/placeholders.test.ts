import { describe, it, expect } from "vitest"
import { listPlaceholders, ReviewPlaceholderError, substitutePlaceholders } from "../index.js"

describe("substitutePlaceholders", () => {
  it("substitutes bound identifiers", () => {
    expect(substitutePlaceholders("turbo run build --filter={changed}", { changed: "...[abc]" })).toBe(
      "turbo run build --filter=...[abc]",
    )
    expect(substitutePlaceholders("git diff {base}..{head}", { base: "a", head: "b" })).toBe("git diff a..b")
  })

  it("leaves shell syntax alone: ${VAR}, brace expansion, {{escaped}}", () => {
    expect(substitutePlaceholders("echo ${HOME} {a,b} {{changed}}", {})).toBe("echo ${HOME} {a,b} {changed}")
  })

  it("throws on an unbound placeholder, naming what is bound", () => {
    expect(() => substitutePlaceholders("x {changed}", { base: "a" }, "check 'types'")).toThrow(ReviewPlaceholderError)
    expect(() => substitutePlaceholders("x {changed}", { base: "a" }, "check 'types'")).toThrow(
      "check 'types': placeholder '{changed}' has no value — bound placeholders: {base}",
    )
  })

  it("lists referenced placeholders, excluding escapes and shell vars", () => {
    expect(listPlaceholders("a {changed} {{lit}} ${HOME} {head} {changed}")).toEqual(["changed", "head"])
  })
})
