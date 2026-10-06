# Run your tests or a reviewer model every time an agent finishes a turn

Status: Stable (turn-end shell and judge gates). The commit-awaiting-ack
section is Beta.

An agent says "done" when its turn ends, not when your tests pass. A **gate**
is a check the daemon runs for you at that moment: your test suite, or a short
reviewer agent that reads the work and says pass or fail. If the check fails,
the daemon can send the agent back to fix it.

Gates are driven by [`agentproto policy`](../verbs/policy.md), a thin client
over the daemon's completion-policy engine. A **policy** is one gate attached
to one session (or to a group of sessions), and it lives in the daemon, so it
survives your terminal closing.

## Prerequisites

- A running daemon (`agentproto serve`, see [`serve`](../verbs/serve.md)).
- A session to gate. Get its id from `agentproto sessions` (for example
  `ses_abc12` below). The gate fires when that session's **turn ends**, so it
  needs an agent session, not a plain terminal.

## 1. Run your tests at the end of every turn

### Allow the command first

The daemon runs gate commands under the same default-deny allowlist as every
other command it runs for agents. Create (or extend)
`<workspace>/.agentproto/allowed-commands.json`, where `<workspace>` is the
directory the daemon was started with (`agentproto serve --workspace <dir>`):

```json
{
  "version": 1,
  "commands": ["pnpm"]
}
```

Entries are matched by command name (`pnpm`, not `/usr/bin/pnpm`). If the file
is missing or the command is not listed, the gate does not run: the policy goes
straight to `blocked` with the error `gate command 'pnpm' not in allowlist`.
Be careful what you add: allowing an interpreter such as `bash` or `python3`
lets any caller run arbitrary code.

### Attach the gate

```bash
agentproto policy attach --session ses_abc12 -- pnpm test
# agentproto policy attach: policy_41970250 → watching
```

Everything after `--` is the command and its arguments, passed as-is (no shell,
so no pipes or `&&`). It runs in the session's own working directory; use
`--gate-cwd <dir>` to run it somewhere else.

Two defaults to know:

- A shell gate is killed after **60 seconds** and counts as failed. For a real
  test suite, raise it: `--gate-timeout 10m`.
- The gate passes when the command exits `0`. Anything else is a failure.

### What happens at turn end

| Gate result | What the policy does |
|-------------|----------------------|
| Passes | Status becomes `done`. The daemon emits a `policy:passed` event and does nothing else. |
| Fails, no retry configured | Status becomes `blocked` and the daemon emits `policy:failed`. The agent is **not** re-prompted. |
| Fails, retry configured | The daemon sends the session a nudge message, then waits for the next turn end and runs the gate again. After the retry limit it becomes `blocked`. |

To make the agent fix a red gate on its own, add a retry:

```bash
agentproto policy attach --session ses_abc12 \
  --on-fail-nudge "pnpm test failed with exit {code}. Fix the failing tests, then finish." \
  --on-fail-max-retries 3 \
  --gate-timeout 10m \
  -- pnpm test
```

Things that are easy to miss:

- **The nudge carries only the exit code.** `{code}` is replaced by it; the
  test output is not sent to the agent. Say in the nudge how to find the
  failures ("run `pnpm test` and fix what fails"), or the agent has to
  rediscover them.
- **Set `--on-fail-nudge` yourself.** The built-in default message is written
  in French.
- `--on-fail-max-retries` defaults to `2` when you give only `--on-fail-nudge`.
  It must be at least `1`.
- A nudge is only sent while the session is still alive. If it has already
  ended, the policy goes to `blocked`.
- The last gate run, including truncated `stdout` and `stderr`, is in
  `agentproto policy status <policyId> --json` under `lastGate`. That is where
  you read why a gate failed.

### Watch it, wait for it, cancel it

```bash
agentproto policy status policy_41970250   # one-line snapshot, never blocks
agentproto policy status policy_41970250 --json   # full state: lastGate, retries, error
agentproto policy ls --session ses_abc12   # what is gating this session?
agentproto policy wait policy_41970250     # block until it settles
agentproto policy cancel policy_41970250
```

`--wait` on `attach` does the attach and the wait in one call. Statuses you
will see: `watching` (waiting for turn end), `gating` (check running),
`nudging`, `done`, `blocked`, `cancelled`, and `awaiting-ack` (section 3).
`wait` exits `0` on `done` or `awaiting-ack`, `2` on `blocked`, `cancelled` or
CLI timeout, and `3` if the policy is not found. Full flag list and exit codes
are in the [`policy` verb page](../verbs/policy.md).

A policy that is still `watching` when its session ends is `cancelled`: with no
turn end to react to, there is nothing to gate.

