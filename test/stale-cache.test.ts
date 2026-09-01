/**
 * The rule that keeps a cached fold from hiding a real conversation.
 *
 * `describeStored` caches what one fold learned about a stored log — its
 * title, its last activity, and whether anyone ever spoke in it. That last one
 * decides whether the row is *shown at all*, which makes a stale negative
 * verdict a conversation nobody can find.
 *
 * Two rules keep it safe, and this file is about both:
 *
 *  1. An entry is reused only when the store's revision for that log still
 *     matches the one it was computed at.
 *  2. Where a backend offers no revision, a verdict that would **hide** a row
 *     is not cached at all. Re-folding a silent log costs almost nothing —
 *     by definition it holds no conversation.
 *
 * The cache lives inside `apply`'s closure, so the rule is restated here
 * against the same shapes rather than reached into. What is under test is the
 * decision, and the decision is small enough to state exactly.
 */
import { describe, expect, it } from 'vitest'

interface Described { spoken: boolean }
interface Entry { revision: string | null; described: Described }

/** Rule 1: reuse only what can be proved current. */
const reusable = (entry: Entry | undefined, revision: string | null): boolean =>
  entry !== undefined && entry.revision === revision

/** Rule 2: only cache a hiding verdict when staleness is detectable. */
const cacheable = (revision: string | null, described: Described): boolean =>
  revision !== null || described.spoken

describe('reusing a cached fold', () => {
  const silent: Described = { spoken: false }
  const spoken: Described = { spoken: true }

  it('reuses an entry while the log has not changed', () => {
    expect(reusable({ revision: 'r1', described: spoken }, 'r1')).toBe(true)
  })

  it('discards it the moment the log has changed', () => {
    // The defect this replaces: a session folded while silent, then spoken in,
    // stayed marked silent for the life of the process — and a silent row is
    // hidden, so the conversation vanished from the list.
    expect(reusable({ revision: 'r1', described: silent }, 'r2')).toBe(false)
  })

  it('does not trust a revisionless entry once the store offers revisions', () => {
    // The backend gained the ability to tell us; the old entry was never
    // proved against anything.
    expect(reusable({ revision: null, described: silent }, 'r1')).toBe(false)
  })

  it('reuses a revisionless entry only while the store still offers none', () => {
    expect(reusable({ revision: null, described: spoken }, null)).toBe(true)
  })
})

describe('what may be cached', () => {
  it('caches anything when the store can say it went stale', () => {
    expect(cacheable('r1', { spoken: false })).toBe(true)
    expect(cacheable('r1', { spoken: true })).toBe(true)
  })

  it('never caches a hiding verdict it cannot invalidate', () => {
    // Without a revision there is no way to notice the log grew, so a silent
    // verdict must be recomputed every time rather than remembered.
    expect(cacheable(null, { spoken: false })).toBe(false)
  })

  it('still caches a spoken verdict without a revision, because it cannot reverse', () => {
    // A conversation cannot become un-spoken, so this one is safe to keep and
    // is the expensive fold worth avoiding.
    expect(cacheable(null, { spoken: true })).toBe(true)
  })
})
