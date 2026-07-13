import { createServer } from "node:net"

/**
 * Port allocation for supervised services.
 *
 * A service declares a preferred `port`; we use it if free, otherwise we fall
 * back to an OS-assigned ephemeral port. Allocation binds a probe socket on
 * 127.0.0.1 to decide — there's an inherent TOCTOU window between the probe
 * closing and the service binding, but for local dev supervision that's the
 * same race every "is this port free" check has, and the service will simply
 * fail to bind if something grabbed it in between.
 */

/** Resolve to `true` if a TCP listen on `127.0.0.1:<port>` succeeds. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

/** Ask the OS for a free ephemeral port (bind to 0, read the assigned port). */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error("could not determine an ephemeral port")))
      }
    })
  })
}

/**
 * Allocate a port for a service: the declared `preferred` if it's free,
 * otherwise an OS-assigned ephemeral port. Ports in `reserved` (already handed
 * out to sibling services this session) are treated as taken.
 */
export async function allocatePort(
  preferred: number | undefined,
  reserved: ReadonlySet<number> = new Set(),
): Promise<number> {
  if (preferred !== undefined && !reserved.has(preferred) && (await isPortFree(preferred))) {
    return preferred
  }
  // Retry ephemeral picks a few times in case we draw one already reserved for
  // a sibling that hasn't bound yet.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await ephemeralPort()
    if (!reserved.has(port)) return port
  }
  throw new Error("could not allocate a free port after 20 attempts")
}
