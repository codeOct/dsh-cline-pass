/**
 * Self-contained smoke test for dsh-cline-pass.
 *
 * A stub gateway speaks the Cline Pass wire protocol (OpenAI-compatible SSE
 * plus the planner/direct routing metadata), records every request body, and
 * can refuse specific pinned upstreams. Against it the test drives:
 *
 * - the pure protocol layer (pin injection, failover expansion, error parsing),
 * - the LLM adapter, asserting the exact harness chunk sequence,
 * - pre-first-token failover across pinned candidates,
 * - every registered tool, validating each returned value against that tool's
 *   own declared output schema.
 *
 * No network and no dsh process are involved. Run with: node test/smoke.mjs
 */

import { createServer } from 'node:http'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ClinePassAdapter, Config, apply, inject, name } from '../lib/index.js'
import {
  buildAttempts,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  parseRouting,
  parseTier0,
} from '../lib/protocol.js'
import { createStore } from '../lib/store.js'
import { MODEL_CATALOG, REASONING_EFFORTS, resolveModelMetadata } from '../lib/catalog.js'

// ── stub gateway ────────────────────────────────────────────────────────────

const PIPELINES = {
  'cline-pass/glm-5.2': { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] },
  'cline-pass/kimi-k3': { pipeline: 'direct', upstreams: ['gmicloud', 'novita'] },
}

const stub = {
  /** upstream slugs that refuse a strict pin */
  broken: [],
  /** every request body received, in order */
  requests: [],
  /** which content the next successful stream carries */
  stream: 'tool-call',
}

/** The pin a request carries, read back per pipeline. */
function readPin(body, pipeline) {
  if (pipeline === 'planner') {
    const gateway = body?.providerOptions?.gateway ?? {}
    return { only: gateway.only ?? null, order: gateway.order ?? null, sort: gateway.sort ?? null }
  }
  const provider = body?.provider ?? {}
  return { only: provider.only ?? null, order: provider.order ?? null, sort: provider.sort ?? null }
}

/** The upstream a request would reach under this pin. */
function effectiveUpstream(pin, fallback) {
  return pin.only?.[0] ?? pin.order?.[0] ?? fallback
}

/** A planner-style routing-layer rejection that names every usable upstream. */
function routingError(upstreams) {
  return {
    error: `invalid_request_error: No allowed providers available. Available providers are: ${upstreams.join(', ')}.`,
  }
}

