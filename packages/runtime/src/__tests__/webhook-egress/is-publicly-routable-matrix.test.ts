/**
 * `is-publicly-routable-matrix` — the one predicate, full range matrix from
 * the plan (§4 W-A.2) plus fail-closed oddities and legit public endpoints.
 */

import { describe, expect, it } from "vitest"

import { isPubliclyRoutable } from "../../webhook-egress/ssrf-fetch.js"

describe("is-publicly-routable-matrix", () => {
  const blockedV4: string[] = [
    "0.1.2.3", // 0/8
    "10.0.0.1", // 10/8
    "10.255.255.255",
    "100.64.0.1", // CGNAT 100.64/10
    "100.127.255.254",
    "169.254.169.254", // link-local (cloud metadata)
    "172.16.0.1", // 172.16/12
    "172.31.255.255",
    "192.0.0.8", // 192.0.0.0/24 infrastructure
    "192.0.2.1", // doc range
    "192.168.0.1", // 192.168/16
    "198.18.0.5", // benchmark 198.18/15
    "198.19.255.255",
    "198.51.100.7", // doc range
    "203.0.113.9", // doc range
    "224.0.0.1", // multicast 224/4
    "239.255.255.255",
    "240.0.0.1", // reserved 240/4
    "255.255.255.255",
  ]
  const publicV4: string[] = [
    "8.8.8.8",
    "1.1.1.1",
    "9.9.9.9",
    "172.32.0.1", // just past 172.16/12
    "172.15.0.1", // below
    "198.20.0.1", // just past the benchmark 198.18/15
    "203.0.114.1", // just past the doc range
    "100.63.255.1", // below CGNAT
    "100.128.0.1", // above CGNAT
    "11.0.0.1",
  ]

  const blockedV6: string[] = [
    "::", // unspecified
    "::1", // loopback
    "fc00::1", // ULA fc00::/7
    "fd12:3456::1",
    "fe80::1", // link-local
    "febf::1", // fe80::/10 upper edge
    "ff02::1", // multicast ff00::/8
    "::ffff:127.0.0.1", // mapped loopback via the SAME v4 predicate
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "2001:db8::1", // doc range
  ]
  const publicV6: string[] = [
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8", // mapped PUBLIC v4 passes
    "2400:cb00::1",
  ]

  const failClosed: string[] = [
    "", // empty
    "not-an-ip",
    "1.2.3.4.5",
    "1.2.3",
    "999.1.1.1", // out of octet range
    "01.2.3.4", // tolerated by some resolvers as decimal forms — not a literal we accept
    "fc00::::1", // double "::"
    "gg00::1", // bad hex
    "1:2:3", // too few groups, no "::"
    "1:2:3:4:5:6:7:8:9", // too many
    ":1:2", // leading single colon junk
  ]

  it("every blocked IPv4 range from the plan matrix", () => {
    for (const ip of blockedV4) expect(isPubliclyRoutable(ip)).toBe(false)
  })
  it("every blocked IPv6 kind from the plan matrix (incl. mapped-v4 through the same predicate)", () => {
    for (const ip of blockedV6) expect(isPubliclyRoutable(ip)).toBe(false)
  })
  it("real public endpoints pass", () => {
    for (const ip of publicV4) expect(isPubliclyRoutable(ip)).toBe(true)
    for (const ip of publicV6) expect(isPubliclyRoutable(ip)).toBe(true)
  })
  it("fails closed: odd/unparseable literals are NOT routable", () => {
    for (const ip of failClosed) expect(isPubliclyRoutable(ip)).toBe(false)
  })
  it("edge boundaries of the ranges flip exactly at the edge", () => {
    expect(isPubliclyRoutable("172.15.255.255")).toBe(true)
    expect(isPubliclyRoutable("172.16.0.0")).toBe(false)
    expect(isPubliclyRoutable("198.17.255.255")).toBe(true)
    expect(isPubliclyRoutable("198.18.0.0")).toBe(false)
    expect(isPubliclyRoutable("100.127.255.255")).toBe(false)
    expect(isPubliclyRoutable("100.128.0.0")).toBe(true)
    expect(isPubliclyRoutable("223.255.255.255")).toBe(true) // under multicast
    expect(isPubliclyRoutable("224.0.0.0")).toBe(false) // multicast edge
    expect(isPubliclyRoutable("fe80::")).toBe(false)
    expect(isPubliclyRoutable("fec0::")).toBe(true) // just past fe80::/10
    expect(isPubliclyRoutable("ff00::")).toBe(false)
  })
})
