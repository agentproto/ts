---
"@agentproto/runtime": patch
---

The session screencast route (`GET /sessions/:id/screencast.jpg`) now reads the real result of Bureau's `browser_screenshot` called as a raw imported tool, a JSON object `{ base64, format, width, height }` given as a text block, as `structuredContent`, or both, in addition to an MCP `image` block. Before, a session with a perfectly open tab got a 404 logged as `bureau_error`. A tab whose result carries no usable image (empty or undecodable base64, unknown format, non-JSON, no content) is now logged as its own `bad_result` miss reason, distinct from `bureau_error`; the 404 body is unchanged.
