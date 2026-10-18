/**
 * The adapter's own conversation store, checkpointed with the box.
 *
 * A sandbox session's adapter conversation lives INSIDE the box, under the
 * box daemon's per-session isolated adapter-config dir
 * (`~/.agentproto/adapter-config/<box session id>` — claude-code's
 * `projects/<slug>/<uuid>.jsonl`, an OS-confined codex's `CODEX_HOME`
 * rollouts, an engaged-credential opencode's isolated `opencode.db`, the
 * session's imported skills, …). The git checkpoint (`sandbox-delivery.ts`)
 * carries the WORK; this module carries the CONVERSATION. Without it, a
 * restart that moves to a fresh box re-clones the code but the adapter
 * starts blank — the store died with the old box.
 *
 * Two halves, mirroring `sandbox-tar-checkpoint.ts`:
 *   - {@link archiveAdapterStore} — checkpoint time (box still alive): pack
 *     the session's isolated config dir in the box, pull the archive to the
 *     host next to `checkpoint.json`. Never throws; the outcome is a record
 *     (`saved`/`skipped`/`failed`) stamped onto the checkpoint record.
 *   - {@link restoreAdapterStore} — fresh-box restart: upload the saved
 *     archive and extract it at the same (home-relative) path BEFORE the new
 *     box's adapter starts, so the box daemon's resume can find the
 *     conversation again.
 *
 * Only THIS session's store is archived: the isolated config dir is keyed by
 * the session's own box-side id (`SessionDescriptor.adapterSessionId` on a
 * sandbox row is exactly that id — the proxy's `sessionId` is the box
 * daemon's remote session id). Adapters that ignore the isolated dir and keep
 * a shared global store (hermes' `~/.hermes/state.db`, a non-confined
 * codex's `~/.codex`, …) have nothing per-session to ship — their store is
 * simply absent here, and a restart falls back to the digest handoff as
 * before.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CONVERSATION_STORES } from "./conversation-store.js"
import { describeExecFailure, shellQuote, type SandboxExec } from "./sandbox-workspace-remote.js"

/** Host-side file the archived store is saved as, next to `checkpoint.json`. */
export const ADAPTER_STORE_FILE = "adapter-store.tar.gz"
/** Bundles above this are left in the box and reported, not downloaded. */
export const DEFAULT_ADAPTER_STORE_MAX_BYTES = 20 * 1024 * 1024
/** Box-local path the archive is packed into (checkpoint) … */
export const BOX_ADAPTER_STORE_ARCHIVE_PATH = "/tmp/agentproto-adapter-store.tar.gz"
/** … and the path a restore upload lands at before extraction. */
export const BOX_ADAPTER_STORE_RESTORE_PATH = "/tmp/agentproto-adapter-store-restore.tar.gz"
/** Pack + download budget for the store archive inside a checkpoint. Sized
 *  to minutes on purpose: the store is a tar.gz of the adapter's isolated
 *  config dir (torch/etc. config trees included), and on a provider network
 *  (e2b) 30 s regularly expired mid-pack — `deadline_exceeded` at the exec
 *  level, surfacing as "packing failed" (observed 2026-10-18). */
export const ADAPTER_STORE_TIMEOUT_MS = 180_000
/** Extract budget on a fresh box. */
const ADAPTER_STORE_RESTORE_TIMEOUT_MS = 30_000

/** The session's isolated adapter-config dir, HOME-RELATIVE — the archive
 *  stores this prefix and the restore extracts under `$HOME` again, so the
 *  pair works on any box whose home path differs from the dead one's. */
export function adapterStoreRelativeDir(adapterSessionId: string): string {
  return `.agentproto/adapter-config/${adapterSessionId}`
}

/** The host-side archive path for a session's transcript dir. */
export function adapterStoreArchivePath(sessionDir: string): string {
  return join(sessionDir, ADAPTER_STORE_FILE)
}

/** A saved archive from a PRIOR session's checkpoints, when one reached the
 *  host. `undefined` — no store was ever archived (store missing/over-cap,
 *  provider cannot download, or a pre-feature session) — the caller keeps
 *  today's fresh-spawn behaviour. */
export function savedAdapterStoreArchive(sessionDir: string): string | undefined {
  const path = adapterStoreArchivePath(sessionDir)
  return existsSync(path) ? path : undefined
}

export type AdapterStoreStatus = "saved" | "skipped" | "failed"

/** Checkpoint-record entry for the archived conversation store. */
export interface AdapterStoreRecord {
  status: AdapterStoreStatus
  /** Host path of the downloaded archive — present iff `saved`. */
  path?: string
  adapter?: string
  /** The box-side session id the store is keyed by (a sandbox row's
   *  `adapterSessionId` is exactly this id). */
  adapterSessionId?: string
  bytes?: number
  detail?: string
}

