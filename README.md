# PT Agent

PT 站点 Free 资源的自动下载工具：**只下载值得下的**，并在 Free 到期前清掉下不完的任务。

两种用法，共享同一套决策逻辑：

| | [浏览器插件](pt-agent-extension/) | [终端守护进程](pt-agent-daemon/) |
|---|---|---|
| 触发 | 手动点「扫描」 | 随机间隔自动跑（默认 40–90 分钟） |
| 需要浏览器 | 是 | 否 |
| 适合 | 想自己过一眼再决定 | NAS / 服务器上无人值守 |
| 界面 | 插件弹窗 | 同款视觉的 WebUI |

## 它解决什么问题

PT 站的 Free 资源有时限。手动盯着抢很累，无脑全下又会出事——下不完的任务过了 Free 期
会真实计入下载量，还可能触发 HR。

所以这个工具做两件事：

1. **只推送「推荐」级别的资源**。决策引擎按 Free 剩余时长、做种/下载比、体积、HR 标记等
   算一个分，再过一遍本地安全准入（评分、体积、Free 剩余、分享率）。两关都过才发送。
2. **入队时把 Free 截止时间写进下载器标签**，到期前自动删掉还没下完的任务（含文件）。
   已完成的、不是本工具加的、打了保护标签的一律不碰。

并发数只提示不拦截——下载器自己有队列，超出上限的任务会排队而不是丢失。

## 快速开始

**终端守护进程**（推荐，无人值守）：

```bash
cd pt-agent-daemon
./install.sh
ptagent doctor
ptagent scan --dry-run     # 先空跑一轮，看它会挑什么
ptagent start
```

详见 [pt-agent-daemon/README.md](pt-agent-daemon/README.md) 和
[部署指南](pt-agent-daemon/DEPLOY.md)（systemd / launchd / Docker / 群晖）。

**浏览器插件**：Chrome 打开 `chrome://extensions`，开启开发者模式，
「加载已解压的扩展程序」选 `pt-agent-extension/`。详见
[pt-agent-extension/README.md](pt-agent-extension/README.md)。

## 决策逻辑只有一份

评分、决策、准入、Free 保护、qBittorrent 客户端这 12 个模块的源头在
`pt-agent-extension/`，守护进程以逐字节副本的形式带在 `pt-agent-daemon/vendor/engines/`，
由 `npm run sync-engines` 同步、`MANIFEST.json` 记录 sha256、测试确认两边一致。

这样守护进程能单独打包发布，同时不会出现「插件说推荐、终端说拒绝」这种没法解释的分歧。
**要改判定规则，改 `pt-agent-extension/` 里的源文件，然后同步。**

## 现状

- **站点**：只实现了 M-Team（API 模式）。站点适配层是多站点结构，接新站点补一个适配器即可。
- **下载器**：只实现了 qBittorrent。Transmission / Deluge 的适配层位置已经留好。
- **测试**：插件 177 个，守护进程 100 个。核心链路用假网络跑完整流程，不是只测单个函数。

## 安全

这个工具**会删文件**。几条边界写死在代码里并有测试守着：

- 只删带 `ptagent` 标签的任务（本工具自己加的）
- 已完成的任务不删——还要留着做种
- 打了 `pt_agent_keep` / `pt_agent_nodel` 的不删
- `autoDeleteExpired=false` 时只告警不删

删除动作全部记进审计日志，`ptagent audit` 可查。

配置文件里有下载器密码和站点 API Key：`.env` 权限 600 且已在 `.gitignore` 里，
WebUI 的所有接口出站前一律脱敏，绑非回环地址时强制要求访问令牌。

## 免责

自动化下载是否符合站点规则，请自行确认。本工具不绕过任何站点限制，
只是把你本来就会手动做的判断和操作自动化。用它导致的账号问题由使用者自负。

## License

[MIT](LICENSE)
