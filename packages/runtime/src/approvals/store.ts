/**
 * Filesystem persistence for approval requests — `<homeDir>/<id>/request.json`
 * (the `ApprovalRecord`, everything except the payload bytes),
 * `<homeDir>/<id>/payload.json` (canonical JSON of the gated payload, what
 * `signArtifact` hashes and signs), and `<homeDir>/<id>/card-ticket.json`
 * (the `ui_card` channel's one-time ticket — hash only). Atomic
 * write-tmp+rename, same recipe as `agentproto-dir.ts` / `task-ledger.ts`.
 * Everything reloads at boot: a pending request (and a live card ticket)
 * survives a daemon restart.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"

import type { ApprovalRecord, CardTicketRecord } from "./types.js"

export function defaultApprovalsHomeDir(): string {
  return join(homedir(), ".agentproto", "approvals")
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  renameSync(tmp, path)
}

function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

function approvalDir(homeDir: string, id: string): string {
  return join(homeDir, id)
}

function requestPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "request.json")
}

function payloadPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "payload.json")
}

function cardTicketPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "card-ticket.json")
}

/** Workspace-relative path to `<id>/payload.json` — what `signArtifact`
 *  takes as its `artifactPath` (relative to the governance workspace root,
 *  which IS this same `homeDir`). */
export function payloadRelativePath(id: string): string {
  return `${id}/payload.json`
}

export function writePayload(homeDir: string, id: string, canonicalJson: string): void {
  mkdirSync(approvalDir(homeDir, id), { recursive: true })
  const tmp = `${payloadPath(homeDir, id)}.tmp.${process.pid}`
  writeFileSync(tmp, canonicalJson, { encoding: "utf8", mode: 0o600 })
  renameSync(tmp, payloadPath(homeDir, id))
}

export function writeApprovalRecord(homeDir: string, record: ApprovalRecord): void {
  writeJsonAtomic(requestPath(homeDir, record.id), record)
}

export function readApprovalRecord(homeDir: string, id: string): ApprovalRecord | undefined {
  return readJsonIfExists<ApprovalRecord>(requestPath(homeDir, id))
}

export function writeCardTicket(homeDir: string, ticket: CardTicketRecord): void {
  writeJsonAtomic(cardTicketPath(homeDir, ticket.approvalId), ticket)
}

export function readCardTicket(homeDir: string, id: string): CardTicketRecord | undefined {
  return readJsonIfExists<CardTicketRecord>(cardTicketPath(homeDir, id))
}

/** Load every persisted approval, keyed by id — the boot-recovery pass. A
 *  directory whose `request.json` is missing or malformed is skipped
 *  (mirrors the task ledger's "malformed = ignored" loader policy). */
export function loadAllApprovals(homeDir: string): Map<string, ApprovalRecord> {
  const out = new Map<string, ApprovalRecord>()
  if (!existsSync(homeDir)) return out
  let entries: string[]
  try {
    entries = readdirSync(homeDir)
  } catch {
    return out
  }
  for (const id of entries) {
    if (id.startsWith(".") || id === "audit" || id === "_secrets.json") continue
    const record = readApprovalRecord(homeDir, id)
    if (record && record.id === id) out.set(id, record)
  }
  return out
}

/** Load every persisted card ticket, keyed by approval id — same
 *  best-effort boot-recovery pass as `loadAllApprovals`. */
export function loadAllCardTickets(homeDir: string): Map<string, CardTicketRecord> {
  const out = new Map<string, CardTicketRecord>()
  if (!existsSync(homeDir)) return out
  let entries: string[]
  try {
    entries = readdirSync(homeDir)
  } catch {
    return out
  }
  for (const id of entries) {
    if (id.startsWith(".") || id === "audit" || id === "_secrets.json") continue
    const ticket = readCardTicket(homeDir, id)
    if (ticket && ticket.approvalId === id) out.set(id, ticket)
  }
  return out
}
