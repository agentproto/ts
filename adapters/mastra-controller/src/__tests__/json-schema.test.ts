import { readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { controllerManifestJsonSchema } from "../json-schema.js"

const SCHEMA_FILE = new URL("../../schema/mastra.agent-controller.v1.schema.json", import.meta.url)

function render(): string {
  return `${JSON.stringify(controllerManifestJsonSchema(), null, 2)}\n`
}

describe("schema/mastra.agent-controller.v1.schema.json", () => {
  it("equals the schema generated from the zod source", () => {
    if (process.env.AGENTPROTO_WRITE_SCHEMA === "1") writeFileSync(SCHEMA_FILE, render())
    expect(
      readFileSync(SCHEMA_FILE, "utf8"),
      "committed JSON Schema drifted from src/manifest.ts: run `pnpm schema:write` in adapters/mastra-controller",
    ).toBe(render())
  })

  it("names the manifest and requires the portable core", () => {
    const schema = controllerManifestJsonSchema() as {
      title: string
      required: string[]
      properties: { spec: { enum: string[] } }
    }
    expect(schema.title).toBe("mastra.agent-controller/v1")
    expect(schema.required).toEqual(expect.arrayContaining(["id", "name", "version", "modes"]))
    expect(schema.properties.spec.enum).toContain("mastra.agent-controller/v1")
  })
})
