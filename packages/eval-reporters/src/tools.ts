/**
 * MCP tool definitions for the eval-reporter adapter family.
 *
 * This module returns tool *specs* (name, description, schema, handler) rather
 * than registering directly on an `McpServer`. That keeps the package
 * daemon-free and unit-testable; a daemon package can register the returned
 * specs on its server later.
 */

import { z } from "zod"
import type { AdapterEntry, AdapterLister, SetupField } from "@agentproto/provider-kit"
import { computeStatus } from "@agentproto/provider-kit"
import type { EvalEvent } from "@agentproto/eval"
import { EVAL_REPORTER_CATALOG } from "./catalog.js"
import {
  makeEvalReporterCredsStore,
  type EvalReporterCreds,
  type LangfuseCreds,
} from "./creds.js"
import type { EvalReporterHandle, EvalReporterInfo } from "./resolve.js"
import { makeEvalReporterResolver, resolveEvalReporter } from "./resolve.js"

/** Fields collected by the `setup_eval_reporter` tool for Langfuse. */
export const LANGFUSE_SETUP_FIELDS: readonly SetupField[] = [
  {
    name: "publicKey",
    description: "Langfuse public key",
    required: true,
    sensitive: true,
  },
  {
    name: "secretKey",
    description: "Langfuse secret key",
    required: true,
    sensitive: true,
  },
  {
    name: "baseUrl",
    description: "Langfuse base URL, e.g. https://cloud.langfuse.com",
    required: true,
    sensitive: false,
  },
  {
    name: "environment",
    description: "Optional environment label",
    required: false,
    sensitive: false,
  },
]

const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com"

export interface MakeEvalReporterToolsOptions {
  /** Home dir override (tests). Defaults to `AGENTPROTO_HOME ?? ~/.agentproto`. */
  home?: string
}

export interface EvalReporterToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[]
  readonly isError?: boolean
}

export interface EvalReporterListToolSpec {
  readonly name: "list_eval_reporters"
  readonly description: string
  readonly handler: () => Promise<EvalReporterToolResult>
}

export interface EvalReporterSetupToolSpec {
  readonly name: "setup_eval_reporter"
  readonly description: string
  readonly inputSchema: z.ZodObject<Record<string, z.ZodString>>
  readonly handler: (args: Record<string, string>) => Promise<EvalReporterToolResult>
}

export interface EvalReporterTools {
  readonly list_eval_reporters: EvalReporterListToolSpec
  readonly setup_eval_reporter: EvalReporterSetupToolSpec
}

/**
 * Build the eval-reporter family's MCP tool specs.
 *
 *   - `list_eval_reporters` — parameterless; returns status + capabilities,
 *     never creds.
 *   - `setup_eval_reporter` — multi-field form for configurable reporters
 *     (currently `langfuse`). Sensitive values are never echoed.
 */
export function makeEvalReporterTools(
  deps: MakeEvalReporterToolsOptions = {},
): EvalReporterTools {
  const credsStore = makeEvalReporterCredsStore(deps.home)
  const resolver = makeEvalReporterResolver(credsStore)

  const lister: AdapterLister<EvalReporterInfo> = async () => {
    const out: AdapterEntry<EvalReporterInfo>[] = []
    for (const entry of EVAL_REPORTER_CATALOG) {
      const handle = await resolver(entry.slug)
      if (handle === null) {
        out.push({
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          packageName: entry.packageName,
          ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
          status: "supported",
          version: "not installed",
        })
        continue
      }

      const credsExist = await credsStore.exists(entry.slug)
      const status = computeStatus({
        resolved: true,
        requiresSetup: handle.requiresSetup,
        ledgerExists: false,
        credsExist,
      })

      out.push({
        slug: handle.slug,
        name: handle.name,
        description: handle.description,
        packageName: entry.packageName,
        ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
        status,
        version: handle.version,
        info: handle.info(),
      })
    }
    return out
  }

  const listTool: EvalReporterListToolSpec = {
    name: "list_eval_reporters",
    description:
      "List known eval reporter backends with their status (supported/" +
      "available/ready) and declared capabilities. Credentials are never " +
      "returned. Use `setup_eval_reporter` to configure a backend that " +
      "needs credentials.",
    handler: async () => {
      const entries = await lister()
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(entries, null, 2) },
        ],
      }
    },
  }

  const shape: Record<string, z.ZodString> = {
    slug: z.string().describe("Eval reporter slug to configure"),
  }
  for (const field of LANGFUSE_SETUP_FIELDS) {
    const desc = field.sensitive
      ? `${field.description} SENSITIVE — never logged and never echoed back in tool results.`
      : field.description
    shape[field.name] = (
      field.required !== false
        ? z.string().min(1, `${field.name} is required`)
        : z.string()
    ).describe(desc)
  }
  const inputSchema = z.object(shape)

  const setupTool: EvalReporterSetupToolSpec = {
    name: "setup_eval_reporter",
    description:
      "Configure an eval reporter backend that requires credentials " +
      "(currently `langfuse`). Each field is SENSITIVE — stored with mode " +
      "0600 and never echoed back in tool results.",
    inputSchema,
    handler: async (args: Record<string, string>) => {
      const slug = args.slug ?? ""
      if (slug !== "langfuse") {
        return {
          content: [
            {
              type: "text" as const,
              text: `setup_eval_reporter: unknown slug '${slug}'. Valid: langfuse`,
            },
          ],
          isError: true,
        }
      }

      const handle = resolveEvalReporter(slug, { creds: null })
      if (!handle.requiresSetup) {
        return {
          content: [
            {
              type: "text" as const,
              text: `setup_eval_reporter: '${slug}' is not configurable`,
            },
          ],
          isError: true,
        }
      }

      const missing = LANGFUSE_SETUP_FIELDS.filter(
        (field) => field.required !== false,
      )
        .map((field) => field.name)
        .filter((name) => {
          const value = args[name]
          return value === undefined || value.length === 0
        })
      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `missing required field(s): ${missing.join(", ")}`,
            },
          ],
          isError: true,
        }
      }

      const publicKey = args.publicKey ?? ""
      const secretKey = args.secretKey ?? ""
      const rawBaseUrl = args.baseUrl
      const baseUrl =
        rawBaseUrl !== undefined && rawBaseUrl.length > 0
          ? rawBaseUrl
          : DEFAULT_LANGFUSE_BASE_URL
      const environment = args.environment
      const creds: LangfuseCreds =
        environment !== undefined && environment.length > 0
          ? { publicKey, secretKey, baseUrl, environment }
          : { publicKey, secretKey, baseUrl }
      await credsStore.write(slug, creds)

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                slug,
                hint: `${slug} configured — status is now ready`,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  }

  return { list_eval_reporters: listTool, setup_eval_reporter: setupTool }
}
