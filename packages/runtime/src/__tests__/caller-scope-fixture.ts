/**
 * The ONE shared fixture of the T15 read-path tests: a synthetic user tree
 * with a sealed `perso` node, and a separate company tree, in temp dirs, plus
 * a fake session registry that places a session in each. Nothing here reads
 * the live daemon or ~/.agentproto.
 *
 *   <base>/user                 @me/root     (root)
 *     root.txt                  above the sealed wall
 *     perso/                    @me/perso    (type perso, sealed floor)
 *       diary.txt
 *       journal/entry.txt       plain folder inside perso
 *       apps/diary/             an installed app inside perso
 *     notes/                    @me/notes    (company, isolated), a sealed sibling's sibling
 *       todo.txt
 *       apps/todo/              an installed app inside notes
 *   <base>/company              @acme/root   (root), a different tree
 *     agentik/                  @acme/agentik (company)
 *       plan.txt
 *       apps/crm/               an installed app inside the company tree
 *   <base>/free                 no WORKSPACE.md anywhere above
 *     free.txt
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeTypesManifest } from "@agentproto/workspace"
import { writeWorkspaceManifest } from "@agentproto/workspace/manifest"
import { CallerScopes, type CallerScope } from "../caller-scope.js"

export const PERSO_ID = "@me/perso"
export const NOTES_ID = "@me/notes"
export const USER_ROOT_ID = "@me/root"
export const COMPANY_ROOT_ID = "@acme/root"
export const AGENTIK_ID = "@acme/agentik"

const TYPES = {
  schema: "workspace.types/v1" as const,
  types: {
    root: { parents: [], max_per_tree: 1 },
    perso: { parents: ["root"], default_wall: "sealed" as const },
    company: { parents: ["root"], default_wall: "isolated" as const },
  },
}

export function declare(dir: string, id: string, type: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "WORKSPACE.md"),
    writeWorkspaceManifest({
      schema: "workspace/v2",
      id,
      version: "1.0.0",
      name: id,
      type,
      owner: { type: "org", id: "t", slug: "t" },
      storage: { inline: { provider: "local-fs", config: {} } },
      ...extra,
    } as never),
  )
}

function put(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
}

export interface FakeSession {
  cwd?: string
  operator?: string
  workspaceSlug?: string
}

/** Sessions the daemon knows, by id. `get` and `findByIdOrName` answer the same. */
export class FakeSessions {
  readonly byId = new Map<string, FakeSession>()
  get(id: string): FakeSession | undefined {
    return this.byId.get(id)
  }
  findByIdOrName(id: string): FakeSession | undefined {
    return this.byId.get(id)
  }
}

export interface CallerFixture {
  base: string
  user: { root: string; perso: string; persoJournal: string; notes: string }
  company: { root: string; agentik: string }
  free: string
  sessions: FakeSessions
  scopes: CallerScopes
  /** Resolve a caller the way the gateway does for `?callerSessionId=`. */
  caller(id: string | undefined): CallerScope
  cleanup(): void
}

/** Session ids the fixture registers. */
export const SESSION = {
  perso: "sess_perso",
  notes: "sess_notes",
  userRoot: "sess_user_root",
  agentik: "sess_agentik",
  free: "sess_free",
  ghost: "sess_ghost",
} as const

export function buildCallerFixture(): CallerFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "caller-scope-")))
  const user = join(base, "user")
  const company = join(base, "company")
  const free = join(base, "free")

  mkdirSync(user, { recursive: true })
  writeFileSync(join(user, "TYPES.md"), writeTypesManifest(TYPES))
  declare(user, USER_ROOT_ID, "root")
  declare(join(user, "perso"), PERSO_ID, "perso")
  declare(join(user, "notes"), NOTES_ID, "company")
  put(join(user, "root.txt"), "ROOT-ABOVE-THE-WALL")
  put(join(user, "perso", "diary.txt"), "PERSO-DIARY")
  put(join(user, "perso", "journal", "entry.txt"), "PERSO-JOURNAL")
  put(join(user, "perso", "apps", "diary", "data", "secret.json"), '{"secret":"PERSO-APP"}')
  put(join(user, "notes", "todo.txt"), "NOTES-TODO")
  put(join(user, "notes", "apps", "todo", "data", "todo.json"), '{"todo":"NOTES-APP"}')

  mkdirSync(company, { recursive: true })
  writeFileSync(join(company, "TYPES.md"), writeTypesManifest(TYPES))
  declare(company, COMPANY_ROOT_ID, "root")
  declare(join(company, "agentik"), AGENTIK_ID, "company")
  put(join(company, "agentik", "plan.txt"), "COMPANY-PLAN")
  put(join(company, "agentik", "apps", "crm", "data", "crm.json"), '{"crm":"COMPANY-APP"}')

  put(join(free, "free.txt"), "FREE")

  const sessions = new FakeSessions()
  sessions.byId.set(SESSION.perso, { cwd: join(user, "perso", "journal"), operator: "operator:jeremy" })
  sessions.byId.set(SESSION.notes, { cwd: join(user, "notes"), operator: "operator:jeremy" })
  sessions.byId.set(SESSION.userRoot, { cwd: user, operator: "operator:jeremy" })
  sessions.byId.set(SESSION.agentik, { cwd: join(company, "agentik") })
  sessions.byId.set(SESSION.free, { cwd: free })

  const scopes = new CallerScopes()
  return {
    base,
    user: { root: user, perso: join(user, "perso"), persoJournal: join(user, "perso", "journal"), notes: join(user, "notes") },
    company: { root: company, agentik: join(company, "agentik") },
    free,
    sessions,
    scopes,
    caller: (id) => scopes.resolve(id, sessions),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}
