/**
 * Mount the plugin on the STABLE DSH line, against that line's real packages.
 *
 * The alpha line is covered by `test/mount.mjs`. This one exists because the
 * two lines differ in ways that decide whether the plugin works at all:
 *
 * - stable pins `@deepseek-ai/schemastery@3.18.2`, whose `Schema` has NO
 *   `.volatile()`. Building the plugin's schema at module scope therefore threw
 *   `TypeError: z.object(...).volatile is not a function`, so the plugin could
 *   not even be imported — the route never registered.
 * - stable's settings service DOES expose `installSection`, and its
 *   `fiber.config` is a plain resolved object with no `.get()`; so `setSource`
 *   is the only channel a saved value can reach the plugin through.
 * - stable's loader (`1.0.3`) has no `loader/volatile-update` event at all.
 *
 * The assertions mirror the alpha mount test's intent: the route activates, a
 * settings write is observed by the running plugin, and the write reaches the
 * next outgoing request. Point `--stable-dir` at an installed
 * `@deepseek-ai/dsh@0.1.5-rc.3` tree (or set STABLE_DSH_DIR).
 *
 * Usage: node test/mount-stable.mjs [--stable-dir <path to node_modules/@deepseek-ai/dsh>]
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

const argIndex = process.argv.indexOf('--stable-dir')
const stableDir = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.STABLE_DSH_DIR
if (stableDir === undefined || stableDir === '') {
  console.error('✘ this test needs the stable installation: pass --stable-dir <.../@deepseek-ai/dsh> or set STABLE_DSH_DIR')
  process.exit(2)
}
if (!existsSync(stableDir)) {
  console.error(`✘ no stable installation at ${stableDir}`)
  process.exit(2)
}

const installAnchor = join(stableDir, 'package.json')
if (!existsSync(installAnchor)) {
  console.error(`✘ ${installAnchor} does not exist`)
  process.exit(2)
}
/**
 * Where the stable installation's sibling packages live.
 *
 * npm installs a flat tree, so `@deepseek-ai/schemastery` sits beside `dsh` in
 * the same `node_modules/@deepseek-ai` directory; a nested
 * `dsh/node_modules/@deepseek-ai` may not exist at all. Both layouts are tried
 * so the test works whether the tree came from npm or pnpm.
 */
const candidateScopes = [
  join(dirname(dirname(stableDir)), '@deepseek-ai'),
  join(stableDir, 'node_modules', '@deepseek-ai'),
]
const installScope = candidateScopes.find((scope) => existsSync(join(scope, 'schemastery')) && existsSync(join(scope, 'dsh-llm')))
if (installScope === undefined) {
  console.error(`✘ could not find the stable @deepseek-ai scope beside ${stableDir}; tried:\n  ${candidateScopes.join('\n  ')}`)
  process.exit(2)
}

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// The stable tree must be the one actually used, or the test proves nothing
// about stable: assert its own schemastery has no volatile support.
const stableSchemastery = join(installScope, 'schemastery')
const stableVersion = existsSync(join(stableSchemastery, 'package.json'))
  ? JSON.parse((await import('node:fs')).readFileSync(join(stableSchemastery, 'package.json'), 'utf8')).version
  : '(absent)'
const stableZ = (await import(`${pathToUrl(join(stableSchemastery, 'lib', 'index.mjs'))}`)).default
function pathToUrl(p) { return `file:///${p.replace(/\\/g, '/')}` }

check('the stable installation really is the non-volatile line', typeof stableZ.object({}).volatile !== 'function', `schemastery ${stableVersion}`)

// ── import the plugin against THIS stable schemastery ───────────────────────
// The plugin's own `@deepseek-ai/schemastery` import resolves to the profile's
// copy below, which is symlinked to the stable installation.
const { boot, loadProfileDirectory, loadOptionalPatches } = await import(pathToUrl(join(installScope, 'dsh-app-boot', 'lib', 'index.js')))
// Kept in scope for trees whose profile loader needs the patch file read directly.
void loadOptionalPatches

// ── stub gateway ────────────────────────────────────────────────────────────
const received = []
const gateway = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  received.push(body)
  const only = body?.providerOptions?.gateway?.only ?? body?.provider?.only ?? null
  const order = body?.providerOptions?.gateway?.order ?? body?.provider?.order ?? null
  const upstream = only?.[0] ?? order?.[0] ?? 'alibaba'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `served by ${upstream}` } }] })}\n\n`)
  // Routing metadata on the DELTA, which is where a stream carries it.
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing: { finalProvider: upstream, canonicalSlug: 'z-ai/glm-5.2' } } } } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, choices: [] })}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
})
await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${gateway.address().port}/api/v1`

