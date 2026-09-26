/**
 * Real wiring for the `agentproto setup` wizard: `@clack/prompts` for the UI
 * and prompts, and each existing verb's own entrypoint for every change.
 *
 * Output routing: the clack UI writes through `uiStream`, bound to the
 * ORIGINAL stdout (stderr under --json), so it stays visible while a verb's
 * own stdout/stderr is being buffered behind a spinner.
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Writable } from "node:stream"
import * as clack from "@clack/prompts"
import { runWorkspace } from "../commands/workspace.js"
import { runInstall } from "../commands/install.js"
import { runAuth } from "../commands/auth.js"
import { ensureDaemon, runInstallMcp } from "../commands/install-mcp.js"
import { runInstallSkill } from "../commands/install-skill.js"
import { modelsSummary } from "../commands/models.js"
import { findInstalledAppDir } from "../app-serve.js"
import { runFirstSession } from "./first-run-session.js"
import type { SetupChoice, SetupIO, SetupPrompts, SetupVerbs } from "./types.js"
import type { WizardDeps, WizardUi } from "./wizard.js"

type WriteCallback = (err?: Error | null) => void
type StreamWrite = (
  chunk: string | Uint8Array,
  encodingOrCb?: BufferEncoding | WriteCallback,
  cb?: WriteCallback,
) => boolean

function chunkText(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
}

/** Swap `stream.write` for `sink` while `fn` runs. */
async function redirect<T>(streams: readonly NodeJS.WriteStream[], sink: (text: string) => void, fn: () => Promise<T>): Promise<T> {
  const originals = streams.map((s) => s.write)
  const replacement: StreamWrite = (chunk, encodingOrCb, cb) => {
    sink(chunkText(chunk))
    const done = typeof encodingOrCb === "function" ? encodingOrCb : cb
    done?.(null)
    return true
  }
  for (const s of streams) s.write = replacement
  try {
    return await fn()
  } finally {
    streams.forEach((s, i) => {
      const original = originals[i]
      if (original) s.write = original
    })
  }
}

function uiStreamFor(json: boolean): Writable {
  const target = json ? process.stderr : process.stdout
  const write = target.write.bind(target)
  return Object.assign(
    new Writable({
      write(chunk: string | Uint8Array, _enc, cb) {
        write(chunk)
        cb()
      },
    }),
    { isTTY: target.isTTY === true, columns: target.columns, rows: target.rows },
  )
}

function clackPrompts(output: Writable): SetupPrompts {
  // Clack resolves a cancelled prompt (Ctrl-C / Esc) to its cancel symbol.
  const orNull = <T extends boolean | string | string[]>(v: T | symbol): T | null => (typeof v === "symbol" ? null : v)
  const options = (choices: readonly SetupChoice[]) =>
    choices.map((c) => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) }))
  return {
    confirm: async (message, initial) => orNull<boolean>(await clack.confirm({ message, initialValue: initial, output })),
    multiselect: async (message, choices, initial) =>
      orNull<string[]>(
        await clack.multiselect<string>({
          message,
          options: options(choices),
          initialValues: [...initial],
          required: false,
          output,
        }),
      ),
    select: async (message, choices) => orNull<string>(await clack.select<string>({ message, options: options(choices), output })),
    text: async (message, initial) =>
      orNull<string>(await clack.text({ message, initialValue: initial, defaultValue: initial, output })),
    password: async (message) => orNull<string>(await clack.password({ message, output })),
  }
}

function realVerbs(cwd: string): SetupVerbs {
  return {
    workspace: (args) => runWorkspace(args),
    daemon: async (args) => {
      const { runDaemon } = await import("../commands/daemon.js")
      return runDaemon(args)
    },
    ensureDaemon: () => ensureDaemon(true),
    install: (args) => runInstall(args),
    auth: (args) => runAuth(args),
    installMcp: (args) => runInstallMcp(args),
    installSkill: (slug, args) => runInstallSkill(slug, args),
    updateCli: () =>
      new Promise((resolve) => {
        const child = spawn("npm", ["i", "-g", "@agentproto/cli@latest"], { stdio: "inherit" })
        child.once("error", () => resolve(127))
        child.once("exit", (code) => resolve(code ?? 1))
      }),
    modelsSummary: () => modelsSummary(),
    firstRun: (slug, prompt, onLine) => runFirstSession(slug, prompt, onLine, { cwd }),
    appInstalled: (appId) => findInstalledAppDir(appId) !== undefined,
  }
}

export interface RealSetupOptions {
  /** Prompts allowed (TTY and not --yes). */
  interactive: boolean
  json: boolean
  cwd: string
}

export function createSetupIO(opts: RealSetupOptions): { io: SetupIO; ui: WizardUi; runtime: Pick<WizardDeps, "ledger" | "runQuietly" | "runStreaming" | "writeJson"> } {
  const output = uiStreamFor(opts.json)
  const logOpts = { output }
  const io: SetupIO = {
    interactive: opts.interactive,
    prompts: clackPrompts(output),
    log: {
      info: (m) => clack.log.info(m, logOpts),
      success: (m) => clack.log.success(m, logOpts),
      warn: (m) => clack.log.warn(m, logOpts),
      error: (m) => clack.log.error(m, logOpts),
      step: (m) => clack.log.step(m, logOpts),
      message: (m) => clack.log.message(m, logOpts),
    },
    verbs: realVerbs(opts.cwd),
  }
  const ui: WizardUi = {
    intro: (t) => clack.intro(t, logOpts),
    outro: (m) => clack.outro(m, logOpts),
    note: (m, t) => clack.note(m, t, logOpts),
    spinner: () => {
      // Off a terminal (piped, CI) spinner frames are just escape noise.
      if (Reflect.get(output, "isTTY") !== true) {
        return {
          start: () => undefined,
          stop: (m) => clack.log.success(m, logOpts),
          error: (m) => clack.log.error(m, logOpts),
        }
      }
      const s = clack.spinner({ output })
      return { start: (m) => s.start(m), stop: (m) => s.stop(m), error: (m) => s.error(m) }
    },
  }
  const stdout = process.stdout
  const stderr = process.stderr
  return {
    io,
    ui,
    runtime: {
      ledger: {
        read: (path) => readFile(path, "utf8").catch(() => null),
        write: async (path, text) => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, text, "utf8")
        },
      },
      runQuietly: async (fn) => {
        let captured = ""
        const value = await redirect([stdout, stderr], (t) => (captured += t), fn)
        return { value, output: captured }
      },
      runStreaming: (fn) => {
        if (!opts.json) return fn()
        const toStderr = stderr.write.bind(stderr)
        return redirect([stdout], (t) => toStderr(t), fn)
      },
      writeJson: (text) => stdout.write(text),
    },
  }
}
