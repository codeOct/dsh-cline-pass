/**
 * The engine: account selection, pinned request chains with failover, probing,
 * validation, and request recording. It owns every network call, so the adapter
 * and the management tools apply identical pinning semantics.
 *
 * Failover contract: a candidate is abandoned only while nothing has been
 * delivered yet. A non-2xx, a transport failure, or an error payload before the
 * first content delta moves to the next candidate; once a chunk has been
 * produced the stream is the answer, and a later failure is reported as such.
 *
 * @module dsh-cline-pass/engine
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  chatCompletion,
  fetchGatewayCatalog,
  fetchOfficialModels,
  openChatStream,
  openRouterEndpoints,
} from './cline.js'
import {
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  errorText,
  extractAvailableProviders,
  injectPrefs,
  isAdherenceOk,
  mergeUpstreams,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  unwrapEnvelope,
} from './protocol.js'

/** How many upstreams are validated concurrently. */
const VALIDATE_CONCURRENCY = 5

/**
 * How many channels the primary response must name before the harvest is skipped.
 *
 * The probe has two sources for a model's channel list and they overlap almost
 * completely:
 *
 * - the primary call's own routing metadata (`fallbacksAvailable`), which costs
 *   nothing extra because the call is being made anyway, and
 * - the `__probe__` harvest, which costs a whole extra round trip.
 *
 * Measured against the live gateway, the harvest answers `empty response
 * content` and its parser returns `null` — every channel came from the primary
 * response, and the harvest was adding ~1.7-2.1 s to every probe for nothing.
 * It was written for a gateway that replied "Available providers are: …", which
 * this one no longer does.
 *
 * The harvest is still worth its round trip when the primary response names too
 * few channels to pin or exclude anything useful, so it is kept as a fallback
 * rather than removed. A single-channel answer is exactly the case where the
 * router did not disclose its pool and the trick can still recover it.
 */
const HARVEST_MIN_CHANNELS = 2

/** Combine an operation's own budget with an optional caller-owned deadline. */
function operationDeadline(budgetMs, deadlineMs) {
  const local = Number.isFinite(budgetMs) && budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY
  return Number.isFinite(deadlineMs) ? Math.min(local, deadlineMs) : local
}

/** Whether an operation-wide deadline has been reached. */
function deadlineExpired(deadlineMs) {
  return Number.isFinite(deadlineMs) && Date.now() >= deadlineMs
}

/** Limit one request to whatever time remains for its enclosing operation. */
function timeoutWithin(timeoutMs, deadlineMs) {
  if (deadlineExpired(deadlineMs)) return 0
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Number.isFinite(deadlineMs) ? Math.max(1, deadlineMs - Date.now()) : undefined
  }
  return Number.isFinite(deadlineMs)
    ? Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()))
    : timeoutMs
}

/**
 * Parse an SSE body into decoded JSON frames.
 * @param body - a web ReadableStream of UTF-8 bytes.
 * @returns every `data:` payload up to `[DONE]`.
 */
export async function* parseServerSentEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.length === 0 || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        yield '[DONE]'
        return
      }
      try {
        yield JSON.parse(payload)
      } catch { /* an unparseable frame carries nothing to deliver */ }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload === '[DONE]') {
      yield '[DONE]'
      return
    }
    if (payload.length > 0) {
      try {
        yield JSON.parse(payload)
      } catch { /* see above */ }
    }
  }
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * Create the engine.
 *
 * @param options.resolveAccount - async `() => { name, key, baseURL }`; called
 *   once per attempt, so round-robin pools rotate per attempt.
 * @param options.store - the observation store (probe results, history).
 * @param options.logger - optional Cordis logger.
 * @param options.attemptTimeoutMs - per-attempt budget for a chat request.
 * @param options.probeTimeoutMs - per-request budget for a diagnostic call.
 * @param options.diagnosticTimeoutMs - total budget for one diagnostic action.
 */
