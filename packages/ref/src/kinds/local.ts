import { z } from "zod"
import type { KindDefinition } from "../types.js"
import { InvalidRefBody } from "../types.js"

const sha256Re = /^[a-f0-9]{64}$/

export interface LocalRef {
  kind: "local"
  path: string
  sha256?: string
}

export const localSchema: z.ZodType<LocalRef> = z.object({
  kind: z.literal("local"),
  path: z
    .string()
    .min(1)
    .refine(p => !p.startsWith("/") && !p.split("/").includes(".."), {
      message:
        "path must be workspace-relative (no leading '/', no '..' segments)",
    }),
  sha256: z.string().regex(sha256Re).optional(),
})

export const localKind: KindDefinition<LocalRef> = {
  kind: "local",
  collections: ["file"],
  schema: localSchema,
  parse: body => {
    const { path, sha256 } = splitShaSuffix(body)
    if (path.startsWith("/")) {
      throw new InvalidRefBody("local", body, "path must be workspace-relative")
    }
    if (path.split("/").includes("..")) {
      throw new InvalidRefBody(
        "local",
        body,
        "path may not contain '..' segments"
      )
    }
    return { kind: "local", path, ...(sha256 ? { sha256 } : {}) }
  },
  serialize: v => `${v.path}${v.sha256 ? `#sha256=${v.sha256}` : ""}`,
  resolve: async (value, ctx) => {
    if (!ctx.filesystem) {
      throw new Error("local resolve requires ctx.filesystem")
    }
    const root = ctx.workspaceRoot ?? ""
    const fullPath = root
      ? `${root.replace(/\/$/, "")}/${value.path}`
      : value.path
    const bytes = await ctx.filesystem.readFile(fullPath)
    return bytes ? { bytes } : {}
  },
}

export function splitShaSuffix(body: string): {
  path: string
  sha256?: string
} {
  const idx = body.indexOf("#sha256=")
  if (idx < 0) return { path: body }
  const path = body.slice(0, idx)
  const sha256 = body.slice(idx + "#sha256=".length)
  if (!sha256Re.test(sha256)) {
    throw new InvalidRefBody(
      "local",
      body,
      "sha256 must be 64 lowercase hex chars"
    )
  }
  return { path, sha256 }
}
