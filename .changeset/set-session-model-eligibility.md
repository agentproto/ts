---
"@agentproto/runtime": patch
---

Refuse a live model switch (agent_set_model) that would move a free session onto a paid model or onto a model outside the session profile's allow-list.
