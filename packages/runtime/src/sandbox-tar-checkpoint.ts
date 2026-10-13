/**
 * Tarball checkpoints of a sandbox session's working dir, for workspaces with
 * no git clone source (no configured `remote`, no usable `origin`).
 *
 * Without a remote a box has no branch to push, so the work would die with the
 * box. Instead the box's working dir is packed (`.git`, `node_modules` and
 * `.gitignore`d paths excluded, size-capped), pulled to the host under the
 * session's directory in `~/.agentproto`, and — when the session is restarted
 * on a FRESH box — uploaded and extracted into the new box's working dir.
 *
 * It rides the same hooks as the git checkpoint (`sandbox-delivery.ts`): the
 * proxy's per-turn/periodic `checkpoint` and its `onBeforeTeardown`, both gated
 * by the resolved `defaults.sandbox.checkpoint` config.
 *
 * `workspace-checkpoint.json` in the session dir is written when the session
 * boots (status `pending`) and updated by every run; it doubles as the marker
 * that a session is in tar mode and names the box dir, so a restart or a
 * daemon re-attach can re-wire the hooks without any descriptor field.
 */

import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile as readHostFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_CHECKPOINT_DEADLINE_MS,
  DEFAULT_DELIVERY_DEADLINE_MS,
  type ResolvedSandboxCheckpointConfig,
} from "./sandbox-delivery.js"
import { describeExecFailure, shellQuote, type SandboxExec } from "./sandbox-workspace-remote.js"

export const WORKSPACE_TAR_FILE = "workspace-checkpoint.tar.gz"
export const WORKSPACE_TAR_RECORD_FILE = "workspace-checkpoint.json"
/** Archives above this are left in the box and reported, not downloaded. */
export const DEFAULT_TAR_MAX_BYTES = 50 * 1024 * 1024
/** Always excluded; a `.gitignore` in the working dir adds to these. */
export const DEFAULT_TAR_EXCLUDES: readonly string[] = [
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".DS_Store",
]

const BOX_TAR_PATH = "/tmp/agentproto-workspace-checkpoint.tar"
const BOX_RESTORE_PATH = "/tmp/agentproto-workspace-restore.tar.gz"
const PACK_TIMEOUT_MS = 120_000
const EXTRACT_TIMEOUT_MS = 120_000

export interface TarCheckpointTarget {
  /** Absolute working dir INSIDE the box. */
  dir: string
}

export type TarCheckpointStatus = "pending" | "saved" | "skipped" | "failed"

export interface TarCheckpointRecord {
  at: string
  dir: string
  status: TarCheckpointStatus
  mode?: "checkpoint" | "teardown"
  /** Host path of the latest saved archive, when one exists. */
  path?: string
  bytes?: number
  /** sha256 of the packed archive — a run that packs the same key skips the download. */
  key?: string
  unchanged?: boolean
  detail?: string
  turn?: number
}

export function tarRecordPath(sessionDir: string): string {
  return join(sessionDir, WORKSPACE_TAR_RECORD_FILE)
}

export function tarArchivePath(sessionDir: string): string {
  return join(sessionDir, WORKSPACE_TAR_FILE)
}

/**
 * The shell command that packs `dir` into `<boxTar>.gz` and prints `bytes=` and
 * `sha=`. Deterministic (sorted names, `gzip -n`) so an untouched dir yields the
 * same sha. tar exit 1 ("file changed as we read it") is tolerated: the agent
 * keeps working during a periodic checkpoint.
 */
