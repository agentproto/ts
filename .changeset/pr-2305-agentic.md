---
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentproto": patch
---

End a clerk reaction dead when its `run.command` exits non-zero or is terminated by a signal/timeout, instead of recording a dishonest done (runtime). Document the behavior in the shipped `ap-reactions` skill guide (skill pack).
