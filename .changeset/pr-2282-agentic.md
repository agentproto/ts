---
"@agentproto/computer-api": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-computer": minor
---

Add the common sandbox list and usage surface. `@agentproto/sandbox` gains the `SandboxBox` and `SandboxUsageWindow` types plus optional `list()`/`usage()` methods on `SandboxProvider`; `@agentproto/computer-api` gains the `GET /v1/usage` schemas/types and additive W0b list fields; `@agentproto/sandbox-computer` implements `list()`/`usage()` and `ComputerControllerClient.getUsage()`, keeping absent controller fields absent.