export function buildTarPackCommand(
  dir: string,
  excludes: readonly string[] = DEFAULT_TAR_EXCLUDES,
  boxTar: string = BOX_TAR_PATH,
): string {
  const patterns = excludes.map(shellQuote).join(" ")
  const out = shellQuote(`${boxTar}.gz`)
  const tarFile = shellQuote(boxTar)
  // Drop comments, negations, blanks and catch-all (`*`, `/`) lines of a
  // `.gitignore` — tar has no negation, and a bare `*` would exclude everything.
  const gitignore =
    `[ ! -f .gitignore ] || sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*!/d' -e '/^[[:space:]]*$/d' ` +
    `-e '/^[*\\/]*$/d' -e 's#^/##' -e 's#/*$##' .gitignore >> "$ex"`
  return (
    `cd ${shellQuote(dir)} || { echo "working dir does not exist in the box" >&2; exit 3; }; ` +
    `ex=$(mktemp) || exit 3; printf '%s\\n' ${patterns} > "$ex"; { ${gitignore}; }; ` +
    `rm -f ${tarFile} ${out}; ` +
    `tar --sort=name --exclude-from="$ex" -cf ${tarFile} . 2>/dev/null; rc=$?; ` +
    `if [ $rc -gt 1 ] || [ ! -s ${tarFile} ]; then rm -f ${tarFile}; tar --exclude-from="$ex" -cf ${tarFile} .; rc=$?; fi; ` +
    `rm -f "$ex"; [ $rc -le 1 ] || { echo "tar failed (exit $rc)" >&2; exit 2; }; ` +
    `gzip -nf ${tarFile} && echo "bytes=$(wc -c < ${out} | tr -d ' ')" && echo "sha=$(sha256sum ${out} | cut -d' ' -f1)"`
  )
}

export function parseTarPack(stdout: string): { bytes: number; sha: string } | undefined {
  const bytes = /^bytes=(\d+)$/m.exec(stdout)
  const sha = /^sha=([0-9a-f]{64})$/m.exec(stdout)
  return bytes && sha ? { bytes: Number(bytes[1]), sha: sha[1]! } : undefined
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function withTimeout<T>(ms: number, run: (timeoutMs: number) => Promise<T>): Promise<T> {
  if (ms <= 0) throw new Error("checkpoint deadline reached")
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("checkpoint deadline reached")), ms)
  })
  try {
    return await Promise.race([run(ms), expired])
  } finally {
    clearTimeout(timer)
  }
}