## 2. Ask a reviewer model instead

A judge gate starts a short-lived agent, gives it your rubric plus the tail of
the watched session's output, and reads its verdict. The judge session is always
killed afterwards.

```bash
agentproto policy attach --session ses_abc12 \
  --judge-adapter claude-code \
  --judge-model claude-sonnet-5-5 \
  --judge-prompt "Review the diff. FAIL if it changes behavior without a test or touches auth code." \
  --judge-timeout 3m \
  --on-fail-nudge "A reviewer rejected your last turn. Re-read the diff and fix what it would object to." \
  --on-fail-max-retries 2
```

- `--judge-adapter` is the agent CLI that plays the judge (see
  [adapters](../concepts/adapters.md)); `--judge-model` is optional.
- The daemon appends an instruction to end the reply with `VERDICT: PASS` or
  `VERDICT: FAIL`. The judge may instead return a JSON block with `decision`,
  `summary` and `findings`; only `decision` decides pass or fail, and the rest is
  stored on the policy so you can see why (`policy status --json`, field
  `verdict`). Details are in the
  [`policy` verb page](../verbs/policy.md#judge-gate-details).
- It fails safe: a timeout (default **2 minutes**), an unparseable reply, an
  unknown adapter or a judge that cannot start all count as a failed gate, never
  as a pass.
- The judge model is set per gate with `--judge-model`. It is not read from the
  daemon's model-role settings.
- The retry nudge works exactly as in section 1. As with the shell gate, the
  nudge does not carry the judge's findings.

A policy takes one gate only: passing both a command and a judge exits `2`.

## 3. Hold a commit until you approve it (Beta)

A green gate can also stage a commit made by the daemon, parked until you say
yes.

```bash
agentproto policy attach --session ses_abc12 --then commit \
  --commit-path src --commit-path package.json \
  --commit-message "feat: land the thing" \
  --gate-timeout 10m \
  -- pnpm test
```

`--then commit` **requires** `--commit-path` (repeatable) and
`--commit-message`. Leaving either out exits `2` with
`--then commit requires --commit-path <path> (repeatable) and --commit-message <text>`.
The commit flags are rejected without `--then commit`.

On a green gate the policy moves to `awaiting-ack` and emits a
`policy:commit-ready` event listing the paths and message. Nothing is committed
yet. Then:

```bash
agentproto policy ack policy_41970250 --approve   # git add + git commit
agentproto policy ack policy_41970250 --reject    # cancel, nothing committed
```

After an approval, `policy status --json` shows the new `commitSha`. Pass
`--no-ack` to commit directly on a green gate with no human step.

### `git` must be allowed

The commit is run by the daemon, so `git` has to be in the same allowlist from
section 1:

```json
{
  "version": 1,
  "commands": ["pnpm", "git"]
}
```

Without it, the approval fails with `commit command 'git' not in allowlist` and
the policy goes to `blocked`. The commit is made in the watched session's working
directory.

### The ack is a convention, not a lock

`policy ack` is declared but not enforced. Any process that holds the daemon's
token can run it, and the daemon cannot tell your shell from an agent's. Do not
rely on it to stop a session approving its own commit; treat it as a prompt for
the human, and keep agents away from `policy ack` by instruction (the repo's
`AGENTS.md` does this for `gh pr merge` in the same way).

## What it doesn't do

- **It does not stop an agent from running `git commit` itself.** A gate runs
  when a turn ends. A commit the agent makes during the turn is not intercepted
  by anything here, and `--then commit` only governs the commit the daemon makes
  after a green gate (and it is off unless you pass it).
- **It is not a pre-commit hook.** It reacts to the end of a turn, not to a
  commit, so it cannot guarantee that every commit in your repo passed a check.
- **It does not block a push.** Nothing in `policy` touches `git push`. If you
  want a check before pushing, `agentproto review init` installs a pre-push
  hook, but that hook is opt-in and anyone can skip it with `git push
  --no-verify`. See [`review`](../verbs/review.md).
- **It does not feed failure details back to the agent.** The nudge contains the
  exit code and your text only; the output stays on the policy.
- **The ack is not access control** (see above).
- **It is not instant protection against a runaway agent.** A gate that is
  `blocked` stops the retries; it does not stop or roll back the session.

## See also

- [`agentproto policy`](../verbs/policy.md): every flag, exit code, fan-in with
  `--sessions`, and the full `--attach-json` shape.
- [`agentproto review`](../verbs/review.md): REVIEW.md lanes and the opt-in
  pre-push hook.
- [`agentproto sessions`](../verbs/sessions.md): finding the session id to gate.
