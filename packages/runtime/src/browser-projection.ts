/**
 * `projectBrowserTools`: project a kit `BrowserInstance` (from
 * `@agentproto/driver-browser`) onto the page-level `browser_*` MCP tools.
 *
 * MCP only. The SDK stays the existing typed client. The lifecycle tools
 * (`start_browser`, `browser_status`, ...) live in `browser-tools.ts` and are
 * untouched; this module adds the page-control set on top of an instance:
 *
 *   browser_navigate, browser_evaluate, browser_click, browser_fill,
 *   browser_screenshot, browser_get_dom, browser_list_requests,
 *   browser_get_request_body, browser_cdp_send
 *
 * Capability gating is declarative (`BROWSER_TOOL_GATES` in the kit, AIP-14
 * capability gate): a tool whose capability the provider lacks answers with a
 * typed `browser:unsupported` error result naming the capability, before any
 * driver is attached. It is never a crash and never an empty success.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  assertToolSupported,
  clickOptionsSchema,
  evaluateOptionsSchema,
  fillOptionsSchema,
  navigateOptionsSchema,
  screenshotOptionsSchema,
  type BrowserAttachOptions,
  type BrowserCapabilities,
  type BrowserDriver,
  type BrowserInstance,
  type BrowserProvider,
} from "@agentproto/driver-browser"
import { toToolResult } from "@agentproto/tool"

/** What the projection needs to know about the provider that owns the instance. */
export type ProjectedProvider = Pick<BrowserProvider, "id"> & {
  capabilities: Partial<BrowserCapabilities>
}

/** Result of one projected tool call, MCP `CallToolResult` compatible. */
export interface ProjectedToolResult {
  content: { type: "text"; text: string }[]
  structuredContent: Record<string, unknown>
  isError?: true
  [key: string]: unknown
}

export interface ProjectedBrowserTool {
  /** MCP tool name, e.g. `browser_list_requests`. */
  name: string
  description: string
  /** Kit tool id used for the capability gate, e.g. `browser.list_requests`. */
  gateId: string
  inputSchema: z.ZodObject<z.ZodRawShape>
  call(input: unknown): Promise<ProjectedToolResult>
}

export interface ProjectBrowserToolsOptions {
  /** The provider that launched `instance` (its manifest capabilities gate the tools). */
  provider: ProjectedProvider
  /** Passed to `instance.attach()` on the first tool call. */
  attach?: BrowserAttachOptions
  /**
   * Writes bytes to a path on the host and returns the resolved path. Needed
   * only for `path` on `browser_screenshot` and `browser_get_dom`; without it
   * those calls fail with a clear message instead of writing anywhere.
   */
  writeArtifact?: (path: string, bytes: Buffer) => string
}

export interface ProjectedBrowserTools {
  tools: readonly ProjectedBrowserTool[]
  /** Register every projected tool on an MCP server. */
  register(server: McpServer): void
  /** Close the lazily attached driver, if any. Safe to call twice. */
  close(): Promise<void>
}

const listRequestsSchema = z.object({
  since: z.number().optional(),
  limit: z.number().int().positive().max(500).default(100),
})
const getRequestBodySchema = z.object({ requestId: z.string() })
const getDomSchema = z.object({
  selector: z.string().optional(),
  path: z
    .string()
    .optional()
    .describe("Write the serialized HTML to a file and return its path instead of the HTML."),
})
const cdpSendSchema = z.object({ method: z.string(), params: z.unknown().optional() })

interface ToolSpec {
  name: string
  description: string
  schema: z.ZodObject<z.ZodRawShape>
  run(input: unknown, driver: BrowserDriver, opts: ProjectBrowserToolsOptions): Promise<unknown>
}

function requireWriter(tool: string, opts: ProjectBrowserToolsOptions): NonNullable<ProjectBrowserToolsOptions["writeArtifact"]> {
  if (!opts.writeArtifact) {
    throw new Error(`${tool}: \`path\` requires a host artifact writer; this host returns inline data only.`)
  }
  return opts.writeArtifact
}

