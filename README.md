<p align="center"><img src="assets/logo.png" width="200" alt="boss-at-me"></p>

<h1 align="center">boss-at-me</h1>

<p align="center">老板 @ 你，AI 先替你想好怎么回</p>

飞书群里被指定的人（比如你的领导）@ 你，或者私聊你时：

1. AI 读群聊上下文、你的项目代码、本地文档和飞书文档，判断这条消息要不要回、怎么回；
2. 飞书机器人私聊你：原文、要点、依据和回复草稿；
3. 你在私聊里回 `发 3`，它就以**你本人的身份**回复到群里那条消息下。

需要你本人拍板的事（排期、上线、开权限、方案取舍）会标成「需你处理」，只给建议草稿；你已经亲自回过的会自动跳过。

如果这条消息之后你已经亲自在群里（或私聊里）回过，就不会再给你发草稿：分析前先查一次聊天记录，分析期间你回了，发草稿前还会再查一次。已经发出去的旧草稿卡片不会自动消失，可以在卡片上点「不发」，或在私聊里发「全部忽略」清掉。

私聊是可选的（setup 的 watch 步骤里开关）：对方连发的几条会合并成一份草稿；对方发完先等几分钟（默认 5 分钟）再分析，这期间你自己回了就不打扰。

> 仅支持 macOS。AI 只有只读权限：读代码、读文档、读聊天，不能改文件也不能发消息；真正发出去的只有你确认过的那一句。

## 安装

```bash
npm install -g boss-at-me
boss-at-me setup
```

需要 Node.js ≥ 20.17。setup 会一步步带你完成：

| 步骤 | 做什么 |
|---|---|
| preflight | 检查并安装 [Claude Code](https://docs.claude.com/claude-code)（分析引擎）和 [lark-cli](https://github.com/larksuite/cli)（飞书官方命令行） |
| lark-app | 在浏览器里一键创建你的个人飞书应用（机器人） |
| lark-auth | 浏览器授权读消息、搜消息、以你身份回复等权限。「以本人身份发消息」需要企业管理员审批，审批前也能用，只是要手动复制回复 |
| watch | 添加 / 删除要监听的人（从通讯录里选），以及是否处理他们的私聊 |
| provider | 选模型供应商：跟随 CC Switch、Anthropic 官方、DeepSeek、Kimi、智谱 GLM、通义千问、MiniMax、OpenRouter 或自定义网关。token 存在 macOS 钥匙串 |
| sources | 粘贴项目代码目录、本地文档目录，并选择是否允许读飞书文档链接 |
| reply | 草稿署名、检查间隔、单条/每月费用上限、未处理草稿提醒间隔 |
| selftest | 机器人给你发一条测试私聊 |
| cards | 开通卡片回调：草稿以卡片发到私聊，可直接改、点按钮发送（不装也能用「发 N」文字指令） |
| service | 安装 launchd 后台服务，开机自动运行 |

任何一步都可以单独重跑：`boss-at-me setup --step provider`。

## 日常使用

在机器人私聊里回复：

- `发 3`：原样发送 3 号草稿（末尾带署名）
- `改 3 你的内容`：发你改过的内容
- `不发 3`：忽略

只有一条待确认时可以省略编号。

草稿是一张飞书卡片：输入框里是草稿，可以直接改，点「发送 / 不发」即可；卡片上还会给 2～3 条快捷回复，点一下就直接发出去（超过输入框上限的长草稿只读展示，改用文字指令）。

其它指令：

- `待确认` / `提醒`：立刻列出还没处理的草稿
- `全部忽略`：清掉所有待确认草稿
- `重发 3`：自动发送失败（比如「以本人身份发消息」权限还在审批）后重试
- `原因 3 已回 / 不用 / 不好`：记录忽略原因，帮助后续调优

有未处理草稿时，机器人默认每 12 小时汇总提醒一次，到期前 2 小时会单独提醒（想关掉就在 setup 的 reply 步骤把提醒间隔设为 0）。

```bash
boss-at-me status      # 配置、服务状态、待确认草稿
boss-at-me stats       # 今日/本月分析次数、估算费用、待确认和忽略原因
boss-at-me logs -f     # 实时日志
boss-at-me pause       # 暂停 / resume 恢复
boss-at-me doctor      # 诊断
boss-at-me uninstall   # 卸载
```

## 更新

有新版本时，机器人每天最多私聊提醒一次，`boss-at-me status` 也会显示。更新只需：

```bash
boss-at-me update          # 更新到最新版；--check 只查看不安装
```

它会按你的安装方式执行对应的更新命令（GitHub / npm / 源码 git pull）。如果新版本需要补充配置，会列出要重跑的 setup 步骤并引导执行。配置、token、飞书授权都会保留；后台服务下一轮自动使用新代码，不用重启。

检查更新要访问 GitHub。如果你平时通过代理上网，setup 时会记下 shell 里的 `HTTPS_PROXY`，只给检查更新用，飞书和模型请求不走代理。

## 团队预设

团队内部可以把公共配置写成一个 JSON 文件，安装时带上：

```bash
boss-at-me setup --preset ./team-preset.json   # 也支持 https URL
```

格式见 [examples/preset.example.json](examples/preset.example.json)：可预填模型网关地址、默认监听的人、署名、检查间隔。预设里不要放 token，token 仍由每个人自己粘贴进钥匙串。

## 数据放在哪

| 内容 | 位置 |
|---|---|
| 配置、状态、日志 | `~/.boss-at-me/`（权限 0700） |
| 模型 token | macOS 钥匙串，服务名 `boss-at-me` |
| 飞书应用和授权 | 由 lark-cli 管理（`~/.lark-cli/` + 钥匙串） |
| 后台服务 | `~/Library/LaunchAgents/com.boss-at-me.agent.plist` |

## 费用

每条 @ 消息调用一次模型，按所选供应商计费，通常每条几毛钱人民币到几元；单条上限可在 setup 的 reply 步骤设置。

`boss-at-me stats` 可以看今日/本月的分析次数和估算费用（按所选供应商价目估算，实际账单可能不同）；还能在 reply 步骤设「每月分析费用上限」（默认 0 表示不限），到上限后暂停自动分析并私聊提醒。

## 开发

```bash
npm test
npm run check-leaks   # 发布前检查打包内容是否含个人/公司信息；私有关键词写进 .leakwords（已 gitignore）
```

改完代码后：定时服务（每 2 分钟一轮）下一轮会自动使用新代码；常驻的实时确认服务要重启才生效——运行 `boss-at-me setup --step service`（或 `boss-at-me pause && boss-at-me resume`）。

发版流程：

1. 改 `package.json` 的 `version`；
2. 在 `src/releases.json` 加一条：`notes` 写给用户看的更新说明，`steps` 列出需要用户重跑的 setup 步骤（没有就留空数组）；
3. `npm test && npm run check-leaks`，提交，打标签 `vX.Y.Z`，推送到 `main`。

用户端每天读取 `main` 分支上的 `package.json` 和 `src/releases.json` 判断是否有新版本。
