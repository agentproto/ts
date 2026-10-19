/**
 * Driver-level computer states, as reported by `GET /v1/computers/:id`.
 *
 * The controller itself never reports `suspended`: a suspended computer
 * reads back as `stopped`. The state is kept here as a tolerated alias so
 * a newer controller can report it without breaking an older client.
 */
export const COMPUTER_STATES = [
  "running",
  "stopped",
  "paused",
  "crashed",
  "starting",
  "unknown",
  "missing",
  "suspended",
] as const

export type ComputerState = (typeof COMPUTER_STATES)[number]

import { z } from "zod"

/**
 * The state field is READ-tolerant: any unknown future state is bucketed
 * under `"unknown"` instead of rejecting, so a status read never throws on
 * controller evolution.
 */
export const computerStateSchema = z.string().transform((v): ComputerState => {
  return (COMPUTER_STATES as readonly string[]).includes(v) ? (v as ComputerState) : "unknown"
})

export const COMPUTER_STATE_UNKNOWN: ComputerState = "unknown"
