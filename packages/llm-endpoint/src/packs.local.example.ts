/**
 * Local pack overrides — gitignored.
 *
 * Create a file named `packs.local.json` (JSON, not TypeScript).
 * The runtime searches for it in: process.cwd(), src/, or __dirname.
 *
 * Schema:
 *   {
 *     "packs": {
 *       "my-private": {
 *         "id": "my-private",
 *         "label": "My Private",
 *         "description": "...",
 *         "models": {
 *           "secret-1": {
 *             "provider": "openrouter",
 *             "model": "anthropic/claude-opus-4",
 *             "equivalentClaudeName": "claude-opus-4-8"
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Local packs are selectable via X-Proxy-Pack, ?pack=, or /v1/{pack}/messages
 * just like official packs. Their model codes are namespaced to their pack —
 * they do NOT override codes in other packs.
 * NOTE: packs.local.json is read once at process startup and cached.
 * Editing the file requires restarting the proxy process to take effect.
 * (tsx watch does not trigger reload for JSON files.)
 */
