/**
 * A2A push notifications — the config store, URL rule, and the delivery
 * service (a2a-push.ts) with a fake `fetch`. The JSON-RPC surface these back
 * (the four config methods, `SendMessage` delivery) is covered end-to-end in
 * a2a-task-http.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  A2A_PUSH_CONFIG_LIMIT,
  A2aPushConfigLimitError,
  checkA2aPushUrl,
  createA2aPushConfigStore,
  parseA2aTaskPushNotificationConfig,
  type A2aTask,
  type A2aTaskPushNotificationConfig,
} from "../a2a-tasks.js"
import {
  A2A_NOTIFICATION_TOKEN_HEADER,
  createA2aPushService,
  deliverPushEvent,
  type A2aPushDeps,
} from "../a2a-push.js"

const APP_ID = "@test/push-app"
const TASK_ID = "task-1"
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: ${what} not reached`)
    await sleep(5)
  }
}

const workingTask = (): A2aTask => ({
  id: TASK_ID,
  contextId: "ctx-1",
  status: { state: "TASK_STATE_WORKING", timestamp: "2026-10-13T10:00:00.000Z" },
})

const completedTask = (): A2aTask => ({
  id: TASK_ID,
  contextId: "ctx-1",
  status: {
    state: "TASK_STATE_COMPLETED",
    timestamp: "2026-10-13T10:05:00.000Z",
    message: { messageId: "m-1", role: "ROLE_AGENT", parts: [{ text: "done" }] },
  },
  artifacts: [{ artifactId: "out-1", parts: [{ text: "done" }] }],
})

interface RecordedPost {
  url: string
  headers: Record<string, string>
  body: any
}

/** A fake `fetch` that records every POST and answers from a script of
 *  `Response`s / `Error`s (default: 200). */
function makeFetch(script: ((n: number, post: RecordedPost) => Response | Error) | undefined = undefined): {
  posts: RecordedPost[]
  fetchImpl: typeof fetch
} {
  const posts: RecordedPost[] = []
  let calls = 0
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const post: RecordedPost = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    posts.push(post)
    const behavior = script ? script(calls, post) : new Response(null, { status: 200 })
    calls++
    if (behavior instanceof Error) throw behavior
    return behavior
  }) as typeof fetch
  return { posts, fetchImpl }
}

const ok = (): Response => new Response(null, { status: 200 })
const status = (code: number): Response => new Response(null, { status: code })

describe("a2a push config URL rule", () => {
  it("accepts https and loopback http, rejects everything else", () => {
    expect(checkA2aPushUrl("https://example.com/hook")).toBeUndefined()
    expect(checkA2aPushUrl("https://example.com:8443/a/b?x=1")).toBeUndefined()
    expect(checkA2aPushUrl("http://localhost:3000/hook")).toBeUndefined()
    expect(checkA2aPushUrl("http://127.0.0.1/hook")).toBeUndefined()
    expect(checkA2aPushUrl("http://[::1]:9/hook")).toBeUndefined()
    expect(checkA2aPushUrl("ftp://example.com/hook")).toContain("must be https")
    expect(checkA2aPushUrl("http://example.com/hook")).toContain("must be https")
    expect(checkA2aPushUrl("http://localhost.evil.com/hook")).toContain("must be https")
    expect(checkA2aPushUrl("https://user:pass@example.com/hook")).toContain("userinfo")
    expect(checkA2aPushUrl("not a url at all")).toContain("not a valid URL")
  })
})

