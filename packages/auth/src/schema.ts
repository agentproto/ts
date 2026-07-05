/**
 * AIP-50 auth-provider frontmatter / literal Zod schema.
 *
 * Single source of truth for both authoring paths: `defineAuthProvider`
 * (TS literal) and `parseAuthProviderManifest` (.md) run this same schema,
 * so a malformed literal and a malformed manifest fail identically.
 */

import { z } from "zod"

export const tokenStoreSpecSchema = z
  .object({
    keychain: z.string().min(1),
    path: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
  })
  .strict()

export const patAuthConfigSchema = z
  .object({
    flow: z.literal("pat"),
    tokenStore: tokenStoreSpecSchema,
  })
  .strict()

export const serviceAuthConfigSchema = z
  .object({
    flow: z.literal("service-auth"),
    clientId: z.string().min(1).optional(),
    loginHint: z.string().min(1).optional(),
    tokenStore: tokenStoreSpecSchema,
  })
  .strict()

export const deviceCodeAuthConfigSchema = z
  .object({
    flow: z.literal("device-code"),
    clientId: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    deviceLabel: z.string().min(1).optional(),
    tokenStore: tokenStoreSpecSchema,
  })
  .strict()

export const authConfigSchema = z.discriminatedUnion("flow", [
  patAuthConfigSchema,
  serviceAuthConfigSchema,
  deviceCodeAuthConfigSchema,
])

export const installConfigSchema = z
  .object({
    sealKey: z.string().min(1),
    secretBacked: z.string().min(1),
  })
  .strict()

export const authProviderFrontmatterSchema = z
  .object({
    id: z.string().min(2).max(80),
    description: z.string().min(1).max(2000),
    apiBase: z.string().url(),
    auth: authConfigSchema,
    install: installConfigSchema.optional(),
    // Recommended values "tunnel" | "api" | "mcp" — free-form allowed, not an enum.
    audience: z.string().min(1).optional(),
  })
  .strict()
  .describe(
    "AIP-50 auth-provider manifest: how a CLI tool authenticates to an API server and (optionally) where to call the AIP-19 provision endpoints.",
  )

export type AuthProviderFrontmatter = z.infer<typeof authProviderFrontmatterSchema>
