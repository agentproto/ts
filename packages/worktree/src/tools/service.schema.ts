import { z } from "zod"

/** Shared shape of a supervised service's status across the service tools. */
export const serviceStatusSchema = z.object({
  name: z.string().describe("The declared script name."),
  hostname: z.string().describe("The *.localhost host the reverse proxy routes to this service."),
  port: z.number().int().describe("The port the service listens on."),
  url: z.string().describe("The service's reverse-proxy URL."),
  pid: z.number().int().nullable().describe("Child process id while running, else null."),
  status: z.enum(["running", "exited"]).describe("Whether the service process is up."),
  exitCode: z.number().int().nullable().describe("Exit code once it has exited, else null."),
  startedAt: z.string().nullable().describe("ISO timestamp of the last start, else null."),
})

export type ServiceStatusOutput = z.infer<typeof serviceStatusSchema>
