/**
 * A minimal local git smart-HTTP server over a self-signed HTTPS cert —
 * lets `review-pack-loader.test.ts` exercise a REAL `git+https://` clone
 * (the only scheme the loader now accepts) without touching the network.
 *
 * Bridges `git http-backend` as CGI: each request's method/path/query/body
 * become the CGI env + stdin `git-http-backend` expects; its stdout is
 * "Status:"/headers, a blank line, then the body — split and replayed onto
 * the Node response. The fixture cert is self-signed (checked in under
 * `fixtures/git-https/`), so the CLIENT side must skip verification
 * (`GIT_SSL_NO_VERIFY`) — not because the cert is malformed, just because
 * it isn't in any trust store a test can reasonably populate.
 */

import { execFile, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:https"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "git-https")

function gitExecPath(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["--exec-path"], (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout.trim())
    })
  })
}

export interface GitHttpsFixture {
  /** `https://127.0.0.1:<port>` — append `/<repo>.git` for a clone URL. */
  url: string
  /** `process.env` + `GIT_SSL_NO_VERIFY=1`, for the client-side git calls. */
  env: NodeJS.ProcessEnv
  close(): Promise<void>
}

/** Serve every bare repo under `projectRoot` over smart-HTTP/HTTPS. */
export async function startGitHttpsFixture(projectRoot: string): Promise<GitHttpsFixture> {
  const backend = join(await gitExecPath(), "git-http-backend")
  const key = readFileSync(join(FIXTURE_DIR, "key.pem"))
  const cert = readFileSync(join(FIXTURE_DIR, "cert.pem"))

  const server: Server = createServer({ key, cert }, (req, res) => {
    const u = new URL(req.url ?? "/", "https://localhost")
    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_PROJECT_ROOT: projectRoot,
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.replace(/^\?/, ""),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        SERVER_SOFTWARE: "agentproto-test-git-http-backend",
      },
    })
    req.pipe(child.stdin)

    let headerBuf = Buffer.alloc(0)
    let headersSent = false
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk)
        return
      }
      headerBuf = Buffer.concat([headerBuf, chunk])
      const idx = headerBuf.indexOf("\r\n\r\n")
      if (idx === -1) return
      const headerText = headerBuf.subarray(0, idx).toString("utf8")
      const body = headerBuf.subarray(idx + 4)
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of headerText.split("\r\n")) {
        if (!line) continue
        const sepAt = line.indexOf(":")
        const name = line.slice(0, sepAt).trim()
        const value = line.slice(sepAt + 1).trim()
        if (/^status$/i.test(name)) status = parseInt(value, 10) || 200
        else headers[name] = value
      }
      res.writeHead(status, headers)
      headersSent = true
      if (body.length) res.write(body)
    })
    child.stdout.on("end", () => {
      if (!headersSent) res.writeHead(500)
      res.end()
    })
    child.on("error", () => {
      if (!headersSent) res.writeHead(500)
      res.end()
    })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("git https fixture: server has no port")

  return {
    url: `https://127.0.0.1:${address.port}`,
    env: { ...process.env, GIT_SSL_NO_VERIFY: "1" },
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  }
}
