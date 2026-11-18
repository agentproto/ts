---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Stop context-continuation loops. (1) A fresh continuation now receives the STATE first (`## status: DONE` when the source finished its turn with no open task, else `IN PROGRESS` with the next step) and the original prompt only as a labelled reference (`## goal (reference only ...)`), so it never re-runs a task that was already carried out (and its side effects). (2) A chain of consecutive "rapid" continuations (each session lived under 15 min, cap 3) is refused with `ContinueFreshSpawnError` code `continuation_cap`; the automatic path hard-stops the last link and sends the parent a `[continuation-loop]` blocker message instead of spawning another successor. A long-lived session (a brain running for hours) is unaffected. (3) `mistral-vibe` declares `deferredToolDiscovery` (new `acpAgents.*.deferred_tool_discovery` config field), proved live: the daemon self-mount is now deferred for Vibe, which stays at ~16% context instead of starting at 85-88% with every tool schema loaded. This reproduces and fixes the 2026-11-18 loop where a Vibe sub-session was continued 11 times in a row.
