---
"@agentproto/runtime": minor
---

Add interpreter detection and warning to `command_execute`: export `INTERPRETER_BASENAMES`, `isInterpreterBasename()`, and `interpreterExecWarning()` to help users avoid the security footgun of allowlisting code interpreters (bash, node, python, etc.), which can grant arbitrary host code execution despite workspace cwd anchoring. Warnings are logged once per interpreter per daemon session and included in the result JSON for visibility without blocking.
