# dsh-cline-pass

Connect [Cline Pass](https://cline.bot/cline-pass) subscription models to the [DeepSeek Harness](https://github.com/deepseek-ai). Install it as a dsh plugin and the models appear in the model list without running a proxy service.

## Features

- Use Cline Pass subscription models from dsh
- Streaming, tool calls, image input, and reasoning
- Multiple accounts with optional round-robin rotation
- Probe, test, pin, or exclude upstream channels
- Automatic failover before the first token
- Web settings panel and `cline_pass_*` tools

## Requirements

- dsh `>= 0.1.2-alpha.3 < 0.2.0`
- Node.js `>= 20.3`
- A Cline Pass API key

The plugin supports both the stable and the alpha dsh lines, whose configuration
mechanisms differ; the plugin probes for what the host offers:

| | Stable (`0.1.5-rc.3`) | Alpha (`0.1.7+`) |
| --- | --- | --- |
| Live configuration source | `settings.installSection`'s `setSource` | the volatile reference from `config.get()` |
| `loader/volatile-update` | absent | present |
| `Schema.prototype.volatile` | absent | present |

Saved pins, hidden models and account edits therefore take effect on both lines
without a restart.

## Install

```bash
dsh plugin --profile web add dsh-cline-pass
```

You can also install a local directory or tarball:

```bash
dsh plugin --profile web add /path/to/dsh-cline-pass
dsh plugin --profile web add ./dsh-cline-pass-<version>.tgz
```

Restart dsh after installation.

## Configure

With the Web profile, open **Settings → Cline Pass** to save and test a key. Keys are stored in the dsh credential store and shown only in masked form.

You can also set an environment variable before starting dsh:

```bash
export CLINE_PASS_API_KEY=sk_xxx
dsh --profile web
```

### Multiple accounts

Add accounts in the settings panel and select single-account or round-robin mode. You can also use the tool interface:

```text
cline_pass_accounts action=add name=main key=sk_xxx
cline_pass_accounts action=add name=backup key=sk_yyy
cline_pass_accounts action=mode mode=roundrobin
cline_pass_accounts action=remove name=backup
```

Removing an account removes only the account; its stored credential stays in the
credential store so it can be restored later.

With more than one account, a strip of account tabs appears above the quota card.
**Click a tab to switch which account's quota is shown** — one account at a time,
so several accounts' windows do not pile up into an unreadable column. Switching
the view never writes to the configuration.

> The panel deletes an account through the host's path-removal operation
> (`mutate` + `unset`) rather than an ordinary write, because `settings.update`
> merges plain objects recursively and a missing key is therefore preserved —
> an ordinary write cannot delete an account at all.

### Configuration file

To override defaults, add a `cline-pass` section to your profile's `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: cline-pass
  config:
    accountMode: roundrobin
    accounts:
      main:
        apiKeyEnv: CLINE_PASS_MAIN_KEY
      backup:
        apiKeyEnv: CLINE_PASS_BACKUP_KEY
```

Common settings include `baseURL`, `knownModels`, `models`, `perModel`, `exposeCatalog`, and `historyLimit`. The default gateway is `https://api.cline.bot/api/v1`.

## Upstream channels

For a new model, click **Auto-configure** in the panel to probe, validate, and configure channels. Expand a model row to adjust channel order or exclude a channel.

You can also run the tools in this order:

```text
cline_pass_probe    model=cline-pass/glm-5.2
cline_pass_validate model=cline-pass/glm-5.2
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
```

`pinMode` supports `strict` and `preferred`. `preferred` tries channels in order and fails over before the first token when needed. Use `exclude` to block specific channels.

## Tools

| Tool | Purpose |
| --- | --- |
| `cline_pass_status` | Show route and account status |
| `cline_pass_models` | List models and channels |
| `cline_pass_probe` | Probe channels |
| `cline_pass_validate` | Test each channel |
| `cline_pass_test` | Verify the current settings |
| `cline_pass_pin` | Save channel settings |
| `cline_pass_accounts` | Manage accounts |
| `cline_pass_history` | Read request history |

## Development

```bash
npm test                  # the full offline suite (real mounts and account removal included)
npm run test:client       # the panel's browser half
npm run test:protocol     # wire protocol and pin verdicts
npm run test:accounts     # account removal, with the host's real settings semantics
npm run test:mount        # mount on a real alpha plugin tree
```

Stable-line compatibility is verified separately (it needs an installed stable dsh):

```bash
node test/mount-stable.mjs --stable-dir <.../@deepseek-ai/dsh>
```

Live gateway checks are also available:

```bash
npm run test:live
npm run test:live:image
npm run test:live:reasoning
```

These commands need a valid Cline Pass key and make a small number of paid requests.

## Acknowledgements

Upstream channel and failover behavior was informed by the MIT-licensed [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher).

## License

[MIT](LICENSE)
