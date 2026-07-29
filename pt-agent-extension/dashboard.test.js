const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionDir = __dirname;

test("opens the dashboard in a new tab without requiring an M-Team source tab", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /searchParams\.set\("mode", "dashboard"\)/);
  assert.match(script, /chrome\.tabs\.create/);
  assert.match(script, /windowId:\s*tab\?\.windowId/);
  assert.match(script, /active:\s*true/);
  assert.doesNotMatch(script, /chrome\.windows\.create/);
});

test("loads M-Team account, catalog, and download tokens directly from the extension", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const mteamRequest = async/);
  assert.match(script, /const site = activeSite\(\)/);
  assert.match(script, /new URL\(String\(path\)\.replace\(\/\^\\\/\+\/, ""\), site\.apiUrl\)/);
  assert.match(script, /mteamRequest\("\/api\/member\/profile"/);
  assert.match(script, /mteamRequest\("\/api\/torrent\/search"/);
  assert.match(script, /mteamRequest\(\s*"\/api\/torrent\/genDlToken"/);
  assert.match(script, /正在从 M-Team API 加载当前 Free/);
});

test("popup offers full-screen mode and a dedicated Free deadline column", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  assert.match(html, /id="fullscreenBtn"/);
  assert.match(html, /id="downloaderPanel"/);
  assert.match(html, /id="downloadRecommendedBtn"/);
  assert.match(html, /id="downloadsView"/);
  assert.match(html, /id="backfillDeadlineBtn"/);
  assert.match(html, /data-view="downloads"/);
  assert.match(html, /Free 截止时间/);
  assert.match(html, /发布时间/);
  assert.match(html, /id="uploaded"/);
  assert.match(html, /id="downloaded"/);
  assert.match(html, /id="bonusPerHour"/);
  assert.match(html, /id="seedingCount"/);
  assert.match(html, /id="newbieAssessment"/);
  assert.match(html, /id="guardMonitorEnabled"/);
  assert.match(html, /id="autoDeleteExpired"/);
  assert.match(html, /id="auditList"/);
  assert.match(html, /class="app-shell"/);
  assert.ok(
    html.indexOf('src="private-config.js"') < html.indexOf('src="popup.js"'),
    "private config must load before popup logic"
  );
});

test("compact mode remains scrollable so the downloader panel is reachable", () => {
  const css = fs.readFileSync(path.join(extensionDir, "popup.css"), "utf8");
  assert.match(css, /body\.mode-popup\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test("keeps the source Free timestamp unchanged for the qBittorrent tag", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /sourceTimestamp/);
  assert.match(script, /return `\$\{sourceTimestamp\[1\]\} \$\{sourceTimestamp\[2\]\}`/);
});

test("configures multiple downloaders and sites from a dedicated settings menu", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(html, /data-view="settings"/);
  assert.match(html, /id="settingsView"/);
  assert.match(html, /id="downloaderList"/);
  assert.match(html, /id="siteList"/);
  assert.match(html, /id="addDownloaderBtn"/);
  assert.match(html, /id="addSiteBtn"/);
  assert.match(html, /id="reprobeDownloadersBtn"/);
  // 旧的单下载器内联表单必须彻底移除，避免两处配置互相覆盖
  assert.doesNotMatch(html, /id="qbAddress"/);
  assert.doesNotMatch(html, /id="mteamApiKey"/);
  assert.doesNotMatch(script, /defaultQbSettings/);
  assert.doesNotMatch(script, /saveQbSettings/);
  ["downloader-registry.js", "downloader-store.js", "site-store.js",
   "network-router.js", "host-permissions.js", "request-rules.js",
   "torrent-links.js"].forEach((file) => {
    assert.ok(
      html.indexOf(`src="${file}"`) > -1 && html.indexOf(`src="${file}"`) < html.indexOf('src="popup.js"'),
      `${file} must load before popup logic`
    );
  });
});

