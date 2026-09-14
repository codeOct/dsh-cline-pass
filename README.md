# dsh-cline-pass

将 [Cline Pass](https://cline.bot/cline-pass) 订阅模型接入 [DeepSeek Harness](https://github.com/deepseek-ai)。安装为 dsh 插件后，模型会直接出现在模型列表中，无需运行代理服务。

## 功能

- 使用 Cline Pass 订阅模型
- 支持流式输出、工具调用、图片和 reasoning
- 管理多个账号并轮询使用
- 探测、测试、钉住或排除上游渠道
- 在首个 token 前自动故障转移
- 提供开箱即用的 Web 图形设置面板；也支持 `cline_pass_*` 工具自动化管理

## 要求

- dsh `>= 0.1.2-alpha.3`
- Node.js `>= 20.3`
- Cline Pass API Key

## 安装

```bash
dsh plugin --profile web add dsh-cline-pass
```

也可以安装本地目录或 tarball：

```bash
dsh plugin --profile web add /path/to/dsh-cline-pass
dsh plugin --profile web add ./dsh-cline-pass-0.1.0.tgz
```

安装后重启 dsh。

## 图形化配置（推荐）

使用 `web` profile 启动 dsh 后，打开 **设置 → Cline Pass**：

1. 在“账号”区域粘贴 API Key，点击 **保存并测试**。
2. 在“订阅模型”区域选择模型，点击 **一键配置**。
3. 需要手动调整时，展开模型行，点击渠道即可设置顺序；使用 `⊘` 排除渠道。

面板会自动完成渠道探测、可用性测试和设置验证。Key 会保存到 dsh 凭据库，页面只显示掩码。

## 配置

最简单的方式是设置环境变量：

```bash
export CLINE_PASS_API_KEY=sk_xxx
dsh --profile web
```

如果不使用图形界面，可以设置环境变量。Key 也可以通过下方的工具接口写入 dsh 凭据库。

### 多账号

在设置面板的“账号”区域添加账号即可。需要自动化时再调用工具：

```text
cline_pass_accounts action=add name=main key=sk_xxx
cline_pass_accounts action=add name=backup key=sk_yyy
cline_pass_accounts action=mode mode=roundrobin
```

### 配置文件

需要覆盖默认值时，在 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中添加：

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

常用设置包括 `baseURL`、`knownModels`、`models`、`perModel`、`exposeCatalog` 和 `historyLimit`。默认网关地址为 `https://api.cline.bot/api/v1`。

## 上游渠道

首次使用模型时，在面板点击 **一键配置** 即可。需要自动化时，可按以下顺序调用工具：

```text
cline_pass_probe    model=cline-pass/glm-5.2
cline_pass_validate model=cline-pass/glm-5.2
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
```

`pinMode` 支持 `strict` 和 `preferred`。`preferred` 会按顺序尝试渠道，并在首个 token 前失败时自动切换。`exclude` 可排除指定渠道。

## 工具

| 工具 | 用途 |
| --- | --- |
| `cline_pass_status` | 查看路由和账号状态 |
| `cline_pass_models` | 查看模型和渠道 |
| `cline_pass_probe` | 探测渠道 |
| `cline_pass_validate` | 测试每个渠道 |
| `cline_pass_test` | 验证当前设置 |
| `cline_pass_pin` | 保存渠道设置 |
| `cline_pass_accounts` | 管理账号 |
| `cline_pass_history` | 查看请求历史 |

## 开发

```bash
npm test
npm run test:client
npm run test:mount
```

访问真实网关的测试还包括：

```bash
npm run test:live
npm run test:live:image
npm run test:live:reasoning
```

这些命令需要有效的 Cline Pass Key，并会产生少量请求费用。

## 致谢

上游渠道和故障转移行为参考了 MIT 许可的 [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher)。

## License

[MIT](LICENSE)
