import { useMcpConnection, useMcpTool } from "@agentproto/app-client/react"

interface AppStatus {
  running: boolean
  appId: string
}

export function DashboardRoute() {
  const connection = useMcpConnection()
  const status = useMcpTool<AppStatus>("app_status")

  return (
    <section>
      <h1>__APP_NAME__</h1>
      <p>Connection mode: {connection?.mode ?? "connecting…"}</p>
      {status.isPending && <p>Loading status…</p>}
      {status.isError && <p role="alert">{status.error.message}</p>}
      {status.data && (
        <dl>
          <dt>Running</dt>
          <dd>{String(status.data.running)}</dd>
          <dt>App id</dt>
          <dd>{status.data.appId}</dd>
        </dl>
      )}
    </section>
  )
}