// ── throwaway profile on the stable tree ────────────────────────────────────
const profileDir = mkdtempSync(join(here, '.mount-stable-'))
const homeDir = join(profileDir, 'home')
const scratch = join(profileDir, 'scratch')
mkdirSync(homeDir, { recursive: true })
mkdirSync(scratch, { recursive: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
symlinkSync(installScope, join(profileDir, 'node_modules', '@deepseek-ai'), 'dir')

const bundleDir = join(profileDir, 'bundle')
mkdirSync(bundleDir, { recursive: true })
writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'stable-bundle', version: '1.0.0', private: true, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2))
symlinkSync(bundleDir, join(profileDir, 'node_modules', 'stable-bundle'), 'dir')

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-stable', private: true, dsh: { profile: { bundles: ['stable-bundle'] } } }, null, 2))
writeFileSync(join(profileDir, 'cordis.yml'), '# composed from the bundle and the profile patch\n[]\n')

// The stable line mounts the file provider directly under the id `settings` —
// `dsh-settings` is its base class, not a separate row. Writing two rows collides
// on the service name ("service \"settings\" has been registered at
// <SettingsProvider>"), which is how this shape was found.
writeFileSync(join(bundleDir, 'cordis.patch.yml'), `- insert:
    - id: llm
      name: '@deepseek-ai/dsh-llm'

    - id: settings
      name: '@deepseek-ai/dsh-settings-file'

    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'

    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'

    - id: tools
      name: '@deepseek-ai/dsh-tools'

    - id: cline-pass
      name: ${JSON.stringify(join(pluginDir, 'lib/index.js'))}
`)

writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: settings
  config:
    path: ${JSON.stringify(join(scratch, 'settings.yaml'))}
    dshHome: ${JSON.stringify(homeDir)}
    watch: false

- id: credentials
  config:
    path: ${JSON.stringify(join(scratch, 'credentials.yaml'))}

- id: cline-pass
  config:
    baseURL: ${JSON.stringify(baseURL)}
    apiKeyEnv: STABLE_TEST_API_KEY
    knownModels:
      - cline-pass/glm-5.2
      - cline-pass/kimi-k3
