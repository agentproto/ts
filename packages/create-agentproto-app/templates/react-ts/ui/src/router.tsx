import {
  Link,
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"

import { DashboardRoute } from "./routes/dashboard"
import { AboutRoute } from "./routes/about"

// Hash history: the daemon / `app serve` / MCP-Apps panel serve this as a
// single static index.html with no server rewrite rules, so history-API
// routing would 404 on refresh or a direct link. Hash routes work from any
// subpath (and even file://) without per-route HTML.
const rootRoute = createRootRoute({
  component: () => (
    <div className="app-shell">
      <nav>
        <Link to="/" activeOptions={{ exact: true }}>
          Dashboard
        </Link>
        <Link to="/about">About</Link>
      </nav>
      <Outlet />
    </div>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardRoute,
})

const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutRoute,
})

const routeTree = rootRoute.addChildren([indexRoute, aboutRoute])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
