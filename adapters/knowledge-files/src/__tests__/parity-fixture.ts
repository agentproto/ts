/**
 * Shared parity fixture: a small corpus and the hits the pre-E97 engine (text
 * kept in the index) returned on it, captured on main. Both the in-memory and
 * the on-disk engine must reproduce them exactly.
 */

/** Corpus with frontmatter, repeated terms, a score tie, a doc whose only
 *  match sits in the frontmatter, a non-ASCII body, and a long body so the
 *  snippet window has to move. */
export const CORPUS: Record<string, string> = {
  "alpha.md":
    "---\ntitle: Alpha notes\nslug: alpha\n---\nThe brain index keeps postings for every session. Index index index.",
  "beta.md":
    "---\ntitle: Beta\nsessionId: sess-beta\n---\nA session about the daemon heap and the brain query route.",
  "gamma.md": "No frontmatter here: daemon daemon heap growth after a federated query.",
  "tie-1.md": "tie breaker words",
  "tie-2.md": "tie breaker words",
  "front-only.md": "---\ntitle: zebra\nslug: front\n---\nnothing that matches the body",
  "unicode.md": "Résumé \u2014 café heap naïve query déjà vu daemon",
  "long.md": `${"filler words go here ".repeat(40)}the needle sits deep inside ${"more filler text ".repeat(40)}`,
  "nested/deep.txt": "nested session heap index text",
}

export interface ParityCase {
  readonly query: string
  readonly topK?: number
  readonly minScore?: number
  readonly hits: ReadonlyArray<Record<string, unknown>>
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    "query": "heap",
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.2324833175475982,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "daemon heap",
    "hits": [
      {
        "sourceId": "knowledge/gamma.md",
        "score": 3.1902093262880395,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 2.9077812293590535,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 2.8528662655963855,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "index index",
    "hits": [
      {
        "sourceId": "knowledge/alpha.md",
        "score": 5.962169024273949,
        "text": "\nThe brain index keeps postings for every session. Index index index.",
        "span": {
          "start": 38,
          "end": 107
        },
        "metadata": {
          "title": "Alpha notes",
          "slug": "alpha",
          "entrySlug": "alpha"
        }
      },
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 4.5364649879454655,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "tie breaker",
    "hits": [
      {
        "sourceId": "knowledge/tie-1.md",
        "score": 4.725679027092521,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/tie-2.md",
        "score": 4.725679027092521,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "zebra",
    "hits": []
  },
  {
    "query": "needle",
    "hits": [
      {
        "sourceId": "knowledge/long.md",
        "score": 0.4713430024374004,
        "text": "iller words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here the needle sits deep inside more filler text more filler text more filler text more filler text more filler text more filler text more filler text more fi",
        "span": {
          "start": 694,
          "end": 994
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "session",
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.7177020425559189,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.651573779510753,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/alpha.md",
        "score": 1.5903483899728255,
        "text": "\nThe brain index keeps postings for every session. Index index index.",
        "span": {
          "start": 38,
          "end": 107
        },
        "metadata": {
          "title": "Alpha notes",
          "slug": "alpha",
          "entrySlug": "alpha"
        }
      }
    ]
  },
  {
    "query": "café heap",
    "hits": [
      {
        "sourceId": "knowledge/unicode.md",
        "score": 4.160656388180504,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "query",
    "topK": 3,
    "hits": [
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.651573779510753,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.620382948048787,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.5903483899728255,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "heap",
    "minScore": 1,
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.2324833175475982,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "heap",
    "minScore": -1,
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.2324833175475982,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/alpha.md",
        "score": 0,
        "text": "\nThe brain index keeps postings for every session. Index index index.",
        "span": {
          "start": 38,
          "end": 107
        },
        "metadata": {
          "title": "Alpha notes",
          "slug": "alpha",
          "entrySlug": "alpha"
        }
      },
      {
        "sourceId": "knowledge/front-only.md",
        "score": 0,
        "text": "\nnothing that matches the body",
        "span": {
          "start": 32,
          "end": 62
        },
        "metadata": {
          "title": "zebra",
          "slug": "front",
          "entrySlug": "front"
        }
      },
      {
        "sourceId": "knowledge/long.md",
        "score": 0,
        "text": "filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler",
        "span": {
          "start": 0,
          "end": 300
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/tie-1.md",
        "score": 0,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/tie-2.md",
        "score": 0,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "words",
    "topK": 1,
    "hits": [
      {
        "sourceId": "knowledge/long.md",
        "score": 2.1397730748651056,
        "text": "filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler",
        "span": {
          "start": 0,
          "end": 300
        },
        "metadata": {}
      }
    ]
  }
]
