import { useMcpTool } from "@agentproto/app-client/react"

interface AppDataList {
  items: string[]
}

export function AboutRoute() {
  const data = useMcpTool<AppDataList>("app_data_list", { key: "notes" })

  return (
    <section>
      <h2>About __APP_NAME__</h2>
      <p>
        Scaffolded by <code>create-agentproto-app</code>. Edit{" "}
        <code>.agentproto/APP.md</code>, the agent, and the workflow to make
        this app yours.
      </p>
      <h3>App data (key: notes)</h3>
      {data.isPending && <p>Loading…</p>}
      {data.isError && <p role="alert">{data.error.message}</p>}
      {data.data && (
        <ul>
          {data.data.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
