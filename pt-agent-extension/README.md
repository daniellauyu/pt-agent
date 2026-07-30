# PT Agent Helper Chrome Extension

这是 PT Agent 的第一版 Chrome 插件 Demo。

## 当前能力

- 点击插件图标后打开紧凑小窗
- 小窗可在当前 Chrome 窗口中新建标签页打开完整工作台
- 插件内置 M-Team 页面地址和 API 地址，无需先打开 M-Team 页面即可加载资源、账号、回填标签和下载
- 独立的「设置」菜单，下载器和站点分开配置
- 支持配置多台下载器，并按网络可达性自动在内网 / 外网地址之间切换
- 下载器地址由插件在运行时按需申请主机权限，改地址不再需要改 manifest
- 「下载中」面板可查看当前任务、进度和速度
- 将“可下载资源”和“下载中”拆分成两个独立菜单
- 支持单个资源“一键下载”和批量“一键下载推荐”，下载由插件本地准入后直连 qBittorrent
- 插件在每次入队时本地执行安全准入
- 首次发送时自动创建并使用 qBittorrent 的 `PT_AGENT` 分类
- 自动写入 `ptagent` 标签，并以保留时区的 ISO 8601 标签记录 Free 截止时间
- qBittorrent 任务列表会单独显示从标签读取出的 Free 截止时间
- 资源按钮会根据 qB 状态显示“一键下载”“下载中”或“已下载”
- M-Team 账号概况通过站点 API 显示分享率、上传量、下载量、当前魔力、每小时魔力、做种数和做种体积
- 支持回查 qB 中原先添加且仍在下载的 M-Team 任务，按名称与字节体积精确匹配后补写当前 Free 截止标签；已完成和做种中的任务不会修改
- M-Team 资源默认通过 API 聚合普通区与成人区的多页当前 Free 数据，每页 100 条，连续两页无 Free 后停止并按种子 ID 去重
- M-Team 分页 API 获取失败时自动降级为当前页面 DOM 扫描
- 推荐资源要求下载人数严格大于做种人数，同时仍需满足做种供给稳定、Free 时间充足等安全条件
- 对 1–2 个做种但下载需求极高的稀缺资源增加机会模型：体积不超过单任务上限（50GB）、Free 至少 6 小时、下载人数至少 20、下载/做种比至少 10、完成所需均速不超过 512KiB/s 时允许推荐，以提高获得上传量的机会。能否下完由"所需均速"判断，不再另设固定 GB 上限
- 资源列表按 Free 剩余时间从多到少排序（缺少截止时间的排在最后），并显示完整发布时间
- 做种数和做种容量按 qB 全库中所有已完成的 M-Team 任务统计，不按 `ptagent` 标签过滤；每小时魔力仍显示 M-Team Tracker 实际计算值
- 新手考核卡显示上传、下载、魔力三项缺口、截止底线、提前 5 天安全目标、当前安全余量和截止预计魔力
- 根据 Tracker 认可做种容量与当前魔力效率，显示建议总容量和还需新增容量区间（插件本地预测）
- 新手考核卡会统计 qB 中 `queuedUP` 与实际活跃的 M-Team 做种任务，优先提示上传队列导致 Tracker 未认可做种的问题
- Free Guard 由插件后台每分钟检查一次；默认只做只读预警
- 自动删除默认关闭；显式启用后仍会保护 `PT_AGENT_NODEL/KEEP` 标签任务
- 下载提交、准入失败、Free 预警、保护删除和后台异常保存在本地审计记录中，支持导出 JSON
- 纯本地运行，无需任何后端服务；所有扫描、准入、下载、生命周期管理都在插件内完成
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

## 配置下载器和站点

首次使用先复制不含密钥的模板，用于填充初始值：

```bash
cp private-config.example.js private-config.js
```

旧版本的单下载器设置（`ptAgentQbSettings`）会在首次运行时自动迁移成一条下载器记录，其中的 M-Team API Key 会自动迁到站点配置里，不需要手工搬。

### 下载器（设置 → 下载器）

1. 点「新增下载器」，填写名称、地址、账号、密码，点「保存」。
2. 保存时浏览器会弹出该地址的访问授权，必须允许，否则插件无法访问该下载器。
3. 点「测试连接」确认可用。

每台下载器可单独设置下载目录和分类（默认 `PT_AGENT`）。密码保存在当前扩展的
`chrome.storage.local` 中。普通的「扫描 JSON」会脱敏；用于迁移到终端守护进程的
「含密钥配置」会包含密码和 API Key，导出时会二次确认，文件只能传到你自己的设备。

### 内外网自动切换

Chrome 扩展读不到 WiFi SSID（`chrome.networking.onc` 只在 ChromeOS 企业环境可用），因此插件不判断"连的是哪个网"，而是**按可达性自动选路**：

- 按列表从上到下依次探测每台下载器（3 秒超时，只做可达性检查，不登录）
- 用第一台连得通的，结果缓存 30 秒
- 内网时局域网地址通；换到外网后它超时失败，自动落到下一条公网地址

把内网地址用 ↑ 排在外网地址前面即可。**同一台 qB 的内网和外网地址请各建一条记录**。「重新探测」可以立即重新选路。

### 站点（设置 → 站点）

站点地址、API 地址和 API Key 单独配置，支持多站点。目前资源聚合只实现了 M-Team 的 API 模式，其它站点走页面 DOM 扫描。

### 跨站请求与 403