/**
 * The in-box pack command: tar the session's isolated adapter-config dir
 * (home-relative) and print `bytes=`; `store=missing` when the dir does not
 * exist (adapter without config-dir isolation, or nothing written yet).
 * Deterministic-ish (`--sort=name`, `gzip -n`) like the workspace tar; tar
 * exit 1 ("file changed as we read it") is tolerated — the adapter keeps
 * writing during a periodic checkpoint.
 */
export function buildAdapterStoreArchiveCommand(
  adapterSessionId: string,
  boxPath: string = BOX_ADAPTER_STORE_ARCHIVE_PATH,
): string {
  const rel = shellQuote(adapterStoreRelativeDir(adapterSessionId))
  const out = shellQuote(boxPath)
  const tmp = shellQuote(`${boxPath}.tar`)
  // tar to a plain file first, THEN gzip it: piping `tar | gzip` would make
  // `$?` gzip's status (no `pipefail` in POSIX sh), hiding a tar failure.
  return (
    `cfg="$HOME"/${rel}; ` +
    `[ -d "$cfg" ] || { echo "store=missing"; exit 0; }; ` +
    `rm -f ${out} ${tmp}; ` +
    `tar --sort=name -C "$HOME" -cf ${tmp} ${rel} 2>/dev/null; rc=$?; ` +
    `if [ $rc -le 1 ] && [ -s ${tmp} ]; then gzip -n -c ${tmp} > ${out}; rc=$?; fi; ` +
    `rm -f ${tmp}; ` +
    `[ $rc -eq 0 ] && [ -s ${out} ] || { rm -f ${out}; echo "tar failed (exit $rc)" >&2; exit 2; }; ` +
    `echo "bytes=$(wc -c < ${out} | tr -d ' ')"`
  )
}

