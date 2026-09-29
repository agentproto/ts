/**
 * `agentproto app pack <appDir> [--out <path.agentapp>] [--json]`
 * `agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]`
 * `agentproto app install <dir|url|file.agentapp> [--ref] [--subdir] [--data-dir]`
 * `agentproto app resync <appId>`
 *
 * Package an agentproto app folder (one holding a valid `.agentproto/APP.md`)
 * into a single self-contained `.agentapp` tar.gz bundle — the "APK for
 * agentproto apps" — and unpack that bundle back into a folder, verifying
 * the aggregate SHA-256 before restoring. The pack/unpack core lives in
 * `@agentproto/app-kit` (`packApp` / `unpackApp`); the verbs here are thin
 * wrappers over it. This file also dispatches `app serve` (`../app-serve.ts`),
 * `app build` (`../app-build.ts`), and `app dev` (`../app-dev.ts`).
 *
 * `install` of a git URL or `.agentapp` (URL or local file) is executed by the
 * running daemon (`app_install`), which owns the remote-install state; a plain
 * directory keeps the local id→dir registration.
 */

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import matter from "gray-matter"
import { AgentAppPackError, packApp, unpackApp } from "@agentproto/app-kit"
import { pathExists } from "./skill-install/shared.js"
import { expandHome } from "./skill-install/pack-resolve.js"
import {
  runAppServe,
  installAppDir,
  listInstalledApps,
  resolveDaemonMcpUrl,
  createDaemonMcpClientGetter,
} from "../app-serve.js"
import { runAppBuild } from "../app-build.js"
import { runAppDev } from "../app-dev.js"
import { runAppInit, runAppValidate } from "./app-init.js"

const USAGE = `agentproto app — package, unpack, install, serve, build, or dev an agentproto app

Usage:
  agentproto app pack <appDir> [--out <path.agentapp>] [--json]
  agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]
  agentproto app install <appDir|url|file.agentapp> [--ref <ref>] [--subdir <path>] [--data-dir <path>]
  agentproto app resync <appId>
  agentproto app list
  agentproto app serve [appDir] [--port <n>] [--app <appId>] [--json]
  agentproto app build <appDir> [--json]
  agentproto app dev <appDir> [--port <n>] [--json] [-- <viteArgs...>]
  agentproto app init <template> [dir]
  agentproto app validate [dir] [--json]

pack:
  Walk <appDir> (must contain .agentproto/APP.md), write manifest.json and a
  sha256 aggregate over every file, and emit a verified .agentapp tar.gz.
  Without --out, derives <id>-<version>.agentapp in the current directory.
  Skips any node_modules/ or .git/ directory at any depth.

unpack:
  Extract a .agentapp, verify format agentapp/v1 and the sha256 aggregate,
  and restore the app folder (without manifest.json). Without --dir,
  restores into <id>-<version> in the current directory.

install:
  Install an app. <appDir> registers an app id→dir mapping in
  ~/.agentproto/apps.json (reads .agentproto/APP.md for the id; idempotent).
  A git URL (https://…, git@…, file://…; optional --ref branch/tag and
  --subdir path inside the repo) or a .agentapp (https URL, file:// URL, or
  local path) is installed BY THE RUNNING DAEMON under its state dir
  (~/.agentproto/apps/<slug>), pinned to the installed commit / bundle digest.
  Start the daemon first for those. Re-installing replaces the app dir and
  keeps its data dir.
  --data-dir <path> sets where the app's durable data (app_data_*) lives,
  distinct from its source dir. Absolute, ~-relative, or relative to
  <appDir>. Without it: the entry's existing data dir is kept, else the
  APP.md \`data.dir\` hint (relative to <appDir>), else <appDir>/data.

resync:
  Ask the running daemon to re-check an app installed from git or a
  .agentapp against its source, and reinstall it when the remote moved.
  Prints { changed: false } or { changed: true, from, to }.

list:
  List every registered app (id → dir, data dir) from ~/.agentproto/apps.json.

serve:
  Serve <appDir>'s .agentproto/ui/ as a standalone webapp with a window.McpApp
  bridge wired to the daemon's /mcp endpoint. Pass --app <appId> to serve an
  installed app by its registered id instead of giving a directory path.
  Port resolution: --port, then the APP.md "ui.port" hint, then an OS-assigned
  free port.

build:
  Build <appDir>/ui/ (a Vite UI source project) into .agentproto/ui/. No
  ui/ project, or one with no "scripts.build", is a no-op success — the app
  is a hand-written static UI with nothing to compile.

dev:
  Run <appDir>/ui/'s own dev server with a live window.McpApp bridge (a
  bridge-only HTTP server, CORS-enabled, separate from the Vite dev port).
  Requires ui/package.json with a "scripts.dev"; static UIs use app serve.`

