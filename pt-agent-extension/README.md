# PT Agent Helper Chrome Extension

这是 PT Agent 的第一版 Chrome 插件 Demo。

## 当前能力

- 点击插件图标后打开紧凑小窗
- 小窗可在当前 Chrome 窗口中新建标签页打开完整工作台
- 插件内置 M-Team 页面地址和 API 地址，无需先打开 M-Team 页面即可加载资源、账号、回填标签和下载
- 提供“我的下载器”面板，可连接 qBittorrent WebUI、查看当前任务、进度和速度
- 将“可下载资源”和“下载中”拆分成两个独立菜单
- 支持单个资源“一键下载”和批量“一键下载推荐”
- 单个下载和批量下载共用安全准入闸门：推荐级别、评分至少 80、单任务不超过 50GB、Free 至少剩余 12 小时、分享率至少 1.0、全 qB 活动下载最多 3 个
- 首次发送时自动创建并使用 qBittorrent 的 `PT_AGENT` 分类，避免与其他下载任务混在一起
- 发送到 qBittorrent 时，自动写入固定的 `ptagent` 标签，并把 Free 截止时间写成 `YYYY-MM-DD HH:mm:ss` 标签
- qBittorrent 任务列表会单独显示从标签读取出的 Free 截止时间
- 资源按钮会根据 qB 状态显示“一键下载”“下载中”或“已下载”
- M-Team 账号概况通过站点 API 显示分享率、上传量、下载量、当前魔力、每小时魔力、做种数和做种体积
- 支持回查 qB 中原先添加且仍在下载的 M-Team 任务，按名称与字节体积精确匹配后补写当前 Free 截止标签；已完成和做种中的任务不会修改
- M-Team 资源默认通过 API 聚合普通区与成人区的多页当前 Free 数据，每页 100 条，连续两页无 Free 后停止并按种子 ID 去重
- M-Team 分页 API 获取失败时自动降级为当前页面 DOM 扫描
- 推荐资源要求下载人数严格大于做种人数，同时仍需满足做种供给稳定、Free 时间充足等安全条件
- 资源列表按发布时间倒序排列，并显示完整发布时间
- 做种数和做种容量按 qB 全库中所有已完成的 M-Team 任务统计，不按 `ptagent` 标签过滤；每小时魔力仍显示 M-Team Tracker 实际计算值
- 新手考核卡按 6000 魔力目标显示当前进度、缺口、当前速度预计完成时间，并以注册时间后 30 天作为估算窗口反推所需每小时魔力、提升倍数和做种规模；容量为按当前效率线性粗估，实际截止时间以站内通知为准
- 新手考核卡会统计 qB 中 `queuedUP` 与实际活跃的 M-Team 做种任务，优先提示上传队列导致 Tracker 未认可做种的问题
- Free Guard 由扩展后台每分钟检查一次，只管理带 `ptagent` 标签的未完成任务；下载页显示预计完成时间、无法完成、保护窗口、已到期和缺少截止标签
- Free Guard 的自动删除默认关闭；手动开启并二次确认后，进入保护窗口的未完成任务会从 qB 删除并同步删除文件
- 下载提交、准入失败、Free 预警、保护删除和后台异常保存在本地审计记录中，支持导出 JSON
- 内置本地 PT Core Service 地址，支持手动同步和扫描后自动同步资源、账号、qB 全库 M-Team 做种汇总与审计记录；Core 离线不影响原有扫描和下载
- 根据站点配置匹配当前网站
- 检测当前站点是否可用：
  - 种子行
  - 标题
  - 下载链接
  - 大小
  - Free 标识
  - Free 截止时间
  - 做种/下载人数
  - HR 状态
- 扫描当前页面的 `.torrent-row`
- 解析资源字段：
  - 标题
  - 大小
  - Free 类型
  - Free 开始时间
  - Free 截止时间
  - Free 剩余时间与绝对截止时间分栏展示
  - 做种人数
  - 下载人数
  - HR 状态
  - 下载链接
- 解析账号字段：
  - 上传量
  - 下载量
  - 分享率
  - 魔力
  - 做种容量
- 按默认安全策略标记：
  - 推荐
  - 风险
  - 拒绝