export function createEngine({
  resolveAccount,
  store,
  logger,
  attemptTimeoutMs = 180000,
  probeTimeoutMs = 15000,
  diagnosticTimeoutMs = 25000,
}) {
  /**
   * One pinned request, non-streaming.
   * @returns `{ status, ok, json, text, routing, attempt, account }`.
   */
  async function attemptChat(model, body, attempt, { signal, timeoutMs = attemptTimeoutMs } = {}) {
    const account = await resolveAccount()
    const meta = store.metaOf(model)
    const pinned = injectPrefs(body, meta, attempt)
    const started = Date.now()
    const result = await chatCompletion({
      baseURL: account.baseURL,
      apiKey: account.key,
      body: pinned,
      signal,
      timeoutMs,
    })
    const payload = unwrapEnvelope(result.json)
    const failed = result.ok !== true || (payload?.error !== undefined && payload?.choices === undefined)
    const routing = failed ? {} : parseRouting(payload)
    return {
      attempt,
      account,
      status: failed ? (payload?.error === undefined ? result.status : 502) : 200,
      ok: !failed,
      json: payload,
      text: result.text,
      ms: Date.now() - started,
      routing,
      // A 200 says the gateway answered. It does not say the pin was applied,
      // and the router drops an unusable `only` without complaining.
      adherence: failed ? null : pinAdherence(attempt, routing),
      warnings: pinWarnings(attempt, meta),
      error: failed ? (errorText(payload?.error) || result.text.slice(0, 400) || `HTTP ${result.status}`) : '',
    }
  }

  /**
   * Run one model's ordered candidate chain until an attempt is both answered
   * and served by the channel the pin asked for.
   *
   * This is the diagnostic path (`cline_pass_test`), so it keeps looking past a
   * candidate the router quietly ignored: the point of the call is to find out
   * whether the pin works, and "the gateway said yes to someone else" is a
   * failure to find out, not an answer.
   *
   * @returns `{ ok, result?, trace, error, warnings }` — `result` is the winner.
   */
  async function runChain(model, body, pinConfig, { signal, timeoutMs, budgetMs, deadlineMs } = {}) {
    const trace = []
    let last = null
    const deadline = operationDeadline(budgetMs, deadlineMs)
    for (const attempt of buildAttempts(pinConfig)) {
      if (deadlineExpired(deadline)) {
        return { ok: false, result: last, trace, error: 'diagnostic time limit reached', warnings: last?.warnings ?? [], timedOut: true }
      }
      const outcome = await attemptChat(model, body, attempt, { signal, timeoutMs: timeoutWithin(timeoutMs, deadline) })
      const honored = outcome.ok && isAdherenceOk(outcome.adherence)
      const note = !outcome.ok
        ? outcome.error
        : honored
          ? 'ok'
          : `pin not adopted: served by ${outcome.routing?.finalProvider ?? '(unknown)'}`
      trace.push({ upstream: attempt.upstream ?? '(auto)', status: outcome.status, ms: outcome.ms, note: note.slice(0, 160) })
      last = outcome
      if (honored) return { ok: true, result: outcome, trace, error: '', warnings: outcome.warnings, timedOut: false }
      if (!outcome.ok) {
        // A channel that refuses a strict pin is learned as unusable for it.
        if (attempt.upstream !== null && outcome.error !== '') store.learnUpstream(model, attempt.upstream, classifyUpstreamError(outcome.error), outcome.error, outcome.ms)
        if (attempt.upstream === null && (attempt.excludeList ?? []).length > 0 && outcome.error !== '') learnFromError(model, outcome.error)
      }
    }
    const error = last === null
      ? 'no candidate succeeded'
      : last.ok !== true
        ? last.error
        : last.adherence === 'violated'
          ? `an excluded channel served the request: ${last.routing?.finalProvider ?? '(unknown)'}`
          : `the gateway ignored the pin: served by ${last.routing?.finalProvider ?? '(unknown)'}`
    return { ok: false, result: last, trace, error, warnings: last?.warnings ?? [], timedOut: deadlineExpired(deadline) }
  }

  /** Merge a gateway error's own provider list into the model's channel list. */
  function learnFromError(model, message) {
    const match = /Available providers are:\s*([^.]+)/.exec(String(message ?? ''))
    if (match === null) return
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    if (tokens.length === 0) return
    const meta = store.metaOf(model)
    const current = Array.isArray(meta.upstreams) ? meta.upstreams : []
    // Comparing lengths used to stand in for "something new arrived", which is
    // false the moment the list is capped: a genuinely new channel replacing a
    // dropped one keeps the length identical and the learning was discarded.
    if (!tokens.some((token) => !current.includes(token))) return
    store.learn(model, { upstreams: mergeUpstreams(current, tokens) })
  }

  /**
   * Probe one model: detect its pipeline, read back the upstream it used, and
   * harvest the channel list each pipeline publishes. Costs two tiny requests.
   *
   * Every discovered channel is a hint about *one* router. Since a model can be
   * served from either pipeline and the two disagree about both the channel
   * names and the field that pins them, a single list is not enough to constrain
   * a request — it is what let an excluded channel through.
   */
  async function probe(model, { signal, timeoutMs = probeTimeoutMs, budgetMs = diagnosticTimeoutMs, deadlineMs } = {}) {
    const account = await resolveAccount()
    const started = Date.now()
    const deadline = operationDeadline(budgetMs, deadlineMs)
    const firstTimeout = timeoutWithin(timeoutMs, deadline)
    if (firstTimeout === 0) return { ok: false, ms: 0, model, error: 'diagnostic time limit reached', timedOut: true }
    let result
    try {
      result = await chatCompletion({
        baseURL: account.baseURL,
        apiKey: account.key,
        body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
        signal,
        timeoutMs: firstTimeout,
      })
    } catch (error) {
      const ms = Date.now() - started
      const message = errorText(error) || 'probe request failed'
      store.learn(model, { ok: false, lastError: message, lastMs: ms })
      return { ok: false, ms, model, error: message, timedOut: deadlineExpired(deadline) }
    }
    const payload = unwrapEnvelope(result.json)
    const ms = Date.now() - started
    if (payload?.error !== undefined && payload?.choices === undefined) {
      const message = errorText(payload.error)
      store.learn(model, { ok: false, lastError: message, lastMs: ms })
      return { ok: false, ms, model, error: message, timedOut: deadlineExpired(deadline) }
    }
    const routing = parseRouting(payload)
    const pipeline = routing.pipeline
    const otherPipeline = pipeline === 'planner' ? 'direct' : pipeline === 'direct' ? 'planner' : null
    // The primary response's own channel list: `fallbacksAvailable` names every
    // provider the router could have used, and it arrives with a call that was
    // already being made. When it is rich enough to build pins and excludes
    // from, the extra harvest round trip is skipped entirely (see
    // HARVEST_MIN_CHANNELS) — that is where the probe's second half second went.
    const disclosed = Array.isArray(routing.fallbacks) ? routing.fallbacks.filter((name) => String(name).length > 0) : []
    const needHarvest = disclosed.length < HARVEST_MIN_CHANNELS
    // Once the serving pipeline is known, the router harvests and optional public
    // metadata are independent. Running them together keeps one slow source from
    // adding its full timeout after every other source has already answered.
    const discoveryTimeout = timeoutWithin(timeoutMs, deadline)
    const discover = (work, fallback) => signal?.aborted === true || discoveryTimeout === 0 ? Promise.resolve(fallback) : work()
    const [harvested, otherHarvested, detail] = await Promise.all([
      pipeline === null || !needHarvest ? null : discover(() => harvest(model, pipeline, account, { signal, timeoutMs: discoveryTimeout }), null),
      otherPipeline === null || !needHarvest ? null : discover(() => harvest(model, otherPipeline, account, { signal, timeoutMs: discoveryTimeout }), null),
      pipeline === 'planner' || typeof routing.canonicalSlug !== 'string'
        ? { slug: null, endpoints: [] }
        : discover(() => openRouterEndpoints(routing.canonicalSlug, { signal, timeoutMs: discoveryTimeout, deadlineMs: deadline }), { slug: null, endpoints: [] }),
    ])
    const endpoints = detail?.endpoints ?? []
    const openrouterSlug = detail?.slug ?? null
    const previous = store.metaOf(model)
    const upstreamDetail = { ...(previous.upstreamDetail ?? {}) }
    for (const entry of endpoints) upstreamDetail[entry.slug] = entry
    const discovered = pipeline === 'planner'
      ? mergeUpstreams(harvested, routing.fallbacks)
      : mergeUpstreams(routing.fallbacks, harvested, Object.keys(upstreamDetail))
    // The channel that just served the probe is a real channel whether or not the
    // router's own list mentions it, and it is the highest-confidence entry there
    // is — so it goes first, where a list bound cannot reach it. It is also
    // translated into the pipeline's own vocabulary first: a direct answer names
    // the provider as it displays it (`Z.AI`), which is not the slug OpenRouter
    // accepts.
    const servedRaw = typeof routing.finalProvider === 'string' && routing.finalProvider.length > 0 ? routing.finalProvider : null
    const served = servedRaw === null ? [] : [pipeline === null ? servedRaw : channelNameFor(servedRaw, pipeline)]
    const combined = mergeUpstreams(served, discovered, otherHarvested)
    // A probe that discovered nothing must not wipe what an earlier one found:
    // `validate` refuses to run without a list, and every allow-list is built
    // from it, so losing it silently disarms exclusions instead of failing.
    const upstreams = combined.length > 0 ? combined : (Array.isArray(previous.upstreams) ? previous.upstreams : [])
    const channels = { ...(previous.channels ?? {}) }
    if (pipeline !== null) {
      // With the harvest skipped, `harvested` is null and the per-pipeline scope
      // has to be built from the pipeline's own vocabulary. The reply's channel
      // names arrive in the vocabulary of *whichever* router answered, and the
      // two disagree on some names (`zai` vs `z-ai`), so each is translated
      // before it becomes the allow-list an exclusion is compiled from.
      const scoped = mergeUpstreams(
        served,
        harvested ?? discovered.map((name) => channelNameFor(name, pipeline)),
      )
      if (scoped.length > 0) channels[pipeline] = scoped
    }
    if (otherPipeline !== null && Array.isArray(otherHarvested) && otherHarvested.length > 0) channels[otherPipeline] = otherHarvested
    const tier0 = [...new Set([...(previous.tier0 ?? []), ...parseTier0(routing.plan)])]
    const meta = store.learn(model, {
      ok: true,
      pipeline,
      pinnable: pipeline !== null,
      // The router's own published pool, in its own order. When the harvest was
      // skipped this is the primary response's fallback list — the same fact
      // from the call that had to happen anyway — rather than a stale reading.
      availableProviders: harvested ?? (needHarvest ? (previous.availableProviders ?? []) : routing.fallbacks),
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      openrouterSlug: openrouterSlug ?? previous.openrouterSlug ?? null,
      upstreamDetail,
      upstreams,
      channels,
      staleAt: combined.length === 0 && upstreams.length > 0 ? Date.now() : 0,
      tier0,
      // Whether this probe had to pay for the `__probe__` harvest, so the panel
      // and the tools can explain where the time went instead of leaving a
      // multi-second probe looking arbitrary.
      harvested: !needHarvest ? false : (harvested !== null || otherHarvested !== null),
      lastProvider: routing.finalProvider ?? previous.lastProvider ?? null,
      lastMs: ms,
      probedAt: Date.now(),
      lastError: '',
    })
    return {
      ok: true,
      ms,
      model,
      error: '',
      pipeline: meta.pipeline,
      pinnable: meta.pinnable === true,
      canonicalSlug: meta.canonicalSlug ?? '',
      lastProvider: meta.lastProvider ?? '',
      upstreams: meta.upstreams ?? [],
      availableProviders: meta.availableProviders ?? [],
      tier0: meta.tier0 ?? [],
      // False when the channel list came from the primary response alone, which
      // is the fast path; true when the extra harvest round trip was paid.
      harvested: meta.harvested === true,
      timedOut: deadlineExpired(deadline),
    }
  }

  /**
   * Harvest the exact channel list for one pipeline by pinning a channel that
   * cannot exist: the router fails before spending a token and names every
   * provider it could have used.
   */
  async function harvest(model, pipeline, account, { signal, timeoutMs = probeTimeoutMs } = {}) {
    const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
    const body = pipeline === 'planner'
      ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
      : { ...base, provider: { only: ['__probe__'] } }
    try {
      const result = await chatCompletion({ baseURL: account.baseURL, apiKey: account.key, body, signal, timeoutMs })
      const payload = unwrapEnvelope(result.json)
      const message = errorText(payload?.error) || result.text
      return extractAvailableProviders(message, pipeline)
    } catch {
      return null
    }
  }

  /**
   * Test every known channel of a model once and record the verdicts.
   *
   * A channel counts as usable only when the response names it as the one that
   * served the request. The previous rule — any payload carrying `choices` — is
   * what marked every channel available while the pin was being ignored, and
   * those verdicts then fed the exclusion allow-list, hiding the very leak they
   * were supposed to describe.
   *
   * @returns `{ results: [{ upstream, status, ms, note }], summary }`.
   */
  async function validate(model, { signal, timeoutMs = probeTimeoutMs, budgetMs = diagnosticTimeoutMs, deadlineMs } = {}) {
    const meta = store.metaOf(model)
    const list = Array.isArray(meta.upstreams) ? meta.upstreams : []
    const results = []
    const deadline = operationDeadline(budgetMs, deadlineMs)
    let timedOut = false
    for (let index = 0; index < list.length; index += VALIDATE_CONCURRENCY) {
      // Cancelling a run used to still send every remaining request, at real
      // cost, with nowhere for the answers to go.
      if (signal?.aborted === true) break
      if (deadlineExpired(deadline)) {
        timedOut = true
        break
      }
      const batch = list.slice(index, index + VALIDATE_CONCURRENCY)
      const requestTimeout = timeoutWithin(timeoutMs, deadline)
      const settled = await Promise.all(batch.map(async (upstream) => {
        const started = Date.now()
        const attempt = { upstream, strict: true, sort: null, orderRest: [], excludeList: [] }
        const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
        // The same injection the live path uses, so a verdict describes the pin
        // this plugin would really send rather than a hand-built body that can
        // drift away from it.
        const body = injectPrefs(base, meta, attempt)
        try {
          const account = await resolveAccount()
          const result = await chatCompletion({ baseURL: account.baseURL, apiKey: account.key, body, signal, timeoutMs: requestTimeout })
          const payload = unwrapEnvelope(result.json)
          const ms = Date.now() - started
          let status = 'unknown'
          let note = ''
          let actual = ''
          if (payload?.error !== undefined && payload?.choices === undefined) {
            note = errorText(payload.error)
            status = classifyUpstreamError(note)
          } else if (payload?.choices !== undefined) {
            const routing = parseRouting(payload)
            actual = String(routing.finalProvider ?? '')
            const adherence = pinAdherence(attempt, routing)
            if (isAdherenceOk(adherence)) {
              status = 'ok'
              if (adherence === 'fallback') note = `answered by ${routing.finalProvider ?? 'another channel'}`
            } else {
              status = 'not-adopted'
              note = `pin not adopted: served by ${routing.finalProvider ?? '(unknown)'}`
            }
          }
          return { upstream, status, ms, note: note.slice(0, 160), actual }
        } catch (error) {
          return { upstream, status: 'unknown', ms: Date.now() - started, note: errorText(error).slice(0, 160), actual: '' }
        }
      }))
      for (const result of settled) {
        store.learnUpstream(model, result.upstream, result.status, result.note, result.ms)
        results.push(result)
      }
    }
    const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 }
    for (const result of results) {
      // `not-adopted` has no summary column of its own: it means "not usable as
      // a pin", which is what `bad` already counts, and the exact verdict stays
      // on the row for anyone who needs the distinction.
      const bucket = result.status === 'not-adopted' ? 'bad' : result.status
      summary[bucket] = (summary[bucket] ?? 0) + 1
    }
    store.learn(model, { validatedAt: Date.now() })
    return { results, summary, cancelled: signal?.aborted === true, timedOut: timedOut || deadlineExpired(deadline) }
  }

  /**
   * Send one small chat through a (possibly temporary) pin configuration and
   * report what served it. Nothing is persisted.
   *
   * `ok` means a candidate was served by the channel the pin named. A gateway
   * that answers from somewhere else fails the call and says so, because a
   * `targets: [baseten]` next to `actual: deepseek` is the whole finding.
   */
  async function test(model, { upstreams, exclude, signal, timeoutMs = probeTimeoutMs, budgetMs = diagnosticTimeoutMs, deadlineMs } = {}) {
    const pin = currentPin(model, { upstreams, exclude })
    const started = Date.now()
    const outcome = await runChain(model, { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 }, pin, { signal, timeoutMs, budgetMs, deadlineMs })
    const ms = Date.now() - started
    const warnings = outcome.warnings ?? []
    const targets = pin.upstreams ?? []
    const excluded = pin.exclude ?? []
    const routing = outcome.result?.routing ?? {}
    const account = outcome.result?.account?.name ?? ''
    if (!outcome.ok) {
      record(model, { provider: routing.finalProvider ?? null, attempts: outcome.trace.map((row) => row.upstream), ms, stream: false, error: outcome.error, account: account === '' ? null : account })
      return {
        ok: false,
        ms,
        model,
        error: outcome.error,
        targets,
        excluded,
        trace: outcome.trace,
        actual: routing.finalProvider ?? '',
        actualName: routing.finalProviderName ?? '',
        pipeline: routing.pipeline ?? '',
        pinnable: routing.pipeline !== null && routing.pipeline !== undefined,
        canonicalSlug: routing.canonicalSlug ?? '',
        account,
        content: '',
        adopted: false,
        adherence: outcome.result?.adherence ?? '',
        warnings,
        timedOut: outcome.timedOut === true,
      }
    }
    record(model, { provider: routing.finalProvider, canonical: routing.canonicalSlug, attempts: outcome.trace.map((row) => row.upstream), ms, stream: false, error: null, account })
    return {
      ok: true,
      ms,
      model,
      error: '',
      targets,
      excluded,
      trace: outcome.trace,
      actual: routing.finalProvider ?? '',
      actualName: routing.finalProviderName ?? '',
      pipeline: routing.pipeline ?? '',
      pinnable: routing.pipeline !== null,
      canonicalSlug: routing.canonicalSlug ?? '',
      account,
      content: String(routing.content ?? '').slice(0, 120),
      adopted: outcome.result?.adherence === 'adopted',
      adherence: outcome.result?.adherence ?? '',
      // The router's own account of the decision — for a planner answer it reads
      // `Provider set restricted to: <provider>`, which is the confirmation a
      // pin was applied rather than merely not contradicted.
      plan: routing.plan ?? '',
      warnings,
      timedOut: outcome.timedOut === true,
    }
  }

  /**
   * Check one account key against the gateway with a single small request.
   *
   * A key that authenticates but whose model still errors (a reasoning model
   * burning `max_tokens` into an empty completion, for example) counts as
   * authorized: only a real authentication failure is reported as one.
   */
  async function testAccount({ key, baseURL, model, signal, timeoutMs = probeTimeoutMs }) {
    const started = Date.now()
    try {
      const result = await chatCompletion({
        baseURL,
        apiKey: key,
        body: { model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 },
        signal,
        timeoutMs,
      })
      const payload = unwrapEnvelope(result.json)
      const ms = Date.now() - started
      if (payload?.error !== undefined && payload?.choices === undefined) {
        const message = errorText(payload.error)
        const authFailed = /unauthorized|re-authenticate|invalid\s*api|401/i.test(message)
        return { ok: !authFailed, authorized: !authFailed, ms, model, error: message }
      }
      return { ok: true, authorized: true, ms, model, error: '' }
    } catch (error) {
      return { ok: false, authorized: false, ms: Date.now() - started, model, error: errorText(error) }
    }
  }

  /** Resolve a per-call pin override against the stored configuration. */
  function currentPin(model, override = {}) {
    const stored = pinOf(model)
    return {
      upstreams: Array.isArray(override.upstreams) ? override.upstreams.map(String) : stored.upstreams,
      exclude: Array.isArray(override.exclude) ? override.exclude.map(String) : stored.exclude,
      pinMode: stored.pinMode,
      sort: stored.sort,
      // Carried so a diagnostic call writes the same spellings a live call does.
      spelling: stored.spelling,
    }
  }

  /** The configured pin for one model, read through the plugin's live config. */
  let pinReader = () => ({ upstreams: [], exclude: [], pinMode: 'strict', sort: null })
  const pinOf = (model) => pinReader(model)

  /** Record one request in the observation store. */
  function record(model, info) {
    store.record({ model, ...info })
  }

  return {
    /** Replace the function that reads a model's configured pin. */
    setPinReader(reader) {
      pinReader = reader
    },
    /** Refresh the gateway's own catalog ids. */
    async gatewayCatalog(options = {}) {
      const account = await resolveAccount()
      return await fetchGatewayCatalog({ baseURL: account.baseURL, apiKey: account.key, ...options })
    },
    /** Refresh the official subscription model list. */
    async officialModels(options = {}) {
      return await fetchOfficialModels(options)
    },
    /** The resolved account for the next request (round-robin aware). */
    resolveAccount,
    attemptChat,
    runChain,
    probe,
    validate,
    test,
    testAccount,
    currentPin,
    record,
    learnFromError,
    chatCompletion,
    openChatStream,
    parseServerSentEvents,
    buildAttempts,
    injectPrefs,
  }
}
