import { defineConnector } from "@agentproto/collect"

const decode = (bytes) => new TextDecoder().decode(bytes)

export const fake = defineConnector({
  id: "fake",
  version: "1.0.0",
  transports: ["http"],
  capabilities: ["search"],
  counters: [{ name: "views", unit: "count", scope: "root", primary: true }],
  plan(_recipe, sources) {
    const tasks = []
    for (const s of sources) {
      const base = s.options?.base ?? process.env.FAKE_BASE
      for (const q of s.queries) {
        const url = `${base}/q/${encodeURIComponent(q.text)}?subject=${encodeURIComponent(q.subject)}`
        tasks.push({ id: `q-${q.text}`, params: { url } })
      }
    }
    return tasks
  },
  async fetch(task, transport) {
    const res = await transport.http.request({ url: task.params.url })
    return { raws: [{ url: res.url, ext: "json", bytes: res.body, httpStatus: res.status }] }
  },
  parse({ raw }) {
    const subject = new URL(raw.url).searchParams.get("subject") ?? undefined
    const body = JSON.parse(decode(raw.bytes))
    const posts = body.posts ?? []
    return {
      items: posts.map((p) => ({
        id: `fake:${p.id}`,
        source: "fake",
        kind: "post",
        url: `https://example.test/${p.id}`,
        text: p.text,
        subjects: subject ? [{ label: subject, provenance: "query" }] : [],
        authorRef: `fake:@${p.author}`,
      })),
      observations: posts.map((p) => ({ itemId: `fake:${p.id}`, metrics: { views: p.views } })),
      actors: posts.map((p) => ({ ref: `fake:@${p.author}`, displayName: p.author })),
    }
  },
})
