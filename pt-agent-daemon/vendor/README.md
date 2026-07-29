# vendor/engines —— 不要手工编辑这里的任何文件

这个目录里的 12 个 `.js` 是**浏览器插件 `pt-agent-extension/` 的逐字节副本**，
不是本项目的源码。守护进程靠它们做评分、决策、准入判定、Free 到期保护和下载器通信。

## 为什么要有副本

决策逻辑必须和插件完全一致，否则会出现「插件说推荐、终端说拒绝」这种没法解释的分歧。
但守护进程又要能单独打包发到 NAS 上跑，不该拖着一个 Chrome 扩展的源码目录。

折中办法就是这里：**副本 + 校验**。副本让它能独立发布，校验保证副本不会和源头悄悄跑偏。

## 怎么改

不要改这里。要改判定规则，去改 `pt-agent-extension/` 里的对应文件，然后：

```bash
npm run sync-engines     # 重新拷贝并更新 MANIFEST.json
npm test                 # vendor-sync 测试会确认两边一致
```

`MANIFEST.json` 记录每个文件的 sha256 和同步时间。校验分两层：

| 校验 | 抓什么 | 什么时候能跑 |
|---|---|---|
| 副本 vs MANIFEST | 有人手工改了 vendor 文件 | 任何时候，包括单独发布的副本 |
| 副本 vs 插件源文件 | 插件改了但忘了同步 | 只在完整仓库里 |

```bash
npm run check-engines    # 手动校验，有问题退出码 1
```

## 清单

| 文件 | 作用 |
|---|---|
| `decision-engine.js` | 资源评分与 推荐/风险/拒绝 判定 |
| `admission-engine.js` | 本地安全准入（评分、体积、Free 剩余、分享率） |
| `guard-engine.js` | Free 到期状态判定 |
| `assessment-engine.js` | 新手考核期魔力进度测算 |
| `qb-client.js` | qBittorrent WebUI API 客户端 |
| `downloader-registry.js` | 下载器适配层（qB 已实现，Transmission / Deluge 预留） |
| `downloader-store.js` | 多下载器配置与内网地址识别 |
| `site-store.js` | 多站点配置 |
| `network-router.js` | 按可达性自动选路（内外网切换） |
| `exclusion-store.js` | 已排除种子 |
| `torrent-links.js` | 站点资源 ↔ 下载器任务的持久化关联 |
| `mteam-backfill.js` | M-Team 搜索匹配与 Free 截止时间提取 |
