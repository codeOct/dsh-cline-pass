# dsh-cline-pass

Cline Pass, wired straight into the DeepSeek Harness: **install it as a dsh
plugin and it works** — no proxy process to run, no cline-pass-switcher
install required.

It registers a provider route on the harness LLM seam (default `cline-pass`),
so subscription models like `cline-pass/glm-5.2` appear in the model picker and
are usable by every agent exactly like a built-in provider. Everything the
cline-pass-switcher web console did — enumerate upstream channels, measure which
ones can actually be pinned, pin or exclude them, spread an account pool, read
request history — is registered here as `cline_pass_*` tools instead.

- Upstream pinning (`provider.only` / `providerOptions.gateway.only`) and
  pre-first-token failover happen **in process**: no local proxy, no extra port
- Streaming, tool calls, reasoning and usage use the harness's native chunk
  protocol
- Context window and output cap are declared **per model** (1M / 384k for
  `deepseek-v4.1-flash`) rather than once per route — an understated window
  makes the agent truncate history it could have kept
- Reasoning effort offers `none / minimal / low / medium / high / xhigh / max`,
  the gateway's own vocabulary (`off` is rejected with HTTP 400); sending none
  leaves the field out entirely
- Configuration lives in this plugin's `cline-pass` settings section: it
  survives restarts, reloads live, and is editable from the Models page
- API keys never enter the configuration: accounts name a credential reference
  and the key is resolved per request through the credential seam
