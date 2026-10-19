/**
 * Contract fixtures for the computer API schemas: one valid and one
 * invalid example per endpoint payload. The package tests pin these
 * shapes, and the `@agentproto/sandbox-computer` fake controller runs the
 * same schemas over its own replies, so the fake cannot drift from the
 * published contract either.
 */
import type { z } from "zod"
import {
  computerStatusSchema,
  createComputerRequestSchema,
  createComputerResponseSchema,
  errorResponseSchema,
  execRequestSchema,
  execResponseSchema,
  resumeResponseSchema,
  sessionsResponseSchema,
  suspendResponseSchema,
} from "../index.js"

export interface Fixture {
  name: string
  schema: z.ZodType
  /** Expected to validate (true) or to reject (false). */
  valid: boolean
  value: unknown
}

const create = (name: string, schema: z.ZodType, valid: boolean, value: unknown): Fixture => ({
  name,
  schema,
  valid,
  value,
})

export const fixtures: Fixture[] = [
  create(
    "createComputerRequest",
    createComputerRequestSchema,
    true,
    {
      template: "workstation",
      tenantId: "acme",
      cpus: 2,
      memoryMiB: 4096,
      rootDiskMiB: 20480,
      ttl: 3600,
      maxSessions: 2,
      env: { FOO: "bar" },
      egress: { allow: [{ host: "example.com", port: 443 }] },
    },
  ),
  create(
    "createComputerRequest: unknown extra fields tolerated",
    createComputerRequestSchema,
    true,
    { template: "workstation", tenantId: "acme", futureField: { nested: true } },
  ),
  create(
    "createComputerRequest: missing template",
    createComputerRequestSchema,
    false,
    { tenantId: "acme" },
  ),
  create("createComputerRequest: fractional maxSessions", createComputerRequestSchema, false, {
    template: "workstation",
    tenantId: "acme",
    maxSessions: 1.5,
  }),
  create("createComputerRequest: wrong cpus type", createComputerRequestSchema, false, {
    template: "workstation",
    tenantId: "acme",
    cpus: "two",
  }),
  create(
    "createComputerResponse",
    createComputerResponseSchema,
    true,
    {
      id: "cmp-001",
      template: "workstation",
      state: "running",
      ports: [{ host: 40001, guest: 18790 }],
      createdAt: "2026-01-01T00:00:00Z",
    },
  ),
  create("createComputerResponse: missing id", createComputerResponseSchema, false, {
    template: "workstation",
    state: "running",
  }),
  create("createComputerResponse: ports not an array", createComputerResponseSchema, false, {
    id: "cmp-001",
    template: "workstation",
    state: "running",
    ports: { host: 40001 },
  }),
  create(
    "computerStatus",
    computerStatusSchema,
    true,
    {
      name: "cmp-001",
      state: "running",
      ports: [{ host: 40001, guest: 18790 }],
      template: "workstation",
      tenantId: "acme",
    },
  ),
  create(
    "computerStatus: unknown future state buckets under unknown",
    computerStatusSchema,
    true,
    { name: "cmp-001", state: "hibernating-with-bees" },
  ),
  create("computerStatus: missing name", computerStatusSchema, false, { state: "running" }),
  create("computerStatus: ports with non-integer host", computerStatusSchema, false, {
    name: "cmp-001",
    state: "running",
    ports: [{ host: 40001.5, guest: 18790 }],
  }),
  create("execRequest", execRequestSchema, true, {
    argv: ["/bin/bash", "-lc", "echo hi"],
    timeoutSec: 30,
  }),
  create("execRequest: missing argv", execRequestSchema, false, { timeoutSec: 30 }),
  create("execRequest: fractional timeoutSec", execRequestSchema, false, {
    argv: ["echo"],
    timeoutSec: 1.5,
  }),
  create("execResponse", execResponseSchema, true, { exitCode: 0, stdout: "hi", stderr: "" }),
  create("execResponse: exitCode fractional", execResponseSchema, false, {
    exitCode: 0.5,
    stdout: "",
    stderr: "",
  }),
  create("execResponse: stdout not a string", execResponseSchema, false, {
    exitCode: 0,
    stdout: 7,
    stderr: "",
  }),
  create("suspendResponse", suspendResponseSchema, true, {
    ok: true,
    snapshot: "snap-cmp-001-0",
    state: "stopped",
  }),
  create("suspendResponse: wrong ok type", suspendResponseSchema, false, { ok: "yes" }),
  create("resumeResponse: same id", resumeResponseSchema, true, { ok: true, id: "cmp-001", state: "running" }),
  create("resumeResponse: rename to a fresh id", resumeResponseSchema, true, {
    ok: true,
    id: "cmp-restored-002",
    state: "running",
  }),
  create("resumeResponse: id not a string", resumeResponseSchema, false, { id: 12 }),
  create("sessionsResponse", sessionsResponseSchema, true, { sessions: 1, maxSessions: 2 }),
  create("sessionsResponse: unknown extra fields tolerated", sessionsResponseSchema, true, {
    sessions: 0,
    maxSessions: 1,
    futureField: true,
  }),
  create("sessionsResponse: fractional sessions", sessionsResponseSchema, false, { sessions: 0.5 }),
  create(
    "errorResponse",
    errorResponseSchema,
    true,
    { error: "unknown template", detail: [{ path: "template", message: "not registered" }] },
  ),
  create("errorResponse: missing error", errorResponseSchema, false, { detail: [] }),
]
