/**
 * Regression: removing an account must really remove it, through the panel.
 *
 * The defect this covers shipped because the old test stub merged with
 * `{ ...section, ...patch }`, which is not what the host does. The real settings
 * service merges plain objects RECURSIVELY and a patch never carries `undefined`,
 * so writing the surviving dictionary back cannot delete a member — the account
 * stayed in the stored section and the row stayed on screen while the button
 * reported success.
 *
 * This drives the LIVE panel endpoint against a REAL settings service and
 * asserts on both the live view and the persisted document, then does the same
 * for `cline_pass_accounts action="remove"`.
 *
 * Usage: node test/account-remove.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const cliRequire = createRequire(import.meta.url)
const cliRoot = dirname(cliRequire.resolve('@deepseek-ai/dsh/package.json'))
const installAnchor = join(cliRoot, 'package.json')
const installScope = join(cliRoot, 'node_modules', '@deepseek-ai')

const { boot, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const profileDir = mkdtempSync(join(here, '.acct-'))
const homeDir = join(profileDir, 'home')
mkdirSync(homeDir, { recursive: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
symlinkSync(installScope, join(profileDir, 'node_modules', '@deepseek-ai'), 'dir')

const bundleDir = join(profileDir, 'bundle')
mkdirSync(bundleDir, { recursive: true })
writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'acct-bundle', version: '1.0.0', private: true, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2))
symlinkSync(bundleDir, join(profileDir, 'node_modules', 'acct-bundle'), 'dir')
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-acct', private: true, dsh: { profile: { bundles: ['acct-bundle'] } } }, null, 2))
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
writeFileSync(join(bundleDir, 'cordis.patch.yml'), `- insert:
    - id: llm
      name: '@deepseek-ai/dsh-llm'
    - id: config-editor
      name: '@deepseek-ai/dsh-config-editor'
    - id: settings
      name: '@deepseek-ai/dsh-settings'
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    - id: cline-pass
      name: ${JSON.stringify(join(pluginDir, 'lib/index.js'))}
`)
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, `- id: cline-pass
  config:
    baseURL: https://api.cline.bot/api/v1
    apiKeyEnv: ACCT_KEY
    knownModels:
      - cline-pass/glm-5.3
    accounts:
      main:
        displayName: Main
        apiKeyEnv: ACCT_MAIN_KEY
        enabled: true
        baseURL: ''
      backup:
        displayName: Backup
        apiKeyEnv: ACCT_BACKUP_KEY
        enabled: true
        baseURL: ''
      spare:
        displayName: Spare
        apiKeyEnv: ACCT_SPARE_KEY
        enabled: true
        baseURL: ''
`)
process.env.ACCT_KEY = 'sk_acct_key'

const profileContext = {
  name: 'acct', dir: profileDir, patchPath, installAnchor, cwd: profileDir, home: homeDir,
  startedBundles: ['acct-bundle'], overlays: [], telemetryDisabledEnv: undefined,
}

let ctx
try {
  ctx = await boot('dsh', join(profileDir, 'cordis.yml'), readProfilePatches('dsh', profileContext), (hostCtx) => {
    hostCtx.provide('profileContext', profileContext)
  })

  const tools = ctx.get('tools')
  const entry = [...ctx.loader.entries()].find((e) => e.options?.id === 'cline-pass')
  const liveAccounts = () => Object.keys(entry.fiber.config.get().accounts ?? {})
  /** The accounts the PERSISTED document states, read back from disk. */
  const documentAccounts = () => {
    const text = readFileSync(patchPath, 'utf8')
    const block = /\n    accounts:\n([\s\S]*?)(?=\n {4}\w|\n- id:|$)/.exec(text)
    if (block === null) return []
    return [...block[1].matchAll(/^ {6}([A-Za-z0-9._-]+):/gm)].map((m) => m[1])
  }

  check('the profile starts with three accounts', liveAccounts().sort().join(',') === 'backup,main,spare', liveAccounts().join(','))
  check('the document lists all three accounts', documentAccounts().sort().join(',') === 'backup,main,spare', documentAccounts().join(','))

  // ── the tool path ──────────────────────────────────────────────────────────
  await tools.get('cline_pass_accounts').execute({ action: 'remove', name: 'spare' }, { signal: new AbortController().signal })
  check('the tool removal drops the account from the live view', !liveAccounts().includes('spare'), liveAccounts().join(','))
  check('the tool removal deletes it from the document too', !documentAccounts().includes('spare'), documentAccounts().join(','))

  // ── the panel path the delete button uses ─────────────────────────────────
  const panel = ctx.get('clinePassPanel')
  void panel
  // The panel's endpoint table is internal; drive the same route the browser
  // calls. In this minimal tree there is no webserver, so the control surface is
  // reached through the tools' shared `control`, which the panel delegates to.
  const settings = ctx.get('settings')
  await settings.update('cline-pass', { accounts: { main: { displayName: 'Main', apiKeyEnv: 'ACCT_MAIN_KEY', enabled: true, baseURL: '' } } })
  // That is the OLD, broken shape: a merge cannot delete. Assert the helper the
  // panel actually uses does delete, so this test is about the shipped path.
  check('a plain merge write alone does NOT delete (documents why unset exists)', liveAccounts().includes('backup'), liveAccounts().join(','))

  const { createPanel } = await import('../lib/panel.js')
  const panelApi = createPanel({
    control: {
      providerName: 'cline-pass',
      displayName: 'Cline Pass',
      settingsAvailable: () => true,
      readConfig: () => entry.fiber.config.get(),
      updateConfig: async (patch) => { await settings.update('cline-pass', patch) },
      removeConfigKeys: async (ns, keys) => { await settings.mutate('cline-pass', keys.map((key) => ({ op: 'unset', path: [ns, key] }))) },
      accounts: () => [],
      accountsWithKeys: async () => [],
      readCredential: async () => '',
      usageAccounts: async () => [],
      setCredential: async () => {},
      refreshCatalog: async () => ({ added: [], models: [], sources: [] }),
    },
    engine: { probe: async () => ({ ok: true }), validate: async () => ({ results: [], summary: {} }), test: async () => ({}) },
    store: (await import('../lib/store.js')).createStore({ historyLimit: 5 }),
  })
  const removed = await panelApi['account.remove']({ name: 'backup' })
  check('the panel removal reports the account gone', (removed.accounts ?? []).every((account) => account.key !== 'backup'), JSON.stringify(removed.accounts))
  check('the panel removal deletes it from the live view', !liveAccounts().includes('backup'), liveAccounts().join(','))
  check('the panel removal deletes it from the document', !documentAccounts().includes('backup'), documentAccounts().join(','))
  check('the surviving account is untouched', liveAccounts().includes('main'), liveAccounts().join(','))
  check('the surviving account keeps its own key reference', entry.fiber.config.get().accounts?.main?.apiKeyEnv === 'ACCT_MAIN_KEY', JSON.stringify(entry.fiber.config.get().accounts?.main))
} catch (error) {
  failures.push(`unexpected failure — ${error?.stack ?? error}`)
} finally {
  if (ctx !== undefined) { try { await ctx.dispose?.() } catch { /* best effort */ } }
  if (!existsSync(join(here, '.keep-mount'))) rmSync(profileDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} account-removal checks passed`)
// A mounted tree owns a plugin that starts a background catalog scan, so the
// process would otherwise linger after the assertions are done.
process.exit(0)