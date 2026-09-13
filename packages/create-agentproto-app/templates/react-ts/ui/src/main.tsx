import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { McpAppProvider } from "@agentproto/app-client/react"

import { router } from "./router"
import { standaloneTools } from "./standalone-tools"
import "./styles.css"

const queryClient = new QueryClient()

const rootEl = document.getElementById("root")
if (!rootEl) {
  throw new Error("#root element not found")
}

createRoot(rootEl).render(
  <StrictMode>
    <McpAppProvider options={{ standaloneTools }}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </McpAppProvider>
  </StrictMode>,
)
