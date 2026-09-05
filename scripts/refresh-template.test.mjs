#!/usr/bin/env node
import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const REFRESH = path.join(ROOT, "scripts/refresh-template.mjs")
const SYNC = path.join(ROOT, "scripts/sync-templates.mjs")

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "refresh-template-fixture-"))
  mkdirSync(path.join(root, "templates/workstation"), { recursive: true })
  mkdirSync(path.join(root, "scripts"), { recursive: true })
  cpSync(path.join(ROOT, "templates/workstation/versions.json"), path.join(root, "templates/workstation/versions.json"))
  cpSync(SYNC, path.join(root, "scripts/sync-templates.mjs"))
  return root
}

function run(root, args, env = {}) {
  return execFileSync(process.execPath, [REFRESH, "--root", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  })
}

function fakeBinaries(root, { dirty = false } = {}) {
  const bin = path.join(root, "bin")
  mkdirSync(bin)
  const write = (name, source) => {
    const target = path.join(bin, name)
    writeFileSync(target, `#!/bin/sh\n${source}\n`)
    chmodSync(target, 0o755)
  }
  write("git", dirty ? 'echo " M changed"' : "exit 0")
  write("npm", `
case "$2" in
  @agentproto/cli@latest) echo '"0.17.0"' ;;
  @agentproto/adapter-hermes@latest) echo '"0.4.10"' ;;
  @agentproto/adapter-mastra-agent@latest) echo '"0.6.0"' ;;
  @agentproto/adapter-opencode@latest) echo '"1.1.10"' ;;
  opencode-ai@latest) echo '"1.18.28"' ;;
  *) exit 9 ;;
esac`)
  write("e2b", `
if [ "$1" = auth ] && [ "$2" = info ]; then echo logged-in; exit 0; fi
if [ "$1" = template ] && [ "$2" = create ]; then
  if [ "$3" = agentproto-workstation-dev ]; then echo "created devtemplate000000001"; else echo "created stabletemplate000001"; fi
  exit 0
fi
if [ "$1" = sandbox ] && [ "$2" = create ]; then echo "created sandboxproof00000001"; exit 0; fi
if [ "$1" = sandbox ] && [ "$2" = kill ]; then exit 0; fi
if [ "$1" = sandbox ] && [ "$2" = exec ]; then
  case "$5" in
    agentproto) echo 'agentproto 0.17.0 (test)'; exit 0 ;;
    node) echo v22.22.0; exit 0 ;;
    git) echo 'git version 2.50.1'; exit 0 ;;
    npm) echo '{"dependencies":{"@agentproto/cli":{"version":"0.17.0"},"@agentproto/adapter-hermes":{"version":"0.4.10"},"@agentproto/adapter-mastra-agent":{"version":"0.6.0"},"@agentproto/adapter-opencode":{"version":"1.1.10"},"opencode-ai":{"version":"1.18.28"}}}'; exit 0 ;;
    sh) exit 0 ;;
  esac
fi
exit 8`)
  return bin
}

function runExpectingFailure(root, args, env = {}) {
  try {
    run(root, args, env)
  } catch (error) {
    return String(error.stderr)
  }
  throw new Error(`expected ${args.join(" ")} to fail`)
}

