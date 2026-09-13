import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// `base: "./"` + hash-history routing (see src/router.tsx) so the built
// output works from any subpath (or file://) with no server rewrite rules —
// the daemon/app-serve/MCP-Apps panel all serve this as plain static files.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../.agentproto/ui",
    emptyOutDir: true,
  },
  server: {
    proxy: process.env.AGENTPROTO_BRIDGE_URL
      ? {
          "/__agentproto": {
            target: process.env.AGENTPROTO_BRIDGE_URL,
            changeOrigin: true,
          },
        }
      : undefined,
  },
})
