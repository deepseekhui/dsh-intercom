# dsh-intercom · 对讲机

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一条**会话之间直接说话**的线。

同一个 DSH 里可以同时开着好几个对话（不同的 Agent、不同的记忆本子）。这个插件让其中一个对话**把话直接送进另一个对话**，那边当场醒过来答话——不是投信箱等人来查。

## 它做什么

| 工具 | 干什么 |
|---|---|
| `intercom_list` | 列出活着的会话（谁在线、título） |
| `intercom_send` | 把一句话送进某个会话；**冷会话也能叫醒** |
| `intercom_broadcast` | 同时对所有活着的会话说一句，正文自动带「〔群发〕」前缀 |
| `intercom_status` | 看这个窗口还剩几次额度 |

另外在「设置」里注册一个「对讲机」页：看用量、改上限和窗口，改完立刻生效。

## 怎么实现的（不碰野路子）

用的都是宿主自己的接口，**不伪造 Cookie、不读签名密钥、不走 HTTP**：

```
找会话（活的查 ctx.sessions，冷的翻 $DSH_HOME/sessions 目录）
  → 读预设 ctx.sessionQuery.observeSession
  → 装预设 ctx.get('agentPresets').resolve + mount
  → 唤醒 ctx.agents.resume
  → 投递 createUserMessage + agent.followup
```

## 为什么要限流

两个 AI 会互相答话：你说一句，它答一句，你又答一句。没人喊停的话，一晚上能把额度烧光。
所以按**窗口内最多 N 次**硬拦，用完就是拒绝，不会悄悄多送一条。
具体几次、窗口多长，**别信这份文档**——问它自己：`/intercom/status` 或 `intercom_status` 工具返回的才是当前值。

限流按**通道**算，不按人算——烧额度的是那条来回自转的循环，不是某个角色。分人头记账会漏：一个人被限住，另一个接着发，循环照样转。

## 安装

两条路，选一条。

### 一、从 GitHub 装（最省事）

```bash
npx @deepseek-ai/dsh plugin --profile <profile 名> add github:deepseekhui/dsh-intercom
```

装完重启 dsh。

### 二、手动（想改代码时）


```bash
# 1. 把本包放到 <DSH_HOME>/plugins/dsh-intercom
# 2. profile 的 package.json 里加两条
#      dependencies:  "@deepseekhui/dsh-intercom": "link:../../plugins/dsh-intercom"
#      dsh.profile.bundles: 追加 "@deepseekhui/dsh-intercom"
# 3. 软链
mkdir -p <DSH_HOME>/profiles/<名字>/node_modules/@deepseekhui
ln -s ../../../../plugins/dsh-intercom <DSH_HOME>/profiles/<名字>/node_modules/@deepseekhui/dsh-intercom
# 4. 重启 dsh
```

## 配置

`cordis.patch.yml` 里：

| 键 | 出厂值 | 说明 |
|---|---|---|
| `maxPerWindow` | 5 | 一个窗口最多送几次（1–100） |
| `windowMinutes` | 60 | 窗口长度（1–1440） |
| `dataDir` | `$DSH_HOME` | 状态文件和配置文件放哪 |
| `label` | `会话之间` | 设置页顶上那行小字（想写「A ↔ B」就写这里） |

设置页里改的值会写进 `intercom-config.json`，**优先级高于 patch**，改完立刻生效、不用重启。

## 两个坑（我都踩过）

1. **客户端 `id` 必须等于包名**。`window.__ModuleLoader__.load({ id })` 里的 id 不是随便起的，写错就是整页白屏；
2. **宿主 `ctx.provide` 的服务名不能和别的插件重名**，重了 fiber 直接 failed。

## 已知限制

- 只能送到"这台机器上的"会话，跨设备不行；
- 冷会话叫醒要装预设（`agentPresets`），没这个服务的部署只能送活会话；
- 群发的收件人看到的是普通用户消息（带「〔群发〕」前缀），没有别的标记。

## 许可

MIT。群发工具由同一台机器上的另一个 AI 实例（我的搭档）添加，署意已标明。
