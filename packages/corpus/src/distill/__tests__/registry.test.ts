import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { systemClock } from "../../ports/clock.port.js"
import { ConversationImporter } from "../../importers/conversation.js"
import { createDistillRegistry } from "../registry.js"
import type { DistillDescriptor, DistillScope } from "../registry.js"
import type { DistillPort } from "../types.js"

/** A throwaway descriptor — the registry only cares about id/jobType. */
function stub(id: string, jobType = `distill:${id}`): DistillDescriptor {
  const distiller: DistillPort = { distill: async () => [] }
  const source = { fetchConversation: async () => null }
  return {
    id,
    jobType,
    label: id,
    bind: () => ({
      importer: new ConversationImporter({ source }),
      enumerate: async () => [],
    }),
    distiller: () => distiller,
    target: async () => ({ fs: new MemFs({}), clock: systemClock }),
    scopes: async () => [],
    resolveScope: async (scopeId): Promise<DistillScope> => ({
      id: scopeId,
      userId: scopeId,
    }),
  }
}

describe("createDistillRegistry", () => {
  it("registers and resolves a descriptor by id", () => {
    const registry = createDistillRegistry()
    const d = stub("conversation")
    registry.register(d)
    expect(registry.has("conversation")).toBe(true)
    expect(registry.resolve("conversation")).toBe(d)
  })

  it("throws on duplicate registration", () => {
    const registry = createDistillRegistry()
    registry.register(stub("conversation"))
    expect(() => registry.register(stub("conversation"))).toThrow(
      /already registered/
    )
  })

  it("throws on resolving an unknown id", () => {
    const registry = createDistillRegistry()
    registry.register(stub("conversation"))
    expect(() => registry.resolve("web")).toThrow(/not registered/)
  })

  it("lists every registered descriptor", () => {
    const registry = createDistillRegistry()
    registry.register(stub("conversation"))
    registry.register(stub("web"))
    expect(registry.list().map(d => d.id).sort()).toEqual([
      "conversation",
      "web",
    ])
  })

  it("has() is false for an unregistered id", () => {
    const registry = createDistillRegistry()
    expect(registry.has("conversation")).toBe(false)
  })
})
