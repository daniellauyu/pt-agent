# PT Agent 守护进程

终端里跑的 PT 自动下载器。不需要开浏览器、不需要插件常驻，按**随机间隔**定时扫描站点 Free 资源，
**只推送决策引擎判为「推荐」的**，入队时把 Free 截止时间写进标签，到期还没下完就连文件一起删掉。

自带一个和浏览器插件同款视觉的 WebUI 用来配置和查看。

```
ptagent doctor      # 先体检
ptagent start       # 前台跑守护进程
```

## 它和浏览器插件是什么关系

**决策逻辑是同一份代码**，不是各写一遍。`src/engines.js` 直接 `require` 了
`../pt-agent-extension/` 里的评分、决策、准入、Free 保护、qBittorrent 客户端等模块——
那些模块本来就是纯函数加依赖注入，没有任何 `chrome.*` 或 DOM 调用，在 Node 里能原样跑。

这么做的理由很实际：调整评分权重或 Free 判定时两边必然同步，不会出现「插件说推荐、终端说拒绝」。
代价是两个子项目必须留在同一个仓库里。

| | 浏览器插件 | 守护进程 |
|---|---|---|
| 触发方式 | 手动点「扫描」 | 随机间隔自动跑 |
| 需要浏览器 | 是 | 否 |
| 种子文件抓取 | 受同源策略限制，CDN 302 后常拿不到字节，只能退化成让下载器自己抓 | 无同源策略，永远能拿到字节再上传，成功率更高 |
| Free 到期删除 | 默认关闭 | 默认开启 |
| 配置存储 | `chrome.storage.local` | `~/.ptagent/config.json` |
| 决策逻辑 | 源头 | `vendor/engines/` 里的逐字节副本 |

## 安装

需要 Node.js 20 或更高。没有任何第三方依赖。

```bash
cd pt-agent-daemon
npm link            # 之后可以直接用 ptagent 命令
# 或者不 link，直接 node bin/ptagent.js <命令>
```

**单独部署到 NAS / 服务器**：整个 `pt-agent-daemon/` 目录拷过去即可，
`vendor/engines/` 已经带上了全部决策逻辑。拷完先验一下：

```bash
node scripts/sync-engines.js --check
node bin/ptagent.js doctor
```

## 五分钟跑起来

```bash
# 1. 站点（M-Team 的 API Key 在站点「控制台 → 实验室」里生成）
ptagent site add --api-key <你的APIKEY>

# 2. 下载器。内网地址放前面，出门在外时会自动落到后面的公网地址
ptagent downloader add --name 内网qB --address http://192.168.1.10:8080/ \
  --username admin --password <密码> --savepath /volume1/downloads
ptagent downloader add --name 公网qB --address https://qb.example.com/ \
  --username admin --password <密码>

# 3. 扫描节奏：40 到 90 分钟之间随机
ptagent config set scanIntervalMinMinutes 40
ptagent config set scanIntervalMaxMinutes 90

# 4. 体检，全绿再启动
ptagent doctor

# 5. 先空跑一轮看看它会挑什么，确认合意再放开
ptagent scan --dry-run

# 6. 启动
ptagent start
```

启动后终端里会打印 WebUI 地址，默认 <http://127.0.0.1:7788/>。

## 命令

### 守护

| 命令 | 说明 |
|---|---|
| `ptagent start` | 定时扫描 + Free 保护 + WebUI，前台运行 |
| `ptagent web` | 只开 WebUI，不跑定时任务 |

### 一次性动作

| 命令 | 说明 |
|---|---|
| `ptagent scan [--dry-run]` | 立刻扫描一轮，`--dry-run` 只评估不推送 |
| `ptagent guard [--dry-run]` | 立刻跑一次 Free 到期保护 |
| `ptagent backfill` | 给下载器里缺 Free 截止标签的任务回查补上 |
| `ptagent push <种子ID...> [--force]` | 手动推送，`--force` 跳过本地安全准入 |

### 查看

| 命令 | 说明 |
|---|---|
| `ptagent status` | 调度状态、上一轮结果 |
| `ptagent resources [--filter recommend]` | 最近一次扫描的评估明细 |
| `ptagent tasks` | 下载器当前任务与保护状态 |
| `ptagent logs [-n 100] [--level error] [--prefix push:]` | 运行日志 |
| `ptagent audit [-n 50]` | 生命周期审计（谁在什么时候被加进来、被删掉） |

### 配置

| 命令 | 说明 |
|---|---|
| `ptagent config list` | 打印全部配置 |
| `ptagent config set <键> <值>` | 改一项，键名见 `config list` |
| `ptagent downloader list\|add\|set\|rm\|test` | |
| `ptagent site list\|add\|set\|rm` | |
| `ptagent doctor` | 体检：配置完整性 + 站点与下载器连通性 |

所有命令都支持 `--json`（机器可读）、`--home <目录>`（换数据目录）、`--quiet`。

## 它怎么决定下载什么

一个资源要真正被推送，必须连过两关：

