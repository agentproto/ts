#!/usr/bin/env node
/**
 * Shared deterministic provenance footer builder for agentic deliveries the
 * runner stamps AFTER the box has done its work. The runner owns the footer —
 * never the model — so the `@agentproto-bot` marker is a reliable
 * native-vs-legacy discriminator and carries session provenance + cost that the
 * box can't know about itself.
 *
 * The canonical implementation now lives in `@agentproto/runtime`
 * (`packages/runtime/src/pr-provenance.ts`) so the DAEMON PR-open lane
 * (`command_execute` → `gh pr create`) stamps the exact same footer — one
 * format, one marker, one renderer. This module re-exports it so the
 * runner-side scripts (stamp-pr-footer, stamp-review-footer, the `gh_open_pr`
 * tool) keep their existing import unchanged. A script may import a package's
 * built `dist/` (it already does for `computeProvenance`); the reverse — a
 * package importing a loose script — is what the relocation avoids.
 */

export { MARKER, fmtTokens, buildFooter } from "../../packages/runtime/dist/pr-provenance.mjs"