export function parseAdapterStoreArchive(stdout: string): { bytes: number } | undefined {
  const bytes = /^bytes=(\d+)$/m.exec(stdout)
  return bytes ? { bytes: Number(bytes[1]) } : undefined
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ArchiveAdapterStoreInput {
  exec: SandboxExec
  /** Absent when the provider cannot download files. */
  readFile?: (path: string) => Promise<Uint8Array>
  /** The box-side session id the store is keyed by. */
  adapterSessionId: string
  adapter?: string
  /** Host dir receiving `adapter-store.tar.gz`. */
  outDir: string
  maxBytes?: number
  /** Cap on pack + download; defaults to {@link ADAPTER_STORE_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Pack the session's conversation store in the box and pull it to the host.
 * NEVER throws and never rejects: every failure mode (no exec, no download,
 * missing store, over-cap, tar failure) resolves to a `skipped`/`failed`
 * record so the enclosing checkpoint is unaffected — the store is a
 * passenger on the checkpoint, never its gate.
 */
export async function archiveAdapterStore(input: ArchiveAdapterStoreInput): Promise<AdapterStoreRecord> {
  const base: AdapterStoreRecord = {
    status: "failed",
    ...(input.adapter ? { adapter: input.adapter } : {}),
    adapterSessionId: input.adapterSessionId,
  }
  const maxBytes = input.maxBytes ?? DEFAULT_ADAPTER_STORE_MAX_BYTES
  const timeoutMs = input.timeoutMs ?? ADAPTER_STORE_TIMEOUT_MS
  let packed: { bytes: number }
  try {
    const result = await input.exec({
      command: buildAdapterStoreArchiveCommand(input.adapterSessionId),
      timeoutMs,
    })
    if (result.exitCode !== 0) {
      // A missing dir exits 0 with `store=missing`; anything else is a real
      // tar/exec failure, recorded but never thrown.
      return { ...base, detail: `packing the adapter store failed: ${describeExecFailure(result)}` }
    }
    const parsed = parseAdapterStoreArchive(result.stdout)
    if (!parsed) {
      return { ...base, detail: "packing the adapter store failed: unparseable output" }
    }
    packed = parsed
  } catch (err) {
    return { ...base, detail: `packing the adapter store failed: ${errorText(err)}` }
  }
  if (!input.readFile) {
    return {
      ...base,
      status: "skipped",
      bytes: packed.bytes,
      detail: "the sandbox provider cannot download files from the box",
    }
  }
  if (packed.bytes > maxBytes) {
    return {
      ...base,
      status: "skipped",
      bytes: packed.bytes,
      detail:
        `adapter store is ${packed.bytes} bytes, over the ${maxBytes} byte limit; left at ` +
        `${BOX_ADAPTER_STORE_ARCHIVE_PATH} in the box`,
    }
  }
  try {
    const data = await input.readFile(BOX_ADAPTER_STORE_ARCHIVE_PATH)
    await mkdir(input.outDir, { recursive: true })
    const path = adapterStoreArchivePath(input.outDir)
    await writeFile(path, data)
    return { ...base, status: "saved", path, bytes: data.byteLength }
  } catch (err) {
    return { ...base, status: "failed", detail: `downloading the adapter store failed: ${errorText(err)}` }
  }
}

export type AdapterStoreRestoreResult = { ok: true; bytes: number } | { ok: false; message: string }

export interface RestoreAdapterStoreInput {
  /** Absent when the provider cannot upload files. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  exec?: SandboxExec
  /** Host-side archive (from {@link savedAdapterStoreArchive}). */
  archivePath: string
  maxBytes?: number
  timeoutMs?: number
}

/**
 * Upload the saved archive into a FRESH box and extract it at the same
 * home-relative path, before the box's adapter starts. A restore failure is
 * reported, never thrown — the restart proceeds and the adapter starts
 * blank (today's behaviour), because a missing conversation must not fail
 * the restart itself.
 */
export async function restoreAdapterStore(input: RestoreAdapterStoreInput): Promise<AdapterStoreRestoreResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_ADAPTER_STORE_MAX_BYTES
  const timeoutMs = input.timeoutMs ?? ADAPTER_STORE_RESTORE_TIMEOUT_MS
  if (!input.writeFile) return { ok: false, message: "the sandbox provider cannot upload files into the box" }
  if (!input.exec) return { ok: false, message: "the sandbox provider cannot run commands in the box" }
  let data: Uint8Array
  try {
    data = await readFile(input.archivePath)
  } catch (err) {
    return { ok: false, message: `reading the saved adapter store failed: ${errorText(err)}` }
  }
  if (data.byteLength > maxBytes) {
    return {
      ok: false,
      message: `saved adapter store is ${data.byteLength} bytes, over the ${maxBytes} byte limit`,
    }
  }
  try {
    await input.writeFile(BOX_ADAPTER_STORE_RESTORE_PATH, data)
  } catch (err) {
    return { ok: false, message: `uploading the adapter store failed: ${errorText(err)}` }
  }
  try {
    // `--no-same-owner` + extract under `$HOME`: the archive stores the
    // config dir home-relative (see {@link buildAdapterStoreArchiveCommand}),
    // so the store lands at the same path the box daemon keys it by, on any
    // box, without needing root to restore ownership.
    const result = await input.exec({
      command:
        // Refuse an archive with absolute or `..` member paths before extracting.
        `if tar -tzf ${shellQuote(BOX_ADAPTER_STORE_RESTORE_PATH)} | grep -qE '(^/|(^|/)\\.\\.(/|$))'; ` +
        `then echo "unsafe member path in adapter store archive" >&2; exit 3; fi; ` +
        `tar --no-same-owner -xzf ${shellQuote(BOX_ADAPTER_STORE_RESTORE_PATH)} -C "$HOME" && ` +
        `rm -f ${shellQuote(BOX_ADAPTER_STORE_RESTORE_PATH)} && echo restored`,
      timeoutMs,
    })
    if (result.exitCode !== 0 || !result.stdout.includes("restored")) {
      return { ok: false, message: `extracting the adapter store failed: ${describeExecFailure(result)}` }
    }
  } catch (err) {
    return { ok: false, message: `extracting the adapter store failed: ${errorText(err)}` }
  }
  return { ok: true, bytes: data.byteLength }
}

/**
 * On a FRESH box after {@link restoreAdapterStore}: which adapter
 * conversation does the restored store hold? The store dir is keyed by the
 * DEAD box's session id (the host passes that id as the resume target), but
 * the adapter resumes by its own conversation id — so the box daemon
 * resolves the id against the restored dir with the same
 * `CONVERSATION_STORES` discovery a local fs-resume uses, newest-first.
 * `undefined` when the adapter has no discoverable store (or nothing landed
 * in the dir) — the resume attempt is dropped and the spawn starts blank,
 * exactly as before the store existed.
 */
export async function discoverRestoredAdapterConversation(input: {
  adapter: string
  configDir: string
  /** The box-side cwd the conversation was written under — claude-code's
   *  project-slug dir (and opencode's `directory` scoping) derive from it.
   *  Pass `""` when unknown (the cwd-scoped stores then simply find
   *  nothing, and the resume falls back to a blank spawn). */
  cwd?: string
}): Promise<string | undefined> {
  const store = CONVERSATION_STORES[input.adapter]
  if (!store) return undefined
  try {
    const candidates = await store.discover({
      cwd: input.cwd ?? "",
      configDir: input.configDir,
    })
    return candidates[0]?.conversationId
  } catch {
    return undefined
  }
}