- 121 smoke checks + 20 real-mount checks (see [Development](#development))

> The difference from the proxy approach: before, you ran a proxy and pointed a
> client's base URL at it. Now dsh *is* the client, so pinning, failover and
> observation all happen inside the harness — one process less, one HTTP hop
> less, one config file less.

---

## Prerequisites

- dsh `>= 0.1.2-alpha.3 < 0.2.0`
- A Cline Pass API key (`sk_…`, created in Cline's account settings after
  subscribing)
- Node ≥ 20.3 (`AbortSignal.any`)

The plugin installs fine without a key: it registers, the models list, and only
an actual request reports the missing credential.

---

## Install

```bash
# after publishing
dsh plugin --profile web add dsh-cline-pass

# or from a local checkout / tarball
dsh plugin --profile web add /path/to/dsh-cline-pass
dsh plugin --profile web add ./dsh-cline-pass-0.1.0.tgz
```

`dsh plugin` forwards to pnpm inside the profile directory and adds this package
to `dsh.profile.bundles` (it declares `dsh.bundle.patch`). **Restart dsh**
afterwards — a running process does not hot-load a new host row.

Then supply the key, either way:

```bash
# A. environment variable (simplest)
export CLINE_PASS_API_KEY=sk_xxx

# B. store it in dsh's credential document (0600, under DSH_HOME) — write it
#    from the Models settings page, or have an agent call:
#    cline_pass_accounts action=add name=main key=sk_xxx
```

With the credential store no restart is needed: the key is resolved per request.

---

## Configuration

Every field has a default. Override in **your profile's own**
`$DSH_HOME/profiles/<name>/cordis.patch.yml` (applied after every bundle layer):

```yaml
- id: cline-pass
  config:
    accounts:
      main:
        displayName: Main
        apiKeyEnv: CLINE_PASS_MAIN_KEY
      backup:
        displayName: Backup
        apiKeyEnv: CLINE_PASS_BACKUP_KEY
    accountMode: roundrobin
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `cline-pass` | Provider route name (model ids keep their `cline-pass/…` prefix) |
| `displayName` | `Cline Pass` | Label in the picker |
| `baseURL` | `https://api.cline.bot/api/v1` | Cline gateway |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | Credential name of the implicit default account |
| `accounts` | `{}` | Account pool; empty means one implicit account on the fields above |
| `accountMode` | `single` | `single` (manual) or `roundrobin` (per request) |
| `activeAccount` | `''` | Account key used in single mode |
| `knownModels` | 15 subscription models | Models exposed to the harness |
| `models` | `{}` | Per-model metadata overrides: `name` / `contextWindow` / `maxTokens` / `reasoning` / `input` (the built-in catalog is the default — see below) |
| `perModel` | `{}` | Per-model pin (below) |
| `reasoningModels` | `true` | Whether models the catalog does not describe also offer effort selection |
| `defaultContextWindow` | `128000` | Fallback context window for models the catalog does not cover |
| `defaultMaxTokens` | `32000` | Fallback output cap for models the catalog does not cover |
| `streamIdleTimeoutMs` | `300000` | Stream read idle timeout |
| `exposeCatalog` | `false` | Merge the gateway's full catalog into the model list |
| `historyLimit` | `100` | In-memory request-history rows |

### Model metadata (context window and reasoning effort)

The plugin declares the context window and output cap **per model**, from the numbers AI Gateway and
models.dev publish, instead of giving the whole route one default — the harness derives its prompt
budget from `context.contextWindow`, so an understated window makes the agent discard history it
could have kept. All 15 built-in models carry real numbers (`deepseek-v4.1-flash` is 1M context /
384k output).

Reasoning offers `none / minimal / low / medium / high / xhigh / max`, exactly the set the gateway
enumerates (it rejects `off` with HTTP 400). The plugin sets **no** default: leave the picker alone
and no `reasoning_effort` is sent at all, so the gateway's own default applies.

When a number is wrong for you, override it in the `models` section — no code change needed:

```yaml
cline-pass:
  models:
    cline-pass/deepseek-v4.1-flash:
      contextWindow: 400000   # overrides the built-in 1000000
      maxTokens: 64000
      reasoning: false        # hides effort selection for this model
```

---

## Tools

| Tool | Purpose | Real upstream calls | Writes config |
|---|---|---|---|
| `cline_pass_status` | Route, account pool, key presence, model/pin counts | No | No |
| `cline_pass_models` | Per-model pipeline, channels, availability, pin; `refresh` rescans the official list | Only `refresh` | Only `refresh` |
| `cline_pass_probe` | Detect the pipeline and harvest the pinnable channel list | Yes (~$0.0002) | Probe result (memory) |
| `cline_pass_validate` | Test every channel: available / rate-limited / not-pinnable / auth-failed | Yes (one per channel) | Verdicts (memory) |
| `cline_pass_test` | One small request to prove a pin takes effect, with the failover trace | Yes | No (temporary) |
| `cline_pass_pin` | Persist pin list / exclude list / mode / sort | No | Yes |
| `cline_pass_accounts` | Pool: list / add / remove / mode / set / test | Only `test` | All but `list`/`test` |
| `cline_pass_history` | In-process request history: upstream, latency, attempts, errors | No | No |

### Recommended workflow

```text
cline_pass_status                              # is the route up, is a key stored?
cline_pass_probe    model=cline-pass/glm-5.2   # which channels exist, which pipeline?
cline_pass_validate model=cline-pass/glm-5.2   # which of them actually work?
cline_pass_test     model=cline-pass/glm-5.2 upstreams=["alibaba"]
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
cline_pass_models   model=glm-5.2              # read it back
cline_pass_history                             # what really served traffic
```

### The two pipelines

Cline Pass subscription models are served behind one of two pipelines — the
finding the cline-pass-switcher project measured and published:

- **direct** (OpenRouter behind): the response carries top-level `provider` /
  `model`; pin with top-level `provider.only/order/sort`.
- **planner** (Vercel AI Gateway behind): the response carries
  `provider_metadata.gateway.routing`; only
  `providerOptions.gateway.only/order/sort` is passed through, the top-level
  form is discarded.

`cline_pass_probe` detects the pipeline and harvests each pipeline's own channel
list; `cline_pass_pin` only records *who* to pin and the plugin injects the
right form (both when the pipeline is still unknown). `sort` values
`cost/ttft/tps` are translated per pipeline (`price/latency/throughput` on
OpenRouter).

### Failover

`upstreams` is an ordered candidate list: the first is primary, the rest are
fallbacks. A candidate is abandoned **only while nothing has been delivered** —
non-2xx, connection failure, routing-layer error, or HTTP 200 whose body is an
error object. Once content starts flowing, a failure is reported as such rather
than silently asked of another channel. `exclude` always wins over `upstreams`
and, under automatic routing, becomes an `only` allow-list so the gateway cannot
fall back onto an excluded channel.

---

## Security and cost

- **Keys live only in the credential seam.** Account configuration stores the
  reference name; `cline_pass_accounts` returns masked hints (`sk_smo…aaaa`) and
  never echoes a key. `action=add key=…` writes to dsh's credential document,
  not to `settings.yaml`.
- `probe` / `validate` / `test` make **real upstream calls** (~$0.0002 each;
  `validate` issues one per channel and can take minutes). `status`, `models`
  and `history` are free.
- Observation (probe results, channel verdicts, request history) is in-memory
  only — derived data that any probe can rebuild — so observing never triggers a
  configuration write.

---

## Development

```bash
# Let bare specifiers resolve to the peer packages dsh already ships
mkdir -p node_modules/@deepseek-ai
for p in dsh-llm dsh-tools dsh-credentials dsh-settings dsh-launch-environment dsh-timeout dsh-util-values dsh-app-boot schemastery cordis; do
  ln -sfn "$(dirname "$(realpath "$(command -v dsh)")")/../node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done

npm test           # 121 checks: protocol, adapter, failover, metadata, every tool — stub gateway, no network
npm run test:mount # 20 checks: real profile mount + a real streamed call through LlmRuntime
npm run test:live  # real gateway, one request per effort, proving all 7 are accepted (small cost)
```

Both tests re-validate every tool's returned value against its declared
`output.schema` and call its `render`. The mount test really `boot()`s a
throwaway profile and asserts that every row activated, the route reached
`ctx.llm.listProviders()`, the model metadata passed the runtime's live
validators, `ctx.llm.stream()` produced chunks end to end, and a pin written
through `settings.update` reached the very next request; the temporary profile is
deleted afterwards.

## Acknowledgements

The routing behavior — the two pipelines, how a pin is written for each, channel
enumeration, and the failover semantics — reimplements findings published by the
MIT-licensed [cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher)
project. This plugin is an independent implementation against the harness LLM
seam and neither depends on nor requires that project.

## License

[MIT](LICENSE)