describe("a2a push config parsing", () => {
  it("stamps taskId and a fresh id, keeps token/authentication/tenant", () => {
    const parsed = parseA2aTaskPushNotificationConfig(
      {
        url: "https://example.com/hook",
        token: "tok",
        authentication: { scheme: "Bearer", credentials: "cred" },
        tenant: "t-1",
        taskId: "ignored",
      },
      { taskId: TASK_ID },
    )
    expect(parsed).toEqual({
      id: expect.any(String),
      taskId: TASK_ID,
      url: "https://example.com/hook",
      token: "tok",
      authentication: { scheme: "Bearer", credentials: "cred" },
      tenant: "t-1",
    })
    const withId = parseA2aTaskPushNotificationConfig({ url: "https://e.com/h", id: "given" }, { taskId: TASK_ID })
    expect(withId.id).toBe("given")
  })

  it("rejects bad shapes and bad URLs", () => {
    const bad: unknown[] = [
      "https://example.com/hook",
      {},
      { url: "" },
      { url: "ftp://x/y" },
      { url: "http://example.com/hook" },
      { url: "https://u:p@example.com/h" },
      { url: "https://e.com/h", token: "" },
      { url: "https://e.com/h", token: 5 },
      { url: "https://e.com/h", authentication: "Bearer x" },
      { url: "https://e.com/h", authentication: { scheme: "" } },
      { url: "https://e.com/h", authentication: { scheme: "Bearer", credentials: 5 } },
      { url: "https://e.com/h", id: "" },
    ]
    for (const raw of bad) {
      expect(() => parseA2aTaskPushNotificationConfig(raw, { taskId: TASK_ID }), JSON.stringify(raw)).toThrow()
    }
  })
})

describe("a2a push config store", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a2a-push-store-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const cfg = (id: string, taskId = TASK_ID): A2aTaskPushNotificationConfig => ({
    id,
    taskId,
    url: `https://example.com/${id}`,
  })

  it("create → get → list → delete round trips in one JSON file per app", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, cfg("c1"))
    await store.create(APP_ID, cfg("c2"))
    await store.create(APP_ID, cfg("other", "task-2"))
    expect(await store.get(APP_ID, TASK_ID, "c1")).toEqual(cfg("c1"))
    expect(await store.get(APP_ID, TASK_ID, "nope")).toBeUndefined()
    expect((await store.list(APP_ID, TASK_ID)).map(c => c.id)).toEqual(["c1", "c2"])
    expect(await store.list(APP_ID, "task-2")).toEqual([cfg("other", "task-2")])
    expect(await store.delete(APP_ID, TASK_ID, "c1")).toBe(true)
    expect(await store.delete(APP_ID, TASK_ID, "c1")).toBe(false)
    expect((await store.list(APP_ID, TASK_ID)).map(c => c.id)).toEqual(["c2"])
    // One atomic JSON file beside the ledger; no stray tmp files.
    const files = await readdir(dir)
    expect(files).toEqual([`${encodeURIComponent(APP_ID)}.push.json`])
    const onDisk = JSON.parse(await readFile(join(dir, files[0]!), "utf8"))
    expect(onDisk).toEqual({ [TASK_ID]: [cfg("c2")], "task-2": [cfg("other", "task-2")] })
  })

  it("a create with an existing id replaces that config", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, cfg("c1"))
    await store.create(APP_ID, { ...cfg("c1"), url: "https://example.com/new" })
    const listed = await store.list(APP_ID, TASK_ID)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.url).toBe("https://example.com/new")
  })

  it("enforces 10 configs per task; an 11th create throws A2aPushConfigLimitError", async () => {
    const store = createA2aPushConfigStore(dir)
    for (let i = 0; i < A2A_PUSH_CONFIG_LIMIT; i++) await store.create(APP_ID, cfg(`c${i}`))
    await expect(store.create(APP_ID, cfg("c10"))).rejects.toBeInstanceOf(A2aPushConfigLimitError)
    // Replacing one of the ten is still allowed.
    await expect(store.create(APP_ID, { ...cfg("c0"), url: "https://example.com/replaced" })).resolves.toBeDefined()
    // Another task has its own budget.
    await expect(store.create(APP_ID, cfg("c0", "task-2"))).resolves.toBeDefined()
  })

  it("serializes writes: 5 concurrent creates on one task all survive", async () => {
    const store = createA2aPushConfigStore(dir)
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.create(APP_ID, cfg(`c${i}`))))
    expect((await store.list(APP_ID, TASK_ID)).map(c => c.id).sort()).toEqual(["c0", "c1", "c2", "c3", "c4"])
    // A create racing a delete on the same file keeps both effects.
    await Promise.all([store.create(APP_ID, cfg("c5")), store.delete(APP_ID, TASK_ID, "c0")])
    expect((await store.list(APP_ID, TASK_ID)).map(c => c.id).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"])
  })
})

