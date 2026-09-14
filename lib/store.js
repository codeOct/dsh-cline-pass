/**
 * Runtime state for the Cline Pass provider.
 *
 * Two kinds of state exist, and they are deliberately kept apart:
 *
 * - **Configuration** — accounts, the account mode, the model list and the
 *   per-model pin — lives in the dsh settings document (the plugin's section),
 *   so it survives restarts, hot-reloads, and is editable from the web Models
 *   page. See `index.js`.
 * - **Observation** — pipeline detection, discovered upstream channels,
 *   per-channel availability verdicts, and request history — lives here, in
 *   memory. It is derived data that any probe can rebuild, so it is not written
 *   into the settings document: a settings write re-registers routes, and
 *   churning that on every observed request would be wasteful.
 *
 * @module dsh-cline-pass/store
 */

/** How many request-history rows are retained. */
export const DEFAULT_HISTORY_LIMIT = 100

/** One upstream availability verdict. */
function verdict(status, note, ms) {
  return { status, note: String(note ?? '').slice(0, 200), ms: Number(ms ?? 0), checkedAt: Date.now() }
}

/**
 * Create the observation store.
 * @param options - `{ historyLimit }`.
 */
export function createStore({ historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
  /** @type {Map<string, object>} model id -> discovered metadata */
  const models = new Map()
  /** @type {object[]} newest first */
  const history = []
  let catalog = { ids: [], sources: [], fetchedAt: 0 }

  return {
    /** Discovered metadata for one model (never undefined). */
    metaOf(model) {
      return models.get(model) ?? {}
    },
    /** Every model with discovered metadata. */
    allMeta() {
      return [...models.entries()].map(([id, meta]) => ({ id, ...meta }))
    },
    /**
     * Merge one discovery result into a model's metadata.
     * @param model - wire model id.
     * @param patch - fields to merge (arrays replace, `upstreamStatus` merges).
     */
    learn(model, patch) {
      const current = models.get(model) ?? {}
      const next = { ...current, ...patch }
      if (patch?.upstreamStatus !== undefined) {
        next.upstreamStatus = { ...(current.upstreamStatus ?? {}), ...patch.upstreamStatus }
      }
      if (next.upstreams !== undefined) {
        next.upstreams = [...new Set(next.upstreams.map(String).filter((name) => name.length > 0))].slice(0, 25)
      }
      models.set(model, next)
      return next
    },
    /**
     * Record one upstream's availability verdict, unless it is inconclusive.
     * Transient rate limits are recorded (the console labels them) but never
     * remove a channel from the list.
     */
    learnUpstream(model, upstream, status, note, ms) {
      if (upstream === undefined || upstream === null || upstream === '') return
      if (status === 'unknown') return
      const current = models.get(model) ?? {}
      models.set(model, {
        ...current,
        upstreamStatus: { ...(current.upstreamStatus ?? {}), [upstream]: verdict(status, note, ms) },
      })
    },
    /** Append one request-history row (newest first, bounded). */
    record(entry) {
      history.unshift({ ts: Date.now(), ...entry })
      if (history.length > historyLimit) history.length = historyLimit
    },
    /**
     * Read request history.
     * @param limit - maximum rows (defaults to the configured cap).
     * @param model - optional case-insensitive substring filter.
     */
    readHistory(limit = historyLimit, model = '') {
      const needle = String(model ?? '').trim().toLowerCase()
      return history
        .filter((entry) => needle === '' || String(entry.model ?? '').toLowerCase().includes(needle))
        .slice(0, Math.max(0, Math.min(limit, historyLimit)))
    },
    /** Total rows retained, before any filter. */
    historySize() {
      return history.length
    },
    /** The last cached official-catalog scan. */
    catalog() {
      return catalog
    },
    /** Replace the cached official-catalog scan. */
    setCatalog(next) {
      catalog = { ...next, fetchedAt: Date.now() }
      return catalog
    },
  }
}
