import { z } from "zod"

export const pluginAuthorSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    url: z.string().optional(),
  }).strict(),
])

export const pluginRepositorySchema = z.union([
  z.string(),
  z.object({
    type: z.string(),
    url: z.string(),
  }).strict(),
])

export const pluginExtensionSchema = z.object({
  path: z.string(),
  description: z.string().optional(),
}).strict()

export const pluginSchema = z.object({
  $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: pluginRepositorySchema.optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(z.string(), pluginExtensionSchema).optional(),
}).strict()
