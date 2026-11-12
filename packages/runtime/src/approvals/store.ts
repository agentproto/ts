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
  rmSync,
  writeFileSync,
} from "node:fs"

import type {
  ApprovalRecord,
  CardTicketRecord,
  RelayOutboxEntry,
  ReachReceiptEntry,
  RelayedMarker,
  TelegramCardEntry,
} from "./types.js"

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

function relayOutboxPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "relay-outbox.json")
}

function telegramCardPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "telegram-card.json")
}

function reachPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "reach.json")
}

function relayedPath(homeDir: string, id: string): string {
  return join(approvalDir(homeDir, id), "relayed.json")
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

/** The pinned payload's parsed JSON, read back from `<id>/payload.json`.
 *  `undefined` when the file is missing or not valid JSON. */
export function readPayload(homeDir: string, id: string): unknown | undefined {
  return readJsonIfExists<unknown>(payloadPath(homeDir, id))
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

export function writeRelayOutbox(homeDir: string, entry: RelayOutboxEntry): void {
  writeJsonAtomic(relayOutboxPath(homeDir, entry.approvalId), entry)
}

export function removeRelayOutbox(homeDir: string, id: string): void {
  rmSync(relayOutboxPath(homeDir, id), { force: true })
}

/** Every undelivered relay entry, keyed by approval id, the boot-recovery
 *  pass. Malformed files are ignored, same policy as the other loaders. */
export function loadAllRelayOutbox(homeDir: string): RelayOutboxEntry[] {
  const out: RelayOutboxEntry[] = []
  if (!existsSync(homeDir)) return out
  let entries: string[]
  try {
    entries = readdirSync(homeDir)
  } catch {
    return out
  }
  for (const id of entries) {
    if (id.startsWith(".") || id === "audit" || id === "_secrets.json") continue
    const entry = readJsonIfExists<RelayOutboxEntry>(relayOutboxPath(homeDir, id))
    if (
      entry &&
      entry.approvalId === id &&
      (entry.decision === "approved" || entry.decision === "denied") &&
      typeof entry.attempts === "number"
    ) {
      out.push(entry)
    }
  }
  return out
}

export function writeTelegramCard(homeDir: string, card: TelegramCardEntry): void {
  writeJsonAtomic(telegramCardPath(homeDir, card.approvalId), card)
}

export function removeTelegramCard(homeDir: string, id: string): void {
  rmSync(telegramCardPath(homeDir, id), { force: true })
}

/** Every Telegram card still open, the boot-recovery pass. Malformed files
 *  are ignored, same policy as the other loaders. */
export function loadAllTelegramCards(homeDir: string): TelegramCardEntry[] {
  const out: TelegramCardEntry[] = []
  if (!existsSync(homeDir)) return out
  let entries: string[]
  try {
    entries = readdirSync(homeDir)
  } catch {
    return out
  }
  for (const id of entries) {
    if (id.startsWith(".") || id === "audit" || id === "_secrets.json") continue
    const card = readJsonIfExists<TelegramCardEntry>(telegramCardPath(homeDir, id))
    if (
      card &&
      card.approvalId === id &&
      typeof card.token === "string" &&
      card.token !== "" &&
      typeof card.messageId === "number" &&
      Number.isFinite(card.messageId) &&
      typeof card.text === "string"
    ) {
      out.push(card)
    }
  }
  return out
}

export function writeRelayedMarker(homeDir: string, marker: RelayedMarker): void {
  writeJsonAtomic(relayedPath(homeDir, marker.approvalId), marker)
}

export function hasRelayedMarker(homeDir: string, id: string): boolean {
  return existsSync(relayedPath(homeDir, id))
}

/** Every REACH attempt for one approval, oldest first (`<id>/reach.json`).
 *  A missing or malformed file reads as no attempt. */
export function readReachReceipts(homeDir: string, id: string): ReachReceiptEntry[] {
  const file = readJsonIfExists<{ receipts?: unknown }>(reachPath(homeDir, id))
  if (!file || !Array.isArray(file.receipts)) return []
  return file.receipts.filter(
    (r): r is ReachReceiptEntry =>
      r !== null &&
      typeof r === "object" &&
      typeof (r as ReachReceiptEntry).dedupeKey === "string" &&
      typeof (r as ReachReceiptEntry).adapterId === "string" &&
      typeof (r as ReachReceiptEntry).status === "string",
  )
}

/** Append one attempt. The file only ever grows: earlier entries are kept
 *  as they were read. */
export function appendReachReceipt(homeDir: string, id: string, entry: ReachReceiptEntry): void {
  writeJsonAtomic(reachPath(homeDir, id), { receipts: [...readReachReceipts(homeDir, id), entry] })
}