// ── public entries ───────────────────────────────────────────────────────

/** Dispatcher for `agentproto app` — first non-flag token is the subverb. */
export async function runApp(args: readonly string[]): Promise<number> {
  const subVerb = args.find((a) => !a.startsWith("-"))
  if (subVerb === "pack") {
    return runAppPack(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "unpack") {
    return runAppUnpack(args.filter((a) => a !== subVerb))
  }

  if (subVerb === "serve") {
    return runAppServe(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "install") {
    return runAppInstall(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "resync") {
    return runAppResync(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "list") {
    return runAppList()
  }
  if (subVerb === "build") {
    return runAppBuild(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "dev") {
    return runAppDev(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "init") {
    return runAppInit(args.filter((a) => a !== subVerb))
  }
  if (subVerb === "validate") {
    return runAppValidate(args.filter((a) => a !== subVerb))
  }

  process.stderr.write(
    `agentproto app: unknown sub-command${subVerb ? ` '${subVerb}'` : ""}.\n` +
      `${USAGE}\n`,
  )
  return 2
}

/** `agentproto app install <appDir>` — register the app's id→dir mapping. */
export async function runAppInstall(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      "data-dir": { type: "string" },
      ref: { type: "string" },
      subdir: { type: "string" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const appDirArg = positionals[0]
  if (!appDirArg) {
    process.stderr.write(
      `agentproto app install: <appDir> is required.\n${USAGE}\n`,
    )
    return 2
  }
  const dataDirArg = typeof values["data-dir"] === "string" ? values["data-dir"] : undefined
  if (dataDirArg !== undefined && dataDirArg.trim() === "") {
    process.stderr.write(`agentproto app install: --data-dir needs a path.\n`)
    return 2
  }

  const refArg = typeof values.ref === "string" ? values.ref : undefined
  const subdirArg = typeof values.subdir === "string" ? values.subdir : undefined

  if (isRemoteInstallUrl(appDirArg)) {
    const kind = /\.agentapp(\?.*)?$/.test(appDirArg) ? "agentapp" : "git"
    if (kind === "agentapp" && (refArg !== undefined || subdirArg !== undefined)) {
      process.stderr.write(`agentproto app install: --ref/--subdir only apply to git URLs.\n`)
      return 2
    }
    return callDaemonAppTool("install", "app_install", {
      url: appDirArg,
      ...(refArg !== undefined ? { ref: refArg } : {}),
      ...(subdirArg !== undefined ? { subdir: subdirArg } : {}),
      ...(dataDirArg !== undefined ? { dataDir: dataDirArg } : {}),
    })
  }
  if (refArg !== undefined || subdirArg !== undefined) {
    process.stderr.write(`agentproto app install: --ref/--subdir only apply to git URLs.\n`)
    return 2
  }
  if (appDirArg.endsWith(".agentapp")) {
    const file = resolve(process.cwd(), expandHome(appDirArg))
    if (!(await pathExists(file))) {
      process.stderr.write(`agentproto app install: bundle not found: ${file}\n`)
      return 2
    }
    return callDaemonAppTool("install", "app_install", {
      file,
      ...(dataDirArg !== undefined ? { dataDir: dataDirArg } : {}),
    })
  }

  const appDir = resolve(process.cwd(), expandHome(appDirArg))
  const appMdPath = join(appDir, ".agentproto", "APP.md")

  if (!(await pathExists(appMdPath))) {
    process.stderr.write(
      `agentproto app install: ${appDir} is not an agentproto app ` +
        `(missing ${appMdPath}).\n`,
    )
    return 2
  }

  // Read the app id (and the optional `data.dir` hint) from APP.md frontmatter.
  let appId: string
  let hintDir: string | undefined
  try {
    const raw = await readFile(appMdPath, "utf8")
    const front = matter(raw).data as Record<string, unknown>
    const dataHint = front.data
    if (typeof dataHint === "object" && dataHint !== null) {
      const d = (dataHint as { dir?: unknown }).dir
      if (typeof d === "string" && d.trim() !== "") hintDir = d
    }
    appId =
      typeof front.id === "string" && front.id.length > 0
        ? front.id
        : typeof front.slug === "string" && front.slug.length > 0
          ? front.slug
          : ""
  } catch {
    process.stderr.write(
      `agentproto app install: could not parse ${appMdPath}.\n`,
    )
    return 1
  }

  if (!appId) {
    process.stderr.write(
      `agentproto app install: APP.md must have a non-empty 'id' or 'slug' field.\n`,
    )
    return 2
  }

  const entry = installAppDir(appId, appDir, {
    ...(dataDirArg !== undefined ? { dataDir: dataDirArg } : {}),
    ...(hintDir !== undefined ? { hintDir } : {}),
  })
  process.stdout.write(
    `agentproto: registered app '${appId}' -> ${appDir}\n` +
      `  data dir: ${entry.dataDir}\n`,
  )
  return 0
}

/** `agentproto app list` — print every registered app id→dir mapping,
 *  with its data dir. */
export async function runAppList(): Promise<number> {
  const apps = listInstalledApps()
  if (apps.length === 0) {
    process.stdout.write("agentproto: no installed apps.\n")
    return 0
  }

  for (const app of apps) {
    process.stdout.write(`${app.appId} -> ${app.dir}\n  data dir: ${app.dataDir}\n`)
  }
  return 0
}


/** True for anything `app install` hands to the daemon as `{url}` (git or
 *  `.agentapp`): a scheme URL or scp-style `git@host:path`. */
function isRemoteInstallUrl(arg: string): boolean {
  return /^(https?|file|ssh|git):\/\//.test(arg) || /^[\w.-]+@[\w.-]+:/.test(arg)
}

/** Call a daemon `app_*` tool over its /mcp endpoint and print the JSON result. */
async function callDaemonAppTool(
  verb: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<number> {
  let text: string | undefined
  let isError = false
  try {
    const client = await createDaemonMcpClientGetter(await resolveDaemonMcpUrl(), "agentproto-app")()
    const res = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean
      content?: { type: string; text?: string }[]
    }
    isError = res.isError === true
    text = res.content?.find((c) => c.type === "text")?.text
  } catch (err) {
    process.stderr.write(
      `agentproto app ${verb}: could not reach the daemon (${err instanceof Error ? err.message : String(err)}). ` +
        `Start it first.\n`,
    )
    return 1
  }
  if (isError) {
    let message = text ?? "daemon returned an error"
    try {
      const parsed = JSON.parse(message) as { error?: unknown }
      if (typeof parsed.error === "string") message = parsed.error
    } catch {
      // not JSON — print as-is
    }
    process.stderr.write(`agentproto app ${verb}: ${message}\n`)
    return 1
  }
  process.stdout.write((text ?? "{}") + "\n")
  return 0
}

/** `agentproto app resync <appId>` — re-check a remote-installed app's source. */
export async function runAppResync(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: { help: { type: "boolean", short: "h" } },
  })
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const appId = positionals[0]
  if (!appId) {
    process.stderr.write(`agentproto app resync: <appId> is required.\n${USAGE}\n`)
    return 2
  }
  return callDaemonAppTool("resync", "app_resync", { appId })
}

/** `agentproto app pack <appDir> [--out ...] [--json]`. */
export async function runAppPack(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      out: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const appDir = positionals[0]
  if (!appDir) {
    process.stderr.write(`agentproto app pack: <appDir> is required.\n${USAGE}\n`)
    return 2
  }

  try {
    const { file, manifest } = await packApp({
      appDir: resolve(process.cwd(), expandHome(appDir)),
      ...(typeof values.out === "string"
        ? { out: resolve(process.cwd(), expandHome(values.out)) }
        : {}),
    })
    if (values.json) {
      process.stdout.write(JSON.stringify(manifest, null, 2) + "\n")
    } else {
      process.stdout.write(`agentproto: packed ${manifest.totalSize} bytes -> ${file}\n`)
    }
    return 0
  } catch (err) {
    if (err instanceof AgentAppPackError) {
      process.stderr.write(`agentproto app pack: ${err.message}\n`)
      return err.code === "not-an-app" ? 2 : 1
    }
    throw err
  }
}

/** `agentproto app unpack <file.agentapp> [--dir ...] [--json]`. */
export async function runAppUnpack(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      dir: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const fileArg = positionals[0]
  if (!fileArg) {
    process.stderr.write(`agentproto app unpack: <file.agentapp> is required.\n${USAGE}\n`)
    return 2
  }

  try {
    const { dir, manifest } = await unpackApp({
      file: resolve(process.cwd(), expandHome(fileArg)),
      ...(typeof values.dir === "string"
        ? { dest: resolve(process.cwd(), expandHome(values.dir)) }
        : {}),
    })
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            fileCount: manifest.fileCount,
            outDir: dir,
            sha256: manifest.sha256,
            verified: true,
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      const label = manifest.name !== undefined ? ` (${manifest.name})` : ""
      process.stdout.write(
        `agentproto: unpacked ${manifest.id}${label} v${manifest.version} -> ${dir}\n` +
          `  ${manifest.fileCount} file(s), sha256 verified (${manifest.sha256.slice(0, 12)}...)\n`,
      )
    }
    return 0
  } catch (err) {
    if (err instanceof AgentAppPackError) {
      process.stderr.write(`agentproto app unpack: ${err.message}\n`)
      return err.code === "bundle-not-found" ? 2 : 1
    }
    process.stderr.write(
      `agentproto app unpack: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
}
