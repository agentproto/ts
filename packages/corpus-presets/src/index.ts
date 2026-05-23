/**
 * @agentproto/corpus-presets — root barrel.
 *
 * Per-vertical presets are SUBPATH exports, not re-exports here. Tree-
 * shakeability matters: a consumer that only wants one vertical must
 * not pull every other vertical's content into its bundle.
 *
 * Discovery for the `corpus` CLI happens via this package's
 * `package.json#agentproto-corpus-preset` manifest — the CLI walks
 * every configured preset package, reads its manifest, and resolves
 * `corpus init <slug>` against the merged set. No hardcoded vertical
 * list lives here.
 *
 * Direct imports (bypassing the CLI's discovery) still work via the
 * declared subpath exports:
 *
 *     import { MarketingCorpusPreset } from "@agentproto/corpus-presets/marketing"
 */

export {}
