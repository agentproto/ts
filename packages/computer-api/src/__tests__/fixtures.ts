/**
 * Contract fixtures for the computer API schemas: one valid and one
 * invalid example per endpoint payload. The package tests pin these
 * shapes, and the `@agentproto/sandbox-computer` fake controller runs the
 * same schemas over its own replies, so the fake cannot drift from the
 * published contract either.
 */
import type { z } from "zod"
import {
  attachRequestSchema,
  capacityResponseSchema,
  computerStatusSchema,
  createComputerRequestSchema,
  createComputerResponseSchema,
  egressErrorResponseSchema,
  egressIpSchema,
  egressPoolResponseSchema,
  errorResponseSchema,
  execRequestSchema,
  execResponseSchema,
  hostCapacityErrorResponseSchema,
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
  create("createComputerRequest: egressIp keywords", createComputerRequestSchema, true, {
    template: "workstation",
    tenantId: "acme",
    egressIp: "auto",
  }),
  create("createComputerRequest: egressIp pool slot", createComputerRequestSchema, true, {
    template: "workstation",
    tenantId: "acme",
    egressIp: "slot1",
  }),
  create("createComputerRequest: invalid egressIp", createComputerRequestSchema, false, {
    template: "workstation",
    tenantId: "acme",
    egressIp: "NOT-VALID",
  }),
  create("createComputerRequest: egressIp too long", createComputerRequestSchema, false, {
    template: "workstation",
    tenantId: "acme",
    egressIp: "toolongslot",
  }),
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
  create("createComputerResponse: egressIp", createComputerResponseSchema, true, {
    id: "cmp-001",
    template: "workstation",
    state: "running",
    egressIp: { id: "slot-a", publicIp: "203.0.113.10" },
  }),
  create("createComputerResponse: null egressIp", createComputerResponseSchema, true, {
    id: "cmp-001",
    template: "workstation",
    state: "running",
    egressIp: null,
  }),
  create("createComputerResponse: malformed egressIp", createComputerResponseSchema, false, {
    id: "cmp-001",
    template: "workstation",
    state: "running",
    egressIp: { id: "slot-a" },
  }),
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
  create("computerStatus: egressIp", computerStatusSchema, true, {
    name: "cmp-001",
    state: "running",
    egressIp: { id: "slot-a", publicIp: "203.0.113.10" },
  }),
  create("computerStatus: null egressIp", computerStatusSchema, true, {
    name: "cmp-001",
    state: "running",
    egressIp: null,
  }),
  create("computerStatus: malformed egressIp", computerStatusSchema, false, {
    name: "cmp-001",
    state: "running",
    egressIp: { publicIp: 203 },
  }),
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
  create("attachRequest: holder", attachRequestSchema, true, { holder: "sess_1a2b3c" }),
  create("attachRequest: body-less {}", attachRequestSchema, true, {}),
  create("attachRequest: empty holder rejected", attachRequestSchema, false, { holder: "" }),
  create("attachRequest: holder not a string", attachRequestSchema, false, { holder: 42 }),
  create("attachRequest: overlong holder rejected", attachRequestSchema, false, {
    holder: "x".repeat(129),
  }),
  create("egressIp", egressIpSchema, true, { id: "slot-a", publicIp: "203.0.113.10" }),
  create("egressIp: missing publicIp", egressIpSchema, false, { id: "slot-a" }),
  create("egressErrorResponse: pool disabled", egressErrorResponseSchema, true, {
    error: "egress-pool-disabled",
  }),
  create("egressErrorResponse: pool unknown", egressErrorResponseSchema, true, {
    error: "egress-pool-unknown",
  }),
  create("egressErrorResponse: pool exhausted", egressErrorResponseSchema, true, {
    error: "egress-pool-exhausted",
  }),
  create("egressErrorResponse: slot dedicated", egressErrorResponseSchema, true, {
    error: "egress-slot-dedicated",
  }),
  create("egressErrorResponse: unknown code", egressErrorResponseSchema, false, {
    error: "egress-pool-melted",
  }),
  create("hostCapacityErrorResponse", hostCapacityErrorResponseSchema, true, {
    error: "host-capacity",
    resource: "memory",
    requested: 8192,
    available: 4096,
  }),
  create("hostCapacityErrorResponse: missing available", hostCapacityErrorResponseSchema, false, {
    error: "host-capacity",
    resource: "memory",
    requested: 8192,
  }),
  create("hostCapacityErrorResponse: wrong error code", hostCapacityErrorResponseSchema, false, {
    error: "egress-pool-unknown",
    resource: "cpus",
    requested: 2,
    available: 1,
  }),
  create("capacityResponse", capacityResponseSchema, true, {
    memoryMiB: { budget: 65536, committed: 16384, available: 49152 },
    cpus: { budget: 16, committed: 4, available: 12 },
    computers: 3,
  }),
  create("capacityResponse: missing computers", capacityResponseSchema, false, {
    memoryMiB: { budget: 65536, committed: 16384, available: 49152 },
    cpus: { budget: 16, committed: 4, available: 12 },
  }),
  create("capacityResponse: fractional computers", capacityResponseSchema, false, {
    memoryMiB: { budget: 65536, committed: 16384, available: 49152 },
    cpus: { budget: 16, committed: 4, available: 12 },
    computers: 1.5,
  }),
  create("egressPoolResponse", egressPoolResponseSchema, true, [
    { id: "slot-a", sourceIp: "198.51.100.2", publicIp: "203.0.113.10", computers: 2 },
  ]),
  create("egressPoolResponse: empty pool", egressPoolResponseSchema, true, []),
  create("egressPoolResponse: missing publicIp", egressPoolResponseSchema, false, [
    { id: "slot-a", sourceIp: "198.51.100.2", computers: 2 },
  ]),
  create("egressPoolResponse: not an array", egressPoolResponseSchema, false, {
    id: "slot-a",
    sourceIp: "198.51.100.2",
    publicIp: "203.0.113.10",
    computers: 2,
  }),
  create(
    "errorResponse",
    errorResponseSchema,
    true,
    { error: "unknown template", detail: [{ path: "template", message: "not registered" }] },
  ),
  create("errorResponse: missing error", errorResponseSchema, false, { detail: [] }),
]