- 支持复制 / 下载扫描 JSON

## 配置 qBittorrent

扩展通过本地 `private-config.js` 读取 qBittorrent 地址、账号、密码、M-Team 页面地址、API 地址和 API Key。仓库只提供不含密钥的模板；首次使用先复制：

```bash
cp private-config.example.js private-config.js
```

然后填写本机配置：

1. 在“小窗模式”向下滚动，或点击“全屏模式”打开完整工作台。
2. 点击“测试连接”确认 qBittorrent 可用。
3. 在资源行点击“一键下载”，或点击顶部“一键下载推荐”。

密码和 M-Team API Key 会从本地 `private-config.js` 写入当前扩展的 `chrome.storage.local`，不会包含在导出的扫描 JSON 中。`private-config.js` 已被 Git 忽略，请勿上传或分享。

如果测试连接提示 `403`、CSRF、Origin 或 Host Header 错误，请先确认 Chrome/Surge 对 `192.168.1.10` 走局域网直连，再检查 qBittorrent WebUI 的 CSRF 和反向代理设置。

## 加载方式

1. 打开 Chrome：

   chrome://extensions/

2. 开启开发者模式。

3. 点击“加载已解压的扩展程序”。

4. 选择目录：

   /Users/daniellau/Desktop/huixing/Developer/PTAgentHub/pt-agent-extension

## 使用方式

无需先打开 M-Team 页面。直接点击插件图标即可通过 M-Team API 加载账号和多页 Free 数据；点击“新标签页打开”会在当前 Chrome 窗口打开完整工作台。“打开 M-Team”仅作为可选入口。

如需持久化历史数据，先启动 `pt-core-service`，插件会自动连接 `http://127.0.0.1:8090/`。顶部状态显示“Core 已连接”后，每次扫描会自动同步；也可点击“同步 Core”手动执行。Core 未启动时只显示离线，不影响 qB 下载功能。

## 默认策略

- HR 任务默认拒绝
- 自动下载最低评分 80
- 最大同时活动下载 3 个
- 单任务最大 50GB
- 分享率低于 1.0 不自动下载
- 非 Free / 2xFree 默认拒绝
- 缺少 Free 截止时间默认风险
- Free 剩余不足 12 小时默认风险
- Free 剩余进入 10 分钟保护窗口默认风险
- 超过 50GB 默认风险

## Free Guard

插件重新加载后会注册每分钟一次的后台检查。默认只监控和记录，不删除任何任务或文件。

如果确实需要自动保护，可在“下载中 → Free Guard”开启“进入保护窗口后自动删除任务和文件”。开启时会再次确认，且后台只会处理同时满足以下条件的任务：

- 带有独立的 `ptagent` 标签
- 下载进度未完成
- 有可解析的 Free 截止标签
- 已进入配置的保护窗口，或 Free 已到期

完成任务、没有 `ptagent` 标签的任务和缺少截止时间的任务不会自动删除。

## 网站配置

站点配置在：

    site-definitions.js

当前内置：

- `mock-mteam`：用于 `mock-pt-site.html`
- `mteam`：M-Team 初始适配占位

配置结构：

```js
{
  id: "mteam",
  name: "M-Team",
  domains: ["m-team.cc", "kp.m-team.cc"],
  selectors: {
    rows: ".torrent-row",
    title: ".torrent-title-link",
    downloadUrl: ".torrent-download",
    size: ".size",
    freeLabel: ".free-label",
    freeEnd: ".free-end",
    seeders: ".seeders b",
    leechers: ".leechers b",
    hr: ".tag-hr"
  },
  attributes: {
    torrentId: "data-torrent-id",
    freeType: "data-free-type",
    freeEnd: "data-free-end"
  },
  requiredFields: ["rows", "title", "downloadUrl", "size", "freeLabel", "freeEnd"]
}
```

如果当前网站未命中配置，插件会进入通用扫描模式，只尝试识别下载链接。

## 下一步

- 增加“导入到 PT Agent 后端”
- 增加右侧页面浮窗
- 增加站点定义配置
- 增加 M-Team 页面适配
- 增加 Free 到期保护提示
