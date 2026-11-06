import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it } from "vitest"
import { collectMastraConfinedReadPaths } from "../confined-read-paths.js"

it("grants built workspace code and installed runtime dependencies without exposing source or dev packages", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mastra-package-grants-")))
  const adapter = join(root, "adapters", "mastra-agent")
  const runtime = join(root, "packages", "runtime")
  const linked = join(root, "outside-app")
  const vendor = join(root, "node_modules", ".pnpm", "dependency@1.0.0", "node_modules", "dependency")
  const dev = join(root, "node_modules", "dev-only")
  const manifest = (path: string, value: object) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, "package.json"), JSON.stringify(value))
  }
  const link = (target: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(target, path, "junction")
  }
  try {
    manifest(adapter, {
      dependencies: { "@agentproto/runtime": "workspace:*", "outside-app": "link:*" },
      devDependencies: { "dev-only": "1.0.0" },
    })
    manifest(runtime, { name: "@agentproto/runtime", dependencies: { dependency: "1.0.0" } })
    manifest(vendor, { name: "dependency", optionalDependencies: { absent: "1.0.0" } })
    manifest(linked, { name: "outside-app" })
    manifest(dev, { name: "dev-only" })
    link(runtime, join(adapter, "node_modules", "@agentproto", "runtime"))
    link(linked, join(adapter, "node_modules", "outside-app"))
    link(vendor, join(runtime, "node_modules", "dependency"))

    expect(new Set(collectMastraConfinedReadPaths(adapter))).toEqual(new Set([
      join(adapter, "package.json"),
      join(adapter, "dist"),
      join(runtime, "package.json"),
      join(runtime, "dist"),
      vendor,
    ]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
