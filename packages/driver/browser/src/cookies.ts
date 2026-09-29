import { z } from "zod"

/** One cookie a host grants to a browser session. `value` is a secret: never log it. */
export const browserCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().default("/"),
  /** Seconds since the epoch; omit or `-1` for a session cookie. */
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
})
export type BrowserCookie = z.infer<typeof browserCookieSchema>

const sessionPayloadSchema = z.object({ cookies: z.array(browserCookieSchema).optional() }).loose()

/** Cookies carried by an attach `sessionPayload` (`{ cookies: [...] }`); `[]` when it has none or is malformed. */
export function cookiesFromSessionPayload(payload: unknown): BrowserCookie[] {
  const parsed = sessionPayloadSchema.safeParse(payload)
  return parsed.success ? (parsed.data.cookies ?? []) : []
}

/** Where granted cookies come from. L5b supplies grants; this is only the seam. */
export type BrowserCookieSource = (request: {
  providerId: string
  profile: string
}) => Promise<readonly BrowserCookie[]> | readonly BrowserCookie[]