describe("a2a push delivery", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "a2a-push-deliver-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const deps = (fetchImpl: typeof fetch, extra: Partial<A2aPushDeps> = {}): A2aPushDeps => ({
    fetchImpl,
    pollMs: 1,
    retryDelaysMs: [0, 0],
    log: () => {},
    ...extra,
  })

  it("deliverPushEvent: 2xx is done; 500→200 is 2 attempts; 404 is 1; a throw retries then gives up", async () => {
    {
      const { posts, fetchImpl } = makeFetch((n) => (n === 0 ? status(500) : ok()))
      const delays: number[] = []
      await deliverPushEvent(cfgLike("c1"), { statusUpdate: { final: true } }, deps(fetchImpl, { sleep: async ms => { delays.push(ms) } }))
      expect(posts).toHaveLength(2)
      expect(delays).toEqual([0])
    }
    {
      const { posts, fetchImpl } = makeFetch(() => status(404))
      const delays: number[] = []
      await deliverPushEvent(cfgLike("c1"), {}, deps(fetchImpl, { sleep: async ms => { delays.push(ms) } }))
      expect(posts).toHaveLength(1)
      expect(delays).toEqual([])
    }
    {
      const { posts, fetchImpl } = makeFetch(() => new Error("connection refused"))
      const delays: number[] = []
      await deliverPushEvent(cfgLike("c1"), {}, deps(fetchImpl, { sleep: async ms => { delays.push(ms) } }))
      expect(posts).toHaveLength(3)
      expect(delays).toEqual([0, 0])
    }
  })

  it("deliverPushEvent sends content-type, the notification token header, and Authorization", async () => {
    const { posts, fetchImpl } = makeFetch()
    await deliverPushEvent(
      {
        id: "c1",
        taskId: TASK_ID,
        url: "https://example.com/hook",
        token: "tok-1",
        authentication: { scheme: "Bearer", credentials: "cred-1" },
      },
      { statusUpdate: { taskId: TASK_ID, final: true } },
      deps(fetchImpl),
    )
    expect(posts).toHaveLength(1)
    expect(posts[0]!.headers["content-type"]).toBe("application/json")
    expect(posts[0]!.headers[A2A_NOTIFICATION_TOKEN_HEADER.toLowerCase()]).toBe("tok-1")
    expect(posts[0]!.headers.authorization).toBe("Bearer cred-1")
    expect(posts[0]!.body).toEqual({ statusUpdate: { taskId: TASK_ID, final: true } })
  })

  it("the watcher delivers artifactUpdate then the final statusUpdate, in order, to every config", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "c1", taskId: TASK_ID, url: "https://example.com/a", token: "tok-a", authentication: { scheme: "Bearer", credentials: "cred-a" } })
    await store.create(APP_ID, { id: "c2", taskId: TASK_ID, url: "https://example.com/b" })
    const { posts, fetchImpl } = makeFetch()
    const service = createA2aPushService(deps(fetchImpl))
    const state = { task: workingTask() }
    service.ensureWatching({
      appId: APP_ID,
      taskId: TASK_ID,
      readTask: async () => state.task,
      listConfigs: () => store.list(APP_ID, TASK_ID),
    })
    expect(service.isWatching(TASK_ID)).toBe(true)
    state.task = completedTask()
    await waitFor(() => posts.some(p => p.body?.statusUpdate?.final === true), "final statusUpdate")
    await waitFor(() => !service.isWatching(TASK_ID), "watcher to end")

    const forA = posts.filter(p => p.url === "https://example.com/a")
    const forB = posts.filter(p => p.url === "https://example.com/b")
    for (const post of forA) {
      expect(post.headers[A2A_NOTIFICATION_TOKEN_HEADER.toLowerCase()]).toBe("tok-a")
      expect(post.headers.authorization).toBe("Bearer cred-a")
    }
    for (const post of forB) {
      expect(post.headers[A2A_NOTIFICATION_TOKEN_HEADER.toLowerCase()]).toBeUndefined()
      expect(post.headers.authorization).toBeUndefined()
    }
    for (const posts of [forA, forB]) {
      expect(posts.map(p => (p.body.artifactUpdate ? "artifactUpdate" : p.body.statusUpdate?.final === true ? "final" : "other"))).toEqual([
        "artifactUpdate",
        "final",
      ])
      expect(posts[0]!.body.artifactUpdate).toMatchObject({
        taskId: TASK_ID,
        contextId: "ctx-1",
        lastChunk: true,
        artifact: { artifactId: "out-1" },
      })
      expect(posts[1]!.body.statusUpdate).toMatchObject({
        taskId: TASK_ID,
        contextId: "ctx-1",
        status: { state: "TASK_STATE_COMPLETED" },
        final: true,
      })
    }
    expect(service.activeWatchers()).toBe(0)
  })

  it("two configs on one task share one watcher", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "c1", taskId: TASK_ID, url: "https://example.com/a" })
    await store.create(APP_ID, { id: "c2", taskId: TASK_ID, url: "https://example.com/b" })
    const { posts, fetchImpl } = makeFetch()
    const service = createA2aPushService(deps(fetchImpl))
    const state = { task: workingTask() }
    const input = {
      appId: APP_ID,
      taskId: TASK_ID,
      readTask: async () => state.task,
      listConfigs: () => store.list(APP_ID, TASK_ID),
    }
    service.ensureWatching(input)
    service.ensureWatching(input)
    expect(service.activeWatchers()).toBe(1)
    state.task = completedTask()
    await waitFor(() => !service.isWatching(TASK_ID), "watcher to end")
    expect(posts.filter(p => p.url === "https://example.com/a")).toHaveLength(2)
    expect(posts.filter(p => p.url === "https://example.com/b")).toHaveLength(2)
    expect(service.activeWatchers()).toBe(0)
  })

  it("a config deleted mid-run receives no further events", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "c1", taskId: TASK_ID, url: "https://example.com/a" })
    await store.create(APP_ID, { id: "c2", taskId: TASK_ID, url: "https://example.com/b" })
    const { posts, fetchImpl } = makeFetch()
    const service = createA2aPushService(deps(fetchImpl))
    const state = { task: workingTask() }
    service.ensureWatching({
      appId: APP_ID,
      taskId: TASK_ID,
      readTask: async () => state.task,
      listConfigs: () => store.list(APP_ID, TASK_ID),
    })
    // First a timestamp-only change on the same state: one statusUpdate each.
    state.task = { ...workingTask(), status: { ...workingTask().status, timestamp: "2026-10-13T10:01:00.000Z" } }
    await waitFor(() => posts.filter(p => p.url === "https://example.com/b").length === 1, "first delivery to both")
    await store.delete(APP_ID, TASK_ID, "c2")
    state.task = completedTask()
    await waitFor(() => posts.filter(p => p.url === "https://example.com/a").some(p => p.body?.statusUpdate?.final === true), "final delivery to the remaining config")
    await waitFor(() => !service.isWatching(TASK_ID), "watcher to end")
    expect(posts.filter(p => p.url === "https://example.com/b")).toHaveLength(1)
    expect(posts.filter(p => p.url === "https://example.com/a")).toHaveLength(3)
  })

  it("a throwing fetch never breaks the watcher: it retries, logs, and still ends on the terminal event", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "c1", taskId: TASK_ID, url: "https://example.com/a" })
    const { posts, fetchImpl } = makeFetch(() => new Error("boom"))
    const logs: string[] = []
    const service = createA2aPushService(deps(fetchImpl, { log: line => logs.push(line) }))
    const state = { task: workingTask() }
    service.ensureWatching({
      appId: APP_ID,
      taskId: TASK_ID,
      readTask: async () => state.task,
      listConfigs: () => store.list(APP_ID, TASK_ID),
    })
    state.task = completedTask()
    await waitFor(() => !service.isWatching(TASK_ID), "watcher to end despite fetch failures")
    // artifactUpdate + final statusUpdate, 3 attempts each.
    expect(posts).toHaveLength(6)
    expect(logs.some(l => l.includes("gave up"))).toBe(true)
  })

  it("a config created on an already terminal task gets one final statusUpdate and no watcher", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "c1", taskId: TASK_ID, url: "https://example.com/a" })
    const { posts, fetchImpl } = makeFetch()
    const service = createA2aPushService(deps(fetchImpl))
    const c1 = (await store.get(APP_ID, TASK_ID, "c1"))!
    await service.deliverFinal({ task: completedTask(), config: c1 })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toEqual({
      statusUpdate: {
        taskId: TASK_ID,
        contextId: "ctx-1",
        status: completedTask().status,
        final: true,
      },
    })
    expect(service.activeWatchers()).toBe(0)
    expect(service.isWatching(TASK_ID)).toBe(false)
  })

  it("deliverFinal sends only to the config just created, not the task's other configs", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "c1", taskId: TASK_ID, url: "https://example.com/a" })
    await store.create(APP_ID, { id: "c2", taskId: TASK_ID, url: "https://example.com/b" })
    const { posts, fetchImpl } = makeFetch()
    const service = createA2aPushService(deps(fetchImpl))
    const c2 = (await store.get(APP_ID, TASK_ID, "c2"))!
    await service.deliverFinal({ task: completedTask(), config: c2 })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe("https://example.com/b")
  })

  it("delivers one event to all configs in parallel: a slow webhook does not delay the others", async () => {
    const store = createA2aPushConfigStore(dir)
    await store.create(APP_ID, { id: "slow", taskId: TASK_ID, url: "https://example.com/slow" })
    await store.create(APP_ID, { id: "fast", taskId: TASK_ID, url: "https://example.com/fast" })
    const times: Array<{ url: string; at: number }> = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.endsWith("/slow")) await sleep(40)
      times.push({ url, at: Date.now() })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const service = createA2aPushService(deps(fetchImpl))
    const state = { task: workingTask() }
    service.ensureWatching({
      appId: APP_ID,
      taskId: TASK_ID,
      readTask: async () => state.task,
      listConfigs: () => store.list(APP_ID, TASK_ID),
    })
    state.task = completedTask()
    await waitFor(
      () => times.filter(t => t.url.endsWith("/fast")).length === 2 && times.filter(t => t.url.endsWith("/slow")).length === 2,
      "both configs to receive both events",
    )
    await waitFor(() => !service.isWatching(TASK_ID), "watcher to end")
    // The fast config's final lands before the slow config's final: the
    // per-event fan-out is parallel, not serial in list order (where the
    // slow config is first).
    const lastFast = times.filter(t => t.url.endsWith("/fast"))[1]!.at
    const lastSlow = times.filter(t => t.url.endsWith("/slow"))[1]!.at
    expect(lastFast).toBeLessThan(lastSlow)
  })
})

const cfgLike = (id: string): A2aTaskPushNotificationConfig => ({
  id,
  taskId: TASK_ID,
  url: "https://example.com/hook",
})
