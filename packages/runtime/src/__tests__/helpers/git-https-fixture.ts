/**
 * A minimal local git smart-HTTP server over a self-signed HTTPS cert —
 * lets `review-pack-loader.test.ts` exercise a REAL `git+https://` clone
 * (the only scheme the loader now accepts) without touching the network.
 *
 * Bridges `git http-backend` as CGI: each request's method/path/query/body
 * become the CGI env + stdin `git-http-backend` expects; its stdout is
 * "Status:"/headers, a blank line, then the body — split and replayed onto
 * the Node response. The cert is generated fresh, per fixture instance,
 * into a throwaway temp dir (`openssl req -x509 ...`, deleted on `close()`)
 * — NEVER checked into the repo, even self-signed and test-only: a
 * committed `key.pem` trips secret scanners and is bad hygiene regardless
 * of whether the key secures anything real. `opensslAvailable()` lets a
 * caller skip (not fail) when `openssl` isn't on PATH.
 */

import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type Server } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"

function execFileP(bin: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(bin, [...args], (err, _stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`))
      else resolvePromise()
    })
  })
}

function gitExecPath(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["--exec-path"], (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout.trim())
    })
  })
}

/** Whether `openssl` is on PATH — callers use this to `it.skip` the
 *  git+https fixture tests with a clear reason rather than fail the suite
 *  on a machine that doesn't have it. */
export async function opensslAvailable(): Promise<boolean> {
  return new Promise((resolvePromise) => execFile("openssl", ["version"], (err) => resolvePromise(!err)))
}

/** Generate a fresh self-signed cert into a new temp dir. Verification is
 *  disabled client-side (`GIT_SSL_NO_VERIFY`) regardless — the cert only
 *  needs to be well-formed, not trusted by anything. */
async function generateSelfSignedCert(): Promise<{ dir: string; keyPath: string; certPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "agentproto-git-https-cert-"))
  const keyPath = join(dir, "key.pem")
  const certPath = join(dir, "cert.pem")
  await execFileP("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ])
  return { dir, keyPath, certPath }
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
  const { dir: certDir, keyPath, certPath } = await generateSelfSignedCert()
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)])

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
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
      await rm(certDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}
