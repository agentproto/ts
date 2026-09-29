import { describe, it, expect } from "vitest"
import {
  A2A_PROTOCOL_VERSION,
  buildAppAgentCard,
  buildDaemonAgentCard,
  type AppCardInput,
} from "../index.js"

const notes: AppCardInput = {
  appId: "@acme/notes",
  name: "Notes",
  description: "Takes notes.",
  version: "1.2.3",
  baseUrl: "http://127.0.0.1:4711/",
  exposes: { agents: ["summarizer"], workflows: ["digest"] },
  agents: [
    { id: "summarizer", description: "Summarizes a note." },
    { id: "private", description: "Not exposed." },
  ],
  workflows: [{ id: "digest", name: "Daily digest" }],
  accepts: { tasks: true },
}

describe("buildAppAgentCard", () => {
  it("builds a spec-shaped card from exposes", () => {
    const card = buildAppAgentCard(notes)
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION)
    expect(card.name).toBe("Notes")
    expect(card.version).toBe("1.2.3")
    expect(card.url).toBe("http://127.0.0.1:4711/a2a/apps/%40acme%2Fnotes")
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })
    expect(card.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } })
    expect(card.security).toEqual([{ bearer: [] }])
    expect(card.skills).toEqual([
      {
        id: "@acme/notes/summarizer",
        name: "summarizer",
        description: "Summarizes a note.",
        tags: ["agent"],
      },
      {
        id: "@acme/notes/digest",
        name: "Daily digest",
        description: 'The workflow "digest" of Notes.',
        tags: ["workflow"],
      },
    ])
    expect(card.description).toBe("Takes notes.")
  })

  it("exposes nothing when exposes is absent or empty", () => {
    expect(buildAppAgentCard({ ...notes, exposes: undefined }).skills).toEqual([])
    expect(buildAppAgentCard({ ...notes, exposes: { agents: [], workflows: [] } }).skills).toEqual([])
  })

  it("falls back to the appId and default version, and flags apps that refuse tasks", () => {
    const card = buildAppAgentCard({ appId: "bare", baseUrl: "https://d.example" })
    expect(card.name).toBe("bare")
    expect(card.version).toBe("0.0.0")
    expect(card.url).toBe("https://d.example/a2a/apps/bare")
    expect(card.description).toContain("does not accept A2A tasks")
  })

  it("keeps a skill for an exposed id missing from the agent list", () => {
    const card = buildAppAgentCard({ ...notes, agents: [], exposes: { agents: ["ghost"] } })
    expect(card.skills.map(s => s.id)).toEqual(["@acme/notes/ghost"])
  })
})

describe("buildDaemonAgentCard", () => {
  it("aggregates skills of apps that expose something", () => {
    const card = buildDaemonAgentCard({
      baseUrl: "http://127.0.0.1:4711",
      apps: [
        notes,
        { appId: "@acme/quiet", baseUrl: "http://127.0.0.1:4711", agents: [{ id: "a" }] },
        { appId: "@acme/two", baseUrl: "http://127.0.0.1:4711", exposes: { agents: ["x"] } },
      ],
    })
    expect(card.url).toBe("http://127.0.0.1:4711")
    expect(card.name).toBe("agentproto daemon")
    expect(card.skills.map(s => s.id)).toEqual([
      "@acme/notes/summarizer",
      "@acme/notes/digest",
      "@acme/two/x",
    ])
    expect(card.capabilities.streaming).toBe(false)
  })

  it("has empty skills with no exposing apps", () => {
    expect(buildDaemonAgentCard({ baseUrl: "http://h", apps: [] }).skills).toEqual([])
  })
})
