/**
 * Node-side `decodeData`: the frame codec's portable `decodeData` returns a
 * `Uint8Array` (so it runs in a browser); the Node tunnel client/server and the
 * `@agentproto/acp/tunnel` entry keep the `Buffer`-typed signature they always
 * had. Under Node the underlying value already is a `Buffer`, so this is free.
 */

import { decodeData as decodeBytes } from "./frames.js"

export function decodeData(data: string): Buffer {
  const bytes = decodeBytes(data)
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
