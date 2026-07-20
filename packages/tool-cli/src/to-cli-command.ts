import { runTool, type DriverHandle, type ResolverContext } from "@agentproto/driver"
import type { ToolContext, ToolHandle } from "@agentproto/tool"
import { parseToolArgv, zodToFlags, type CliInputShape } from "./zod-to-flags.js"

export interface ToCliCommandOptions<TInput, TOutput, TContext extends ToolContext> {
  tool: ToolHandle<TInput, TOutput, TContext>
  candidates: readonly DriverHandle[]
  context?: TContext | (() => TContext | Promise<TContext>)
  resolverContext?: ResolverContext
  secrets?: Record<string, string>
}

export interface CliToolCommand<TInput, TOutput> {
  readonly usage: string
  readonly input: CliInputShape
  parse(argv: readonly string[]): TInput
  run(input: TInput): Promise<TOutput>
}

/** Project one AIP-14 contract onto a CLI parser + run function. No process
 * globals are read here: the embedding CLI owns argv, stdout and policy. */
export function toCliCommand<TInput, TOutput, TContext extends ToolContext>(
  opts: ToCliCommandOptions<TInput, TOutput, TContext>,
): CliToolCommand<TInput, TOutput> {
  const input = zodToFlags(opts.tool.inputSchema)
  const usage = input.kind === "object"
    ? `${opts.tool.id} ${input.flags.map(flag => flag.required ? `--${flag.flag} <${flag.kind}>` : `[--${flag.flag}${flag.kind === "boolean" ? "" : ` <${flag.kind}>`}]`).join(" ")}`.trim()
    : `${opts.tool.id} [<json-input>]`
  const resolveContext = async (): Promise<unknown> => typeof opts.context === "function"
    ? await (opts.context as () => TContext | Promise<TContext>)()
    : opts.context

  return {
    usage,
    input,
    parse(argv) {
      return parseToolArgv(opts.tool.inputSchema, argv) as TInput
    },
    async run(parsed) {
      return runTool({
        tool: opts.tool,
        candidates: opts.candidates,
        input: parsed,
        context: await resolveContext(),
        resolverContext: opts.resolverContext,
        secrets: opts.secrets,
      })
    },
  }
}
