/**
 * The proxy routing table: `<hostname>` → local service port.
 *
 * Kept separate from the HTTP server (see `proxy-server.ts`) so the supervisor
 * can register/unregister routes without owning a live socket, and so routing
 * can be unit-tested without binding a port.
 */
export class ProxyTable {
  private readonly routes = new Map<string, number>()

  /** Register (or replace) the target port for a hostname. */
  set(hostname: string, port: number): void {
    this.routes.set(hostname.toLowerCase(), port)
  }

  /** Remove a hostname's route. Returns whether it was present. */
  delete(hostname: string): boolean {
    return this.routes.delete(hostname.toLowerCase())
  }

  /** The target port registered for an exact hostname, if any. */
  get(hostname: string): number | undefined {
    return this.routes.get(hostname.toLowerCase())
  }

  /**
   * Resolve a raw `Host` header (which may carry a `:port` suffix, and for
   * IPv6 a bracketed host) to a target port.
   */
  lookup(hostHeader: string | undefined): number | undefined {
    if (!hostHeader) return undefined
    const host = stripPort(hostHeader).toLowerCase()
    return this.routes.get(host)
  }

  /** All `[hostname, port]` routes currently registered. */
  entries(): Array<[string, number]> {
    return [...this.routes.entries()]
  }

  /** Number of registered routes. */
  get size(): number {
    return this.routes.size
  }
}

/** Strip a trailing `:port` from a Host header, honouring `[ipv6]:port`. */
export function stripPort(hostHeader: string): string {
  const trimmed = hostHeader.trim()
  if (trimmed.startsWith("[")) {
    // [::1]:8080 → [::1]
    const close = trimmed.indexOf("]")
    return close === -1 ? trimmed : trimmed.slice(0, close + 1)
  }
  const colon = trimmed.indexOf(":")
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}