test("exposes every local admission threshold in the download policy panel", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(html, /id="policySettingsPanel"/);
  [
    "policyMaxActiveDownloads",
    "policyMinimumScore",
    "policyMaxTorrentSizeGB",
    "policyMinFreeHours",
    "policyMinimumRatio",
    "policyRejectHr",
    "policyRejectMissingFreeEnd"
  ].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must be editable in the UI`);
    assert.match(script, new RegExp(`\\$\\("${id}"\\)`), `${id} must be read back by popup logic`);
  });
  assert.match(html, /id="savePolicyBtn"/);
  assert.match(html, /id="resetPolicyBtn"/);
  assert.match(script, /const savePolicySettings = async/);
  assert.match(script, /const readPolicySettingsForm =/);
});

test("stops silently tightening the stored admission thresholds", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
  const getSettings = script.match(/const getSettings = async[\s\S]*?\n};/)?.[0] || "";
  assert.ok(getSettings, "getSettings must exist");
  // 这三条硬钳制让界面上调宽的值被静默改回去，已移除
  assert.doesNotMatch(getSettings, /Math\.(min|max)/);
  assert.doesNotMatch(background, /Math\.min\(50, Number\(stored/);
  assert.doesNotMatch(background, /Math\.max\(80, Number\(stored/);
  assert.doesNotMatch(background, /Math\.min\(3, Number\(stored/);
});

test("re-evaluates scanned torrents after a policy change without a rescan", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const reevaluateScannedTorrents =/);
  const save = script.match(/const savePolicySettings = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(save, /reevaluateScannedTorrents\(\)/);
});

test("routes to a downloader by reachability because Chrome cannot read the WiFi SSID", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const selectActiveDownloader = async/);
  assert.match(script, /globalThis\.PT_AGENT_NETWORK_ROUTER/);
  assert.match(script, /router\.selectDownloader\(state\.downloaders/);
  assert.match(script, /adapter\.probe\(/);
  // 没有主机权限时必须给出可操作的提示，而不是笼统的"连接失败"
  assert.match(script, /缺少该地址的访问权限/);
  assert.match(script, /hostPermissions\.ensure/);
});

test("builds every downloader client through the shared adapter layer", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const createDownloaderClient = async/);
  assert.match(script, /PT_AGENT_DOWNLOADER_TYPES\.createAdapter/);
  assert.doesNotMatch(script, /PT_AGENT_QB\.createClient/);
});

test("sends every downloader request through the Origin-stripping fetch", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
  assert.match(script, /const downloaderFetch = requestRules\.wrapFetch/);
  assert.match(background, /wrapFetch\(globalThis\.fetch\.bind\(globalThis\)\)/);
  // 每一处适配器都要用包装后的 fetch，漏一处那条路径就会继续 403
  const adapterCalls = script.match(/createAdapter\(/g) || [];
  const wrappedCalls = script.match(/fetchImpl: downloaderFetch/g) || [];
  assert.equal(
    wrappedCalls.length,
    adapterCalls.length,
    "every createAdapter call must pass the wrapped fetch"
  );
});

test("resource buttons keep one-click download for risk but keep rejects blocked", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /resourceStatus === "downloaded" \? "已下载"/);
  assert.match(script, /resourceStatus === "downloading" \? "下载中"/);
  assert.match(script, /policyBlocked \? "安全策略拦截"/);
  assert.match(script, /qbPushStatus === "loading" \|\| resourceStatus \|\| policyBlocked \? "disabled"/);
  assert.doesNotMatch(script, /手动下载（风险）/);
  assert.doesNotMatch(script, /globalThis\.confirm/);
});

test("sorts resources by Free remaining time descending with missing deadlines last", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /return -Infinity/);
  assert.match(
    script,
    /\.sort\(\(a, b\) => freeRemainingSortValue\(b\) - freeRemainingSortValue\(a\)\)/
  );
});

test("loads the recommendation engine before the popup logic", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  assert.ok(
    html.indexOf('src="decision-engine.js"') < html.indexOf('src="popup.js"')
  );
});

test("loads and renders the 6000-magic newbie assessment estimator", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.ok(
    html.indexOf('src="assessment-engine.js"') < html.indexOf('src="popup.js"')
  );
  assert.match(script, /target:\s*6000/);
  assert.match(script, /assessmentDays:\s*30/);
  assert.match(script, /上传还差/);
  assert.match(script, /下载还差/);
  assert.match(script, /提前 5 天目标/);
  assert.match(script, /预计还需新增/);
  assert.match(script, /建议总做种规模/);
  assert.match(script, /先激活现有/);
  assert.match(script, /queuedUP/);
});

test("loads the admission and Free Guard engines before popup logic", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const popupIndex = html.indexOf('src="popup.js"');
  assert.ok(html.indexOf('src="admission-engine.js"') < popupIndex);
  assert.ok(html.indexOf('src="guard-engine.js"') < popupIndex);
  assert.ok(html.indexOf('src="exclusion-store.js"') < popupIndex);
});

test("persists excluded torrents, removes them from decisions, and offers restore", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(html, /id="excludedList"/);
  assert.match(html, /排除并删除|已排除种子/);
  assert.match(script, /\.filter\(\(torrent\) => !isTorrentExcluded\(torrent\)\)\s*\.map\(\(torrent\) => evaluateTorrent/);
  assert.match(script, /torrent\.decision === "recommend" && !isTorrentExcluded\(torrent\)/);
  assert.match(script, /deleteTorrents\(torrent\.hash, true\)/);
  assert.match(script, /restoreExcludedTorrent/);
});

test("offers a standalone staged qBittorrent diagnostic", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(html, /id="diagnoseQbBtn"/);
  assert.match(html, /id="qbDiagnostic"/);
  assert.match(script, /const diagnoseQbConnection = async/);
  assert.match(script, /client\.diagnose\(\)/);
  assert.doesNotMatch(
    script.match(/const testQbConnection = async[\s\S]*?\n};/)?.[0] || "",
    /refreshQbTorrents/
  );
});

test("renders lifecycle audit events in explicit newest-first order", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.ok(html.indexOf('src="audit-utils.js"') < html.indexOf('src="popup.js"'));
  assert.match(script, /PT_AGENT_AUDIT\.newestFirst\(state\.auditEvents\)/);
});

test("runs in pure local mode without any PT Core coupling", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
  assert.doesNotMatch(script, /PT_AGENT_CORE/);
  assert.doesNotMatch(script, /syncToCore|coreSettings|CORE_UNAVAILABLE|decisionSource/);
  assert.doesNotMatch(html, /core-client\.js/);
  assert.doesNotMatch(background, /ptAgentCoreSettings/);
});

test("sends recommended torrents directly to qBittorrent", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const pushRecommended =/);
  assert.match(script, /const enqueueTorrentDirectToQb = async/);
  assert.match(script, /client\.ensureCategory\(category, savePath\)/);
  assert.match(script, /const category = downloader\.category \|\| "PT_AGENT"/);
  assert.match(script, /PT_AGENT_QB\.torrentTags\(torrent\.freeEndAt \|\| ""\)/);
  assert.match(script, /client\.addTorrent\(\{/);
});

test("uploads the .torrent bytes fetched in the browser instead of only handing qB a URL", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const fetchTorrentFile = async/);
  const enqueue = script.match(/const enqueueTorrentDirectToQb = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(enqueue, /const file = await fetchTorrentFile\(downloadUrl, operationId\)/);
  assert.match(enqueue, /file,/);
  assert.match(enqueue, /filename: `\$\{safeName\}\.torrent`/);
  assert.match(enqueue, /route: file \? "file" : "url"/);
});

test("degrades to the URL route with a clear reason when the CDN blocks the fetch", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const fetchFile = script.match(/const fetchTorrentFile = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(fetchFile, /qb:torrent-fetch-fallback/);
  assert.match(fetchFile, /likelyCors/);
  assert.match(fetchFile, /finalHost/);
  // 抓不到种子文件不能让整次下载失败，必须返回 null 走 URL 路由
  assert.match(fetchFile, /return null;/);
});

test("counts concurrency by occupied download slots, not by paused or queued tasks", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  // isActiveDownload 用 /DL$/i 匹配，会把 pausedDL / queuedDL 也算进并发，
  // 那样一堆暂停任务就能把额度占满。准入必须用只统计占槽任务的口径。
  assert.match(script, /const downloadSlots = \(\) => globalThis\.PT_AGENT_QB\.summarizeDownloadSlots/);
  assert.match(script, /activeDownloads: activeDownloadsOverride \?\? downloadSlots\(\)\.occupying/);
});

test("warns about concurrency without ever blocking the enqueue", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const engine = fs.readFileSync(path.join(extensionDir, "admission-engine.js"), "utf8");
  // 下载器自己有队列，超出并发的任务会排队而不是丢失，所以并发只提示不拦截
  assert.match(engine, /warnings\.push\(/);
  assert.doesNotMatch(engine, /reasons\.push\(\s*`活动下载已达到/);
  assert.match(script, /if \(admission\.warnings\?\.length\)/);
  assert.match(script, /showToast\(`⏳ \$\{admission\.warnings\.join\("；"\)\}`/);
});

