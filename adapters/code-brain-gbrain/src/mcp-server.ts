/**
 * The tracked `ask_codebase` MCP server — the replacement for the untracked
 * `~/agentproto-kb/tools/code-explorer-mcp/server-http.mjs`.
 *
 * It serves the `@agentproto/code-brain` `ask_codebase` contract over MCP
 * Streamable-HTTP on `127.0.0.1:8831` `POST /mcp`, byte-compatible with the
 * existing `code-explorer` alias in `~/.agentproto/imported-mcps.json`
 * (`{ type: "http", url: "http://127.0.0.1:8831/mcp" }`) — so PR-5 only has
 * to repoint how the endpoint is launched, not the alias/URL/tool name.
 *
 * Unlike the home script (which hand-rolled a gbrain proxy inside the tool
 * handler), this server drives the REAL AIP-14/AIP-30 pipeline: it validates
 * input against `askCodebaseTool`, runs `askCodebaseBuiltin.body` with an
 * injected {@link ICodeBrainProvider}, and validates the output. The gbrain
 * dialect never enters the server — it lives entirely in the provider.
 */

import { createServer, type Server as HttpServer } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  askCodebaseTool,
  askCodebaseBuiltin,
  type ICodeBrainProvider,
} from "@agentproto/code-brain"
import { validateContext, validateInput, validateOutput } from "@agentproto/tool"

/** JSON Schema for `ask_codebase` — matches the code-explorer alias contract. */
const ASK_CODEBASE_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    question: { type: "string", description: "Natural-language codebase question." },
    mode: {
      type: "string",
      enum: ["blend", "define", "callgraph"],
      description:
        "blend (default): federated search all layers. define/callgraph: exact symbol facts.",
    },
    symbol: { type: "string", description: "For define/callgraph: the symbol name." },
    limit: { type: "number", description: "Max hits for blend mode." },
  },
  required: ["question"],
}

const ASK_CODEBASE_DESCRIPTION =
  "Ask a question about the codebase. Answers from the gbrain code+knowledge " +
  "brain: blend (federated search), define (symbol definition), or callgraph " +
  "(callers + callees). Read-only."

/**
 * Drive the `ask_codebase` contract end-to-end for a raw argument bag: the
 * same validate-input → run-body → validate-output pipeline a provider
 * runtime uses. Exposed so the server and tests share one code path.
 */
export async function runAskCodebase(
  provider: ICodeBrainProvider,
  rawArgs: unknown,
  signal: AbortSignal,
) {
  const input = validateInput(askCodebaseTool, rawArgs)
  if (!input.ok) {
    throw new Error(`ask_codebase input invalid: ${input.error.message}`)
  }
  const context = validateContext(askCodebaseTool, { codeBrain: provider })
  if (!context.ok) {
    throw new Error(`ask_codebase context invalid: ${context.error.message}`)
  }
  const output = await askCodebaseBuiltin.body({
    input: input.value,
    context: context.value,
    driverCtx: { secrets: {}, authState: "unknown" },
    signal,
  })
  return validateOutput(askCodebaseTool, output)
}

/** Build a low-level MCP {@link Server} that serves `ask_codebase`. */
export function createAskCodebaseMcpServer(provider: ICodeBrainProvider): Server {
  const server = new Server(
    { name: "code-explorer", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: askCodebaseTool.id,
        description: ASK_CODEBASE_DESCRIPTION,
        inputSchema: ASK_CODEBASE_INPUT_SCHEMA,
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== askCodebaseTool.id) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${request.params.name}` }],
      }
    }
    try {
      const output = await runAskCodebase(
        provider,
        request.params.arguments ?? {},
        extra.signal,
      )
      return { content: [{ type: "text" as const, text: output.answer }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { isError: true, content: [{ type: "text" as const, text: message }] }
    }
  })

  return server
}

/** A running `ask_codebase` HTTP server handle. */
export interface AskCodebaseHttpServer {
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

export interface StartAskCodebaseHttpServerOptions {
  readonly provider: ICodeBrainProvider
  readonly host: string
  readonly port: number
}

/**
 * Start the `ask_codebase` MCP server over Streamable-HTTP on `host:port`,
 * routing `POST /mcp` — the same shape the home-dir server served.
 */
export function startAskCodebaseHttpServer(
  options: StartAskCodebaseHttpServerOptions,
): Promise<AskCodebaseHttpServer> {
  const { provider, host, port } = options
  const httpServer: HttpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        void (async () => {
          try {
            const server = createAskCodebaseMcpServer(provider)
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
            })
            res.on("close", () => {
              void transport.close()
              void server.close()
            })
            await server.connect(transport)
            await transport.handleRequest(req, res, JSON.parse(body))
          } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ error: String(error) }))
          }
        })()
      })
      return
    }
    res.writeHead(404).end()
  })

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      resolve({
        host,
        port,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            httpServer.close((err) => (err ? rejectClose(err) : resolveClose()))
          }),
      })
    })
  })
}
