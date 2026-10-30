import { describe, expect, it } from "vitest"
import { BUILTIN_ROLE_ENTRIES } from "../index.js"

// Hosts merge a seed's body and handle text into emitted agent manifests, and
// some of them refuse an em dash in generated text. The seeds use a colon,
// comma or full stop instead: no U+2014, and no U+2013 used as a spaced dash.
const DASH_AS_PUNCTUATION = /\u2014|\s\u2013\s/

function strings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`))
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`))
  }
  return []
}

describe("@agentproto/role-catalog seed prose", () => {
  it("no seed body or handle field uses a dash as punctuation", () => {
    const offenders = BUILTIN_ROLE_ENTRIES.flatMap((entry) =>
      [
        ...strings(entry.body ?? "", `${entry.slug}.body`),
        ...strings(entry.handle, `${entry.slug}.handle`),
      ].flatMap(([path, text]) =>
        text
          .split("\n")
          .filter((line) => DASH_AS_PUNCTUATION.test(line))
          .map((line) => `${path}: ${line.trim()}`),
      ),
    )
    expect(offenders).toEqual([])
  })
})
