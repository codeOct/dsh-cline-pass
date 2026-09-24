/**
 * Regression coverage for the panel diagnostics' time limits.
 *
 * The fake fetch never answers. It only observes AbortSignal, so this test makes
 * no network request and proves that a stalled provider cannot consume the old
 * per-attempt timeout once per channel.
 */
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/store.js'
import { fetchOfficialModels } from '../lib/cline.js'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Structural equality for the small JSON-shaped values checked here. */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal === undefined || signal === null) {
      reject(new Error('the diagnostic request did not carry an AbortSignal'))
      return
    }
    if (signal.aborted === true) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
  })
}

const originalFetch = globalThis.fetch
const seenSignals = []
// AbortSignal.timeout() intentionally uses an unref'ed timer. Keep this isolated
// test process alive until the synthetic requests observe that timeout.
const keepAlive = setInterval(() => {}, 1_000)

try {
  globalThis.fetch = async (_url, init = {}) => {
    seenSignals.push(init.signal)
    return await waitForAbort(init.signal)
  }

  const probeStore = createStore({ historyLimit: 5 })
  const probeEngine = createEngine({
    resolveAccount: async () => ({ name: 'test', key: 'test', baseURL: 'https://example.invalid/api/v1' }),
    store: probeStore,
    // A normal chat remains patient; probe must choose the short diagnostic limit.
    attemptTimeoutMs: 500,
    probeTimeoutMs: 30,
    diagnosticTimeoutMs: 90,
  })
  const probeStarted = Date.now()
  const probe = await probeEngine.probe('cline-pass/latency-probe')
  const probeElapsed = Date.now() - probeStarted
  check('a stalled probe returns a structured failure', probe.ok === false && probe.error.length > 0, JSON.stringify(probe))
  check('probe uses its short diagnostic limit instead of the chat limit', probeElapsed < 250, `${probeElapsed}ms`)
  check('probe passes an abortable signal to fetch', seenSignals.length === 1 && seenSignals[0]?.aborted === true, String(seenSignals.length))

  seenSignals.length = 0
  const validationStore = createStore({ historyLimit: 5 })
  const model = 'cline-pass/latency-validate'
  const upstreams = Array.from({ length: 25 }, (_, index) => `channel-${index}`)
  validationStore.learn(model, { pipeline: 'planner', pinnable: true, upstreams })
  const validationEngine = createEngine({
    resolveAccount: async () => ({ name: 'test', key: 'test', baseURL: 'https://example.invalid/api/v1' }),
    store: validationStore,
    attemptTimeoutMs: 500,
    probeTimeoutMs: 100,
    diagnosticTimeoutMs: 140,
  })
  const validationStarted = Date.now()
  const validation = await validationEngine.validate(model)
  const validationElapsed = Date.now() - validationStarted
  check('a stalled validation reports its operation deadline', validation.timedOut === true, JSON.stringify(validation))
  check('a validation deadline stops before every channel batch is sent', validation.results.length < upstreams.length && seenSignals.length < upstreams.length, `${validation.results.length}/${upstreams.length}`)
  check('a stalled validation stays inside a small total budget', validationElapsed < 350, `${validationElapsed}ms`)

  // ── the probe must not pay for a harvest it does not need ─────────────────
  //
  // The primary probe reply carries `fallbacksAvailable`, the gateway's whole
  // channel pool, and costs nothing extra. The `__probe__` harvest is a second
  // round trip whose parser returns null on this gateway, so when the reply has
  // already named several channels the harvest must not be issued at all.
  seenSignals.length = 0
  const harvestStore = createStore({ historyLimit: 5 })
  const requestedBodies = []
  globalThis.fetch = async (_url, init = {}) => {
    seenSignals.push(init.signal)
    const body = JSON.parse(String(init.body ?? '{}'))
    requestedBodies.push(body)
    const pinnedToImpossible = body?.providerOptions?.gateway?.only?.[0] === '__probe__' || body?.provider?.only?.[0] === '__probe__'
    if (pinnedToImpossible) {
      // The real gateway answers this with an uninformative body; a slow answer
      // here would be time the probe spends for nothing.
      return jsonResponse({ error: { message: 'empty response content' } }, { delayMs: 120 })
    }
    return jsonResponse({
      choices: [{
        message: {
          content: 'OK',
          provider_metadata: {
            gateway: {
              routing: {
                finalProvider: 'deepseek',
                canonicalSlug: 'deepseek/deepseek-v4.1-flash',
                fallbacksAvailable: ['deepseek', 'alibaba', 'baseten', 'fireworks'],
              },
            },
          },
        },
      }],
    })
  }
  /** A fetch stub response built the way `sendJSON` reads it: via `text()`. */
const jsonResponse = (payload, { delayMs = 0, status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => {
    if (delayMs > 0) await new Promise((resolve) => { const t = setTimeout(resolve, delayMs); t.unref?.() })
    return JSON.stringify(payload)
  },
})

  const harvestEngine = createEngine({
    resolveAccount: async () => ({ name: 'test', key: 'test', baseURL: 'https://example.invalid/api/v1' }),
    store: harvestStore,
    probeTimeoutMs: 200,
    diagnosticTimeoutMs: 500,
  })
  const harvestStarted = Date.now()
  const harvestProbe = await harvestEngine.probe('cline-pass/harvest-probe')
  const harvestElapsed = Date.now() - harvestStarted
  const harvestsIssued = requestedBodies.filter((body) => body?.providerOptions?.gateway?.only?.[0] === '__probe__' || body?.provider?.only?.[0] === '__probe__').length
  check('a probe whose reply lists the channels issues no harvest request', harvestsIssued === 0, `${harvestsIssued} harvest(s) of ${requestedBodies.length} request(s)`)
  check('the probe reports the channels the reply supplied', (harvestProbe.upstreams ?? []).length >= 4, JSON.stringify(harvestProbe.upstreams))
  check('the probe marks the fast path as unharvested', harvestProbe.harvested === false, JSON.stringify(harvestProbe.harvested))
  // The stub's harvest answers after 120ms; with the harvest skipped the probe is
  // the single primary call, so anything near that delay means a harvest ran.
  check('the fast-path probe does not wait for a harvest it skipped', harvestElapsed < 100, `${harvestElapsed}ms`)

  // A reply that discloses too little must still fall back to the harvest.
  seenSignals.length = 0
  requestedBodies.length = 0
  const sparseStore = createStore({ historyLimit: 5 })
  globalThis.fetch = async (_url, init = {}) => {
    seenSignals.push(init.signal)
    const body = JSON.parse(String(init.body ?? '{}'))
    requestedBodies.push(body)
    const pinnedToImpossible = body?.providerOptions?.gateway?.only?.[0] === '__probe__' || body?.provider?.only?.[0] === '__probe__'
    if (pinnedToImpossible) {
      return jsonResponse({ error: { message: 'Available providers are: recovered-a, recovered-b' } })
    }
    return jsonResponse({
      choices: [{
        message: {
          content: 'OK',
          provider_metadata: { gateway: { routing: { finalProvider: 'only-one', fallbacksAvailable: ['only-one'] } } },
        },
      }],
    })
  }
  const sparseEngine = createEngine({
    resolveAccount: async () => ({ name: 'test', key: 'test', baseURL: 'https://example.invalid/api/v1' }),
    store: sparseStore,
    probeTimeoutMs: 200,
    diagnosticTimeoutMs: 500,
  })
  const sparseProbe = await sparseEngine.probe('cline-pass/sparse-probe')
  const sparseHarvests = requestedBodies.filter((body) => body?.providerOptions?.gateway?.only?.[0] === '__probe__' || body?.provider?.only?.[0] === '__probe__').length
  check('a reply naming too few channels still triggers the harvest', sparseHarvests > 0, `${sparseHarvests} harvest(s)`)
  check('the harvest recovered the channels the reply withheld', (sparseProbe.upstreams ?? []).includes('recovered-a'), JSON.stringify(sparseProbe.upstreams))
  check('the recovered probe is marked as harvested', sparseProbe.harvested === true, JSON.stringify(sparseProbe.harvested))

  // ── the catalog scan must not wait on the 4.9 MB community document ───────
  //
  // The gateway's own list answers in well under a second; models.dev/api.json
  // is ~4.9 MB and has taken 18-87 s here. A refresh that waits for both spends
  // its time re-confirming a list the authoritative source already supplied.
  const slowCommunity = async (url, init = {}) => {
    if (String(url).includes('models.dev')) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1500)
        timer.unref?.()
        const signal = init.signal
        if (signal === undefined) return
        if (signal.aborted === true) { clearTimeout(timer); reject(signal.reason); return }
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      return { ok: true, json: async () => ({ providers: {} }), status: 200 }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ clinePass: ['cline-pass/fast-a', 'cline-pass/fast-b'] }),
    }
  }
  const catalogStarted = Date.now()
  const catalog = await fetchOfficialModels({ timeoutMs: 5000, fetchImpl: slowCommunity })
  const catalogElapsed = Date.now() - catalogStarted
  check('the catalog scan returns the authoritative list', same(catalog.models, ['cline-pass/fast-a', 'cline-pass/fast-b']), JSON.stringify(catalog))
  check('the catalog scan does not wait for the slow community source', catalogElapsed < 1000, `${catalogElapsed}ms`)
  check('the catalog scan reports the source that answered', same(catalog.sources, ['cline.api']), JSON.stringify(catalog.sources))

  // A caller that genuinely wants the union can still ask for it.
  const unionStarted = Date.now()
  const union = await fetchOfficialModels({ timeoutMs: 5000, community: 'await', fetchImpl: slowCommunity })
  check('the union form still waits for the community source when asked', Date.now() - unionStarted >= 1400, `${Date.now() - unionStarted}ms`)
  check('the union form still returns the authoritative list', same(union.models, ['cline-pass/fast-a', 'cline-pass/fast-b']), JSON.stringify(union))

  // With no authoritative answer the community source is the only one there is,
  // so it must be awaited instead of skipped.
  const communityOnly = async (url, init = {}) => {
    if (String(url).includes('models.dev')) {
      return { ok: true, status: 200, json: async () => ({ providers: { 'cline-pass': { models: { 'only-here': {} } } } }) }
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
  }
  const fallbackScan = await fetchOfficialModels({ timeoutMs: 2000, fetchImpl: communityOnly })
  check('the community source is awaited when the gateway gives nothing', same(fallbackScan.models, ['cline-pass/only-here']), JSON.stringify(fallbackScan))
} finally {
  clearInterval(keepAlive)
  globalThis.fetch = originalFetch
}

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} checks passed`)
