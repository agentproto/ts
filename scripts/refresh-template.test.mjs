#!/usr/bin/env node
import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const REFRESH = path.join(ROOT, "scripts/refresh-template.mjs")
const SYNC = path.join(ROOT, "scripts/sync-templates.mjs")
// Pins move with every template bump; derive them instead of hardcoding.
const PINS = JSON.parse(readFileSync(path.join(ROOT, "templates/workstation/versions.json"), "utf8"))

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

// What the fake box reports as installed: the stable pins, except for a
// dev --latest run where it reports what the fake registry served.
function bakedReport(latest) {
  if (latest) {
    return {
      cli: "0.17.0",
      packages: {
        "@agentproto/adapter-hermes": "0.4.10",
        "@agentproto/adapter-mastra-agent": "0.6.0",
        "@agentproto/adapter-opencode": "1.1.10",
        "opencode-ai": "1.18.28",
      },
    }
  }
  return { cli: PINS.cli, packages: { ...PINS.adapters, ...PINS.runtime } }
}

function fakeBinaries(root, { dirty = false, latest = false } = {}) {
  const baked = bakedReport(latest)
  const npmLs = JSON.stringify({
    dependencies: Object.fromEntries(
      [["@agentproto/cli", baked.cli], ...Object.entries(baked.packages)].map(([name, version]) => [name, { version }]),
    ),
  })
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
  // The fake remembers the --cpu-count/--memory-mb each template was created
  // with (state dir), so nproc / free -m inside the proof box report them —
  // the way a real box does (MemTotal ~97% of the configured RAM).
  // FAKE_RESOURCES="<cpus> <mb>" overrides what the box reports.
  const state = path.join(root, "e2b-state")
  mkdirSync(state)
  write("e2b", `
STATE=${state}
if [ "$1" = auth ] && [ "$2" = info ]; then echo logged-in; exit 0; fi
if [ "$1" = template ] && [ "$2" = create ]; then
  case "$3" in
    agentproto-workstation-dev) id=devtemplate000000001 ;;
    agentproto-workstation) id=stabletemplate000001 ;;
    agentproto-workstation-nano) id=nanotemplate00000001 ;;
    agentproto-workstation-small) id=smalltemplate0000001 ;;
    agentproto-workstation-medium) id=mediumtemplate000001 ;;
    agentproto-workstation-large) id=largetemplate0000001 ;;
    *) echo "Error: 400: Memory can't be higher than 8192 MiB" >&2; exit 1 ;;
  esac
  echo "$3" >> "$STATE/created"
  echo "$5 $7" > "$STATE/$id"
  # Real build output ends with the image digest (64 hex chars) after the id.
  echo "created $id"
  echo "digest sha256 7b198ad8ecf27b589cb95353df479e097e2a6ab8a1ab8867438a5a16641d5a87"
  exit 0
fi
# Real e2b sandbox ids are 21 chars and the create output also names the
# template id, so the proof must not mistake the template for the sandbox.
if [ "$1" = sandbox ] && [ "$2" = create ]; then echo "$4" > "$STATE/booted"; echo "Sandbox sandboxproof000000001 created from template $4"; exit 0; fi
if [ "$1" = sandbox ] && [ "$2" = kill ]; then exit 0; fi
if [ "$1" = sandbox ] && [ "$2" = exec ] && [ "$3" != sandboxproof000000001 ]; then echo "Paused sandbox $3 not found" >&2; exit 7; fi
if [ "$1" = sandbox ] && [ "$2" = exec ]; then
  cmd="$5"
  case "$5" in
    agentproto) echo 'agentproto ${baked.cli} (test)'; exit 0 ;;
    node) echo v22.22.0; exit 0 ;;
    git) echo 'git version 2.50.1'; exit 0 ;;
    gh) echo "gh version \${FAKE_GH_VERSION:-${PINS.tools.gh.version}} (2026-09-30)"; exit 0 ;;
    npm) echo '${npmLs}'; exit 0 ;;
    sh) exit 0 ;;
    nproc|free)
      if [ -n "$FAKE_RESOURCES" ]; then set -- "$@" $FAKE_RESOURCES; else set -- "$@" $(cat "$STATE/$(cat "$STATE/booted")"); fi
      shift $(($# - 2))
      if [ "$cmd" = nproc ]; then echo "$1"; else echo "               total        used        free"; echo "Mem:            $(($2 * 97 / 100))         253        1676"; echo "Swap:              0           0           0"; fi
      exit 0 ;;
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
    assert.ok(out.includes(`@agentproto/cli@${PINS.cli}`))
    const preset = PINS.sizes[PINS.defaultSize]
    assert.ok(out.includes(`alias: agentproto-workstation (${PINS.defaultSize}: ${preset.cpuCount} vCPU / ${preset.memoryMb} MB)\n`), out)
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
    const bin = fakeBinaries(root, { latest: true })
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

const readVersions = root => JSON.parse(readFileSync(path.join(root, "templates/workstation/versions.json"), "utf8"))
const createdAliases = root => {
  const file = path.join(root, "e2b-state/created")
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []
}

test("stable --pin without --size publishes the bare alias at defaultSize", () => {
  const root = fixture()
  try {
    const bin = fakeBinaries(root)
    run(root, ["--channel", "stable", "--pin"], { PATH: `${bin}:${process.env.PATH}` })
    const preset = PINS.sizes[PINS.defaultSize]
    assert.deepEqual(createdAliases(root), ["agentproto-workstation"])
    assert.equal(readFileSync(path.join(root, "e2b-state/stabletemplate000001"), "utf8").trim(), `${preset.cpuCount} ${preset.memoryMb}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stable --pin --size <preset> publishes, proves and records only that size", () => {
  const root = fixture()
  try {
    const before = readVersions(root)
    const bin = fakeBinaries(root)
    const out = run(root, ["--channel", "stable", "--pin", "--size", "small"], { PATH: `${bin}:${process.env.PATH}` })
    assert.match(out, /published and proved size small template smalltemplate0000001/)
    assert.match(out, new RegExp(`${PINS.sizes.small.cpuCount} vCPU`))
    assert.deepEqual(createdAliases(root), ["agentproto-workstation-small"])
    const after = readVersions(root)
    assert.equal(after.templates.sizes.small.id, "smalltemplate0000001")
    assert.equal(after.templates.sizes.small.baked.cli, before.cli)
    assert.ok(after.templates.sizes.small.baked.builtAt)
    assert.deepEqual(after.templates.stable, before.templates.stable)
    assert.deepEqual(after.templates.dev, before.templates.dev)
    for (const name of Object.keys(before.sizes).filter(n => n !== "small")) {
      assert.deepEqual(after.templates.sizes[name], before.templates.sizes[name])
    }
    assert.match(readFileSync(path.join(root, "packages/sandbox-e2b/src/template-versions.generated.ts"), "utf8"), /smalltemplate0000001/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stable --pin --size all publishes the bare alias plus every available size, skipping unavailable ones", () => {
  const root = fixture()
  try {
    const bin = fakeBinaries(root)
    const versionsPath = path.join(root, "templates/workstation/versions.json")
    const versions = readVersions(root)
    // Pin the fixture to one unavailable preset so the skip path always runs.
    versions.sizes.medium = { ...versions.sizes.medium, available: false, unavailableReason: "400: plan limit" }
    versions.templates.sizes.medium.id = null
    writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n")
    const { status, stdout: result, stderr } = spawnSync(process.execPath, [REFRESH, "--root", root, "--channel", "stable", "--pin", "--size", "all"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    assert.equal(status, 0, stderr)
    assert.match(result, /published and proved stable template stabletemplate000001 \([^)]*\); size nano template nanotemplate00000001/)
    assert.match(stderr, /skipping unavailable size medium: 400: plan limit/)
    const availableSizes = Object.keys(versions.sizes).filter(n => versions.sizes[n].available !== false)
    assert.deepEqual(createdAliases(root), ["agentproto-workstation", ...availableSizes.map(n => `agentproto-workstation-${n}`)])
    const after = readVersions(root)
    assert.equal(after.templates.sizes.medium.id, null)
    for (const name of availableSizes) assert.ok(after.templates.sizes[name].baked.builtAt, name)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--size rejects unknown and unavailable presets and is stable-only", () => {
  const root = fixture()
  try {
    const bin = fakeBinaries(root)
    const env = { PATH: `${bin}:${process.env.PATH}` }
    assert.match(runExpectingFailure(root, ["--channel", "stable", "--pin", "--size", "huge"], env), new RegExp(`unknown --size "huge"; valid sizes: ${Object.keys(PINS.sizes).join(", ")}, all`))
    assert.match(runExpectingFailure(root, ["--channel", "dev", "--latest", "--size", "small"], env), /--size is a stable-only option/)
    assert.match(runExpectingFailure(root, ["--channel", "stable", "--pin", "--size", "all", "--template-id", "abcdefghijklmnopqrst"], env), /cannot be combined with --size all/)
    for (const [name, preset] of Object.entries(PINS.sizes).filter(([, p]) => p.available === false)) {
      const stderr = runExpectingFailure(root, ["--channel", "stable", "--pin", "--size", name], env)
      assert.ok(stderr.includes(preset.unavailableReason), stderr)
    }
    assert.deepEqual(createdAliases(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the proof fails when the box's nproc / free -m do not match the preset", () => {
  const root = fixture()
  try {
    const before = readVersions(root)
    const bin = fakeBinaries(root)
    const stderr = runExpectingFailure(root, ["--channel", "stable", "--pin", "--size", "large"], { PATH: `${bin}:${process.env.PATH}`, FAKE_RESOURCES: `${PINS.sizes.large.cpuCount} 2048` })
    assert.match(stderr, /proof failed: free -m reported \d+ MB total, expected ~8192 MB/)
    const stderrCpu = runExpectingFailure(root, ["--channel", "stable", "--pin", "--size", "large"], { PATH: `${bin}:${process.env.PATH}`, FAKE_RESOURCES: `1 ${PINS.sizes.large.memoryMb}` })
    assert.match(stderrCpu, /proof failed: nproc reported 1, expected 4/)
    assert.deepEqual(readVersions(root), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check also requires a recorded proof for every available size", () => {
  const root = fixture()
  try {
    const versionsPath = path.join(root, "templates/workstation/versions.json")
    const versions = readVersions(root)
    const name = Object.keys(versions.sizes).find(n => versions.sizes[n].available !== false)
    versions.templates.sizes[name].baked = { cli: null, adapters: null, builtAt: null }
    writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n")
    execFileSync(process.execPath, [path.join(root, "scripts/sync-templates.mjs"), "--root", root])
    assert.match(runExpectingFailure(root, ["--channel", "dev", "--check"]), new RegExp(`size ${name} does not have a complete recorded proof`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the proof requires the pinned gh in the box and records it in baked.tools", () => {
  const root = fixture()
  try {
    const before = readVersions(root)
    const bin = fakeBinaries(root)
    const env = { PATH: `${bin}:${process.env.PATH}` }
    assert.match(runExpectingFailure(root, ["--channel", "stable", "--pin", "--size", "small"], { ...env, FAKE_GH_VERSION: "0.0.1" }), new RegExp(`gh --version did not report ${PINS.tools.gh.version.replaceAll(".", "\\.")}`))
    assert.deepEqual(readVersions(root), before)
    run(root, ["--channel", "stable", "--pin", "--size", "small"], env)
    assert.deepEqual(readVersions(root).templates.sizes.small.baked.tools, { gh: PINS.tools.gh.version })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--check rejects a recorded proof that predates the pinned gh", () => {
  const root = fixture()
  try {
    const versionsPath = path.join(root, "templates/workstation/versions.json")
    const versions = readVersions(root)
    delete versions.templates.stable.baked.tools
    writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n")
    execFileSync(process.execPath, [path.join(root, "scripts/sync-templates.mjs"), "--root", root])
    assert.match(runExpectingFailure(root, ["--channel", "dev", "--check"]), /stable does not have a complete recorded proof/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
