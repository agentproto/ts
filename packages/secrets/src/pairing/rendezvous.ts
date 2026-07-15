/**
 * The hosted rendezvous broker — the meeting point `pair offer` defaults to
 * when neither `--rendezvous` nor `pairing.rendezvous` is configured.
 *
 * ## Why it lives here
 *
 * It sits in `@agentproto/secrets/pairing`, beside `offer-url.ts` — the codec
 * that bakes this endpoint into every offer's `rv=` param. The daemon runtime
 * already depends on `@agentproto/secrets`, so it reaches this constant without
 * `@agentproto/runtime` gaining a dependency on `@agentproto/rendezvous`. That
 * matters: the broker package is a deliberately lean, standalone container (its
 * only dep is `ws`), and nothing on the daemon/CLI side should have to pull it
 * in just to learn the default endpoint's URL.
 *
 * ## What the broker sees
 *
 * The hosted broker only ever relays **ciphertext** — it learns the routing
 * token, the peers' IPs, ciphertext sizes, and timing; never plaintext, and it
 * cannot inject or alter frames (the pairing handshake is transcript-bound and
 * every frame is AEAD-sealed). See `docs/cli/concepts/pairing.md` for the full
 * threat model.
 *
 * ## Pointing elsewhere / self-hosting
 *
 * The broker is self-hostable (`agentproto rendezvous serve`). To route through
 * your own instead of the hosted default, set `pairing.rendezvous` in
 * `config.json` (or pass `--rendezvous` for a single offer). To disable the
 * default entirely — so a daemon never reaches the hosted broker unless an
 * endpoint is named explicitly — set `pairing.rendezvous: ""` (an explicit
 * opt-out; `pair offer` then requires `--rendezvous`).
 */
export const HOSTED_RENDEZVOUS_URL = "wss://rdv.agentproto.sh/v1" as const