/** The SSE frames of one successful stream. */
function streamFrames(upstream, pipeline, variant) {
  const routing = pipeline === 'planner'
    ? { provider_metadata: { gateway: { routing: { finalProvider: upstream, canonicalSlug: 'z-ai/glm-5.2', fallbacksAvailable: ['baseten'], planningReasoning: 'alibaba won tier 0 over baseten' } } } }
    : { provider: upstream, model: 'z-ai/glm-5.2' }
  const frames = []
  if (variant === 'tool-call') {
    frames.push({ choices: [{ index: 0, delta: { content: 'Hel' } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'lo' } }] })
    frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"a"' } }] } }] })
    frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else if (variant === 'reasoning') {
    frames.push({ choices: [{ index: 0, delta: { reasoning_content: 'Think' } }] })
    frames.push({ choices: [{ index: 0, delta: { reasoning_content: 'ing' } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'Done' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else if (variant === 'empty') {
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else {
    frames.push({ choices: [{ index: 0, delta: { content: 'OK' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  frames.push({ ...routing, choices: [] })
  frames.push({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } }, choices: [] })
  return frames
}

const gateway = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  stub.requests.push(body)
  const model = String(body?.model ?? '')
  const entry = PIPELINES[model] ?? { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] }
  const pin = readPin(body, entry.pipeline)

  // The harvest probe pins an impossible channel to make the router list reality.
  if (pin.only?.includes('__probe__')) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify(routingError(entry.upstreams)))
  }
  const upstream = effectiveUpstream(pin, entry.upstreams[0])
  if (stub.broken.includes(upstream)) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify({ error: `invalid_request_error: upstream ${upstream} refused the pin` }))
  }

  if (body?.stream !== true) {
    const routing = entry.pipeline === 'planner'
      ? { provider_metadata: { gateway: { routing: { finalProvider: upstream, canonicalSlug: 'z-ai/glm-5.2', fallbacksAvailable: ['baseten'], planningReasoning: 'alibaba won tier 0 over baseten' } } } }
      : { provider: upstream, model: 'z-ai/glm-5.2' }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify({
      ...routing,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }))
  }

  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const frame of streamFrames(upstream, entry.pipeline, stub.stream)) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  response.write('data: [DONE]\n\n')
  response.end()
})

await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${gateway.address().port}/api/v1`

// ── harness ─────────────────────────────────────────────────────────────────

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/** Collect every chunk one adapter stream yields. */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function adapterFor({ store, pin = () => ({}), records = [], learned = [] }) {
  return {
    adapter: new ClinePassAdapter({
      connection: () => ({
        baseURL,
        displayName: 'Cline Pass',
        models: Object.keys(PIPELINES).map((id) => ({ id, name: id })),
        defaultContextWindow: 128000,
        maxTokens: 32000,
        reasoningModels: true,
        streamIdleTimeoutMs: 30000,
      }),
      modelMeta: (model) => store.metaOf(model),
      pin,
      resolveAccount: async () => ({ name: 'default', key: 'sk_test', baseURL }),
      discoveredContext: () => undefined,
      record: (model, info) => records.push({ model, ...info }),
      learnUpstream: (model, upstream, status, note, ms) => learned.push({ model, upstream, status, note, ms }),
    }),
    records,
    learned,
  }
}

try {
  // ── protocol ──────────────────────────────────────────────────────────────

  check('plugin identity', name === 'cline-pass' && same(inject, ['llm', 'tools']))
  check('config schema compiles', typeof Config === 'object' || typeof Config === 'function')

  const plannerPin = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] }, { upstream: 'alibaba', strict: true, sort: 'cost' })
  check('strict pin on the planner pipeline uses providerOptions.gateway.only', same(plannerPin.providerOptions, { gateway: { only: ['alibaba'], sort: 'cost' } }), JSON.stringify(plannerPin))
  const directPin = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['gmicloud'] }, { upstream: 'gmicloud', strict: true, sort: 'ttft' })
  check('strict pin on the direct pipeline uses provider.only and OpenRouter sort names', same(directPin.provider, { only: ['gmicloud'], sort: 'latency' }), JSON.stringify(directPin))
  const unknownPin = injectPrefs({ model: 'm' }, { pipeline: null, upstreams: ['a'] }, { upstream: 'a', strict: true })
  check('an unknown pipeline gets both spellings', same(unknownPin.provider, { only: ['a'] }) && same(unknownPin.providerOptions, { gateway: { only: ['a'] } }), JSON.stringify(unknownPin))
  const preferred = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['a', 'b', 'c'] }, { upstream: 'a', strict: false, orderRest: ['b', 'c'], excludeList: ['c'] })
  check('preferred pin orders candidates and allow-lists the exclusions', same(preferred.providerOptions.gateway, { order: ['a', 'b', 'c'], only: ['a', 'b'] }), JSON.stringify(preferred))
  const autoExclude = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['a', 'b'] }, { upstream: null, excludeList: ['b'] })
  check('automatic routing turns excludes into an allow-list', same(autoExclude.providerOptions.gateway, { only: ['a'] }), JSON.stringify(autoExclude))
  check('no pin and no exclusion leaves the body untouched', same(injectPrefs({ model: 'm' }, {}, {}), { model: 'm' }))

  check('strict candidates expand in order', same(buildAttempts({ upstreams: ['a', 'b'], pinMode: 'strict' }).map((attempt) => attempt.upstream), ['a', 'b']))
  check('excluded candidates are dropped from the chain', same(buildAttempts({ upstreams: ['a', 'b'], exclude: ['a'] }).map((attempt) => attempt.upstream), ['b']))
  check('an empty pin is one automatic candidate', same(buildAttempts({ upstreams: [], exclude: ['a'] }), [{ strict: true, sort: null, excludeList: ['a'], upstream: null, orderRest: [] }]))
  check('preferred candidates carry the rest as fallback order', same(buildAttempts({ upstreams: ['a', 'b'], pinMode: 'preferred' })[0].orderRest, ['b']))

  check('routing is read from planner metadata', parseRouting({ provider_metadata: { gateway: { routing: { finalProvider: 'alibaba', canonicalSlug: 'z-ai/glm-5.2' } } } }).pipeline === 'planner')
  check('routing is read from a direct provider field', parseRouting({ provider: 'GMICloud', model: 'z-ai/glm-5.2', choices: [{ message: { content: 'hi' } }] }).pipeline === 'direct')
  check('an enveloped answer is unwrapped', parseRouting({ data: { provider: 'GMICloud', choices: [{ message: { content: 'hi' } }] } }).finalProvider === 'gmicloud')
  check('classify: rate limit', classifyUpstreamError('429 Too Many Requests') === 'limited')
  check('classify: not pinnable', classifyUpstreamError('invalid_request_error: no allowed providers') === 'bad')
  check('classify: empty reasoning response still means the channel answered', classifyUpstreamError('empty response content') === 'ok')
  check('harvest reads the planner sentence', same(extractAvailableProviders('Available providers are: alibaba, baseten.', 'planner'), ['alibaba', 'baseten']))
  check('harvest ignores JSON fragments in the sentence', same(extractAvailableProviders('Available providers are: alibaba, ","type":"invalid_request_error".', 'planner'), ['alibaba']))
  check('harvest reads OpenRouter metadata', same(extractAvailableProviders('nope {"error":{"metadata":{"available_providers":["gmicloud"]}}}', 'direct'), ['gmicloud']))
  check('tier-0 parsing', same(parseTier0('alibaba won tier 0 over baseten and novita'), ['alibaba', 'baseten', 'novita']))
  check('upstream merge keeps order and drops duplicates', same(mergeUpstreams(['b', 'a'], ['a', 'c']), ['b', 'a', 'c']))

  // ── adapter stream ────────────────────────────────────────────────────────

  const store = createStore({ historyLimit: 10 })
  store.learn('cline-pass/glm-5.2', { pipeline: 'planner', upstreams: ['alibaba', 'baseten'], pinnable: true })

  const plain = adapterFor({ store })
  const chunks = await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    system: 'be brief',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    signal: new AbortController().signal,
  })
  const types = chunks.map((chunk) => chunk.type)
  check('a text stream opens a block, emits deltas, and closes it', same(types.slice(0, 3), ['block-start', 'text-delta', 'text-delta']), types.join(','))
  check('the text block closes with the accumulated text', same(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')?.block, { type: 'text', text: 'Hello' }), JSON.stringify(chunks.filter((chunk) => chunk.type === 'block-end')))
  check('the tool call opens its own block', chunks.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call'))
  check('tool arguments accumulate across deltas', same(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block, { type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"a":1}' }), JSON.stringify(chunks.filter((chunk) => chunk.type === 'block-end')))
  check('usage subtracts cached tokens from the input count', same(chunks.find((chunk) => chunk.type === 'usage')?.usage, { inputTokens: 8, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2 }), JSON.stringify(chunks.find((chunk) => chunk.type === 'usage')))
  check('finish reports the tool-call reason', same(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } }), JSON.stringify(chunks.at(-1)))
  check('the finish chunk is last', types.at(-1) === 'finish')
  check('history recorded the serving upstream', plain.records.length === 1 && plain.records[0].provider === 'alibaba', JSON.stringify(plain.records))
  check('the request carried the pinned model and stream flag', stub.requests.at(-1).model === 'cline-pass/glm-5.2' && stub.requests.at(-1).stream === true)
  check('the system prompt and tool schema reached the wire', stub.requests.at(-1).messages[0].role === 'system' && stub.requests.at(-1).tools[0].function.name === 'echo')

  stub.stream = 'reasoning'
  const reasoning = await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  check('reasoning deltas open a reasoning block', reasoning.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning'))
  check('reasoning text is accumulated', reasoning.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')?.block.text === 'Thinking')
  check('a plain completion finishes with stop', same(reasoning.at(-1).reason, { kind: 'stop' }))

  stub.stream = 'empty'
  const empty = await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  check('an empty completion is an EMPTY_RESPONSE error finish', empty.at(-1).reason.kind === 'error' && empty.at(-1).reason.failure.code === 'EMPTY_RESPONSE', JSON.stringify(empty.at(-1)))
  stub.stream = 'tool-call'

  // ── failover ──────────────────────────────────────────────────────────────

  stub.broken = ['baseten']
  const before = stub.requests.length
  const failover = adapterFor({ store, pin: () => ({ upstreams: ['baseten', 'alibaba'], pinMode: 'strict', sort: '', exclude: [] }) })
  const served = await collect(failover.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  const attempts = stub.requests.slice(before)
  check('a refused first candidate fails over to the next', attempts.length === 2 && same(attempts[0].providerOptions.gateway.only, ['baseten']) && same(attempts[1].providerOptions.gateway.only, ['alibaba']), JSON.stringify(attempts.map((body) => body.providerOptions)))
  check('the failover stream still delivers content', served.some((chunk) => chunk.type === 'text-delta'))
  check('the recorded trace lists both attempts', same(failover.records[0]?.attempts, ['baseten', 'alibaba']), JSON.stringify(failover.records))
  check('the refused channel was learned as not-pinnable', failover.learned.some((entry) => entry.upstream === 'baseten' && entry.status === 'bad'), JSON.stringify(failover.learned))

  stub.broken = ['baseten', 'alibaba']
  const exhausted = adapterFor({ store, pin: () => ({ upstreams: ['baseten', 'alibaba'], pinMode: 'strict', sort: '', exclude: [] }) })
  let exhaustedError = ''
  try {
    await collect(exhausted.adapter, {
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: new AbortController().signal,
    })
  } catch (error) {
    exhaustedError = String(error?.message ?? error)
  }
  check('every candidate failing raises one clear error', /refused the pin/.test(exhaustedError), exhaustedError)
  check('the failed call is recorded with its whole trace', exhausted.records.length === 1 && same(exhausted.records[0].attempts, ['baseten', 'alibaba']), JSON.stringify(exhausted.records))
  stub.broken = []

  // ── tools through the plugin ──────────────────────────────────────────────

  const tools = new Map()
  const credentials = new Map([['CLINE_PASS_API_KEY', 'sk_live_test_key_123456']])
  let section = {
    provider: 'cline-pass',
    displayName: 'Cline Pass',
    baseURL,
    apiKeyEnv: 'CLINE_PASS_API_KEY',
    accounts: {},
    accountMode: 'single',
    activeAccount: '',
    knownModels: Object.keys(PIPELINES),
    perModel: {},
    defaultContextWindow: 128000,
    defaultMaxTokens: 32000,
    streamIdleTimeoutMs: 30000,
    exposeCatalog: false,
    historyLimit: 20,
  }
  const settingsService = {
    installSection(_owner, _ns, _schema, entry, hooks) {
      hooks.setSource(() => section)
      void entry
    },
    async update(_ns, patch) {
      section = { ...section, ...patch }
    },
  }
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: settingsService,
    credentials: {
      async resolve(ref) {
        const value = credentials.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' }
      },
      async set(ref, value) {
        credentials.set(String(ref), value)
      },
    },
    get(serviceName) {
      return this[serviceName]
    },
    inject(names, callback) {
      if (names.includes('settings')) callback(this)
      if (names.includes('credentials')) callback(this)
    },
    llm: {
      registered: null,
      registerAdapter(routes, adapter) {
        this.registered = { routes, adapter }
        return Object.assign(() => {}, { replace() {} })
      },
      registerConfigurableProviders(entries) {
        this.directory = entries
        return Object.assign(() => {}, { replace() {} })
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  apply(fakeCtx, { ...section })
  await new Promise((resolve) => setTimeout(resolve, 10))

  check('the provider route is registered', same(fakeCtx.llm.registered?.routes, ['cline-pass']))
  check('the configurable-provider directory entry is registered', fakeCtx.llm.directory?.[0]?.provider === 'cline-pass' && fakeCtx.llm.directory[0].settingsNs === 'cline-pass')
  const expectedTools = ['cline_pass_status', 'cline_pass_models', 'cline_pass_probe', 'cline_pass_validate', 'cline_pass_test', 'cline_pass_pin', 'cline_pass_accounts', 'cline_pass_history']
  check('every tool is registered', expectedTools.every((toolName) => tools.has(toolName)), [...tools.keys()].join(','))
  check('no extra tools', tools.size === expectedTools.length, [...tools.keys()].join(','))

  async function call(toolName, args = {}) {
    const tool = tools.get(toolName)
    if (tool === undefined) throw new Error(`tool ${toolName} is not registered`)
    const value = await tool.execute(args, { signal: new AbortController().signal })
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'output')
    check(`${toolName} output matches its schema`, violations.length === 0, violations.join('; '))
    const blocks = tool.output.render(args, value)
    check(`${toolName} renders`, Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].text === 'string')
    return value
  }

  const status = await call('cline_pass_status')
  check('status sees the implicit default account and its key', status.accounts.length === 1 && status.accounts[0].keyConfigured === true, JSON.stringify(status.accounts))
  check('status masks the key', status.accounts[0].keyHint === 'sk_liv…3456', status.accounts[0].keyHint)
  check('status never echoes the key', !JSON.stringify(status).includes('sk_live_test_key_123456'))
  check('status reports the registered route and live settings', status.routeRegistered === true && status.settingsAvailable === true)
  check('status counts the model catalog', status.knownModels === 2, String(status.knownModels))

  const models = await call('cline_pass_models')
  check('models lists the configured catalog', models.models.length === 2, String(models.models.length))
  check('models starts unprobed', models.models.every((model) => model.pipeline === '' ))

  const probed = await call('cline_pass_probe', { model: 'cline-pass/glm-5.2' })
  check('probe detects the pipeline', probed.ok === true && probed.pipeline === 'planner', JSON.stringify(probed))
  check('probe harvests the channel list', same(probed.upstreams, ['alibaba', 'baseten']), JSON.stringify(probed.upstreams))
  check('probe adopted the tier-0 hint', same(probed.tier0, ['alibaba', 'baseten']), JSON.stringify(probed.tier0))

  const afterProbe = await call('cline_pass_models', { model: 'glm-5.2' })
  check('models reports the probed pipeline', afterProbe.models[0].pipeline === 'planner' && afterProbe.models[0].pinnable === true, JSON.stringify(afterProbe.models[0]))
  check('a substring filter still matches one model', afterProbe.models.length === 1)

  const validated = await call('cline_pass_validate', { model: 'cline-pass/glm-5.2' })
  check('validate tests every channel', validated.ok === true && validated.results.length === 2 && validated.summary.ok === 2, JSON.stringify(validated.summary))

  const tested = await call('cline_pass_test', { model: 'cline-pass/glm-5.2', upstreams: ['alibaba'] })
  check('test reports the serving upstream', tested.ok === true && tested.actual === 'alibaba', JSON.stringify(tested))
  check('test reports a single attempt', tested.trace.length === 1, JSON.stringify(tested.trace))

  const pinned = await call('cline_pass_pin', { model: 'cline-pass/glm-5.2', upstreams: ['baseten', 'alibaba'], pinMode: 'preferred', sort: 'cost' })
  check('pin persists into the settings section', same(section.perModel['cline-pass/glm-5.2'], { upstreams: ['baseten', 'alibaba'], exclude: [], pinMode: 'preferred', sort: 'cost' }), JSON.stringify(section.perModel))
  check('pin reports what it stored', pinned.pinned.join() === 'baseten,alibaba' && pinned.sort === 'cost', JSON.stringify(pinned))
  const repinned = await call('cline_pass_pin', { model: 'cline-pass/glm-5.2', exclude: ['baseten'] })
  check('pin keeps fields it was not given', repinned.pinned.join() === 'baseten,alibaba' && repinned.excluded.join() === 'baseten', JSON.stringify(repinned))
  const cleared = await call('cline_pass_pin', { model: 'cline-pass/glm-5.2', upstreams: [], exclude: [], sort: 'none' })
  check('pin can clear back to automatic', cleared.pinned.length === 0 && cleared.excluded.length === 0 && cleared.sort === '')

  const added = await call('cline_pass_accounts', { action: 'add', name: 'backup', key: 'sk_backup_account_9876' })
  check('add registers the account', added.accounts.length === 2 && added.accounts.some((account) => account.key === 'backup'), JSON.stringify(added.accounts))
  check('add stores the key in the credential store', credentials.get('CLINE_PASS_BACKUP_KEY') === 'sk_backup_account_9876', String(credentials.get('CLINE_PASS_BACKUP_KEY')))
  check('the stored key is reported as configured', added.accounts.find((account) => account.key === 'backup').keyConfigured === true)
  const mode = await call('cline_pass_accounts', { action: 'mode', mode: 'roundrobin' })
  check('mode switches the pool to round-robin', mode.accountMode === 'roundrobin' && section.accountMode === 'roundrobin')
  const tested2 = await call('cline_pass_accounts', { action: 'test', name: 'backup' })
  check('account test authorizes a working key', tested2.note.includes('authorized'), tested2.note)
  const removed = await call('cline_pass_accounts', { action: 'remove', name: 'backup' })
  check('remove drops the account', removed.accounts.length === 1 && section.accounts.backup === undefined)
  let removeMissing = ''
  try {
    await call('cline_pass_accounts', { action: 'remove', name: 'nope' })
  } catch (error) {
    removeMissing = String(error.message)
  }
  check('removing an unknown account fails loudly', /no account named/.test(removeMissing), removeMissing)

  const history = await call('cline_pass_history', { limit: 5 })
  check('history records the probe, validate and test calls', history.total > 0, String(history.total))
  check('history rows carry the model and latency', history.entries.every((entry) => entry.model !== '' && Number.isSafeInteger(entry.ms)))

  // ── model metadata on the seam ────────────────────────────────────────────
  const resolved = await plain.adapter.resolveModel('cline-pass', 'cline-pass/deepseek-v4.1-flash')
  check('published context window is advertised, not the route default', resolved.context.contextWindow === 1000000, String(resolved.context.contextWindow))
  check('published output cap is advertised', resolved.defaultMaxTokens === 384000, String(resolved.defaultMaxTokens))
  check('the model name is its display name', resolved.name === 'DeepSeek V4.1 Flash', resolved.name)
  check('reasoning capability is advertised', resolved.reasoning !== undefined && resolved.reasoning.efforts.length > 0)
  const effortIds = resolved.reasoning.efforts.map((effort) => effort.id)
  check('every gateway-accepted effort is offered', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].every((id) => effortIds.includes(id)), effortIds.join(','))
  check('"off" is never offered — the gateway rejects it with HTTP 400', !effortIds.includes('off'), effortIds.join(','))
  check('no effort is forced when the caller omits one', resolved.reasoning.defaultEffort === undefined, String(resolved.reasoning.defaultEffort))
  const unknown = await plain.adapter.resolveModel('cline-pass', 'cline-pass/not-in-catalog')
  check('an unknown model falls back to the route-wide window', unknown.context.contextWindow === 128000, String(unknown.context.contextWindow))
  check('an unknown model still advertises the effort list', unknown.reasoning?.efforts.length === 7, String(unknown.reasoning?.efforts.length))
  // The config schema defaults an absent `input` to [], which must read as
  // "not set" — otherwise every model would advertise zero modalities.
  check('published modalities survive an empty config default', JSON.stringify(resolved.inputModalities) === JSON.stringify(['text', 'image']), JSON.stringify(resolved.inputModalities))
  check('an unknown model still advertises text', JSON.stringify(unknown.inputModalities) === JSON.stringify(['text']), JSON.stringify(unknown.inputModalities))

  // The seam validates every descriptor an adapter returns; a rejected one
  // would surface as INVALID_MODEL_INFO / INVALID_MODEL_REASONING at runtime.
  const seenEfforts = new Set()
  let metadataValid = true
  for (const id of Object.keys(PIPELINES)) {
    for (const model of [id, 'cline-pass/deepseek-v4.1-flash']) {
      const info = await plain.adapter.resolveModel('cline-pass', model)
      const okShape = info.provider === 'cline-pass' && info.id === model && typeof info.name === 'string' && info.name.length > 0
      // Uniqueness is required within one descriptor, so the set resets per model.
      seenEfforts.clear()
      const okEfforts = info.reasoning === undefined || (info.reasoning.efforts.length > 0 && info.reasoning.efforts.every((effort) => {
        const unique = !seenEfforts.has(effort.id)
        seenEfforts.add(effort.id)
        return typeof effort.id === 'string' && effort.id.length > 0 && typeof effort.name === 'string' && effort.name.length > 0 && unique
      }))
      if (!okShape || !okEfforts || !Number.isInteger(info.context.contextWindow) || info.context.contextWindow <= 0) metadataValid = false
    }
  }
  check('every descriptor satisfies the seam metadata contract', metadataValid)

  // ── the published catalog is internally consistent ────────────────────────
  // A single bad entry would make one model unusable, so every entry is run
  // through the same resolver the adapter uses, with the config schema's own
  // empty-value defaults standing in for "not configured".
  const emptyOverride = { name: '', contextWindow: 0, maxTokens: 0, input: [], reasoning: undefined }
  const fallback = { contextWindow: 128000, maxTokens: 32000, reasoning: true }
  const catalogProblems = []
  for (const id of Object.keys(MODEL_CATALOG)) {
    const entry = resolveModelMetadata('cline-pass', id, emptyOverride, fallback)
    if (entry.provider !== 'cline-pass' || entry.id !== id) catalogProblems.push(`${id}: identity`)
    if (!Number.isInteger(entry.context.contextWindow) || entry.context.contextWindow <= 0) catalogProblems.push(`${id}: context`)
    if (!Number.isSafeInteger(entry.defaultMaxTokens) || entry.defaultMaxTokens <= 0) catalogProblems.push(`${id}: maxTokens`)
    if (entry.name.length === 0) catalogProblems.push(`${id}: name`)
    // The seam only knows text and image; a catalog listing more (models.dev
    // reports audio for mimo-v2.5) must be clamped, not passed through.
    if (!entry.inputModalities.every((modality) => modality === 'text' || modality === 'image')) catalogProblems.push(`${id}: modality ${entry.inputModalities.join('+')}`)
    if (entry.inputModalities.length === 0) catalogProblems.push(`${id}: no modality`)
    const expectedEfforts = MODEL_CATALOG[id].reasoning === true
    if (expectedEfforts && entry.reasoning?.efforts.length !== 7) catalogProblems.push(`${id}: efforts`)
    if (!expectedEfforts && entry.reasoning !== undefined) catalogProblems.push(`${id}: unexpected efforts`)
  }
  check(`all ${Object.keys(MODEL_CATALOG).length} catalog entries resolve to valid seam metadata`, catalogProblems.length === 0, catalogProblems.join(', '))
  check('the effort list matches the gateway vocabulary exactly', REASONING_EFFORTS.map((effort) => effort.id).join(',') === 'none,minimal,low,medium,high,xhigh,max', REASONING_EFFORTS.map((effort) => effort.id).join(','))
  check('an explicit per-model effort override hides the picker', resolveModelMetadata('cline-pass', 'cline-pass/deepseek-v4.1-flash', { reasoning: false }, fallback).reasoning === undefined)

  // ── reasoning effort reaches the wire ─────────────────────────────────────
  stub.requests.length = 0
  await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: 'max',
  })
  check('the selected reasoning effort is sent as reasoning_effort', stub.requests.at(-1)?.reasoning_effort === 'max', String(stub.requests.at(-1)?.reasoning_effort))
  stub.requests.length = 0
  await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  check('an omitted effort sends no reasoning_effort field', stub.requests.at(-1)?.reasoning_effort === undefined, String(stub.requests.at(-1)?.reasoning_effort))

  let rejected = false
  try {
    await tools.get('cline_pass_pin').execute({}, { signal: new AbortController().signal })
  } catch (error) {
    rejected = error?.name === 'ToolArgsError'
  }
  check('missing required arguments are rejected before execution', rejected)
} catch (error) {
  failures.push(`unexpected failure — ${error?.stack ?? error}`)
}

gateway.close()

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} checks passed`)
