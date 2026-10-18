---
"@agentproto/harness": minor
"@agentproto/worktree": minor
"@agentproto/runtime": patch
---

fix(runtime): sandbox proxy interrupt auth (401) + no-output-stall during tool calls

Les interrupts vers une session sandbox (E2B) échouaient tous en HTTP 401 :
le proxy frappait la route brute `POST /sessions/:id/interrupt` du daemon de
la box, qui exige un Bearer par-boot que l'hôte ne détient jamais — alors
que le prompt passe par le endpoint MCP, lui accessible. Correction :
`HarnessClient.interrupt` (`agent_interrupt`) + un `interrupt` sur le host
daemon ; le `cancel()` du proxy l'emprunte — le même canal MCP que le prompt
authentifie déjà. Le watchdog de stall ne se déclenche plus pendant un tool
call en cours (phase `tool-call:*` / tool call actif) : un long `pnpm
install` n'est plus traité comme un stall.