async function persistTarRecord(record: TarCheckpointRecord, outDir: string): Promise<TarCheckpointRecord> {
  try {
    await mkdir(outDir, { recursive: true })
    await writeFile(tarRecordPath(outDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // the record is informational; a disk failure must not block teardown
  }
  return record
}

/** Mark a session as tar-mode from boot, before any checkpoint has run. */
export function writePendingTarRecord(outDir: string, target: TarCheckpointTarget, now = new Date()): Promise<TarCheckpointRecord> {
  return persistTarRecord({ at: now.toISOString(), dir: target.dir, status: "pending" }, outDir)
}

export interface RunTarCheckpointInput {
  exec: SandboxExec
  /** Absent when the provider cannot download files. */
  readFile?: (path: string) => Promise<Uint8Array>
  target: TarCheckpointTarget
  /** Host session dir receiving the archive and the record. */
  outDir: string
  mode?: "checkpoint" | "teardown"
  maxBytes?: number
  /** Wall-clock budget for pack + download. */
  deadlineMs?: number
  excludes?: readonly string[]
  /** Key of the last archive that reached the host. */
  previousKey?: string
  turn?: number
  now?: () => Date
}

/** Pack the box's working dir and pull the archive to the host. Never throws. */
export async function runTarCheckpoint(input: RunTarCheckpointInput): Promise<TarCheckpointRecord> {
  const mode = input.mode ?? "checkpoint"
  const maxBytes = input.maxBytes ?? DEFAULT_TAR_MAX_BYTES
  const deadlineAt =
    Date.now() + (input.deadlineMs ?? (mode === "teardown" ? DEFAULT_DELIVERY_DEADLINE_MS : DEFAULT_CHECKPOINT_DEADLINE_MS))
  const archive = tarArchivePath(input.outDir)
  const finish = (partial: Pick<TarCheckpointRecord, "status"> & Partial<TarCheckpointRecord>) =>
    persistTarRecord(
      {
        at: (input.now?.() ?? new Date()).toISOString(),
        dir: input.target.dir,
        mode,
        ...(input.turn !== undefined ? { turn: input.turn } : {}),
        ...(existsSync(archive) ? { path: archive } : {}),
        ...partial,
      },
      input.outDir,
    )

  if (!input.readFile) {
    return finish({ status: "failed", detail: "the sandbox provider cannot download files from the box" })
  }
  let packed: { bytes: number; sha: string }
  try {
    const result = await withTimeout(Math.min(PACK_TIMEOUT_MS, deadlineAt - Date.now()), timeoutMs =>
      input.exec({ command: buildTarPackCommand(input.target.dir, input.excludes), timeoutMs }),
    )
    const parsed = result.exitCode === 0 ? parseTarPack(result.stdout) : undefined
    if (!parsed) {
      return finish({
        status: "failed",
        detail: `packing ${input.target.dir} failed: ${result.exitCode === 0 ? "unparseable output" : describeExecFailure(result)}`,
      })
    }
    packed = parsed
  } catch (err) {
    return finish({ status: "failed", detail: `packing ${input.target.dir} failed: ${errorText(err)}` })
  }

  if (packed.bytes > maxBytes) {
    return finish({
      status: "skipped",
      detail:
        `archive of ${input.target.dir} is ${packed.bytes} bytes, over the ${maxBytes} byte limit; ` +
        `left at ${BOX_TAR_PATH}.gz in the box (add large generated paths to .gitignore to shrink it)`,
    })
  }
  if (input.previousKey !== undefined && input.previousKey === packed.sha) {
    return finish({ status: "skipped", unchanged: true, key: packed.sha, detail: "unchanged since the last checkpoint" })
  }
  try {
    const data = await withTimeout(deadlineAt - Date.now(), () => input.readFile!(`${BOX_TAR_PATH}.gz`))
    if (data.byteLength > maxBytes) {
      return finish({ status: "skipped", detail: `downloaded archive is ${data.byteLength} bytes, over the ${maxBytes} byte limit` })
    }
    await mkdir(input.outDir, { recursive: true })
    const tmp = `${archive}.tmp`
    await writeFile(tmp, data, { mode: 0o600 })
    await rename(tmp, archive)
    return finish({ status: "saved", path: archive, bytes: data.byteLength, key: packed.sha })
  } catch (err) {
    return finish({ status: "failed", detail: `downloading the archive failed: ${errorText(err)}` })
  }
}

export interface SandboxTarCheckpointer {
  run(turn?: number): Promise<TarCheckpointRecord>
}

/** Serialized tar checkpoints for one box; remembers the last saved key. */
export function createTarCheckpointer(
  input: Omit<RunTarCheckpointInput, "mode" | "previousKey" | "turn"> & {
    onRecord?: (record: TarCheckpointRecord) => void
  },
): SandboxTarCheckpointer {
  const { onRecord, ...run } = input
  let lastKey: string | undefined
  let inFlight: Promise<TarCheckpointRecord> | undefined
  return {
    run(turn) {
      if (inFlight) return inFlight
      inFlight = (async () => {
        const record = await runTarCheckpoint({
          ...run,
          mode: "checkpoint",
          ...(lastKey !== undefined ? { previousKey: lastKey } : {}),
          ...(turn !== undefined ? { turn } : {}),
        })
        if (record.status === "saved" && record.key !== undefined) lastKey = record.key
        try {
          onRecord?.(record)
        } catch {
          // reporting is best-effort
        }
        return record
      })().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}

/** One-line summary for the session's transcript. */
export function formatTarNotice(record: TarCheckpointRecord): string {
  const head = `[sandbox workspace checkpoint] ${record.dir}`
  switch (record.status) {
    case "saved":
      return `${head} — saved ${record.bytes ?? 0} bytes to ${record.path}`
    case "pending":
      return `${head} — no checkpoint taken yet`
    default:
      return `${head} — ${record.status}${record.detail ? ` (${record.detail})` : ""}`
  }
}

/**
 * The proxy's `checkpoint` / `onBeforeTeardown` options for a tar-mode box —
 * the counterpart of `sandboxCheckpointOpts` + `createDeliveryHook`. The
 * per-turn/periodic checkpoint follows `config.onTurnEnd`, the teardown one
 * `config.onTeardown`. `notify` receives periodic outcomes worth showing (not
 * the unchanged ones); the teardown outcome is persisted and logged only when
 * it did not save, since the session's transcript is already closed by then.
 */
export function tarCheckpointProxyOpts(input: {
  exec: SandboxExec | undefined
  readFile?: (path: string) => Promise<Uint8Array>
  target: TarCheckpointTarget | undefined
  outDir: string
  config: ResolvedSandboxCheckpointConfig
  notify?: (text: string) => void
}): {
  onBeforeTeardown?: () => Promise<void>
  checkpoint?: { run: (turn?: number) => Promise<TarCheckpointRecord>; intervalMs: number }
} {
  const { exec, target, config } = input
  if (!exec || !target) return {}
  const base = { exec, ...(input.readFile ? { readFile: input.readFile } : {}), target, outDir: input.outDir }
  const out: ReturnType<typeof tarCheckpointProxyOpts> = {}
  if (config.onTeardown) {
    out.onBeforeTeardown = async () => {
      const record = await runTarCheckpoint({ ...base, mode: "teardown", deadlineMs: config.timeoutMs })
      if (record.status !== "saved") console.warn(formatTarNotice(record))
    }
  }
  if (config.onTurnEnd) {
    const checkpointer = createTarCheckpointer({
      ...base,
      deadlineMs: config.timeoutMs,
      onRecord: record => {
        if (!record.unchanged) input.notify?.(formatTarNotice(record))
      },
    })
    out.checkpoint = { run: turn => checkpointer.run(turn), intervalMs: config.minIntervalMs }
  }
  return out
}

/** Read a session's tar-mode marker; `undefined` when it is not in tar mode. */
export async function readTarTarget(sessionDir: string): Promise<TarCheckpointTarget | undefined> {
  try {
    const record = JSON.parse(await readHostFile(tarRecordPath(sessionDir), "utf8")) as Partial<TarCheckpointRecord>
    return typeof record.dir === "string" && record.dir.startsWith("/") ? { dir: record.dir } : undefined
  } catch {
    return undefined
  }
}

/** Host path of a session's saved archive, when one exists. */
export function savedTarArchive(sessionDir: string): string | undefined {
  const path = tarArchivePath(sessionDir)
  return existsSync(path) ? path : undefined
}

/**
 * A restarted session continues the previous one's tar-mode chain: adopt its
 * target, mark the new session dir as tar-mode, and carry the latest archive
 * over so a second restart still has a baseline.
 */
export async function adoptTarCheckpoint(prevDir: string, nextDir: string): Promise<TarCheckpointTarget | undefined> {
  const target = await readTarTarget(prevDir)
  if (!target) return undefined
  await writePendingTarRecord(nextDir, target)
  const archive = savedTarArchive(prevDir)
  if (archive) await copyFile(archive, tarArchivePath(nextDir)).catch(() => undefined)
  return target
}

export type TarRestoreResult = { ok: true; bytes: number } | { ok: false; message: string }

/** Upload `archivePath` into the box and extract it into `target.dir`. */
export async function restoreTarCheckpoint(input: {
  exec: SandboxExec
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  target: TarCheckpointTarget
  archivePath: string
  maxBytes?: number
}): Promise<TarRestoreResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_TAR_MAX_BYTES
  if (!input.writeFile) {
    return { ok: false, message: "the sandbox provider cannot upload files into the box" }
  }
  let data: Uint8Array
  try {
    const size = (await stat(input.archivePath)).size
    if (size > maxBytes) {
      return { ok: false, message: `checkpoint archive ${input.archivePath} is ${size} bytes, over the ${maxBytes} byte limit` }
    }
    data = await readHostFile(input.archivePath)
  } catch (err) {
    return { ok: false, message: `cannot read checkpoint archive ${input.archivePath}: ${errorText(err)}` }
  }
  try {
    await input.writeFile(BOX_RESTORE_PATH, data)
    const dir = shellQuote(input.target.dir)
    const result = await input.exec({
      command:
        `mkdir -p ${dir} && tar --no-same-owner -xzf ${shellQuote(BOX_RESTORE_PATH)} -C ${dir}; ` +
        `rc=$?; rm -f ${shellQuote(BOX_RESTORE_PATH)}; exit $rc`,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) {
      return { ok: false, message: `extracting into ${input.target.dir} failed: ${describeExecFailure(result)}` }
    }
    return { ok: true, bytes: data.byteLength }
  } catch (err) {
    return { ok: false, message: `restoring into ${input.target.dir} failed: ${errorText(err)}` }
  }
}

export type TarWorkspaceSetup =
  | { ok: true; target?: TarCheckpointTarget; notices: string[] }
  | { ok: false; message: string }

/**
 * Prepare a box's working dir (`<homeDir>/<slug>`) for tar checkpoints and,
 * when `restoreFrom` names a saved archive, restore it there. A provider that
 * cannot shell in or download files cannot checkpoint: that is reported as a
 * notice and the session simply runs without tar mode — unless a restore was
 * requested, which then fails rather than silently start empty.
 */
export async function setupTarWorkspace(input: {
  exec?: SandboxExec
  readFile?: (path: string) => Promise<Uint8Array>
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  homeDir: string
  slug: string
  /** Host session dir receiving the archive and the tar-mode marker. */
  sessionDir: string
  restoreFrom?: string
}): Promise<TarWorkspaceSetup> {
  const dir = `${input.homeDir.replace(/\/+$/, "")}/${input.slug}`
  const how =
    `Fix: give the workspace a git remote (\`agentproto workspace remote set ${input.slug} --url <https-url> --token-stdin\`) ` +
    "so work is pushed instead, or use a sandbox provider that supports exec and file transfer."
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.slug)) {
    return input.restoreFrom
      ? { ok: false, message: `workspace slug "${input.slug}" is not usable as a directory name in the box` }
      : { ok: true, notices: [`workspace slug "${input.slug}" is not usable as a directory name in the box; work in it is not checkpointed.`] }
  }
  if (!input.exec || !input.readFile) {
    const missing = !input.exec ? "run commands in the box" : "download files from the box"
    const message = `the sandbox provider cannot ${missing}, so the working dir cannot be checkpointed. ${how}`
    return input.restoreFrom ? { ok: false, message } : { ok: true, notices: [`[sandbox] ${message}`] }
  }
  const target = { dir }
  try {
    const made = await input.exec({ command: `mkdir -p ${shellQuote(dir)}`, timeoutMs: 30_000 })
    if (made.exitCode !== 0) throw new Error(describeExecFailure(made))
  } catch (err) {
    return { ok: false, message: `cannot create the working dir ${dir} in the box: ${errorText(err)}` }
  }
  const notices: string[] = []
  if (input.restoreFrom) {
    const restored = await restoreTarCheckpoint({
      exec: input.exec,
      ...(input.writeFile ? { writeFile: input.writeFile } : {}),
      target,
      archivePath: input.restoreFrom,
    })
    if (!restored.ok) return { ok: false, message: restored.message }
    await mkdir(input.sessionDir, { recursive: true }).catch(() => undefined)
    await copyFile(input.restoreFrom, tarArchivePath(input.sessionDir)).catch(() => undefined)
    notices.push(`[sandbox] restored the last workspace checkpoint (${restored.bytes} bytes) into ${dir} on a fresh box.`)
  } else {
    notices.push(
      `[sandbox] no git remote for this workspace: the box starts with an empty ${dir}. Its working dir is ` +
        "checkpointed to the host as a tarball (node_modules, .git and .gitignore'd paths excluded, 50 MiB cap) " +
        "and restored if the session is restarted on a fresh box.",
    )
  }
  await writePendingTarRecord(input.sessionDir, target)
  return { ok: true, target, notices }
}
