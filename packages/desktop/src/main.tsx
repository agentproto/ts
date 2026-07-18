import React from "react"
import ReactDOM from "react-dom/client"

import "./theme/globals.css"
import App from "./App"
import { KitProvider } from "./theme/KitProvider"

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element missing from index.html")

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <KitProvider>
      <App />
    </KitProvider>
  </React.StrictMode>,
)
