import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface FixtureServer {
  url: string
  hits: string[]
  close(): Promise<void>
}

const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>
<input id="name" type="text" />
<button id="go" type="button">go</button>
<div id="out"></div>
<script>
fetch("/api/hello").then((r) => r.json()).then((j) => { document.getElementById("out").textContent = j.hello })
document.getElementById("go").addEventListener("click", () => {
  fetch("/api/echo?name=" + encodeURIComponent(document.getElementById("name").value))
})
</script></body></html>`

/** A loopback page with an input, a button and two JSON routes, on a random port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/"
    hits.push(url)
    if (url.startsWith("/api/hello")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hello: "world" }))
    } else if (url.startsWith("/api/echo")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ echo: url }))
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
