---
"@agentproto/runtime": patch
---

Add app_* daemon tools (app_install, app_list, app_run, app_status, app_stop) for @agentproto/app-kit lifecycle management. Tools enable installing bundled agent-workflow apps, running agents as live sessions, and monitoring app execution. Moves workflow tool-id validation from step-dispatch time to install time, reporting all missing tool ids at once instead of failing one step at a time.