浏览器地址栏访问 qB 是同站请求，插件发出的是跨站请求（Origin 为 `chrome-extension://<id>`）。qBittorrent 的 CSRF 保护会比较 Origin/Referer 与自身 Host，不一致就返回 403 —— 这就是「浏览器能登录，插件却 403」的原因。

qB 的判定规则是「Origin 和 Referer 都为空则不算跨站请求」，因此插件用 `declarativeNetRequest` 在发出请求前剥掉这两个头，**你不需要关闭 qB 的 CSRF 保护**。实现要点（参考 PT-depiler）：

- 用 **session rules** 而非 dynamic rules，不写盘，浏览器重启即失效
- 每次请求现建一条唯一 id 的规则，请求结束立即删除，生效窗口最小
- 用 `excludedTabIds` 排除所有其它标签页

最后一条是安全关键：DNR 规则按请求目标 URL 匹配，若不排除标签页，任意网页向同一个 qB 地址发起的跨站 XHR 也会被剥掉 Origin，等于替所有网站关掉了 qB 的 CSRF 保护。规则只对插件自己发出的请求生效。

权限用的是 `declarativeNetRequestWithHostAccess`，只能作用于你已授权的下载器地址。

### 仍需在 qB 侧处理的情况

剥掉请求头解决不了下面两类 403，需要你自己改配置：

- **验证 Host 头**：qB「选项 → Web UI」里的「验证 Host 头」会拿 `Host` 与「服务器域名」白名单比对。外网用域名访问时，要把域名加进白名单（填 `*` 放行全部）
- **反向代理 / Cloudflare**：nginx、frp 或 Cloudflare 的 WAF、Bot Fight Mode 可能拦截跨站 XHR。此时 403 来自代理而不是 qB

「独立诊断」会分阶段报告网络可达性、登录鉴权和 Web API；日志页展开 `qb:res-error` 能看到响应体前 300 字符和 `server` 头，可以直接判断是 qB 还是代理拒绝的。

## 加载方式

1. 打开 Chrome：

   chrome://extensions/

2. 开启开发者模式。

3. 点击“加载已解压的扩展程序”。

4. 选择目录：

   <仓库目录>/pt-agent-extension

## 使用方式

无需先打开 M-Team 页面。直接点击插件图标即可通过 M-Team API 加载账号和多页 Free 数据；点击“新标签页打开”会在当前 Chrome 窗口打开完整工作台。“打开 M-Team”仅作为可选入口。

插件纯本地运行，不依赖任何后端服务：所有历史、审计记录都保存在 Chrome 扩展的本地存储中。

## 本地安全准入与下载策略

发种子到下载器之前有两道关：

1. **决策引擎**（扫描时，逐个资源）——按 Free 类型、剩余时间、做种/下载人数、体积、HR 判定为推荐 / 风险 / 拒绝并打分
2. **准入引擎**（点下载的那一刻）——在决策结果之上，再检查当前全局状态：正在下载的任务数、账号分享率

分成两步是因为并发数、分享率这类条件会随时变化，只能在入队瞬间判断。任意一条不满足就拦下，按钮显示「准入拦截」，悬停可看具体原因。

准入条件在 **设置 → 下载策略** 里全部可改，保存后立即重新评估当前列表，不需要重新扫描：

| 参数 | 默认值 | 说明 |
|---|---|---|
| 并发提醒阈值 | 3 | **仅提示不拦截**：超过后仍会发送，任务在下载器里排队 |
| 最低评分 | 80 | 决策引擎评分低于此值不自动下载 |
| 单任务体积上限 | 50GB | |
| Free 最短剩余 | 12 小时 | 稀缺高需求资源可豁免 |
| 最低分享率 | 1.0 | 填 0 表示不检查 |
| 拒绝 HR 任务 | 开 | |
| 缺少 Free 截止时间时标记为风险 | 开 | |

并发数只提示不拦截——下载器自己有队列，超出的任务会排队而不是丢失。提示里会提醒注意 Free 是否来得及。

统计并发时只计入真正占用下载槽的任务；暂停（pausedDL / stoppedDL）和排队（queuedDL）的不计入。

其余固定规则（暂不可配）：

- 非 Free / 2xFree 默认拒绝
- Free 已到期默认拒绝
- 0 做种默认风险
- 下载人数不高于做种人数不进入推荐
- Free 剩余进入保护窗口（默认 10 分钟）默认风险

## Free Guard

插件重新加载后会注册每分钟一次的后台检查。默认只做只读预警；在“下载中”面板显式开启“到期前自动删除”后，插件后台会执行删除。只处理同时满足以下条件的任务：

- 带有独立的 `ptagent` 标签
- 下载进度未完成
- 有可解析的 Free 截止标签
- 已进入配置的保护窗口，或 Free 已到期
- 不带 `PT_AGENT_NODEL/KEEP` 保护标签

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

## 下载器适配层

`downloader-registry.js` 定义了统一的下载器接口（`probe / login / getVersion / diagnose / listTorrents / addTorrent / addTags / deleteTorrents / ensureCategory`），上层只依赖这一层。

- **qBittorrent**：已完整实现
- **Transmission / Deluge**：已预留类型和能力声明（`capabilities.categories = false`），适配器尚未实现，在设置里显示为「即将支持」

新增下载器类型只需在 registry 里补一个 `create()`，把返回值转换成规范任务形状（沿用 qBittorrent 的字段命名），无需改动调用方。

## 下一步

- Transmission / Deluge 适配器实现
- RSS 资源发现与规则任务
- 消息通知和考核完成提醒
