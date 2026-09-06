/**
 * MCP tools for the harness→profile binding lifecycle (list / create / delete /
 * set-default) over `~/.agentproto/harness-presets.json`.
 *
 * A {@link HarnessPreset} pins, per adapter harness, WHICH auth profile +
 * default model a fresh spawn bills through when the caller names neither — the
 * persisted replacement for re-picking the profile every spawn. The daemon owns
 * the file, so a remote client (the VS Code extension, a cloud operator)
 * mutates presets through these verbs rather than writing the file itself.
 *
 * These carry no secret in either direction: a preset holds only a `profileRef`
 * (an auth-profile id) and a `defaultModel` string. Validation (profile exists +
 * enabled, model in the profile's allowlist, one default per harness) lives in
 * the store, so every surface — MCP here, CLI, editor — enforces it identically.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { getAuthProfile } from "@agentproto/auth"
import {
  addHarnessPreset,
  listHarnessPresets,
  removeHarnessPreset,
  setDefaultPreset,
  HarnessPresetValidationError,
  type HarnessPresetValidationDeps,
} from "./harness-preset-store.js"
import { paginate, pageParamsShape, toolText } from "./tool-envelope.js"

function text(value: string | object): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  }
}

function errorText(message: string): {
  content: Array<{ type: "text"; text: string }>
  isError: true
} {
  return { content: [{ type: "text", text: message }], isError: true }
}

export interface HarnessPresetToolsDeps {
  /** Profile lookup backing each listed preset's `profileDisabled`/
   *  `profileMissing` status. Defaults to the real `@agentproto/auth`
   *  lookup — same seam `HarnessPresetValidationDeps.getProfile` is
   *  injected through on the store side, so tests can stub it here too. */
  getProfile?: HarnessPresetValidationDeps["getProfile"]
}

export function registerHarnessPresetTools(server: McpServer, deps: HarnessPresetToolsDeps = {}): void {
  const getProfile = deps.getProfile ?? getAuthProfile

  // ── harness_preset_list ───────────────────────────────────────
  server.tool(
    "harness_preset_list",
    "List the harness→profile presets configured on this host (from " +
      "`~/.agentproto/harness-presets.json`). Each preset pins, for one adapter " +
      "harness, which auth profile (`profileRef`) and default model " +
      "(`defaultModel`) a fresh spawn bills through when the caller names " +
      "neither, plus whether it is that harness's default (`isDefault`). Each " +
      "entry also carries `profileDisabled` (true when `profileRef` is a " +
      "disabled or missing profile — a preset a spawn cannot actually bill " +
      "through) and `profileMissing` (true only when `profileRef` references " +
      "no profile at all). No secret is returned — only profile ids. " +
      "Optionally filter to one harness slug.",
    {
      harnessSlug: z
        .string()
        .optional()
        .describe("Keep only presets for this adapter harness (e.g. hermes)."),
      ...pageParamsShape,
    },
    async input => {
      try {
        const presets = await listHarnessPresets(input.harnessSlug)
        const withStatus = await Promise.all(
          presets.map(async preset => {
            const profile = await getProfile(preset.profileRef)
            if (!profile) return { ...preset, profileDisabled: true, profileMissing: true }
            return { ...preset, profileDisabled: profile.disabled === true }
          }),
        )
        // Pagination LAST — after the harness filter + enrichment. Without
        // limit/cursor the output is byte-identical to the pre-pagination
        // handler.
        if (input.limit !== undefined || input.cursor !== undefined) {
          const page = paginate(withStatus, input, { maxLimit: 200, keyOf: p => p.id })
          return { content: [{ type: "text", text: toolText(page) }] }
        }
        return text({ presets: withStatus })
      } catch (err) {
        return errorText(
          `harness_preset_list failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── harness_preset_create ─────────────────────────────────────
  server.tool(
    "harness_preset_create",
    "Create (or replace, by id) a harness→profile preset. Binds an adapter " +
      "harness to an auth profile + default model that a fresh spawn uses when " +
      "the caller pins neither. Rejects a `profileRef` that references no " +
      "existing/enabled auth profile, or a `defaultModel` the profile's " +
      "allowlist can't service. Passing `isDefault: true` demotes every other " +
      "preset for the same harness (at most one default per harness).",
    {
      id: z.string().describe("Stable, unique preset id (e.g. hm-cheap)."),
      harnessSlug: z.string().describe("Adapter harness slug this preset binds (e.g. hermes)."),
      name: z.string().describe("Human-readable display name (e.g. Cheap)."),
      profileRef: z.string().describe("Auth-profile id to bill through (must exist and be enabled)."),
      defaultModel: z.string().describe("Model id applied at spawn (e.g. z-ai/glm-5.2)."),
      isDefault: z
        .boolean()
        .optional()
        .describe("Make this the harness's default preset (demotes any prior default). Default false."),
    },
    async ({ id, harnessSlug, name, profileRef, defaultModel, isDefault }) => {
      try {
        const preset = await addHarnessPreset({
          id,
          harnessSlug,
          name,
          profileRef,
          defaultModel,
          isDefault: isDefault ?? false,
        })
        return text({ preset })
      } catch (err) {
        if (err instanceof HarnessPresetValidationError) {
          return errorText(`harness_preset_create rejected: ${err.message}`)
        }
        return errorText(
          `harness_preset_create failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── harness_preset_delete ─────────────────────────────────────
  server.tool(
    "harness_preset_delete",
    "Delete a harness→profile preset by id. Idempotent: a missing id returns " +
      "`{ deleted: false }`.",
    {
      id: z.string().describe("The preset id to delete."),
    },
    async ({ id }) => {
      try {
        const deleted = await removeHarnessPreset(id)
        return text({ deleted })
      } catch (err) {
        return errorText(
          `harness_preset_delete failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  // ── harness_preset_set_default ────────────────────────────────
  server.tool(
    "harness_preset_set_default",
    "Mark a preset as THE default for its harness, demoting every other preset " +
      "that shares the harness slug (at most one default per harness). Rejects " +
      "an unknown preset id, or a `harnessSlug` that disagrees with the " +
      "preset's own.",
    {
      harnessSlug: z.string().describe("The adapter harness slug the default is for."),
      presetId: z.string().describe("The preset id to mark default."),
    },
    async ({ harnessSlug, presetId }) => {
      try {
        const preset = await setDefaultPreset(harnessSlug, presetId)
        return text({ preset })
      } catch (err) {
        if (err instanceof HarnessPresetValidationError) {
          return errorText(`harness_preset_set_default rejected: ${err.message}`)
        }
        return errorText(
          `harness_preset_set_default failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )
}
