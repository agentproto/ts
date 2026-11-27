# MCP Skills extension: wire shapes (beta)

Fixture version: `beta-1` (2026-11-26). The Skills extension is a beta of the
2026-07-28 revision, so these shapes may move. They were written from the
extension draft by hand, NOT copied from a published page: when the extension
changes, bump `_version` here and update `../../mcp-modern-skills.test.ts`, which
asserts the key sets of a live response against these files.

## Requests from the published page (2026-11-27)

The request fixtures below are copied from https://modelcontextprotocol.io/extensions/skills/overview (read
2026-11-27), each with its `_source`, and replayed by `../../mcp-conformance-blackbox.test.ts` through their
`_conformance` block (format in `../mcp-2026-07-28/README.md`). The live server serves the page's own
`code-review` skill, so `skills/list` must return the page's manifest byte for byte (same digests and sizes).
The two `*-result.json` files above carry no block and are not replayed.

| File | Section |
|---|---|
| `skills-list-request.json` | 'Listing Skills' (request and response) |
| `skills-get-request.json` | 'Getting a Skill' (request) |
| `resources-read-skill-request.json` | 'Reading Skill Content' (request and response) |
| `resources-read-skill-traversal.json` | reconstructed from 'Error Handling' and 'Integrity and Verification' |
| `resources-read-skill-unlisted.json` | reconstructed from 'Error Handling' |
