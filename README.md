# dsh-cline-pass

[![npm](https://img.shields.io/npm/v/dsh-cline-pass)](https://www.npmjs.com/package/dsh-cline-pass) [![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.3-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

将 [Cline Pass](https://cline.bot/cline-pass) 订阅模型接入 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai)，作为原生 LLM provider 使用。

插件注册 `cline-pass` 路由和 `cline_pass_*` 管理工具。安装后，模型会出现在 dsh 模型选择器中并可被所有 agent 使用；上游渠道探测、校验、钉住、排除、故障转移和账号轮询都在 dsh 进程内完成。

## 特性

- **原生 provider**：支持流式输出、工具调用、reasoning 和 usage，使用 dsh 原生 chunk 协议。
- **上游控制**：按模型设置严格钉住或“首选 + 回退”，支持 `cost`、`ttft`、`tps` 排序和排除名单。
- **安全凭据**：配置只保存凭据引用；API Key 通过 dsh credentials seam 按请求解析。
- **账号池**：支持单账号和 `roundrobin` 轮询，账号可单独启用、停用和测试。
- **准确元数据**：逐模型声明上下文窗口、输出上限、输入模态和 reasoning 能力，可配置覆盖。
- **可观测性**：记录探测结果、渠道状态和请求历史，确认实际命中的上游。
- **无需代理**：不启动本地 HTTP 代理，不占用额外端口，也不依赖 `cline-pass-switcher`。

## 兼容性

| 依赖 | 版本 |
| --- | --- |
| dsh | `>= 0.1.2-alpha.3 < 0.2.0` |
| Node.js | `>= 20.3.0` |

你需要一个 Cline Pass API Key（通常以 `sk_` 开头）。没有 Key 也可以安装插件；首次请求时才提示凭据缺失。

## 安装

```bash
dsh plugin --profile web add dsh-cline-pass
```

也可以安装本地目录或 tarball：

```bash
dsh plugin --profile web add /path/to/dsh-cline-pass
dsh plugin --profile web add ./dsh-cline-pass-0.1.0.tgz
```

安装完成后重启 dsh。插件声明了 `dsh.bundle.patch`，命令会把它加入目标 profile 的 bundle 配置。

## 配置凭据

最简单的方式是环境变量：

```bash
export CLINE_PASS_API_KEY=sk_xxx
```

也可以写入 dsh 凭据库（推荐），在 Models 设置页填写，或让 agent 调用：

```text
cline_pass_accounts action=add name=main key=sk_xxx
```

凭据库中的 Key 不会回显，保存后无需重启即可生效。

## 配置文件

设置命名空间是 `cline-pass`。在 profile 自己的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中覆盖默认值：

```yaml
- id: cline-pass
  config:
    displayName: Cline Pass
    baseURL: https://api.cline.bot/api/v1
    apiKeyEnv: CLINE_PASS_API_KEY
    accountMode: roundrobin
    accounts:
      main:
        displayName: 主账号
        apiKeyEnv: CLINE_PASS_MAIN_KEY
      backup:
        displayName: 备用账号
        apiKeyEnv: CLINE_PASS_BACKUP_KEY
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `cline-pass` | provider 路由名 |
| `baseURL` | `https://api.cline.bot/api/v1` | Cline 网关地址 |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | 默认账号的凭据引用 |
| `accounts` | `{}` | 账号池；为空时使用顶层凭据 |
| `accountMode` | `single` | `single` 或 `roundrobin` |
| `activeAccount` | `''` | `single` 模式的账号名 |
| `knownModels` | 内置订阅模型 | 暴露给 dsh 的模型列表 |
| `models` | `{}` | 逐模型元数据覆盖 |
| `perModel` | `{}` | 逐模型上游钉住配置 |
| `exposeCatalog` | `false` | 是否合并网关完整模型目录 |
| `historyLimit` | `100` | 内存历史记录条数 |

例如覆盖模型元数据：

```yaml
cline-pass:
  models:
    cline-pass/deepseek-v4.1-flash:
      contextWindow: 400000
      maxTokens: 64000
      reasoning: false
```

## 管理工具

| 工具 | 用途 |
| --- | --- |
| `cline_pass_status` | 查看路由、凭据和模型状态 |
| `cline_pass_models` | 查看模型、管道和渠道；`refresh` 刷新官方目录 |
| `cline_pass_probe` | 探测管道并获取可钉住渠道 |
| `cline_pass_validate` | 逐渠道测试可用性和限流状态 |
| `cline_pass_test` | 用一次小请求验证钉住是否生效 |
| `cline_pass_pin` | 保存钉住、排除、模式和排序设置 |
| `cline_pass_accounts` | 管理账号池、模式和账号连通性 |
| `cline_pass_history` | 查看本进程内的请求历史 |

推荐流程：

```text
cline_pass_status
cline_pass_probe    model=cline-pass/glm-5.2
cline_pass_validate model=cline-pass/glm-5.2
cline_pass_test     model=cline-pass/glm-5.2 upstreams=["alibaba"]
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
cline_pass_history
```

### 钉住与故障转移

Cline Pass 当前可能使用两种网关管道：

- **direct**（OpenRouter）：使用顶层 `provider.only/order/sort`。
- **planner**（Vercel AI Gateway）：使用 `providerOptions.gateway.only/order/sort`。

插件会根据探测结果注入正确字段；管道未知时会同时注入两种形式。`upstreams` 按顺序作为候选渠道，只有首个 token 产生前才会切换；开始输出后发生的错误会原样上报。`exclude` 优先级高于候选列表，并会在自动路由时转换为 `only` 白名单。

## 安全与成本

- API Key 只存放在 dsh 凭据库或进程环境变量中，工具输出仅显示掩码。
- `status`、`models`、`history` 不访问上游；`probe`、`validate`、`test` 会发送真实请求并产生少量费用。
- 探测结果、渠道判定和请求历史只保存在内存中，重启后清空。

## 开发与测试

```bash
npm test
npm run test:mount
npm run test:live
```

`npm test` 使用桩网关进行离线检查；`test:mount` 验证真实 profile 挂载和 LlmRuntime 流式调用；`test:live` 访问真实网关，会产生少量请求费用。

## 致谢

上游管道、渠道枚举、钉住字段和故障转移语义参考了 MIT 许可的 [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher) 实测结果。本项目是面向 dsh LLM seam 的独立实现。

## License

[MIT](LICENSE)
