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
  assert.match(script, /PT_AGENT_PRIVATE_CONFIG\.mteamApiUrl/);
  assert.match(script, /mteamRequest\("\/api\/member\/profile"\)/);
  assert.match(script, /mteamRequest\("\/api\/torrent\/search"/);
  assert.match(script, /mteamRequest\("\/api\/torrent\/genDlToken"/);
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
  assert.match(html, /M-Team API Key/);
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

test("fills previously empty stored credentials from the local preset", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /password:\s*stored\.password \|\| defaultQbSettings\.password/);
  assert.match(script, /mteamApiKey:\s*stored\.mteamApiKey \|\| defaultQbSettings\.mteamApiKey/);
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
  assert.match(script, /client\.ensureCategory\("PT_AGENT", savePath\)/);
  assert.match(script, /PT_AGENT_QB\.torrentTags\(torrent\.freeEndAt \|\| ""\)/);
  assert.match(script, /client\.addTorrent\(\{/);
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
});

test("surfaces enqueue failures via a global toast and post-send verification", () => {
  const script = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  assert.match(script, /const showToast =/);
  assert.match(script, /showToast\(`❌ 发送失败/);
  assert.match(script, /qb:verify/);
  assert.match(script, /未出现任务/);
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