test("enforces local admission before enqueueing and caps a batch push", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const enqueue = script.match(/const enqueueTorrent = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(enqueue, /const admission = admissionFor\(torrent, batchQueued\)/);
  assert.match(enqueue, /if \(!admission\.allowed\)/);
  assert.match(enqueue, /本地安全准入拒绝/);
  const push = script.match(/const pushRecommended = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(push, /enqueueTorrent\(torrent, \{ batchQueued: succeeded \}\)/);
});

test("routes every user-visible error into the log", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  // 逐个调用点补 debug() 迟早会漏，记录必须放在提示函数本身
  assert.match(script, /const reportUiError =/);
  ["setQbMessage", "setProbeMessage", "setSiteMessage", "setPolicyMessage", "showToast"].forEach((fn) => {
    const body = script.match(new RegExp(`const ${fn} = \\(([\\s\\S]*?)\\n};`))?.[0] || "";
    assert.match(body, /if \(type === "error"\) reportUiError\(/, `${fn} 必须把错误写进日志`);
  });
  // 同一条错误常常同时出现在消息条和浮层，要去重
  assert.match(script, /recentlyReported/);
  assert.match(script, /PT_AGENT_LOGGER\.installConsoleCapture/);
});

test("ships a persistent debug log page", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(html, /id="logsView"/);
  assert.match(html, /id="logList"/);
  assert.match(html, /id="clearLogsBtn"/);
  assert.match(html, /data-view="logs"/);
  // 日志持久化到 chrome.storage，并在启动时载入历史。
  assert.match(script, /ptAgentDebugLog/);
  assert.match(script, /const loadDebugLog = async/);
  assert.match(script, /const renderLogs =/);
  assert.match(script, /PT_AGENT_LOGGER\.write/);
  assert.ok(
    html.indexOf('src="logger.js"') < html.indexOf('src="popup.js"'),
    "the shared logger must load before popup logic"
  );
});