**第一关，决策引擎**（`decision-engine.js`，和插件共用）判为 `recommend`。这一关会因为
不是明确 Free、Free 已到期、HR 任务、0 做种、做种供给相对下载需求过低等原因直接判 `reject` 或 `risk`。

**第二关，本地安全准入**（`admission-engine.js`）再查一遍评分、体积、Free 剩余时长和分享率。
两关都过才发送。

并发数**只提示不拦截**——下载器自己有队列，超出上限的任务会排队而不是丢失。

候选按 **Free 剩余时间从多到少** 排序推送：剩余越长越有把握在 Free 结束前下完，
快到期的即使评分高也很可能被保护机制删掉，先推它是浪费带宽。
`maxPushPerScan`（默认 5）限制单轮数量，剩下的留给下一轮。

## Free 到期保护

入队时会给任务打两个标签：

- `ptagent` —— 标记「这是本工具加的」，没有这个标签的任务一律不碰
- `ptagent-free-end=<ISO 时间>` —— Free 截止时间

保护检查（默认每 60 秒）读这些标签，在**到期前 `guardMinutes` 分钟**（默认 10）
把还没下完的任务连文件一起删掉。以下情况绝不删：

- 任务已完成（还要留着做种）
- 没有 `ptagent` 标签（别人加的任务）
- 打了 `pt_agent_keep` / `pt_agent_nodel` 保护标签

不想让它自动删、只想收到告警，就 `ptagent config set autoDeleteExpired false`。

已经在下载器里但缺截止标签的老任务，用 `ptagent backfill` 回查补上——补上后它们才受保护。

## 数据目录

默认 `~/.ptagent/`，可用 `--home` 或环境变量 `PTAGENT_HOME` 改。

```
~/.ptagent/
├── config.json           # 全部配置：策略、调度、下载器、站点、排除表
└── logs/
    ├── runtime.jsonl     # 运行日志，一行一条 JSON
    └── audit.jsonl       # 生命周期审计
```

`config.json` 里存着下载器密码和站点 API Key。请自行确认它的文件权限。

## WebUI

默认只绑 `127.0.0.1`。要从别的机器访问，必须同时设置访问令牌，否则启动会直接拒绝：

```bash
ptagent config set webHost 0.0.0.0
ptagent config set webToken $(openssl rand -hex 16)
```

启动时会打印带 token 的完整地址。页面上永远看不到密码和 API Key——
接口出站前一律脱敏，只回一个「填过没有」的标记。

## 开机自启

**systemd（Linux）** —— `/etc/systemd/system/ptagent.service`：

```ini
[Unit]
Description=PT Agent Daemon
After=network-online.target

[Service]
Type=simple
User=你的用户名
Environment=PTAGENT_HOME=/home/你的用户名/.ptagent
ExecStart=/usr/bin/node /path/to/pt-agent-daemon/bin/ptagent.js start
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ptagent
journalctl -u ptagent -f
```

**launchd（macOS）** —— `~/Library/LaunchAgents/com.ptagent.daemon.plist`，
`ProgramArguments` 填 `node /path/to/bin/ptagent.js start`，`RunAtLoad` 设 `true`。

**Docker / 群晖** —— 挂载一个卷到 `/data`，设 `PTAGENT_HOME=/data`，命令 `node bin/ptagent.js start`。

## 排查

出问题先看这三条：

```bash
ptagent doctor                    # 配置、决策引擎完整性、连通性
ptagent logs --level error -n 50  # 只看错误
ptagent audit -n 30               # 什么被加了、什么被删了
```

几个常见情况：

- **「站点 X 还没填 API Key」** —— `ptagent site list` 看是不是有多条站点记录，
  被一条空的挡住了。`ptagent site add --api-key <KEY>` 默认会更新同类型的已有记录而不是新建。
- **「qBittorrent 已封禁当前 IP」** —— 密码错了导致连续登录失败触发封禁。
  守护进程会自动退避 30 分钟不再重试（继续撞只会把封禁窗口无限续期）。
  改对密码后到 qB 的「设置 → Web UI → 封禁客户端」里解封，或重启 qB。
- **任务发出去了但下载器里没有** —— 日志里搜 `push:not-landed`。
  常见原因是保存目录无效或种子被下载器拒绝。慢的 NAS 可以调大 `verifyAttempts`。

## 测试

```bash
npm test
```

68 个测试，其中 `scan-flow.test.js` 和 `guard.test.js` 用一个假网络
（同时扮演 M-Team 和 qBittorrent）把完整链路真跑一遍——
会出问题的从来不是单个函数，而是它们串起来的边界：会话过期、409 冲突、种子字节取不到时的降级。

`vendor-sync.test.js` 另外锁住了「能单独发布」这件事本身：
除了校验副本一致性，还会扫描 `src/` 和 `bin/`，确认没有任何一处又引用回 `pt-agent-extension` 目录——
这种引用一旦漏网，只有在单独部署后运行时才会炸出来。
