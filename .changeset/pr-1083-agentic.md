---
"@agentproto/runtime": minor
---

Refactor live-session widget timeline rendering: move usage updates from rows to state, add incremental DOM patching, and support compact display mode.

**WP1**: Usage snapshot (`usage_update` record) now stores in `TimelineState.usage` instead of appending a row. Last-write-wins semantics; usage is displayed in the header chip, not the timeline.

**WP2**: New `isNearBottom()` helper determines auto-scroll — captured BEFORE DOM mutation to preserve read position when user scrolls up, show "new messages" pill otherwise.

**WP3/WP4**: Compact display mode (inline or <640px viewport) collapses the tree into a `<select>` dropdown and groups consecutive tool calls (≥2) into collapsible `<details>` sections.

**WP5**: Header summary line surfaces status dot, tool count, usage chip (from state), and elapsed time, refreshed every 1s during active sessions.

Incremental DOM patching: text-delta patches the last row's text node in place; other records append via `insertAdjacentHTML`; full rebuilds only on session start/focus change/mode flip.
