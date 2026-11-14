import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { LedgerLine } from "./ledger.js"

/** The ledger file every producer appends to under `<agentprotoHome()>`. */
export const DELIVERY_LEDGER_FILE = "delivery-ledger.jsonl"

/** Append exactly one JSON line. Never throws: a failed ledger write must
 *  never change what was delivered. */
export function appendLedgerLine(path: string, line: LedgerLine): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 })
  } catch {
    // Recording only.
  }
}
