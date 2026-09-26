/**
 * Cloudflare Worker entry: serves the pair page bundle (dist/) on every
 * `<daemon-fingerprint>.agentproto.cloud`. All logic lives in ./edge.ts.
 * Configured by wrangler.toml (`[assets]` with `run_worker_first`, so every
 * request passes through here for the host check and the headers).
 */

import { handleRequest, type EdgeEnv } from "./edge"

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    return handleRequest(request, env)
  },
}
