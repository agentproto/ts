# Pi — sandbox & safety profile

## Pi has NO built-in permission system

This is not an opinion — it is pi's own documented position. From pi's
README (`## Permissions & Containerization`):

> Pi does not include a built-in permission system for restricting filesystem,
> process, network, or credential access. By default, it runs with the
> permissions of the user and process that launched it.

And, critically for this adapter, from pi's coding-agent README:

> Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a
> trust prompt.

> **No permission popups.** Run in a container, or build your own confirmation
> flow with extensions inline with your environment and security requirements.

> **Security:** Pi packages run with full system access. Extensions execute
> arbitrary code, and skills can instruct the model to perform any action
> including running executables.

Because this adapter drives pi via `--mode rpc` — a **non-interactive** mode —
there is **no trust prompt and no approval gate**. Every `bash`, `write`,
`edit` the model decides to run executes immediately with the launching
process's full OS permissions.

**Treat a pi session as arbitrary code execution on the host.**

## Recommendation: containerize

Pi's own guidance is to sandbox the whole process. Do not run this adapter
against untrusted repos or prompts on a host you care about. Pi documents three
patterns in `packages/coding-agent/docs/containerization.md`:

- run pi inside a Docker/OCI container scoped to the target workspace;
- restrict network egress at the container/VM boundary;
- **OpenShell** — run the whole `pi` process in a policy-controlled sandbox.

Prefer running the agentproto daemon (and therefore the spawned `pi --mode rpc`
child) inside such a boundary, with only the target working directory mounted
and only the provider API egress it needs.

## MCP substrate is unavailable (defense-in-depth note)

Pi has no MCP, so the daemon **cannot** narrow pi's tool surface by mounting a
curated MCP toolset — pi always exposes its own built-in file/shell tools, and
`connect({ mcpServers })` is ignored (with a one-time warning). There is no
"allowed tools" lever at the protocol layer here: the only enforcement boundary
is the OS/container sandbox you place pi in. This is a meaningful difference
from the ACP adapters, where the host chooses the mounted toolset.

## What the adapter does / doesn't isolate

- **Working directory** — the runner spawns `pi --mode rpc` with the
  host-chosen `cwd`; pi's file tools operate relative to it. This is scoping,
  not a security boundary.
- **Env / secrets** — only the runner-injected env (provider keys + host env)
  reaches the child. Keys are never logged.
- **Process** — the adapter owns the child and kills it (`SIGTERM`, after
  `stdin.end()`) on `close()` / abort. It does **not** confine what the child
  does while alive. That is the sandbox's job.
