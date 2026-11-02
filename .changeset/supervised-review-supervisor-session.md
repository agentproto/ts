---
"@agentproto/runtime": patch
---

Thread a supervising session through workflow runs: `workflow_start` / `workflow_run_file` accept `supervisorSessionId`, and every agent-step session the run spawns records it as `parentSessionId`, so a supervised review/fix loop reads as one parent with reviewer and fixer children instead of anonymous depth-0 roots. Descriptor-only lineage; it never relaxes a depth or role guard.
