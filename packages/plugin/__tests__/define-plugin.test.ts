import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { definePlugin } from "../src/define-plugin.js"
import type { PluginDefinition } from "../src/types.js"

describe("definePlugin", () => {
  const tempDirs: string[] = []

  function createTempPluginDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-plugin-test-"))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0
  })

  it("creates a valid minimal plugin handle", () => {
    const dir = createTempPluginDir()
    const def: PluginDefinition = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "minimal-plugin",
    }

    const handle = definePlugin(dir, def)

    expect(handle.name).toBe("minimal-plugin")
    expect(handle.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
    expect(handle.skills).toEqual([])
    expect(handle.hasMcp).toBe(false)
    expect(handle.extensionDirs).toEqual([])
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Object.isFrozen(handle.skills)).toBe(true)
    expect(Object.isFrozen(handle.extensionDirs)).toBe(true)
  })

  it("resolves skills, mcp.json, and extensionDirs from disk", () => {
    const dir = createTempPluginDir()
    const skillsFooDir = join(dir, "skills", "foo")
    const skillsBarDir = join(dir, "skills", "bar")
    mkdirSync(skillsFooDir, { recursive: true })
    mkdirSync(skillsBarDir, { recursive: true })
    // Also create a file in skills/ to ensure only directories are counted as skills
    writeFileSync(join(dir, "skills", "README.md"), "# Skills")
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }))

    const def: PluginDefinition = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "full-plugin",
      version: "1.2.3",
      description: "A comprehensive test plugin",
      author: {
        name: "Agent Author",
        url: "https://example.com/author",
      },
      homepage: "https://example.com",
      repository: {
        type: "git",
        url: "https://github.com/example/plugin",
      },
      license: "Apache-2.0",
      keywords: ["agent", "tools"],
      extensions: {
        ext1: { path: "extensions/ext1", description: "First extension" },
        ext2: { path: "extensions/ext2" },
      },
    }

    const handle = definePlugin(dir, def)

    expect(handle.name).toBe("full-plugin")
    expect(handle.version).toBe("1.2.3")
    expect(handle.description).toBe("A comprehensive test plugin")
    expect(handle.author).toEqual({
      name: "Agent Author",
      url: "https://example.com/author",
    })
    expect(handle.homepage).toBe("https://example.com")
    expect(handle.repository).toEqual({
      type: "git",
      url: "https://github.com/example/plugin",
    })
    expect(handle.license).toBe("Apache-2.0")
    expect(handle.keywords).toEqual(["agent", "tools"])
    expect(handle.hasMcp).toBe(true)
    expect([...handle.skills].sort()).toEqual(["bar", "foo"])
    expect(handle.extensionDirs).toEqual(["extensions/ext1", "extensions/ext2"])
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("supports string author and string repository", () => {
    const dir = createTempPluginDir()
    const def: PluginDefinition = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "string-fields-plugin",
      author: "Jane Doe",
      repository: "https://github.com/example/plugin",
    }

    const handle = definePlugin(dir, def)
    expect(handle.author).toBe("Jane Doe")
    expect(handle.repository).toBe("https://github.com/example/plugin")
  })

  it("throws when $schema is missing or invalid", () => {
    const dir = createTempPluginDir()
    const def = {
      name: "missing-schema",
    } as unknown as PluginDefinition

    expect(() => definePlugin(dir, def)).toThrowError(
      /definePlugin \(Agent Plugins v1\.0\.0\):.*\$schema/,
    )

    const invalidSchemaDef = {
      $schema: "https://invalid.schema.json",
      name: "invalid-schema",
    } as unknown as PluginDefinition

    expect(() => definePlugin(dir, invalidSchemaDef)).toThrowError(
      /definePlugin \(Agent Plugins v1\.0\.0\):.*\$schema/,
    )
  })

  it("throws when name is missing", () => {
    const dir = createTempPluginDir()
    const def = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    } as unknown as PluginDefinition

    expect(() => definePlugin(dir, def)).toThrowError(
      /definePlugin \(Agent Plugins v1\.0\.0\):.*name/,
    )
  })

  it("throws when unknown/extra field is present (.strict())", () => {
    const dir = createTempPluginDir()
    const def = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "extra-field-plugin",
      unknownProperty: "not-allowed",
    } as unknown as PluginDefinition

    expect(() => definePlugin(dir, def)).toThrowError(
      /definePlugin \(Agent Plugins v1\.0\.0\):.*unknownProperty/,
    )
  })
})
