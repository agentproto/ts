---
"@agentproto/adapter-browser-chrome": patch
---

chrome-live: a new tab no longer fails with "the new tab kept opening outside the
agent window (another Chrome window has focus)". The next blank tab is opened
from one of the agent window's own tabs with `window.open` (run as a user
gesture; the new page is found by `openerId`), which Chrome always places in the
opener's window, instead of `Target.createTarget` after `Target.activateTarget`,
which lands in whichever window is the last active one (the user's, another
agent's, a window on another Space). The previous path stays as a fallback.
`attach({ targetId })` now adopts a page of the entry that is still open (after a
host restart or a dropped connection) instead of opening a fresh tab, and a
failed re-attach never closes the page.