`)
process.env.STABLE_TEST_API_KEY = 'sk_stable_test_key'

const profileContext = {
  name: 'mount-stable',
  dir: profileDir,
  patchPath: join(profileDir, 'cordis.patch.yml'),
  installAnchor,
  cwd: profileDir,
  home: homeDir,
  startedBundles: ['stable-bundle'],
  overlays: [],
  telemetryDisabledEnv: undefined,
}

/**
 * Compose the launch patches the way this line's launcher does.
 *
 * Stable `dsh-app-boot` has no `readProfilePatches` (that arrived later), so the
 * layers are assembled from the APIs it does export: the bundle layers first,
 * then the profile's own patch file.
 */
function composeLaunchPatches() {
  const loaded = loadProfileDirectory('dsh', profileDir, installAnchor)
  return [
    ...loaded.layers.flatMap((layer) => layer.patches),
    ...loaded.patches,
  ]
}

let ctx
try {
  const patches = composeLaunchPatches()
  ctx = await boot('dsh', join(profileDir, 'cordis.yml'), patches, (hostCtx) => {
    hostCtx.provide('profileContext', profileContext)
  })
  check('the tree mounted on the stable line', true)

  const entries = [...ctx.loader.entries()].map((entry) => entry.options?.id ?? entry.options?.name)
  check('the plugin row is in the loader', entries.includes('cline-pass'), entries.join(','))
  check('the settings rows mounted', entries.includes('settings'), entries.join(','))

  // The plugin activating at all is the headline result: on stable it used to
  // throw at import time on `.volatile()`.
  const llm = ctx.get('llm')
  const providers = llm.listProviders()
  check('the provider route is registered on the stable LLM runtime', providers.some((entry) => entry.id === 'cline-pass'), JSON.stringify(providers))

  const models = await llm.listModels('cline-pass')
  check('the plugin defaulted its model catalog on stable', models.length === 2 && models.every((model) => model.id !== '' && model.name !== ''), JSON.stringify(models))

  const tools = ctx.get('tools')
  check('the tools registered on the stable tool runtime', tools.get('cline_pass_status') !== undefined)

  const status = await tools.get('cline_pass_status').execute({}, { signal: new AbortController().signal })
  check('the status tool reports the stable route and its availability', status.provider === 'cline-pass' && status.routeRegistered === true, JSON.stringify({ provider: status.provider, routeRegistered: status.routeRegistered }))
  check('the status tool sees the settings service on stable', status.settingsAvailable === true, JSON.stringify({ settingsAvailable: status.settingsAvailable }))
  // Read the model list WITHOUT a filter: a `model` argument is a substring
  // filter, so passing one and asserting the unfiltered total is contradictory.
  const listed = await tools.get('cline_pass_models').execute({}, { signal: new AbortController().signal })
  check('the configured models survived schema defaulting on stable', (listed.models ?? []).length === 2, JSON.stringify((listed.models ?? []).map((m) => m.id)))
  check('the configured model ids are the ones the profile set', (listed.models ?? []).map((m) => m.id).sort().join(',') === 'cline-pass/glm-5.2,cline-pass/kimi-k3', JSON.stringify((listed.models ?? []).map((m) => m.id)))

  // ── the write path that only `installSection` can carry on this line ──────
  const settings = ctx.get('settings')
  check('the stable settings service exposes installSection', typeof settings?.installSection === 'function', typeof settings?.installSection)

  await settings.update('cline-pass', { perModel: { 'cline-pass/glm-5.2': { upstreams: ['baseten'], exclude: [], pinMode: 'strict', sort: '' } } })

  const afterWrite = await tools.get('cline_pass_models').execute({ model: 'glm-5.2' }, { signal: new AbortController().signal })
  const pinned = afterWrite.models?.[0]
  check('a settings write is observed by the running plugin on stable', pinned?.id === 'cline-pass/glm-5.2' && JSON.stringify(pinned?.pinned) === JSON.stringify(['baseten']), JSON.stringify(pinned))

  // ── and it must reach the wire, plus the history must report the truth ────
  const { createUserMessage } = await import(`${pathToUrl(join(installScope, 'dsh-llm', 'lib', 'index.js'))}`)
  const streamed = []
  for await (const chunk of llm.stream({
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
  })) streamed.push(chunk)

  const sentPin = received.at(-1)?.providerOptions?.gateway ?? received.at(-1)?.provider ?? null
  check('the pinned value reaches the next request on stable', JSON.stringify(sentPin?.only ?? sentPin?.order ?? null) === JSON.stringify(['baseten']), JSON.stringify(sentPin))
  check('the stable call streams its answer', streamed.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') === 'served by baseten', JSON.stringify(streamed.map((c) => c.type)))

  // The history must name the channel that answered, read from the stream's
  // delta metadata — not the pinned channel echoed back.
  const history = await tools.get('cline_pass_history').execute({ limit: 5 }, { signal: new AbortController().signal })
  const entry = history.entries?.[0]
  check('the history records the streaming call', entry !== undefined, JSON.stringify(history))
  check('the history reports the serving channel, not the pinned one', entry?.provider === 'baseten' && entry?.error === '', JSON.stringify(entry))

  // A stream that routes elsewhere must be reported as elsewhere, which is the
  // regression: the delta metadata is the only place this can come from.
  received.length = 0
  await settings.update('cline-pass', { perModel: { 'cline-pass/glm-5.2': { upstreams: [], exclude: [], pinMode: 'preferred', sort: '' } } })
  const unpinned = []
  for await (const chunk of llm.stream({
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } })],
  })) unpinned.push(chunk)
  const historyTwo = await tools.get('cline_pass_history').execute({ limit: 5 }, { signal: new AbortController().signal })
  check('an unpinned streaming call is recorded with its serving channel', historyTwo.entries?.[0]?.provider === 'alibaba', JSON.stringify(historyTwo.entries?.[0]))
} catch (error) {
  failures.push(`unexpected failure — ${error?.stack ?? error}`)
} finally {
  if (ctx !== undefined) {
    try { await ctx.dispose?.() } catch { /* teardown is best effort */ }
  }
  gateway.close()
  if (!existsSync(join(here, '.keep-mount'))) rmSync(profileDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} stable-mount checks passed (schemastery ${stableVersion}, no volatile support)`)
process.exit(0)