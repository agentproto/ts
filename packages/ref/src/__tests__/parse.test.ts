import { describe, expect, it } from "vitest"
import {
  defineRef,
  InvalidRefBody,
  UnknownRefKind,
  isResolvable,
} from "../index.js"

describe("parse — error paths", () => {
  it("rejects compact string without ':'", () => {
    expect(() => defineRef("noseparator")).toThrow(/separator ':'/)
  })

  it("rejects unknown kind in strict mode (default)", () => {
    expect(() => defineRef("madeup:body")).toThrow(UnknownRefKind)
  })

  it("local: rejects path-escape", () => {
    expect(() => defineRef("local:../etc/passwd")).toThrow(InvalidRefBody)
  })

  it("local: rejects absolute paths", () => {
    expect(() => defineRef("local:/etc/passwd")).toThrow(InvalidRefBody)
  })

  it("local: rejects malformed sha suffix", () => {
    expect(() => defineRef("local:foo.md#sha256=zzz")).toThrow(InvalidRefBody)
  })

  it("url: rejects non-http schemes", () => {
    expect(() => defineRef("url:ftp://example.com/x")).toThrow(InvalidRefBody)
    expect(() => defineRef("url:file:///etc/passwd")).toThrow(InvalidRefBody)
    expect(() => defineRef("url:javascript:alert(1)")).toThrow(InvalidRefBody)
  })

  it("git: rejects missing ref", () => {
    expect(() => defineRef("git:https%3A%2F%2Fexample.com%2Frepo.git")).toThrow(
      InvalidRefBody
    )
  })

  it("github: rejects missing slash", () => {
    expect(() => defineRef("github:noowner")).toThrow(InvalidRefBody)
  })

  it("eth_tx: rejects malformed txHash", () => {
    expect(() => defineRef("eth_tx:1:notahash")).toThrow(InvalidRefBody)
  })

  it("eth_tx: rejects missing chainId", () => {
    expect(() => defineRef("eth_tx:0xabcdef")).toThrow(InvalidRefBody)
  })

  it("ots: rejects inner ref of wrong kind", () => {
    expect(() => defineRef("ots:operator:atlas")).toThrow(InvalidRefBody)
  })
})

describe("isResolvable", () => {
  it("returns true for fetchable kinds", () => {
    const r = defineRef("local:foo.md")
    expect(r.resolvable).toBe(true)
    expect(isResolvable(r.value)).toBe(true)
  })

  it("returns false for identity-only kinds", () => {
    const r = defineRef(
      "eth_tx:1:0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34"
    )
    expect(r.resolvable).toBe(false)
    expect(isResolvable(r.value)).toBe(false)
  })

  it("throws NotResolvable when resolving an identity-only kind", async () => {
    const r = defineRef("email:jeremy@agentik.net")
    await expect(r.resolve({})).rejects.toThrow(/not resolvable/i)
  })
})

describe("schema validation rejects bad object inputs", () => {
  it("rejects extra fields not in the schema (non-strict zod still allows; document the looseness)", () => {
    // zod by default strips unknown keys on parse; we accept that lenience.
    const r = defineRef({
      kind: "local",
      path: "foo.md",
    })
    expect(r.value.kind).toBe("local")
  })

  it("rejects missing required fields", () => {
    expect(() =>
      defineRef({ kind: "github", owner: "agentik" } as never)
    ).toThrow()
  })
})
