# PT Agent Helper Chrome Extension

这是 PT Agent 的第一版 Chrome 插件 Demo。

## 当前能力

- 点击插件图标后打开紧凑小窗
- 小窗可在当前 Chrome 窗口中新建标签页打开完整工作台
- 插件内置 M-Team 页面地址和 API 地址，无需先打开 M-Team 页面即可加载资源、账号、回填标签和下载
- 提供“我的下载器”面板，可连接 qBittorrent WebUI、查看当前任务、进度和速度
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
- 对 1–2 个做种但下载需求极高的稀缺资源增加机会模型：体积不超过 10GB、Free 至少 6 小时、下载/做种比至少 10、完成所需均速不超过 512KiB/s 时允许推荐，以提高获得上传量的机会
- 资源列表按发布时间倒序排列，并显示完整发布时间
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

插件纯本地运行，不依赖任何后端服务：所有历史、审计记录都保存在 Chrome 扩展的本地存储中。

## 默认策略

- HR 任务默认拒绝
- 自动下载最低评分 80
- 最大同时活动下载 3 个
- 单任务最大 50GB
- 分享率低于 1.0 不自动下载
- 非 Free / 2xFree 默认拒绝
- 缺少 Free 截止时间默认风险
- Free 剩余不足 12 小时默认风险
- 低做种高需求且可在 Free 内低速完成的小体积资源，可豁免 12 小时硬门槛
- Free 剩余进入 10 分钟保护窗口默认风险
- 超过 50GB 默认风险

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

## 下一步

- RSS 资源发现与规则任务
- 消息通知和考核完成提醒
- Agent Skill 与多下载器适配