test("stable --pin bakes exactly the versions.json pins and never touches dev", () => {
  const root = fixture()
  try {
    const before = JSON.parse(readFileSync(path.join(root, "templates/workstation/versions.json"), "utf8"))
    const bin = fakeBinaries(root)
    const out = run(root, ["--channel", "stable", "--pin"], { PATH: `${bin}:${process.env.PATH}` })
    assert.match(out, /published and proved stable template stabletemplate000001/)
    const after = JSON.parse(readFileSync(path.join(root, "templates/workstation/versions.json"), "utf8"))
    assert.deepEqual(after.templates.dev, before.templates.dev)
    assert.equal(after.templates.stable.id, "stabletemplate000001")
    assert.equal(after.templates.stable.baked.cli, before.cli)
    assert.deepEqual(after.templates.stable.baked.adapters, before.adapters)
    assert.ok(after.templates.stable.baked.builtAt)
    assert.equal(after.cli, before.cli)
    assert.deepEqual(after.adapters, before.adapters)
    assert.match(readFileSync(path.join(root, "packages/sandbox-e2b/src/template-versions.generated.ts"), "utf8"), /stabletemplate000001/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stable --pin --dry-run resolves pins from versions.json without registry access", () => {
  const root = fixture()
  try {
    const bin = fakeBinaries(root)
    // Only git is needed pre-dry-run; npm/e2b must not be consulted for pins.
    const out = run(root, ["--channel", "stable", "--pin", "--dry-run"], { PATH: `${bin}:${process.env.PATH}` })
    assert.match(out, /would publish and prove stable/)
    assert.match(out, /@agentproto\/cli@0\.17\.0/)
    assert.match(out, /agentproto-workstation\n/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stable must never pull npm latest and dev must never use --pin", () => {
  const root = fixture()
  try {
    const bin = fakeBinaries(root)
    assert.match(runExpectingFailure(root, ["--channel", "stable", "--latest"], { PATH: `${bin}:${process.env.PATH}` }), /stable must never pull npm latest/)
    assert.match(runExpectingFailure(root, ["--channel", "stable"], { PATH: `${bin}:${process.env.PATH}` }), /requires --pin/)
    assert.match(runExpectingFailure(root, ["--channel", "dev", "--pin"], { PATH: `${bin}:${process.env.PATH}` }), /--pin is a stable-only mode/)
    assert.equal(existsSync(path.join(root, "templates/workstation/versions.json.bak")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check is zero-credential and validates generated drift plus the exact dev proof", () => {
  const root = fixture()
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/sync-templates.mjs"), "--root", root])
    const out = run(root, ["--channel", "dev", "--check"], { PATH: "/does-not-exist" })
    assert.match(out, /complete recorded proof/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("latest refresh only changes the proved dev entry and canonical generated files", () => {
  const root = fixture()
  try {
    const before = JSON.parse(readFileSync(path.join(root, "templates/workstation/versions.json"), "utf8"))
    const bin = fakeBinaries(root)
    const out = run(root, ["--channel", "dev", "--latest"], { PATH: `${bin}:${process.env.PATH}` })
    assert.match(out, /published and proved dev template devtemplate000000001/)
    const after = JSON.parse(readFileSync(path.join(root, "templates/workstation/versions.json"), "utf8"))
    assert.deepEqual(after.templates.stable, before.templates.stable)
    assert.equal(after.templates.dev.id, "devtemplate000000001")
    assert.equal(after.templates.dev.baked.cli, "0.17.0")
    assert.ok(after.templates.dev.baked.builtAt)
    assert.equal(existsSync(path.join(root, "templates/workstation/Dockerfile")), true)
    assert.match(readFileSync(path.join(root, "packages/sandbox-e2b/src/template-versions.generated.ts"), "utf8"), /devtemplate000000001/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a dirty tree is rejected before registry or E2B work", () => {
  const root = fixture()
  try {
    const bin = fakeBinaries(root, { dirty: true })
    let stderr = ""
    try {
      run(root, ["--channel", "dev", "--latest"], { PATH: `${bin}:${process.env.PATH}` })
    } catch (error) {
      stderr = String(error.stderr)
    }
    assert.match(stderr, /dirty tree/)
    assert.equal(existsSync(path.join(root, "templates/workstation/Dockerfile")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check rejects a dev proof that does not match the declared adapter pins", () => {
  const root = fixture()
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/sync-templates.mjs"), "--root", root])
    const versionsPath = path.join(root, "templates/workstation/versions.json")
    const versions = JSON.parse(readFileSync(versionsPath, "utf8"))
    versions.templates.dev.baked.adapters["@agentproto/adapter-opencode"] = "0.0.0"
    writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n")
    execFileSync(process.execPath, [path.join(root, "scripts/sync-templates.mjs"), "--root", root])
    let stderr = ""
    try {
      run(root, ["--channel", "dev", "--check"])
    } catch (error) {
      stderr = String(error.stderr)
    }
    assert.match(stderr, /complete recorded proof/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
