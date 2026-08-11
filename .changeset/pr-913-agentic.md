---
"@agentproto/runtime": patch
---

Populate session descriptor model from adapter default when no explicit model provided.

When a session is spawned with subscription auth and no explicit model parameter, the session descriptor's model field is now populated from the adapter's manifest default (if available), instead of remaining undefined. This fixes the VSCode panel displaying 'model?' as a fallback. The fix applies consistently to both the normal spawn and async worktree paths.
