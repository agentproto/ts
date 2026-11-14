/**
 * The turn-retry side-effect gate counts only calls that can write. Observed
 * 2026-11-05: three opencode-go/deepseek-v4.1-flash executor turns cut by
 * `EPROTO: The TLS handshake failed` were not retried because
 *
 *   [turn-retry] not retrying: turn already made N possibly side-effecting
 *   tool call(s) (git status --short && git diff --stat, grep ... /tmp/x.log)
 *
 * The recorded name of a shell call is its command line (the ACP title), and
 * the gate only looked at its first word, so `git status && git log` counted
 * as a write while `cat >> notes.md` passed as a read.
 */

import { describe, it, expect } from "vitest"
import type { SessionDescriptor } from "../sessions.js"
import { decideTurnRetry, isReadOnlyToolName } from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"

describe("isReadOnlyToolName: read-only calls", () => {
  it.each([
    // bare harness tools
    "read",
    "Read",
    "grep",
    "glob",
    "list",
    "ls",
    "webfetch",
    // harness titles
    "Read File",
    "Read /repo/AGENTS.md",
    'Search "foo|bar"',
    // shell command lines (the titles observed on the cut turns)
    "git status --short && git diff --stat",
    "git status && git log --oneline -5 && ls",
    'grep -n "EPROTO" /tmp/x.log',
    'grep -n "turn-retry" /tmp/x.log | tail -20',
    "git log --oneline -3 && git status --short | head -20 && git branch --show-current",
    "git status --short && git log --oneline -5 && git ls-remote origin fix/x | head -1",
    "git rev-parse HEAD; git show --stat HEAD",
    "sed -n 505,560p specs/aip-65.mdx; head -30 specs/aip-65.mdx | grep -E \"aip|status|type\"",
    "sed -n '1,80p' src/a.ts",
    "cat AGENTS.md",
    "cat package.json 2>/dev/null | head -50",
    "rg -n \"brainContext\" src | head -30",
    "pwd && ls -la && git status && git log --oneline -5 && git branch -a",
    "cd /repo && git status --short && git log -1 --oneline && git branch --show-current",
    "echo === ; wc -l src/*.ts",
    "git diff origin/main...HEAD -- packages/runtime > /dev/null 2>&1 || echo changed",
    "git remote -v | head -2; ls",
    "find src -name '*.ts' | sort | uniq -c",
    "R=.; git log --oneline origin/main..919fd52 | head; echo ---; git merge-base --is-ancestor fdcc157 919fd52 && echo ANCESTOR",
    "git status --short\ngit diff --stat\n# done",
    "git -C /repo log --oneline -3",
  ])("%s", name => {
    expect(isReadOnlyToolName(name)).toBe(true)
  })
})

describe("isReadOnlyToolName: possibly side-effecting calls", () => {
  it.each([
    // bare harness tools that write or run anything
    "bash",
    "edit",
    "write",
    "Terminal",
    "Write /tmp/x",
    "",
    // a harness-title head chaining a second command
    "read x && rm -rf dist",
    "Search foo; touch x",
    // mutating shell commands
    "git commit -m wip",
    "git status && git commit -am wip",
    "git add -A && git commit -q --no-verify -m test",
    "git fetch origin main && git checkout -b x origin/main",
    "git branch new-branch",
    "git branch -D old",
    "git stash push -m x",
    "git -c core.pager=less log",
    "git diff --output=/tmp/out.patch",
    "sed -i '' 's/a/b/' file.ts",
    "sed -n 's/a/b/w out.txt' file.ts",
    "sed 's/a/b/' file.ts",
    "cat >> notes.md <<'EOF'\nhi\nEOF",
    "cat a > b",
    "echo hi > file",
    "echo hi >> file",
    "git log > /tmp/log.txt",
    "grep x file | tee out.txt",
    "grep x file &> out.txt",
    "ls 2> errors.txt",
    "pnpm test",
    "pnpm --filter @agentproto/runtime test",
    "rm -rf dist",
    "mkdir -p out && ls out",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "sort -o sorted.txt in.txt",
    "uniq in.txt out.txt",
    "rg --pre ./script foo",
    "python3 -c 'print(1)'",
    "echo $(rm -rf x)",
    "echo `touch x`",
    'echo "$(touch x)"',
    "(cd x && rm y)",
    "for d in a b; do rm $d; done",
    "xargs rm < list.txt",
    "FOO=1 git push",
    "diff <(ls a) <(ls b)",
    "git status && 'unterminated",
  ])("%s", name => {
    expect(isReadOnlyToolName(name)).toBe(false)
  })
})

describe("turn-retry gate on the observed EPROTO cut", () => {
  const TLS = "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"
  const policy = resolveTurnRetryPolicy({ on: ["rate-limit", "upstream-5xx", "no-output-stall"] })
  const desc = { id: "s", kind: "agent-cli", status: "running", turnRetry: policy } as SessionDescriptor
  const end = (toolCalls: string[]) => ({ kind: "turn-end" as const, reason: "error", error: TLS, toolCalls })

  it("retries a turn whose calls were all read-only", () => {
    expect(
      decideTurnRetry(desc, end(["read", "git status --short && git diff --stat", 'grep -n "x" /tmp/x.log'])),
    ).toMatchObject({ action: "retry", errorClass: "upstream-5xx", attempt: 1 })
  })

  it("does not retry a turn that also made an edit", () => {
    expect(decideTurnRetry(desc, end(["git status --short && git diff --stat", "edit"]))).toMatchObject({
      action: "skip",
      toolCallsBlocked: true,
      skipReason: expect.stringContaining("1 possibly side-effecting tool call(s) (edit)"),
    })
  })

  it("does not retry a turn that appended to a file with cat", () => {
    expect(decideTurnRetry(desc, end(["cat >> notes.md <<'EOF'\nx\nEOF"]))).toMatchObject({
      action: "skip",
      toolCallsBlocked: true,
    })
  })
})
