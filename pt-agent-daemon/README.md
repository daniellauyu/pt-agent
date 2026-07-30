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
./install.sh        # 推荐：检查环境、建数据目录、装 ptagent 命令、跑一次体检
```

不想用脚本就直接 `node bin/ptagent.js <命令>`，或者 `npm link` 之后用 `ptagent`。

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

## 用 .env 搬到另一台机器

配置调好以后，把整份配置装进一个 `.env` 文件带走：

```bash
ptagent config export-env .env      # 导出（含密码，权限自动设 600）
```

把这个 `.env` 拷到新机器的 `~/.ptagent/.env` 或运行目录下，`ptagent doctor` 应该直接全绿。

**从浏览器插件搬过来**：插件的「设置 → 配置迁移 → 导出配置 JSON」会把下载器、站点、
下载策略和排除记录一并导出，然后：

```bash
ptagent import pt-agent-config-xxx.json   # 整体导入
ptagent doctor                            # 验一下
ptagent config export-env .env            # 再生成便携配置
```

### 规则：写在 .env 里的以 .env 为准

`.env` 里定义的项**每次启动都会覆盖 `config.json` 里的对应字段**。没写进 `.env` 的字段
不受影响，照常可以在 WebUI 里改。

这条规则必须记住，否则会遇到「在 WebUI 改了、重启后被改回去」这种查不出原因的怪事。
所以：

- `ptagent doctor` 的「配置来源」一项会告诉你 `.env` 当前托管了多少项
- `ptagent config set` 改到被托管的键时，会当场警告下次启动会被覆盖
- **`.env` 里只要写了下载器或站点，就会整份接管对应的列表**（不做合并）——
  列表顺序就是探测优先级，两个来源混在一起以后光看 `.env` 说不清实际会先连哪一台。
  被顶掉的记录会记进日志（`config:env-replaced-lists`），不是静默丢弃。

不想让 `.env` 生效就加 `--no-env`。

### 优先级与查找顺序

**进程环境变量 > `.env` 文件 > `config.json`**。

Docker 的 `-e`、systemd 的 `Environment=` 传进来的 `PTAGENT_*` 会压过 `.env` 里的同名项，
不需要重新打镜像就能改一个值。没有 `.env` 文件时，光靠环境变量也能完整配置——容器里就是这么跑的。

`.env` 文件的查找顺序：

1. `--env <文件>` 或环境变量 `PTAGENT_ENV_FILE`
2. `$PTAGENT_HOME/.env`（默认 `~/.ptagent/.env`）
3. 运行目录下的 `.env`
4. 项目根目录的 `.env`

`.env.example` 是不含密钥的完整模板，复制一份改成 `.env` 即可。
`PTAGENT_HOME` 这一项只有写在第 1、3、4 处才有意义——要先知道数据目录才能找到数据目录里的 `.env`。

值里有空格或 `#` 时用引号包起来（密码里带 `#` 很常见）：

```
PTAGENT_DOWNLOADER_1_PASSWORD="pa ss#word"
```

导出时会自动加引号，往返不会变样。

## 数据目录

默认 `~/.ptagent/`，可用 `--home` 或环境变量 `PTAGENT_HOME` 改。

```
~/.ptagent/
├── .env                  # 可选。写在这里的项每次启动覆盖 config.json
├── config.json           # 全部配置：策略、调度、下载器、站点、排除表
└── logs/
    ├── runtime.jsonl     # 运行日志，一行一条 JSON
    └── audit.jsonl       # 生命周期审计
```

`.env` 和 `config.json` 里都存着下载器密码和站点 API Key。
`export-env` 生成的文件权限是 600，仓库的 `.gitignore` 也挡掉了 `.env`。
完整配置必须指定目标文件；不允许直接打印到终端。只需要模板时使用
`ptagent config export-env --no-secrets`。

## WebUI

默认只绑 `127.0.0.1`。要从别的机器访问，必须同时设置访问令牌，否则启动会直接拒绝：

```bash
ptagent config set webHost 0.0.0.0
ptagent config set webToken $(openssl rand -hex 16)
```

启动时只打印不含 token 的地址。打开页面后输入访问令牌，令牌只保存在当前标签页，
并通过 `Authorization` 请求头发送，不进入 URL、浏览器历史或访问日志。
页面上永远看不到密码和 API Key——接口出站前一律脱敏，只回一个「填过没有」的标记。

## 部署

完整的部署说明在 **[DEPLOY.md](DEPLOY.md)**：一键安装脚本、systemd / launchd 服务、
Docker 与群晖、搬迁到另一台机器、以及跑起来之后怎么看。

```bash
./install.sh                     # 检查环境、建数据目录、装 ptagent 命令、体检
./scripts/service.sh install     # 装成开机自启的后台服务
docker compose up -d             # 或者用 Docker
```

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

100 个测试，其中 `scan-flow.test.js` 和 `guard.test.js` 用一个假网络
（同时扮演 M-Team 和 qBittorrent）把完整链路真跑一遍——
会出问题的从来不是单个函数，而是它们串起来的边界：会话过期、409 冲突、种子字节取不到时的降级。

`vendor-sync.test.js` 另外锁住了「能单独发布」这件事本身：
除了校验副本一致性，还会扫描 `src/` 和 `bin/`，确认没有任何一处又引用回 `pt-agent-extension` 目录——
这种引用一旦漏网，只有在单独部署后运行时才会炸出来。

`env.test.js` 专门锁住往返一致性：一份配置导出成 `.env` 再读回来，
每个值——包括带空格和 `#` 的密码——都必须和原来一模一样。
搬到另一台机器后某个值悄悄变了样，是这套流程最难查的失败。
