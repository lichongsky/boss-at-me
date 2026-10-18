# boss-at-me

飞书群里被指定的人（比如你的领导）@ 你时：

1. AI 读群聊上下文、你的项目代码、本地文档和飞书文档，判断这条消息要不要回、怎么回；
2. 飞书机器人私聊你：原文、要点、依据和回复草稿；
3. 你在私聊里回 `发 3`，它就以**你本人的身份**回复到群里那条消息下。

需要你本人拍板的事（排期、上线、开权限、方案取舍）会标成「需你处理」，只给建议草稿；你已经亲自回过的会自动跳过。

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
| watch | 输入要监听的人名，从通讯录里选人 |
| provider | 选模型供应商：跟随 CC Switch、Anthropic 官方、DeepSeek、Kimi、智谱 GLM、通义千问、MiniMax、OpenRouter 或自定义网关。token 存在 macOS 钥匙串 |
| sources | 粘贴项目代码目录、本地文档目录，并选择是否允许读飞书文档链接 |
| reply | 草稿署名、检查间隔、单条分析费用上限 |
| selftest | 机器人给你发一条测试私聊 |
| service | 安装 launchd 后台服务，开机自动运行 |

任何一步都可以单独重跑：`boss-at-me setup --step provider`。

## 日常使用

在机器人私聊里回复：

- `发 3`：原样发送 3 号草稿（末尾带署名）
- `改 3 你的内容`：发你改过的内容
- `不发 3`：忽略

只有一条待确认时可以省略编号。

```bash
boss-at-me status      # 配置、服务状态、待确认草稿
boss-at-me logs -f     # 实时日志
boss-at-me pause       # 暂停 / resume 恢复
boss-at-me doctor      # 诊断
boss-at-me uninstall   # 卸载
```

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

## 开发

```bash
npm test
npm run check-leaks   # 发布前检查打包内容是否含个人/公司信息；私有关键词写进 .leakwords（已 gitignore）
```
