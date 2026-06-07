/**
 * footprint-to-graph — pure mapper: FootprintRecord[] → GraphOp[].
 *
 * Does NOT touch a graph. It translates the captured footprint into the
 * idempotent op stream @agstudio/graph-social already knows how to merge,
 * via the host-injected GraphSinkPort. The subject (the captured person)
 * is one end of every edge, so we thread it through explicitly.
 */

import type {
  FootprintRecord,
  FootprintPerson,
} from "../model/footprint.js"
import type { GraphOp, GraphPerson, GraphSinkPort } from "../ports/graph-sink.port.js"

/** The captured person — the hub of the graph for this run. */
export interface GraphSubject {
  readonly platform: string
  readonly handle: string
  readonly name?: string | null
}

function toGraphPerson(p: FootprintPerson): GraphPerson {
  return {
    platform: p.platform,
    handle: p.handle,
    name: (p.name && p.name.trim()) || p.handle,
    headline: p.headline ?? null,
    location: p.location ?? null,
    bio: p.bio ?? null,
    profileUrl: p.profileUrl ?? null,
    followerCount: p.followerCount ?? null,
    verified: p.verified ?? null,
  }
}

function subjectPerson(subject: GraphSubject): GraphPerson {
  return {
    platform: subject.platform,
    handle: subject.handle,
    name: (subject.name && subject.name.trim()) || subject.handle,
  }
}

/**
 * Translate a buffered footprint into graph ops. Order matters only for
 * readability — every op is an idempotent merge, so replays are safe.
 */
export function footprintToGraphOps(
  records: readonly FootprintRecord[],
  subject: GraphSubject
): GraphOp[] {
  const ops: GraphOp[] = []
  const me = subjectPerson(subject)
  ops.push({ op: "person", person: me })

  for (const r of records) {
    switch (r.kind) {
      case "profile": {
        // The richer profile card supersedes the thin subject seed.
        ops.push({ op: "person", person: toGraphPerson(r) })
        break
      }
      case "post": {
        ops.push({
          op: "post",
          post: {
            platform: r.platform,
            urn: r.urn,
            text: r.text ?? null,
            url: r.url ?? null,
            numLikes: r.numLikes ?? null,
            numComments: r.numComments ?? null,
            authorHandle: r.authorHandle,
          },
        })
        break
      }
      case "engagement-given": {
        // The subject acted on someone else's post: subject becomes a
        // reactor/commenter on that target post.
        const actor: GraphPerson & { reactionType?: string | null; text?: string | null } = {
          ...me,
        }
        const targetAuthor = r.targetAuthor
        ops.push({
          op: "engagement",
          engagement: {
            platform: r.platform,
            post: {
              platform: r.target.platform,
              urn: r.target.urn,
              text: r.target.text ?? null,
              url: r.target.url ?? null,
              authorHandle: r.target.authorHandle,
            },
            reactors:
              r.action === "reply"
                ? undefined
                : [{ ...actor, reactionType: r.action === "repost" ? "REPOST" : "LIKE" }],
            comments:
              r.action === "reply"
                ? [{ ...actor, text: r.replyText ?? null }]
                : undefined,
          },
        })
        if (targetAuthor) ops.push({ op: "person", person: toGraphPerson(targetAuthor) })
        break
      }
      case "engagement-received": {
        // Someone acted on the subject's post.
        const them = toGraphPerson(r.actor)
        const isComment = r.action === "reply" || r.action === "comment"
        ops.push({
          op: "engagement",
          engagement: {
            platform: r.platform,
            post: { platform: r.platform, urn: r.postUrn, authorHandle: subject.handle },
            reactors: isComment ? undefined : [{ ...them, reactionType: r.action === "repost" ? "REPOST" : "LIKE" }],
            comments: isComment ? [{ ...them, text: r.text ?? null }] : undefined,
          },
        })
        break
      }
      case "connection": {
        const them = toGraphPerson(r.person)
        const [from, to] = r.direction === "following" ? [me, them] : [them, me]
        ops.push({ op: "edge", platform: r.platform, edge: r.edge, from, to })
        break
      }
    }
  }
  return ops
}

/** Apply ops through the sink, sequentially (merge ordering stays sane). */
export async function runGraphSink(
  ops: readonly GraphOp[],
  sink: GraphSinkPort
): Promise<{ applied: number; failed: number }> {
  let applied = 0
  let failed = 0
  for (const op of ops) {
    try {
      await sink.apply(op)
      applied++
    } catch {
      failed++
    }
  }
  return { applied, failed }
}
