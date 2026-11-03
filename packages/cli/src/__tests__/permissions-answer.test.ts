/**
 * `agentproto permissions answer` and the question-field listing in `ls`
 * (../commands/permissions.ts), with `_daemon-helpers.js` mocked (same seam
 * as permissions-ls.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runPermissions } from "../commands/permissions.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("agentproto permissions answer", () => {
  let out: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    out = []
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:1", token: "tok" } } as never)
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
  })
  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("posts --select / --text as answers keyed by field id", async () => {
    httpPostJson.mockResolvedValue({ ok: true, sessionId: "s-1" } as never)
    const code = await runPermissions([
      "answer",
      "perm_3",
      "--select",
      "question_0=SQLite",
      "--select",
      "question_1=Logs",
      "--select",
      "question_1=Traces",
      "--text",
      "question_1=profiles",
    ])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:1/permissions/perm_3",
      {
        answers: {
          question_0: { selected: ["SQLite"] },
          question_1: { selected: ["Logs", "Traces"], text: "profiles" },
        },
      },
      "tok",
    )
    expect(out.join("")).toContain("perm_3 answered (session s-1)")
  })

  it("rejects a malformed --select before calling the daemon", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(await runPermissions(["answer", "perm_3", "--select", "nofield"])).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it("ls lists a question's field ids and choice values", async () => {
    httpGetJson.mockResolvedValue({
      permissions: [
        {
          id: "perm_3",
          sessionId: "s-1",
          toolCallId: "perm_3",
          text: "Please answer the following questions.",
          options: [],
          requestedAt: new Date().toISOString(),
          request: "question",
          question: {
            prompt: "Please answer the following questions.",
            fields: [
              {
                id: "question_0",
                input: "single",
                header: "Database",
                prompt: "Which database should we use?",
                choices: [{ value: "Postgres", label: "Postgres" }],
                allowFreeText: true,
              },
            ],
          },
        },
      ],
    } as never)
    expect(await runPermissions(["ls"])).toBe(0)
    const text = out.join("")
    expect(text).toContain("    question_0 (single, +text)  [Database] Which database should we use?\n")
    expect(text).toContain("      - Postgres\n")
  })
})