const SPECS: readonly ToolSpec[] = [
  {
    name: "browser_navigate",
    description: "Navigate the attached tab to a URL and wait for the chosen lifecycle event.",
    schema: navigateOptionsSchema,
    async run(input, driver) {
      const o = navigateOptionsSchema.parse(input)
      await driver.navigate(o)
      return { url: o.url }
    },
  },
  {
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in the page and return the value.",
    schema: evaluateOptionsSchema,
    run: (input, driver) => driver.evaluate(evaluateOptionsSchema.parse(input)),
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector.",
    schema: clickOptionsSchema,
    async run(input, driver) {
      const o = clickOptionsSchema.parse(input)
      await driver.click(o)
      return { selector: o.selector }
    },
  },
  {
    name: "browser_fill",
    description: "Fill an input element by CSS selector.",
    schema: fillOptionsSchema,
    async run(input, driver) {
      const o = fillOptionsSchema.parse(input)
      await driver.fill(o)
      return { selector: o.selector }
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a screenshot of the page or a CSS-selected region. Returns base64 by default; " +
      "pass `path` to write the image to a file and return its path instead.",
    schema: screenshotOptionsSchema,
    async run(input, driver, opts) {
      const o = screenshotOptionsSchema.parse(input)
      const shot = await driver.screenshot(o)
      if (!o.path) return shot
      const bytes = Buffer.from(shot.base64, "base64")
      const path = requireWriter("browser_screenshot", opts)(o.path, bytes)
      return { path, format: shot.format, bytes: bytes.length, width: shot.width, height: shot.height }
    },
  },
  {
    name: "browser_get_dom",
    description: "Return serialized DOM (outerHTML) of the page or a selector.",
    schema: getDomSchema,
    async run(input, driver, opts) {
      const o = getDomSchema.parse(input)
      const html = await driver.getDom(o.selector)
      if (!o.path) return { html }
      const bytes = Buffer.from(html, "utf-8")
      return { path: requireWriter("browser_get_dom", opts)(o.path, bytes), bytes: bytes.length }
    },
  },
  {
    name: "browser_list_requests",
    description: "List recent network requests captured by the driver's ring buffer. Needs the `cdp` capability.",
    schema: listRequestsSchema,
    async run(input, driver) {
      return { requests: await driver.listRequests(listRequestsSchema.parse(input)) }
    },
  },
  {
    name: "browser_get_request_body",
    description: "Fetch a captured response body by requestId. Needs the `cdp` capability.",
    schema: getRequestBodySchema,
    run: (input, driver) => driver.getRequestBody(getRequestBodySchema.parse(input).requestId),
  },
  {
    name: "browser_cdp_send",
    description: "Send a raw Chrome DevTools Protocol command. Needs the `cdp` capability.",
    schema: cdpSendSchema,
    async run(input, driver) {
      const o = cdpSendSchema.parse(input)
      return driver.send({ method: o.method, params: o.params })
    },
  },
]

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}

function toResult(value: unknown, thrown: unknown): ProjectedToolResult {
  const envelope = toToolResult(value, thrown)
  const structuredContent = envelope.ok ? asRecord(envelope.value) : { ok: false, error: envelope.error }
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(envelope.ok ? {} : { isError: true as const }),
  }
}

/** kit tool ids are dotted (`browser.list_requests`); MCP names are snake (`browser_list_requests`). */
const gateIdFor = (name: string): string => name.replace(/^browser_/, "browser.")

export function projectBrowserTools(
  instance: BrowserInstance,
  opts: ProjectBrowserToolsOptions,
): ProjectedBrowserTools {
  let driverPromise: Promise<BrowserDriver> | undefined
  const driver = (): Promise<BrowserDriver> => (driverPromise ??= instance.attach(opts.attach))

  const tools: ProjectedBrowserTool[] = SPECS.map((spec) => {
    const gateId = gateIdFor(spec.name)
    return {
      name: spec.name,
      description: spec.description,
      gateId,
      inputSchema: spec.schema,
      async call(input: unknown): Promise<ProjectedToolResult> {
        try {
          // Gate before attaching: a provider without the capability never gets a driver.
          assertToolSupported(opts.provider.capabilities, gateId, opts.provider.id)
          const result = await spec.run(input, await driver(), opts)
          return toResult(result, undefined)
        } catch (err) {
          return toResult(undefined, err)
        }
      },
    }
  })

  return {
    tools,
    register(server) {
      for (const tool of tools) {
        server.tool(tool.name, tool.description, tool.inputSchema.shape, async (input: unknown) => tool.call(input))
      }
    },
    async close() {
      const pending = driverPromise
      driverPromise = undefined
      if (pending) await (await pending).close().catch(() => undefined)
    },
  }
}
