import { parseArgs } from "node:util"

import { type CasPushResult, type CasExpected, casPush } from "./index.js"

const USAGE =
  "usage: agentproto-git-cas push --branch <branch> (--expect <sha> | --expect-absent) [--remote <name|url>] [--local-ref <ref>] [--cwd <dir>] [--no-verify]"

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

/** Exit code per outcome: 0 pushed/noop, 3 head_moved, 4 rejected_other. */
export function exitCodeFor(result: CasPushResult): number {
  switch (result.outcome) {
    case "pushed":
    case "noop":
      return 0
    case "head_moved":
      return 3
    case "rejected_other":
      return 4
  }
}

/**
 * Run the CLI. The result JSON goes to `out`; the `git_cas_push` log line
 * goes to `err` so stdout stays one parseable document. Usage errors exit 2.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  if (command !== "push") {
    io.err(USAGE)
    return 2
  }
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        branch: { type: "string" },
        expect: { type: "string" },
        "expect-absent": { type: "boolean" },
        remote: { type: "string" },
        "local-ref": { type: "string" },
        cwd: { type: "string" },
        "no-verify": { type: "boolean" },
      },
    }).values
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}`)
    return 2
  }
  const branch = values.branch
  const sha = values.expect
  const absent = values["expect-absent"] === true
  if (typeof branch !== "string" || (typeof sha === "string") === absent) {
    io.err(USAGE)
    return 2
  }
  const expected: CasExpected =
    typeof sha === "string" ? { sha } : { absent: true }
  let result: CasPushResult
  try {
    result = await casPush(
      {
        cwd: typeof values.cwd === "string" ? values.cwd : process.cwd(),
        branch,
        expected,
        remote: typeof values.remote === "string" ? values.remote : undefined,
        localRef:
          typeof values["local-ref"] === "string"
            ? values["local-ref"]
            : undefined,
        noVerify: values["no-verify"] === true,
      },
      { log: io.err },
    )
  } catch (e) {
    io.err((e as Error).message)
    return 2
  }
  io.out(JSON.stringify(result))
  return exitCodeFor(result)
}
