import matter from "gray-matter"
import type { RoleHandle } from "./types.js"

/** A role handle paired with its ROLE.md body. */
export interface RoleEntry {
  readonly role: RoleHandle
  readonly body?: string | undefined
}

/** Render a ROLE.md with the canonical `schema: role/v1` first. */
export function renderRoleMd(entry: RoleEntry): string {
  const { schema: _schema, ...fields } = entry.role
  const data = JSON.parse(JSON.stringify({ schema: "role/v1", ...fields }))
  return matter.stringify(`\n${(entry.body ?? "").trim()}\n`, data)
}
