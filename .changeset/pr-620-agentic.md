---
"@agentproto/runtime": patch
---

Enhance session title handling with clear precedence (explicit title > label > derived) and extend MAX_LENGTH from 60 to 72 code points. Labels are now used verbatim when present, preventing boilerplate orchestrator prompts from creating useless titles—critical for agent spawns where caller intent lives in the label.
