# 给 agent 看的接入说明

这个守护进程的每条命令都能加 `--json`，输出稳定的结构化结果；日志和审计是 JSONL，
可以逐行 `JSON.parse`。下面是最常用的几条路径。

## 先搞清楚现在是什么状态

```bash
ptagent status --json
```

关键字段：

| 字段 | 含义 |
|---|---|
| `nextScanAt` | 下次扫描的 ISO 时间，`null` 表示调度器没在跑 |
| `lastScanAt` / `lastGuardAt` | 上次扫描 / 上次 Free 保护检查 |
| `lastScan.counts` | `{ total, recommend, risk, reject }` |
| `lastScan.pushed[]` | 实际推送的资源，含 `duplicate`（是否已存在）和 `route`（`file` 或 `url`） |
| `lastScan.skipped[]` | 被本地安全准入拦下的，`reasons[]` 是中文原因 |
| `lastScan.failed[]` | 推送失败的，`error` 是原因 |
| `daemon.autoDownload` | `false` 表示只评估不推送 |
| `policy.autoDeleteExpired` | Free 到期是否自动删除 |

`webToken` 在输出里恒为 `"***"` 或 `""`，不会泄漏真实令牌。

## 判断「有没有出问题」

按这个顺序查，不要一上来就读全量日志：

```bash
ptagent doctor --json                        # 配置与连通性，失败时退出码 1
ptagent logs --level error -n 50 --json      # 只看错误
ptagent audit -n 30 --json                   # 什么被加了、什么被删了
```

`doctor` 的 `checks[]` 每项是 `{ label, ok, detail }`，`ok` 为整体结论。
退出码非 0 就是有检查没过。其中「决策引擎」一项会报出 `vendor/engines/` 的同步来源和日期——
要确认跑的是哪一版判定规则，看这里。

## 日志

`~/.ptagent/logs/runtime.jsonl`，每行：

```json
{"at":"2026-07-30T02:11:04.512Z","level":"info","event":"push:add","operationId":"op_...","data":{...}}
```

- `level`：`debug` / `info` / `warn` / `error`
- `operationId`：同一轮扫描或同一次保护检查里的所有条目共享，**按它聚合就能还原完整因果链**
- 过滤：`--level warn`（该级别及以上）、`--prefix push:`（事件前缀）

值得认识的事件前缀：

| 前缀 | 含义 |
|---|---|
| `scan:` | 扫描生命周期（`scan:start` / `scan:catalog` / `scan:evaluated` / `scan:done`） |
| `push:` | 推送（`push:add` / `push:verify` / `push:admission-rejected` / `push:error` / `push:not-landed`） |
| `guard:` | Free 保护（`guard:warning` / `guard:deleted` / `guard:auth-backoff`） |
| `mteam:` / `site:` | 站点请求 |
| `qb:` | 下载器请求 |
| `downloader:route` | 这轮选了哪台下载器、其它几台为什么没选上 |
| `runtime.` | 未捕获异常和未处理的 Promise 拒绝 |
| `webui:error` | WebUI 接口出错 |

`push:not-landed` 值得单独注意：下载器接受了请求但任务没出现，
通常是保存目录无效、种子被拒，或元数据解析太慢。

## 审计

`~/.ptagent/logs/audit.jsonl`，字段和浏览器插件那边同构，
所以同一套分析脚本能同时吃两边导出的数据。

`action` 取值：`enqueue`、`enqueue_manual_override`、`enqueue_error`、
`guard_warning`、`guard_delete`、`guard_error`。

**删除文件只会出现在 `action: "guard_delete"` 且 `deleteFiles: true` 的记录里**，
要复盘「我的文件为什么没了」，只查这一类即可。

## 触发动作

```bash
ptagent scan --dry-run --json    # 只评估，绝不动下载器
ptagent scan --json              # 扫描并推送
ptagent guard --dry-run --json   # 报告会删什么，但不真删
ptagent push 12345 --json        # 推送指定种子 ID（必须在最近一次扫描结果里）
```

**改动性操作的安全边界**：`--dry-run` 保证不产生任何副作用；
`ptagent push --force` 会跳过本地安全准入，代替用户做判断前先问过用户。

## HTTP 接口

守护进程跑起来后，同样的数据可以从 WebUI 的接口拿（默认 `http://127.0.0.1:7788`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 同 `ptagent status` |
| GET | `/api/resources` | 最近一次扫描的完整评估结果 |
| GET | `/api/tasks` | 下载器实时任务 |
| GET | `/api/logs?limit=&level=&prefix=` | 运行日志 |
| GET | `/api/audit?limit=` | 审计 |
| POST | `/api/scan` | body `{ "dryRun": true }` |
| POST | `/api/guard/run` | body `{ "dryRun": true }` |
| POST | `/api/push` | body `{ "torrentIds": ["12345"], "manualOverride": false }` |

配置了 `webToken` 时需要 `Authorization: Bearer <token>` 或 `?token=<token>`。

密码、API Key、访问令牌在所有接口出站前一律脱敏，只会返回 `hasPassword` / `hasApiKey` / `hasWebToken`。

## 配置从哪来

优先级：`.env` > `config.json`。`.env` 里定义的项每次启动覆盖 `config.json` 的对应字段，
没定义的照常可改。判断当前哪些项被托管：

```bash
ptagent doctor --json    # checks[] 里「配置来源」一项会说明
```

日志里的 `config:env-applied` 记录了本次托管的键数量，
`config:env-replaced-lists` 记录了因 `.env` 定义了下载器/站点而被顶掉的旧记录。

**改配置时要注意**：如果目标键由 `.env` 托管，`ptagent config set` 只在本次运行有效，
下次启动会被覆盖回去（CLI 会当场警告）。要永久改，改 `.env`。

## 改代码时要知道的

- **决策逻辑不要在这个子项目里改**。评分、决策、准入、Free 保护、qBittorrent 客户端位于
  `vendor/engines/`，是 `../pt-agent-extension/` 的逐字节副本。
  要改判定规则：改插件那边的源文件，然后 `npm run sync-engines`。
  直接改 `vendor/` 会被 `vendor-sync.test.js` 拦下（MANIFEST 记了每个文件的 sha256）。
- **不要在 `src/` 或 `bin/` 里引用 `pt-agent-extension`**。这个子项目要能单独发布，
  有一处引用就会让独立部署在运行时炸掉；`vendor-sync.test.js` 里有专门的扫描测试挡这件事。
- 加了任何行为改动，跑 `npm test`。`test/helpers.js` 提供的假网络同时扮演 M-Team 和
  qBittorrent，新场景往那里加分支即可，不需要打桩内部函数。
- 提交遵循仓库约定：`vX.Y.Z:中文说明`。