test("never writes M-Team download tokens or third-party response bodies to diagnostics", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(
    script,
    /debug\(\s*"mteam:gen-dl-token",\s*\{\s*torrentId:\s*torrent\.torrentId,\s*generated:\s*Boolean\(downloadUrl\)\s*\},\s*operationId\s*\)/
  );
  assert.doesNotMatch(script, /mteam:gen-dl-token",\s*\{[^}]*downloadUrl:/);
  assert.doesNotMatch(script, /mteam:res-error"[\s\S]{0,140}\bbody:/);
  assert.doesNotMatch(script, /qb:add"[\s\S]{0,120}downloadUrl:\s*String/);
});

test("surfaces enqueue failures via a global toast and post-send verification", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const showToast =/);
  assert.match(script, /showToast\(`❌ 发送失败/);
  assert.match(script, /qb:verify/);
  assert.match(script, /未出现任务/);
});

test("reports an already-present torrent honestly instead of as a fresh send", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /duplicate: Boolean\(addResult\?\.duplicate\)/);
  assert.match(script, /已在下载器中，无需重复添加/);
  assert.match(script, /status: result\.duplicate \? "already_present" : "queued"/);
  // 不能把"其实早就在了"谎报成"刚刚发送成功"
  assert.match(script, /种子已存在于下载器/);
});

test("persists the resource-to-task link and shows the resource name on tasks", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  // 站点资源名和 qB 任务名是两套命名，必须持久化对应关系而不是每次猜
  assert.match(script, /const matchQbTorrent =/);
  assert.match(script, /index\.forResource\(torrent\.site, torrent\.torrentId\)/);
  assert.match(script, /const resourceForTask =/);
  assert.match(script, /qb-resource/);
  assert.match(script, /await linkStore\.link\(/);
  // 旧任务靠 ptagent-source 标签补齐，任务删除后清理关联
  assert.match(script, /linkStore\.backfillFromTasks\(state\.qbTorrents/);
  assert.match(script, /linkStore\.prune\(/);
});

test("verifies a sent torrent by source tag and retries while qB parses it", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  // 只按标题匹配会把"其实已经添加成功"误报成失败：站点标题和 qB 任务名经常不同
  assert.match(script, /PT_AGENT_QB\.matchTorrent\(torrent, state\.qbTorrents\)/);
  assert.doesNotMatch(script, /PT_AGENT_QB\.findMatchingTorrent\(torrent\.title/);
  const verify = script.match(/const verifyEnqueued = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(verify, /for \(let attempt = 1; attempt <= attempts/);
  assert.match(verify, /matchedBy/);
});

test("loads the M-Team historical backfill helper before the popup logic", () => {
  const html = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
  assert.ok(
    html.indexOf('src="mteam-backfill.js"') < html.indexOf('src="popup.js"')
  );
});

test("backfill is limited to active qBittorrent downloads", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /trackerHost\.endsWith\("m-team\.cc"\) &&\s*isActiveDownload\(torrent\)/);
});

test("aggregates current Free torrents from normal and adult M-Team pages", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const pageSize = 100/);
  assert.match(script, /const maxPages = 10/);
  assert.match(script, /fetchMode\("normal"\)/);
  assert.match(script, /fetchMode\("adult"\)/);
  assert.match(script, /emptyFreePages >= 2/);
  assert.match(script, /catalogStats\.normalPages/);
  assert.match(script, /catalogStats\.adultPages/);
});

test("sorts resources by published time descending and renders that time", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /publishedTimestamp\(b\.publishedAt\) - publishedTimestamp\(a\.publishedAt\)/);
  assert.match(script, /formatPublishedAt\(item\.publishedAt\)/);
});
