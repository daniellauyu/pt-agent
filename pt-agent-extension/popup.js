const state = {
  scan: null,
  evaluated: [],
  filter: "all",
  activeView: "resources",
  sourceTabId: null,
  policySettings: null,
  downloaders: [],
  sites: [],
  activeDownloader: null,
  routeCache: null,
  lastSelection: null,
  qbTorrents: [],
  excludedTorrents: [],
  qbSeedingSummary: null,
  qbPushStatus: new Map(),
  auditEvents: [],
  operationId: null
};

const $ = (id) => document.getElementById(id);
const exclusionStore = globalThis.PT_AGENT_EXCLUSIONS.createStore();
const downloaderStore = globalThis.PT_AGENT_DOWNLOADER_STORE.createStore();
const siteStore = globalThis.PT_AGENT_SITE_STORE.createStore();
const hostPermissions = globalThis.PT_AGENT_HOST_PERMISSIONS.createManager();

const isTorrentExcluded = (torrent) => {
  return exclusionStore.isExcluded(torrent, state.excludedTorrents);
};

// ptAgentDebugLog 保持向后兼容；实际持久化由 background 的统一日志服务串行处理。
const DEBUG_LOG_CAP = 2000;
let debugBuffer = [];

const debug = (tag, data, operationId = state.operationId) => {
  const entry = globalThis.PT_AGENT_LOGGER.createEntry({
    level: globalThis.PT_AGENT_LOGGER.inferLevel(tag),
    event: tag,
    data,
    operationId
  });
  debugBuffer.unshift(entry);
  if (debugBuffer.length > DEBUG_LOG_CAP) debugBuffer.length = DEBUG_LOG_CAP;
  globalThis.PT_AGENT_LOGGER.write(entry);
  // 仅在停留于第一页时实时刷新，避免用户翻阅历史页时被新日志打断跳页。
  if (document.getElementById("logList") && logPage === 0) renderLogs();
  return entry;
};

const loadDebugLog = async () => {
  try {
    const history = await globalThis.PT_AGENT_LOGGER.list();
    const seen = new Set();
    debugBuffer = [...debugBuffer, ...history]
      .filter((entry) => entry?.id && !seen.has(entry.id) && seen.add(entry.id))
      .slice(0, DEBUG_LOG_CAP);
  } catch (_) {}
};

const LOG_LEVEL = (tag) => {
  const t = String(tag);
  if (/error|failed|suspect|enqueue-error/.test(t)) return "error";
  if (/verify|refresh-failed|warn/.test(t)) return "warn";
  if (/add-result|res\b|refreshed|success/.test(t)) return "ok";
  return "info";
};

const LOG_PAGE_SIZE = 25;
let logPage = 0;

const formatLogTime = (iso) => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return String(iso);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

const renderLogs = () => {
  const list = document.getElementById("logList");
  if (!list) return;
  const countBadge = document.getElementById("logCount");
  if (countBadge) countBadge.textContent = `${debugBuffer.length} 条`;

  if (!debugBuffer.length) {
    list.innerHTML = `<div class="empty compact-empty">暂无日志。发送种子、扫描等动作会在此记录。</div>`;
    const pager = document.getElementById("logPager");
    if (pager) pager.innerHTML = "";
    return;
  }

  const pageCount = Math.max(1, Math.ceil(debugBuffer.length / LOG_PAGE_SIZE));
  logPage = Math.min(Math.max(0, logPage), pageCount - 1);
  const start = logPage * LOG_PAGE_SIZE;
  const pageItems = debugBuffer.slice(start, start + LOG_PAGE_SIZE);

  list.innerHTML = pageItems.map((entry) => {
    const level = entry.level === "error"
      ? "error"
      : entry.level === "warn"
        ? "warn"
        : LOG_LEVEL(entry.tag);
    const hasData = entry.data !== null && entry.data !== undefined;
    const fullText = !hasData
      ? ""
      : typeof entry.data === "string"
        ? entry.data
        : JSON.stringify(entry.data, null, 2);
    const summary = !hasData
      ? ""
      : typeof entry.data === "string"
        ? entry.data
        : JSON.stringify(entry.data);
    const operationLabel = entry.operation_id
      ? `[op:${String(entry.operation_id).slice(-8)}] `
      : "";
    return `
      <div class="log-row ${level}${hasData ? " expandable" : ""}">
        <div class="log-main">
          <span class="log-time">${escapeHtml(formatLogTime(entry.ts))}</span>
          <span class="log-tag">${escapeHtml(entry.tag)}</span>
          <span class="log-summary" title="${escapeHtml(entry.operation_id || "")}">${escapeHtml(operationLabel + summary)}</span>
          <span class="log-caret">${hasData ? "▸" : ""}</span>
        </div>
        ${fullText ? `<pre class="log-data">${escapeHtml(fullText)}</pre>` : ""}
      </div>
    `;
  }).join("");

  list.querySelectorAll(".log-row.expandable .log-main").forEach((main) => {
    main.addEventListener("click", () => main.parentElement.classList.toggle("open"));
  });

  const pager = document.getElementById("logPager");
  if (pager) {
    pager.innerHTML = `
      <button class="btn btn-quiet log-page-btn" data-log-nav="prev" ${logPage <= 0 ? "disabled" : ""}>← 上一页</button>
      <span class="log-page-info">第 ${logPage + 1} / ${pageCount} 页 · 每页 ${LOG_PAGE_SIZE} 条 · 共 ${debugBuffer.length} 条</span>
      <button class="btn btn-quiet log-page-btn" data-log-nav="next" ${logPage >= pageCount - 1 ? "disabled" : ""}>下一页 →</button>
    `;
    pager.querySelectorAll("[data-log-nav]").forEach((button) => {
      button.addEventListener("click", () => {
        logPage += button.dataset.logNav === "next" ? 1 : -1;
        renderLogs();
      });
    });
  }
};

const clearLogs = async () => {
  debugBuffer = [];
  logPage = 0;
  await globalThis.PT_AGENT_LOGGER.clear();
  renderLogs();
};

const exportLogs = () => {
  const safe = globalThis.PT_AGENT_LOGGER.redact(debugBuffer);
  const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pt-agent-log-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

// 全局浮层提示：不依赖当前视图，成功/失败都能看到（此前错误只写在「下载中」页，资源页点下载看不到）。
const showToast = (message, type = "info", ms = type === "error" ? 12000 : 4000) => {
  let toast = document.getElementById("ptToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "ptToast";
    document.body.appendChild(toast);
    toast.addEventListener("click", () => { toast.className = "pt-toast"; });
  }
  toast.textContent = message;
  toast.className = `pt-toast show ${type}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.className = "pt-toast"; }, ms);
};

const defaultSettings = {
  guardMinutes: 10,
  minFreeHoursForAutoDownload: 12,
  maxTorrentSizeGB: 50,
  minimumScore: 80,
  maxActiveDownloads: 3,
  minimumRatio: 1,
  scarceOpportunityMinFreeHours: 6,
  scarceOpportunityMaxRequiredSpeedBps: 512 * 1024,
  scarceOpportunityMinLeechers: 20,
  scarceOpportunityMinDemandRatio: 10,
  guardMonitorEnabled: true,
  autoDeleteExpired: false,
  guardExecutor: "extension",
  rejectHr: true,
  rejectMissingFreeEnd: true
};

const bytesToGB = (bytes) => {
  if (!bytes) return "-";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1)}GB`;
};

const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (!value) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** exponent).toFixed(exponent >= 3 ? 2 : 1)} ${units[exponent]}`;
};

const formatSpeed = (bytesPerSecond) => {
  const value = Number(bytesPerSecond || 0);
  if (value < 1024) return `${value.toFixed(0)} B/s`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
};

const formatLeft = (hours) => {
  if (hours === null) return "未知";
  if (hours <= 0) return "已到期";
  const h = Math.floor(hours);
  const m = Math.max(0, Math.floor((hours - h) * 60));
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
};

const formatDeadline = (value) => {
  if (!value) return "未提供";
  const rawValue = String(value).trim();
  const sourceTimestamp = rawValue.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:$|[+-]\d{2}:?\d{2}$)/);
  if (sourceTimestamp) return `${sourceTimestamp[1]} ${sourceTimestamp[2]}`;
  const date = new Date(rawValue);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replaceAll("/", "-");
};

const publishedTimestamp = (value) => {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const formatPublishedAt = (value) => {
  if (!value) return "未知";
  const rawValue = String(value).trim();
  const timestamp = rawValue.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return timestamp ? `${timestamp[1]} ${timestamp[2]}` : rawValue;
};

const evaluateTorrent = globalThis.PT_AGENT_DECISION.evaluateTorrent;

// 准入阈值完全由「设置 → 下载策略」决定，这里不再二次收紧用户存下的值。
const getSettings = async () => {
  const data = await chrome.storage.local.get("ptAgentSettings");
  return { ...defaultSettings, ...(data.ptAgentSettings || {}) };
};

const clampNumber = (value, { min, max, fallback }) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const fillPolicySettingsForm = (settings) => {
  $("policyMaxActiveDownloads").value = String(settings.maxActiveDownloads ?? 3);
  $("policyMinimumScore").value = String(settings.minimumScore ?? 80);
  $("policyMaxTorrentSizeGB").value = String(settings.maxTorrentSizeGB ?? 50);
  $("policyMinFreeHours").value = String(settings.minFreeHoursForAutoDownload ?? 12);
  $("policyMinimumRatio").value = String(settings.minimumRatio ?? 1);
  $("policyRejectHr").checked = settings.rejectHr !== false;
  $("policyRejectMissingFreeEnd").checked = settings.rejectMissingFreeEnd !== false;
};

const setPolicyMessage = (message, type = "") => {
  const node = $("policyMessage");
  if (!node) return;
  node.textContent = message;
  node.className = `downloader-message ${type}`.trim();
};

const readPolicySettingsForm = () => ({
  // 这里只做输入合法性兜底（避免 0 并发、负体积），不是策略上限。
  maxActiveDownloads: clampNumber($("policyMaxActiveDownloads").value, { min: 1, max: 50, fallback: 3 }),
  minimumScore: clampNumber($("policyMinimumScore").value, { min: 0, max: 100, fallback: 80 }),
  maxTorrentSizeGB: clampNumber($("policyMaxTorrentSizeGB").value, { min: 1, max: 4096, fallback: 50 }),
  minFreeHoursForAutoDownload: clampNumber($("policyMinFreeHours").value, { min: 0, max: 720, fallback: 12 }),
  minimumRatio: clampNumber($("policyMinimumRatio").value, { min: 0, max: 100, fallback: 1 }),
  rejectHr: $("policyRejectHr").checked,
  rejectMissingFreeEnd: $("policyRejectMissingFreeEnd").checked
});

const savePolicySettings = async () => {
  const next = { ...(state.policySettings || defaultSettings), ...readPolicySettingsForm() };
  state.policySettings = next;
  await chrome.storage.local.set({ ptAgentSettings: next });
  fillPolicySettingsForm(next);
  // rejectHr / Free 剩余等条件属于决策引擎，改完要重新评估已扫描的资源才能生效。
  reevaluateScannedTorrents();
  setPolicyMessage(
    `已保存：并发 ${next.maxActiveDownloads}、最低评分 ${next.minimumScore}、体积上限 ${next.maxTorrentSizeGB}GB、` +
    `Free 最短剩余 ${next.minFreeHoursForAutoDownload} 小时、最低分享率 ${next.minimumRatio}。`,
    "success"
  );
};

const resetPolicySettings = async () => {
  if (!confirm("确定把下载策略恢复成默认值吗？")) return;
  const next = {
    ...(state.policySettings || defaultSettings),
    maxActiveDownloads: defaultSettings.maxActiveDownloads,
    minimumScore: defaultSettings.minimumScore,
    maxTorrentSizeGB: defaultSettings.maxTorrentSizeGB,
    minFreeHoursForAutoDownload: defaultSettings.minFreeHoursForAutoDownload,
    minimumRatio: defaultSettings.minimumRatio,
    rejectHr: defaultSettings.rejectHr,
    rejectMissingFreeEnd: defaultSettings.rejectMissingFreeEnd
  };
  state.policySettings = next;
  await chrome.storage.local.set({ ptAgentSettings: next });
  fillPolicySettingsForm(next);
  reevaluateScannedTorrents();
  setPolicyMessage("已恢复默认下载策略。", "success");
};

const fillGuardSettingsForm = (settings) => {
  $("guardMonitorEnabled").checked = settings.guardMonitorEnabled !== false;
  $("guardMinutes").value = String(settings.guardMinutes || 10);
  $("autoDeleteExpired").checked = settings.autoDeleteExpired === true;
};

const saveGuardSettings = async () => {
  const next = {
    ...(state.policySettings || defaultSettings),
    guardExecutor: "extension",
    guardMonitorEnabled: $("guardMonitorEnabled").checked,
    guardMinutes: Math.max(1, Math.min(120, Number($("guardMinutes").value || 10))),
    autoDeleteExpired: $("autoDeleteExpired").checked
  };
  if (next.autoDeleteExpired && !state.policySettings?.autoDeleteExpired) {
    const confirmed = confirm("开启后，带 ptagent 标签且未完成的任务进入保护窗口时，会从 qB 删除任务并同步删除文件。确定开启吗？");
    if (!confirmed) {
      $("autoDeleteExpired").checked = false;
      next.autoDeleteExpired = false;
    }
  }
  state.policySettings = next;
  await chrome.storage.local.set({ ptAgentSettings: next });
  setQbMessage(
    next.autoDeleteExpired
      ? `Free Guard 已开启自动保护：到期前 ${next.guardMinutes} 分钟删除未完成任务和文件。`
      : `Free Guard 已保存：后台监控${next.guardMonitorEnabled ? "开启" : "关闭"}，自动删除关闭。`,
    "success"
  );
  renderQbTorrents();
};

const loadAuditEvents = async () => {
  state.auditEvents = await globalThis.PT_AGENT_LOGGER.listAudit();
  renderAuditEvents();
};

const appendAuditEvent = async (event, operationId = state.operationId) => {
  const next = await globalThis.PT_AGENT_LOGGER.appendAudit({
    operation_id: operationId,
    ...event
  });
  state.auditEvents = Array.isArray(next) && next.length
    ? next
    : await globalThis.PT_AGENT_LOGGER.listAudit();
  renderAuditEvents();
};

const activeSite = () => {
  return state.sites.find((site) => site.enabled && site.type === "mteam") ||
    state.sites.find((site) => site.enabled) ||
    null;
};

const siteUrl = () => activeSite()?.siteUrl || globalThis.PT_AGENT_PRIVATE_CONFIG.mteamSiteUrl;

const probeDownloader = async (downloader, operationId) => {
  // 没有主机权限时 fetch 必然失败，先明确区分开，否则会被误报成"网络不可达"。
  if (!(await hostPermissions.has(downloader.address))) {
    return { ok: false, error: "缺少该地址的访问权限，请在设置里点「授权」" };
  }
  const adapter = globalThis.PT_AGENT_DOWNLOADER_TYPES.createAdapter(
    downloader,
    { onLog: (event, data) => debug(event, data, operationId) }
  );
  return adapter.probe({ timeoutMs: globalThis.PT_AGENT_NETWORK_ROUTER.DEFAULT_TIMEOUT_MS });
};

// 按可达性选出当前该用哪台下载器（替代读不到的 WiFi SSID 判断）。
const selectActiveDownloader = async ({ force = false, operationId } = {}) => {
  const router = globalThis.PT_AGENT_NETWORK_ROUTER;
  const selection = await router.selectDownloader(state.downloaders, {
    probe: (downloader) => probeDownloader(downloader, operationId),
    cache: force ? null : state.routeCache
  });
  state.routeCache = selection.cache;
  state.activeDownloader = selection.downloader;
  state.lastSelection = selection;
  debug(
    "route:select",
    { reason: selection.reason, active: selection.downloader?.name || null, probes: selection.probes },
    operationId
  );
  renderActiveDownloader();
  return selection;
};

const requireActiveDownloader = async (operationId) => {
  if (!state.downloaders.length) {
    throw new Error("尚未配置下载器，请到「设置 → 下载器」添加一台");
  }
  if (!state.activeDownloader) await selectActiveDownloader({ operationId });
  const downloader = state.activeDownloader;
  if (!downloader) throw new Error("没有可用的下载器");
  if (!downloader.password) throw new Error(`下载器「${downloader.name}」缺少密码`);
  if (!(await hostPermissions.has(downloader.address))) {
    throw new Error(`缺少「${downloader.address}」的访问权限，请到「设置 → 下载器」点「授权」`);
  }
  return downloader;
};

const setQbMessage = (message, type = "") => {
  $("qbMessage").textContent = message;
  $("qbMessage").className = `downloader-message ${type}`.trim();
};

const setQbStatus = (text, type) => {
  $("qbStatus").textContent = text;
  $("qbStatus").className = `site-status ${type}`;
};

// 统一入口：先按网络可达性选出下载器，再通过适配层拿到客户端。
const createDownloaderClient = async (
  operationId = state.operationId || globalThis.PT_AGENT_LOGGER.newOperationId()
) => {
  const downloader = await requireActiveDownloader(operationId);
  return globalThis.PT_AGENT_DOWNLOADER_TYPES.createAdapter(downloader, {
    onLog: (event, data) => debug(event, data, operationId)
  });
};

const mteamRequest = async (
  path,
  { json, form, operationId: suppliedOperationId } = {}
) => {
  const operationId = suppliedOperationId
    || state.operationId
    || globalThis.PT_AGENT_LOGGER.newOperationId();
  const site = activeSite();
  if (!site?.apiKey) throw new Error("缺少站点 API Key，请到「设置 → 站点」填写");
  const headers = { "x-api-key": site.apiKey };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form;
  }
  const params = json !== undefined
    ? json
    : form !== undefined
      ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v).slice(0, 60)]))
      : null;
  const url = new URL(String(path).replace(/^\/+/, ""), site.apiUrl).toString();
  debug("mteam:req", { path, params }, operationId);
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body });
  } catch (error) {
    debug("mteam:req-error", { path, error: String(error?.message || error) }, operationId);
    throw new Error(`M-Team 无法连接（${String(error?.message || error)}）`);
  }
  const payload = await response.json().catch(() => ({}));
  const dataShape = payload?.data && typeof payload.data === "object"
    ? Object.keys(payload.data)
    : typeof payload?.data;
  debug("mteam:res", { path, status: response.status, message: payload?.message, dataShape }, operationId);
  if (!response.ok || payload?.message !== "SUCCESS") {
    debug("mteam:res-error", { path, status: response.status, message: payload?.message }, operationId);
    throw new Error(payload?.message || `M-Team 请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
};

const getSourceTab = async () => {
  if (!Number.isInteger(state.sourceTabId)) {
    throw new Error("缺少来源页面，请返回 PT 页面后重新点击插件图标");
  }
  try {
    return await chrome.tabs.get(state.sourceTabId);
  } catch (_) {
    throw new Error("来源页面已关闭，请在 PT 页面重新打开插件");
  }
};

const scanSourceTab = async () => {
  const tab = await getSourceTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["site-definitions.js", "content-parser.js"]
  });

  return results?.[0]?.result || null;
};

const fetchMteamAccount = async (operationId) => {
  const [profile, statistics, bonusData] = await Promise.all([
    mteamRequest("/api/member/profile", { operationId }),
    mteamRequest("/api/tracker/myPeerStatistics", { operationId }),
    mteamRequest("/api/tracker/mybonus", { operationId })
  ]);
  const uploadedBytes = Number(profile?.memberCount?.uploaded || 0);
  const downloadedBytes = Number(profile?.memberCount?.downloaded || 0);
  return {
    username: profile?.username || "",
    createdDate: profile?.createdDate || "",
    uploadedBytes,
    downloadedBytes,
    ratio: downloadedBytes > 0 ? uploadedBytes / downloadedBytes : null,
    bonus: Number(profile?.memberCount?.bonus || 0),
    seedingCount: Number(statistics?.seederCount || 0),
    seedingSizeBytes: Number(statistics?.seederSize || 0),
    trackerSeedingCount: Number(statistics?.seederCount || 0),
    trackerSeedingSizeBytes: Number(statistics?.seederSize || 0),
    bonusPerHour: Number(bonusData?.formulaParams?.finalBs || 0),
    newUserExamine: Boolean(bonusData?.formulaParams?.newUserExamine),
    source: "mteam-api"
  };
};

const fetchMteamFreeCatalog = async (operationId) => {
  const core = globalThis.PT_AGENT_MTEAM_BACKFILL;
  const pageSize = 100;
  const maxPages = 10;
  const fetchMode = async (mode) => {
    const torrents = [];
    let pagesRead = 0;
    let emptyFreePages = 0;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const data = await mteamRequest("/api/torrent/search", {
        json: { mode, pageNumber, pageSize, discount: "FREE" },
        operationId
      });
      const rows = data?.data || [];
      const freeRows = rows.filter((row) => {
        const deadline = core.freeDeadline(row);
        return deadline && Date.parse(deadline) > Date.now();
      });
      pagesRead += 1;
      torrents.push(...freeRows);
      emptyFreePages = freeRows.length === 0 ? emptyFreePages + 1 : 0;
      if (rows.length < pageSize || emptyFreePages >= 2) break;
    }
    return { mode, pagesRead, torrents };
  };
  const areas = await Promise.all([fetchMode("normal"), fetchMode("adult")]);
  const deduplicated = new Map();
  for (const area of areas) {
    for (const row of area.torrents) {
      const deadline = core.freeDeadline(row);
      deduplicated.set(String(row.id), {
        rowIndex: 0,
        site: "mteam",
        torrentId: String(row.id),
        infoHash: "",
        title: row.name || "",
        subtitle: row.smallDescr || "",
        category: row.category || area.mode,
        sizeBytes: Number(row.size || 0),
        sizeText: "",
        freeType: "free",
        freeStartAt: row.status?.createdDate || row.createdDate || "",
        freeEndAt: deadline,
        freeLeftText: "",
        seeders: Number(row.status?.seeders || 0),
        leechers: Number(row.status?.leechers || 0),
        completed: Number(row.status?.timesCompleted || 0),
        hasHr: false,
        detailUrl: new URL(`/detail/${row.id}`, siteUrl()).toString(),
        downloadUrl: "",
        publishedAt: row.createdDate || row.status?.createdDate || "",
        source: `mteam-api-${area.mode}`
      });
    }
  }
  const torrents = Array.from(deduplicated.values()).map((torrent, rowIndex) => ({
    ...torrent,
    rowIndex
  }));
  return {
    torrents,
    stats: {
      normalPages: areas.find((area) => area.mode === "normal")?.pagesRead || 0,
      adultPages: areas.find((area) => area.mode === "adult")?.pagesRead || 0,
      total: torrents.length,
      pageSize,
      maxPages
    }
  };
};

const findMteamFreeDeadlines = async (tasks, operationId) => {
  const core = globalThis.PT_AGENT_MTEAM_BACKFILL;
  const search = async (keyword, mode) => {
    const data = await mteamRequest("/api/torrent/search", {
      json: { mode, pageNumber: 1, pageSize: 100, keyword },
      operationId
    });
    return data?.data || [];
  };
  const updates = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex++];
      let matched = null;
      for (const mode of core.searchModes(task.name)) {
        for (const keyword of core.keywordCandidates(task.name)) {
          const rows = await search(keyword, mode);
          matched = core.findExactMatch(task, rows);
          if (matched) break;
        }
        if (matched) break;
      }
      const deadline = core.freeDeadline(matched);
      if (matched && deadline) {
        updates.push({
          hash: task.hash,
          name: task.name,
          torrentId: matched.id,
          deadline
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, worker));
  return updates;
};

const backfillMteamDeadlines = async () => {
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  const button = $("backfillDeadlineBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在回查…";
  try {
    if (!activeSite()?.apiKey) throw new Error("缺少站点 API Key，请到「设置 → 站点」填写");
    const client = await createDownloaderClient(operationId);
    await client.login();
    const allTorrents = await client.listTorrents("all");
    const candidates = allTorrents.filter((torrent) => {
      let trackerHost = "";
      try {
        trackerHost = new URL(torrent.tracker || "").hostname;
      } catch (_) {}
      return trackerHost.endsWith("m-team.cc") &&
        isActiveDownload(torrent) &&
        !globalThis.PT_AGENT_MTEAM_BACKFILL.hasDeadlineTag(torrent.tags);
    }).map((torrent) => ({
      hash: torrent.hash,
      name: torrent.name,
      size: torrent.size
    }));
    if (!candidates.length) {
      setQbMessage("下载中的任务均已有截止标签，或当前没有 M-Team 下载任务。", "success");
      return;
    }
    setQbMessage(`正在回查 ${candidates.length} 个下载中的 M-Team 任务，仅精确匹配名称和体积后才写入标签。`);
    const updates = await findMteamFreeDeadlines(candidates, operationId);
    for (const update of updates) {
      await client.addTags(update.hash, globalThis.PT_AGENT_QB.torrentTags(update.deadline));
    }
    await refreshQbTorrents({ silent: true, operationId });
    setQbMessage(
      `回填完成：检查 ${candidates.length} 个下载中任务，找到并更新 ${updates.length} 个当前 Free 截止时间。`,
      "success"
    );
  } catch (error) {
    setQbMessage(error.message || String(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
};

const resolveTorrentDownloadUrl = async (torrent, operationId) => {
  if (torrent.downloadUrl) return torrent.downloadUrl;
  if (torrent.site !== "mteam") {
    throw new Error("当前资源没有可用的种子下载链接");
  }
  if (!torrent.torrentId) {
    throw new Error("无法识别 M-Team 种子 ID");
  }
  if (!activeSite()?.apiKey) {
    throw new Error("请先到「设置 → 站点」填写 API Key");
  }
  const body = new FormData();
  body.set("id", String(torrent.torrentId));
  const downloadUrl = await mteamRequest(
    "/api/torrent/genDlToken",
    { form: body, operationId }
  );
  debug(
    "mteam:gen-dl-token",
    { torrentId: torrent.torrentId, generated: Boolean(downloadUrl) },
    operationId
  );
  if (!downloadUrl) throw new Error("未能生成 M-Team 种子下载地址");
  return downloadUrl;
};

const findQbTorrent = (torrent) => {
  return globalThis.PT_AGENT_QB.findMatchingTorrent(torrent.title, state.qbTorrents);
};

const isActiveDownload = (torrent) => {
  return Number(torrent.progress || 0) < 1 && /DL$|downloading|metaDL|allocating/i.test(String(torrent.state || ""));
};

const admissionFor = (torrent, batchQueued = 0, activeDownloadsOverride = null) => {
  return globalThis.PT_AGENT_ADMISSION.evaluate({
    torrent,
    account: state.scan?.account || {},
    activeDownloads: activeDownloadsOverride ?? state.qbTorrents.filter(isActiveDownload).length,
    batchQueued,
    settings: state.policySettings || defaultSettings
  });
};

const qbResourceStatus = (torrent) => {
  const task = findQbTorrent(torrent);
  if (!task) return null;
  return Number(task.progress || 0) >= 1 || /UP$|uploading/i.test(String(task.state || ""))
    ? "downloaded"
    : "downloading";
};

const guardPresentation = (result) => {
  const labels = {
    safe: "预计可完成",
    cannot_finish: "预计无法完成",
    expiring: "保护窗口",
    expired: "Free 已到期",
    missing_deadline: "缺少截止标签",
    protected: "保护标签",
    completed: "已完成",
    unmanaged: "未托管"
  };
  const eta = Number.isFinite(result.etaSeconds)
    ? `预计 ${formatLeft(result.etaSeconds / 3600)} 完成`
    : "当前速度无法估算";
  return {
    label: labels[result.status] || result.status,
    detail: result.status === "safe" || result.status === "cannot_finish" ? eta : ""
  };
};

const renderActiveDownloader = () => {
  const badge = $("activeDownloaderBadge");
  const active = state.activeDownloader;
  if (badge) {
    badge.textContent = active ? active.name : "未选择";
    badge.className = `site-status ${active && state.lastSelection?.reason !== "fallback" ? "ok" : "bad"}`;
  }
  const name = $("sidebarDownloaderName");
  const mode = $("sidebarDownloaderMode");
  if (name) name.textContent = active ? active.name : "未选择";
  if (mode) {
    mode.textContent = state.lastSelection
      ? globalThis.PT_AGENT_NETWORK_ROUTER.describe(state.lastSelection)
      : "按可达性自动选路";
  }
};

const downloaderTypeOptions = (selected) => {
  return globalThis.PT_AGENT_DOWNLOADER_TYPES.list().map((type) => `
    <option value="${escapeHtml(type.id)}" ${type.id === selected ? "selected" : ""} ${type.implemented ? "" : "disabled"}>
      ${escapeHtml(type.name)}${type.implemented ? "" : "（即将支持）"}
    </option>
  `).join("");
};

const renderDownloaderSettings = async () => {
  const list = $("downloaderList");
  if (!list) return;
  if (!state.downloaders.length) {
    list.innerHTML = `<div class="empty compact-empty">尚未配置下载器，点右上角「新增下载器」。</div>`;
    renderActiveDownloader();
    return;
  }
  const permissions = await Promise.all(
    state.downloaders.map((item) => hostPermissions.has(item.address))
  );
  list.innerHTML = state.downloaders.map((item, index) => {
    const isActive = state.activeDownloader?.id === item.id;
    const granted = permissions[index];
    const probe = state.lastSelection?.probes?.find((entry) => entry.id === item.id);
    const probeText = !probe
      ? ""
      : probe.ok
        ? `可达 ${probe.latencyMs}ms`
        : `不可达：${probe.error}`;
    return `
      <div class="settings-card ${isActive ? "active" : ""}" data-downloader-id="${escapeHtml(item.id)}">
        <div class="settings-card-head">
          <div class="settings-card-title">
            <strong>${escapeHtml(item.name)}</strong>
            ${isActive ? `<span class="settings-chip ok">当前使用</span>` : ""}
            ${item.isPrivate ? `<span class="settings-chip">内网</span>` : `<span class="settings-chip">公网</span>`}
            ${item.enabled ? "" : `<span class="settings-chip off">已停用</span>`}
            ${granted ? "" : `<span class="settings-chip warn">未授权</span>`}
          </div>
          <div class="settings-card-order">
            <button class="btn btn-quiet icon-btn" type="button" data-move="up" ${index === 0 ? "disabled" : ""} title="上移（越靠前越优先探测）">↑</button>
            <button class="btn btn-quiet icon-btn" type="button" data-move="down" ${index === state.downloaders.length - 1 ? "disabled" : ""} title="下移">↓</button>
          </div>
        </div>
        <div class="settings-grid">
          <label><span>名称</span><input data-field="name" type="text" value="${escapeHtml(item.name)}"></label>
          <label><span>类型</span><select data-field="type">${downloaderTypeOptions(item.type)}</select></label>
          <label><span>地址</span><input data-field="address" type="url" value="${escapeHtml(item.address)}" placeholder="http://192.168.1.10:8080/"></label>
          <label><span>账号</span><input data-field="username" type="text" value="${escapeHtml(item.username)}" autocomplete="off"></label>
          <label><span>密码</span><input data-field="password" type="password" value="${escapeHtml(item.password)}" autocomplete="off"></label>
          <label><span>下载目录（可选）</span><input data-field="savePath" type="text" value="${escapeHtml(item.savePath)}" placeholder="使用下载器默认目录"></label>
          <label><span>分类</span><input data-field="category" type="text" value="${escapeHtml(item.category)}"></label>
          <label><span>备注</span><input data-field="note" type="text" value="${escapeHtml(item.note)}" placeholder="例如：家里内网 / 外网域名"></label>
          <label class="settings-switch"><input data-field="enabled" type="checkbox" ${item.enabled ? "checked" : ""}><span>参与自动选路</span></label>
        </div>
        <div class="settings-card-foot">
          <span class="settings-probe ${probe?.ok ? "ok" : probe ? "bad" : ""}">${escapeHtml(probeText)}</span>
          <div class="settings-card-actions">
            ${granted ? "" : `<button class="btn btn-quiet" type="button" data-action="grant">授权访问</button>`}
            <button class="btn btn-quiet" type="button" data-action="test">测试连接</button>
            <button class="btn btn-danger" type="button" data-action="delete">删除</button>
            <button class="btn btn-primary" type="button" data-action="save">保存</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll("[data-downloader-id]").forEach((card) => {
    const id = card.dataset.downloaderId;
    const read = () => {
      const value = { id };
      card.querySelectorAll("[data-field]").forEach((input) => {
        value[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value.trim();
      });
      return value;
    };
    card.querySelector('[data-action="save"]')?.addEventListener("click", () => saveDownloaderCard(read()));
    card.querySelector('[data-action="grant"]')?.addEventListener("click", () => grantDownloaderAccess(read()));
    card.querySelector('[data-action="test"]')?.addEventListener("click", () => testDownloaderCard(read()));
    card.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteDownloaderCard(id, read().name));
    card.querySelectorAll("[data-move]").forEach((button) => {
      button.addEventListener("click", () => moveDownloader(id, button.dataset.move === "up" ? -1 : 1));
    });
  });
  renderActiveDownloader();
};

const setProbeMessage = (message, type = "") => {
  const node = $("probeResult");
  if (!node) return;
  node.textContent = message;
  node.className = `downloader-message ${type}`.trim();
};

const reloadDownloaders = async () => {
  state.downloaders = await downloaderStore.list();
  await renderDownloaderSettings();
};

const saveDownloaderCard = async (value) => {
  const record = globalThis.PT_AGENT_DOWNLOADER_STORE.normalize(value);
  const errors = globalThis.PT_AGENT_DOWNLOADER_STORE.validate(record);
  if (errors.length) {
    setProbeMessage(errors.join("；"), "error");
    return;
  }
  // 地址可能刚改过，保存时顺带把新地址的主机权限申请掉（此处仍在用户手势内）。
  try {
    await hostPermissions.ensure(record.address);
  } catch (_) {}
  await downloaderStore.upsert(record);
  state.routeCache = null;
  await reloadDownloaders();
  await selectActiveDownloader({ force: true });
  setProbeMessage(`已保存「${record.name}」。`, "success");
};

const grantDownloaderAccess = async (value) => {
  const record = globalThis.PT_AGENT_DOWNLOADER_STORE.normalize(value);
  try {
    const result = await hostPermissions.ensure(record.address);
    setProbeMessage(
      result.granted
        ? `已获得 ${record.address} 的访问权限。`
        : `你拒绝了 ${record.address} 的访问授权，该下载器无法连接。`,
      result.granted ? "success" : "error"
    );
  } catch (error) {
    setProbeMessage(error.message || String(error), "error");
  }
  await renderDownloaderSettings();
};

const testDownloaderCard = async (value) => {
  const record = globalThis.PT_AGENT_DOWNLOADER_STORE.normalize(value);
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  setProbeMessage(`正在测试「${record.name}」…`);
  try {
    if (!(await hostPermissions.has(record.address))) {
      await hostPermissions.ensure(record.address);
    }
    const adapter = globalThis.PT_AGENT_DOWNLOADER_TYPES.createAdapter(record, {
      onLog: (event, data) => debug(event, data, operationId)
    });
    await adapter.login();
    const version = await adapter.getVersion();
    setProbeMessage(`「${record.name}」连接成功：${version || "未知版本"}。`, "success");
  } catch (error) {
    setProbeMessage(`「${record.name}」连接失败：${error.message || String(error)}`, "error");
  }
  await renderDownloaderSettings();
};

const deleteDownloaderCard = async (id, name) => {
  if (!confirm(`确定删除下载器「${name || id}」吗？只删除插件里的配置，不影响下载器本身。`)) return;
  await downloaderStore.remove(id);
  state.routeCache = null;
  state.activeDownloader = null;
  await reloadDownloaders();
  setProbeMessage("已删除该下载器配置。", "success");
};

const moveDownloader = async (id, offset) => {
  state.downloaders = await downloaderStore.move(id, offset);
  state.routeCache = null;
  await renderDownloaderSettings();
  setProbeMessage("已调整探测优先级，顺序靠前的会先被尝试。", "success");
};

const addDownloader = async () => {
  const types = globalThis.PT_AGENT_DOWNLOADER_TYPES;
  await downloaderStore.upsert({
    name: `下载器 ${state.downloaders.length + 1}`,
    type: "qbittorrent",
    address: types.get("qbittorrent").defaultAddress,
    username: "",
    password: "",
    enabled: true
  });
  await reloadDownloaders();
  setProbeMessage("已新增一条下载器，请填写地址和账号后点「保存」。", "success");
};

const reprobeDownloaders = async () => {
  const button = $("reprobeDownloadersBtn");
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "探测中…";
  try {
    const selection = await selectActiveDownloader({ force: true });
    setProbeMessage(
      globalThis.PT_AGENT_NETWORK_ROUTER.describe(selection),
      selection.reason === "fallback" || selection.reason === "none" ? "error" : "success"
    );
    await renderDownloaderSettings();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
};

const siteTypeOptions = (selected) => {
  return Object.values(globalThis.PT_AGENT_SITE_STORE.SITE_TYPES).map((type) => `
    <option value="${escapeHtml(type.id)}" ${type.id === selected ? "selected" : ""}>${escapeHtml(type.name)}</option>
  `).join("");
};

const setSiteMessage = (message, type = "") => {
  const node = $("siteMessage");
  if (!node) return;
  node.textContent = message;
  node.className = `downloader-message ${type}`.trim();
};

const renderSiteSettings = () => {
  const list = $("siteList");
  if (!list) return;
  if (!state.sites.length) {
    list.innerHTML = `<div class="empty compact-empty">尚未配置站点。</div>`;
    return;
  }
  const current = activeSite();
  list.innerHTML = state.sites.map((item) => `
    <div class="settings-card ${current?.id === item.id ? "active" : ""}" data-site-id="${escapeHtml(item.id)}">
      <div class="settings-card-head">
        <div class="settings-card-title">
          <strong>${escapeHtml(item.name)}</strong>
          ${current?.id === item.id ? `<span class="settings-chip ok">当前使用</span>` : ""}
          ${item.enabled ? "" : `<span class="settings-chip off">已停用</span>`}
          ${item.apiKey ? "" : `<span class="settings-chip warn">缺少 API Key</span>`}
        </div>
      </div>
      <div class="settings-grid">
        <label><span>名称</span><input data-field="name" type="text" value="${escapeHtml(item.name)}"></label>
        <label><span>类型</span><select data-field="type">${siteTypeOptions(item.type)}</select></label>
        <label><span>站点地址</span><input data-field="siteUrl" type="url" value="${escapeHtml(item.siteUrl)}"></label>
        <label><span>API 地址</span><input data-field="apiUrl" type="url" value="${escapeHtml(item.apiUrl)}"></label>
        <label><span>API Key</span><input data-field="apiKey" type="password" value="${escapeHtml(item.apiKey)}" autocomplete="off"></label>
        <label><span>备注</span><input data-field="note" type="text" value="${escapeHtml(item.note)}"></label>
        <label class="settings-switch"><input data-field="enabled" type="checkbox" ${item.enabled ? "checked" : ""}><span>启用</span></label>
      </div>
      <div class="settings-card-foot">
        <span></span>
        <div class="settings-card-actions">
          <button class="btn btn-danger" type="button" data-action="delete">删除</button>
          <button class="btn btn-primary" type="button" data-action="save">保存</button>
        </div>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("[data-site-id]").forEach((card) => {
    const id = card.dataset.siteId;
    const read = () => {
      const value = { id };
      card.querySelectorAll("[data-field]").forEach((input) => {
        value[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value.trim();
      });
      return value;
    };
    card.querySelector('[data-action="save"]')?.addEventListener("click", () => saveSiteCard(read()));
    card.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteSiteCard(id, read().name));
  });
};

const saveSiteCard = async (value) => {
  const record = globalThis.PT_AGENT_SITE_STORE.normalize(value);
  const errors = globalThis.PT_AGENT_SITE_STORE.validate(record);
  if (errors.length) {
    setSiteMessage(errors.join("；"), "error");
    return;
  }
  await siteStore.upsert(record);
  state.sites = await siteStore.list();
  renderSiteSettings();
  setSiteMessage(`已保存站点「${record.name}」。`, "success");
};

const deleteSiteCard = async (id, name) => {
  if (!confirm(`确定删除站点「${name || id}」吗？`)) return;
  state.sites = await siteStore.remove(id);
  renderSiteSettings();
  setSiteMessage("已删除该站点配置。", "success");
};

const addSite = async () => {
  await siteStore.upsert({ name: `站点 ${state.sites.length + 1}`, type: "mteam", enabled: true });
  state.sites = await siteStore.list();
  renderSiteSettings();
  setSiteMessage("已新增一条站点，请填写地址和 API Key 后点「保存」。", "success");
};

const renderAuditEvents = () => {
  const list = $("auditList");
  if (!list) return;
  if (!state.auditEvents.length) {
    list.innerHTML = `<div class="empty compact-empty">暂无下载和保护动作记录。</div>`;
    return;
  }
  const actionLabels = {
    enqueue: "提交下载",
    enqueue_error: "提交失败",
    guard_warning: "保护预警",
    guard_delete: "保护删除",
    guard_error: "保护异常",
    torrent_excluded: "手动排除",
    torrent_restored: "恢复决策"
  };
  const newestEvents = globalThis.PT_AGENT_AUDIT.newestFirst(state.auditEvents);
  list.innerHTML = newestEvents.slice(0, 30).map((event) => `
    <div class="audit-row">
      <span>${escapeHtml(formatPublishedAt(event.timestamp))}</span>
      <span class="audit-action">${escapeHtml(actionLabels[event.action] || event.action || "未知动作")}</span>
      <span>${escapeHtml(event.status || "-")}</span>
      <span title="${escapeHtml(event.title || "")}">${escapeHtml(event.title || event.reason || "-")}</span>
    </div>
  `).join("");
};

const renderQbTorrents = () => {
  const list = $("qbList");
  const activeTorrents = state.qbTorrents.filter(isActiveDownload);
  if (!activeTorrents.length) {
    list.innerHTML = `<div class="empty compact-empty">qBittorrent 当前没有下载中的任务。</div>`;
    return;
  }

  list.innerHTML = activeTorrents.map((torrent) => {
    const progress = Math.max(0, Math.min(100, Number(torrent.progress || 0) * 100));
    const deadline = globalThis.PT_AGENT_QB.deadlineFromTags(torrent.tags);
    const guardResult = globalThis.PT_AGENT_GUARD.evaluate(torrent, {
      guardMinutes: state.policySettings?.guardMinutes || 10
    });
    const guard = guardPresentation(guardResult);
    const excluded = isTorrentExcluded({
      ...torrent,
      infoHash: torrent.hash,
      title: torrent.name,
      sizeBytes: torrent.total_size || torrent.size
    });
    return `
      <div class="qb-row">
        <div>
          <div class="qb-name">${escapeHtml(torrent.name || "(未命名任务)")}</div>
          <div class="qb-subtext">${escapeHtml(torrent.hash || "")}</div>
        </div>
        <div class="cell">${escapeHtml(torrent.state || "unknown")}</div>
        <div>
          <div class="progress-track"><div class="progress-bar" style="width:${progress.toFixed(1)}%"></div></div>
          <div class="progress-text">${progress.toFixed(1)}%</div>
        </div>
        <div class="cell">${formatSpeed(torrent.dlspeed)}</div>
        <div>
          <span class="guard-state ${escapeHtml(guardResult.status)}">${escapeHtml(guard.label)}</span>
          <div class="deadline ${deadline ? "" : "missing"}">${escapeHtml(deadline || "未设置截止标签")}</div>
          <div class="qb-subtext">${escapeHtml(guard.detail || torrent.tags || "无标签")}</div>
        </div>
        <div class="qb-actions">
          <button class="btn btn-danger qb-exclude-button" type="button" data-hash="${escapeHtml(torrent.hash || "")}">${excluded ? "重试删除" : "排除并删除"}</button>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".qb-exclude-button").forEach((button) => {
    button.addEventListener("click", () => {
      const torrent = state.qbTorrents.find((item) => item.hash === button.dataset.hash);
      if (torrent) excludeAndDeleteTorrent(torrent);
    });
  });
};

const renderExcludedTorrents = () => {
  const list = $("excludedList");
  if (!list) return;
  $("excludedCount").textContent = `${state.excludedTorrents.length} 个`;
  if (!state.excludedTorrents.length) {
    list.innerHTML = `<div class="empty compact-empty">暂无已排除种子。</div>`;
    return;
  }
  list.innerHTML = state.excludedTorrents.map((record) => `
    <div class="excluded-row">
      <div>
        <div class="qb-name">${escapeHtml(record.title || record.torrentId || record.infoHash || "未命名种子")}</div>
        <div class="qb-subtext">${escapeHtml(record.site && record.torrentId ? `${record.site}:${record.torrentId}` : record.infoHash || "名称和体积匹配")}</div>
      </div>
      <div class="cell">${escapeHtml(formatPublishedAt(record.excludedAt))}</div>
      <button class="btn btn-quiet excluded-restore-button" type="button" data-exclusion-id="${escapeHtml(record.id)}">恢复参与决策</button>
    </div>
  `).join("");
  list.querySelectorAll(".excluded-restore-button").forEach((button) => {
    button.addEventListener("click", () => restoreExcludedTorrent(button.dataset.exclusionId));
  });
};

const excludeAndDeleteTorrent = async (torrent) => {
  const confirmed = confirm(`确定排除并删除「${torrent.name || "未命名任务"}」吗？\n\nqBittorrent 任务和已下载文件都会删除；排除记录会保留，之后的种子决策不会再推荐它。`);
  if (!confirmed) return;
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  const source = globalThis.PT_AGENT_QB.sourceFromTags(torrent.tags) || {};
  const record = await exclusionStore.exclude({
    ...source,
    infoHash: torrent.hash,
    title: torrent.name,
    sizeBytes: torrent.total_size || torrent.size,
    reason: "user_manual",
    deleteFiles: true
  });
  state.excludedTorrents = await exclusionStore.list();
  state.evaluated = state.evaluated.filter((item) => !isTorrentExcluded(item));
  renderExcludedTorrents();
  renderList();
  await appendAuditEvent({
    action: "torrent_excluded",
    status: "excluded",
    title: record.title,
    site: record.site,
    torrentId: record.torrentId,
    reason: "用户手动加入排除列表，并请求删除 qB 任务和文件",
    deleteFiles: true
  }, operationId).catch(() => {});
  try {
    const client = await createDownloaderClient(operationId);
    await client.login();
    await client.deleteTorrents(torrent.hash, true);
    state.qbTorrents = state.qbTorrents.filter((item) => item.hash !== torrent.hash);
    renderQbTorrents();
    setQbMessage(`已删除并排除：${torrent.name}`, "success");
    showToast(`🗑️ 已删除并排除：${torrent.name}`, "success");
  } catch (error) {
    renderQbTorrents();
    const reason = error.message || String(error);
    setQbMessage(`已加入排除列表，但 qB 删除失败：${reason}`, "error");
    showToast(`⚠️ 已排除，但 qB 删除失败：${reason}`, "error");
  }
};

const restoreExcludedTorrent = async (id) => {
  const record = state.excludedTorrents.find((item) => item.id === id);
  state.excludedTorrents = await exclusionStore.restore(id);
  renderExcludedTorrents();
  renderQbTorrents();
  await appendAuditEvent({
    action: "torrent_restored",
    status: "restored",
    title: record?.title || "",
    site: record?.site || "",
    torrentId: record?.torrentId || "",
    reason: "用户恢复参与后续种子决策",
    deleteFiles: false
  }).catch(() => {});
  setQbMessage("已恢复参与决策；重新扫描后会再次显示符合条件的资源。", "success");
};

const refreshQbTorrents = async ({
  silent = false,
  operationId = globalThis.PT_AGENT_LOGGER.newOperationId()
} = {}) => {
  try {
    const client = await createDownloaderClient(operationId);
    await client.login();
    state.qbTorrents = await client.listTorrents("all");
    state.qbSeedingSummary = globalThis.PT_AGENT_QB.summarizeMteamSeeding(state.qbTorrents);
    const downloadingCount = state.qbTorrents.filter(isActiveDownload).length;
    debug(
      "qb:refreshed",
      { tasks: state.qbTorrents.length, downloading: downloadingCount, evaluated: state.evaluated.length },
      operationId
    );
    renderQbTorrents();
    await loadAuditEvents();
    // qB 数据到位后必定重渲染资源列表，让「下载中/已下载」状态即时生效（修复重开插件后状态丢失）。
    if (state.evaluated.length) renderList();
    setQbStatus(`已连接 · ${state.activeDownloader?.name || ""}`.trim(), "ok");
    if (!silent) {
      setQbMessage(
        `${state.activeDownloader?.name || "下载器"} 当前有 ${downloadingCount} 个下载中任务。`,
        "success"
      );
    }
    return true;
  } catch (error) {
    debug("qb:refresh-failed", String(error?.message || error), operationId);
    setQbStatus("连接失败", "bad");
    setQbMessage(error.message || String(error), "error");
    return false;
  }
};

const testQbConnection = async () => {
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  try {
    const client = await createDownloaderClient(operationId);
    await client.login();
    const version = await client.getVersion();
    setQbStatus("已连接", "ok");
    setQbMessage(
      `${state.activeDownloader?.name || "下载器"}（${version || "未知版本"}）连接成功。`,
      "success"
    );
  } catch (error) {
    setQbStatus("连接失败", "bad");
    setQbMessage(
      `${error.message || String(error)}。若账号无误，请检查 qB WebUI 的 CSRF、Host Header 和跨域设置。`,
      "error"
    );
  }
};

const renderQbDiagnostic = (result, address) => {
  const panel = $("qbDiagnostic");
  panel.hidden = false;
  const stageRows = (result?.stages || []).map((stage) => `
    <div class="qb-diagnostic-stage ${escapeHtml(stage.status)}">
      <span class="diagnostic-dot"></span>
      <strong>${escapeHtml(stage.label)}</strong>
      <span>${escapeHtml(stage.detail)}</span>
    </div>
  `).join("");
  const hint = result?.failedStage === "reachability"
    ? "浏览器没有收到 qB 的 HTTP 响应。请确认 WebUI 已启动、地址和端口正确；如果地址改过，还要确认扩展拥有该地址的访问权限，并检查 HTTP/HTTPS 是否一致。"
    : result?.failedStage === "login"
      ? "qB 服务可以访问，但登录未通过。请检查账号密码，以及 WebUI 的 Host Header、CSRF 和认证设置。"
      : result?.failedStage === "api"
        ? "登录成功，但 Web API 版本接口异常。请检查 qB WebUI/API 设置。"
        : "网络、登录和 Web API 均正常。";
  panel.innerHTML = `
    <div class="qb-diagnostic-title">
      <strong>qB 独立诊断</strong>
      <span>${escapeHtml(address || "")}</span>
    </div>
    ${stageRows}
    <div class="qb-diagnostic-hint">${escapeHtml(hint)}</div>
  `;
};

const diagnoseQbConnection = async () => {
  const button = $("diagnoseQbBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "检测中…";
  try {
    const downloader = await requireActiveDownloader();
    const client = await createDownloaderClient(globalThis.PT_AGENT_LOGGER.newOperationId());
    const result = await client.diagnose();
    renderQbDiagnostic(result, downloader.address);
    setQbStatus(result.ok ? "诊断通过" : "诊断失败", result.ok ? "ok" : "bad");
    setQbMessage(
      result.ok
        ? `qBittorrent ${result.version} 独立诊断通过。`
        : `qB 独立诊断停在「${result.stages.at(-1)?.label || "未知阶段"}」。`,
      result.ok ? "success" : "error"
    );
  } catch (error) {
    const result = {
      ok: false,
      failedStage: "settings",
      stages: [{
        key: "settings",
        label: "设置校验",
        status: "error",
        detail: error.message || String(error)
      }]
    };
    renderQbDiagnostic(result, state.activeDownloader?.address || "");
    setQbStatus("诊断失败", "bad");
    setQbMessage(error.message || String(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
};

// 在浏览器侧抓取 .torrent 文件字节（插件有 M-Team 权限与用户会话），失败则返回 null 由调用方回退到 URL。
const fetchTorrentFile = async (downloadUrl, operationId) => {
  try {
    const response = await fetch(downloadUrl, { credentials: "omit" });
    debug(
      "qb:torrent-fetch",
      { ok: response.ok, status: response.status, type: response.headers.get("content-type") },
      operationId
    );
    if (!response.ok) return null;
    const blob = await response.blob();
    // 校验确实是种子文件：排除 HTML 错误页和明显过小的响应。
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("html") || blob.size < 40) {
      debug("qb:torrent-fetch-suspect", { size: blob.size, contentType }, operationId);
      return null;
    }
    return blob;
  } catch (error) {
    debug("qb:torrent-fetch-error", String(error?.message || error), operationId);
    return null;
  }
};

const enqueueTorrentDirectToQb = async (torrent, downloadUrl, operationId) => {
  const downloader = await requireActiveDownloader(operationId);
  const client = await createDownloaderClient(operationId);
  const savePath = downloader.savePath || "";
  const category = downloader.category || "PT_AGENT";
  await client.login();
  await client.ensureCategory(category, savePath);
  const tag = [
    globalThis.PT_AGENT_QB.torrentTags(torrent.freeEndAt || ""),
    globalThis.PT_AGENT_QB.sourceTag(torrent.site, torrent.torrentId)
  ].filter(Boolean).join(", ");
  // 优先在浏览器侧取到 .torrent 字节再上传：qB 服务端去抓 M-Team 链接可能因鉴权/出口 IP 失败并静默丢弃。
  const file = await fetchTorrentFile(downloadUrl, operationId);
  const safeName = String(torrent.title || torrent.torrentId || "download")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
  debug(
    "qb:add",
    { route: file ? "file" : "url", fileSize: file?.size || 0, tag, savePath, category, downloader: downloader.name },
    operationId
  );
  const addResult = await client.addTorrent({
    url: downloadUrl,
    file,
    filename: `${safeName}.torrent`,
    tag,
    savePath,
    category
  });
  debug("qb:add-result", addResult, operationId);
  return {
    route: file ? "file" : "url",
    downloader: downloader.name,
    category,
    evaluation: {
      decision: torrent.decision,
      score: Number(torrent.score || 0)
    }
  };
};

const enqueueTorrent = async (torrent, { manualOverride = false, batchQueued = 0 } = {}) => {
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  const key = `${torrent.site}:${torrent.torrentId || torrent.rowIndex}`;
  state.qbPushStatus.set(key, "loading");
  renderList();
  debug(
    "qb:enqueue-start",
    {
      title: torrent.title,
      site: torrent.site,
      torrentId: torrent.torrentId,
      hasDownloadUrl: Boolean(torrent.downloadUrl),
      freeEndAt: torrent.freeEndAt || null,
      decision: torrent.decision,
      manualOverride,
      batchQueued
    },
    operationId
  );
  try {
    if (!torrent.freeEndAt && !manualOverride) {
      throw new Error("缺少 Free 截止时间，未发送到 qBittorrent");
    }
    // 本地安全准入：并发上限、评分、体积、Free 剩余和分享率都在入队前真正拦截，手动覆盖除外。
    if (!manualOverride) {
      const admission = admissionFor(torrent, batchQueued);
      debug(
        "qb:admission",
        { title: torrent.title, allowed: admission.allowed, reasons: admission.reasons },
        operationId
      );
      if (!admission.allowed) {
        throw new Error(`本地安全准入拒绝：${admission.reasons.join("；")}`);
      }
    }
    const downloadUrl = await resolveTorrentDownloadUrl(torrent, operationId);
    const result = await enqueueTorrentDirectToQb(torrent, downloadUrl, operationId);
    await appendAuditEvent({
      action: manualOverride ? "enqueue_manual_override" : "enqueue",
      status: "queued",
      title: torrent.title,
      site: torrent.site,
      torrentId: torrent.torrentId || "",
      deadline: torrent.freeEndAt,
      progress: 0,
      downloader: result.downloader,
      reason: manualOverride
        ? `用户手动覆盖 risk 准入，下载器 ${result.downloader}，分类 ${result.category}，评分 ${result.evaluation.score}`
        : `本地安全准入通过，下载器 ${result.downloader}，分类 ${result.category}，评分 ${result.evaluation.score}`,
      deleteFiles: false
    }, operationId).catch(() => {});
    state.qbPushStatus.set(key, "success");
    const okMessage = manualOverride
      ? `已按你的判断手动发送：${torrent.title}`
      : `已发送到 qBittorrent：${torrent.title}`;
    setQbMessage(`${okMessage}；下载器：${result.downloader}，分类：${result.category}`, "success");
    showToast(`✅ ${okMessage}`, "success");
    // 发送后验证：qB 可能回「Ok」却因保存目录无效/重复/被拒而不真正添加，此处兜底提示，避免假成功。
    setTimeout(async () => {
      await refreshQbTorrents({ silent: true, operationId });
      const landed = findQbTorrent(torrent);
      debug(
        "qb:verify",
        { title: torrent.title, landedInQb: Boolean(landed), qbTorrents: state.qbTorrents.length },
        operationId
      );
      if (!landed) {
        showToast(
          `⚠️ qB 接受了请求，但未出现任务「${torrent.title}」。可能是：保存目录无效、重复任务、或种子被 qB 拒绝。控制台看 [PT] qb:add-result。`,
          "error"
        );
      }
    }, 1800);
    return true;
  } catch (error) {
    state.qbPushStatus.set(key, "error");
    const reason = error.message || String(error);
    await appendAuditEvent({
      action: "enqueue_error",
      status: "failed",
      title: torrent.title,
      site: torrent.site,
      torrentId: torrent.torrentId || "",
      deadline: formatDeadline(torrent.freeEndAt),
      progress: 0,
      reason,
      deleteFiles: false
    }, operationId).catch(() => {});
    setQbMessage(`${torrent.title}：${reason}`, "error");
    showToast(`❌ 发送失败：${torrent.title}\n${reason}`, "error");
    debug("qb:enqueue-error", reason, operationId);
    return false;
  } finally {
    renderList();
  }
};

const pushRecommended = async () => {
  const torrents = state.evaluated.filter((torrent) => torrent.decision === "recommend" && !isTorrentExcluded(torrent));
  if (!torrents.length) {
    setQbMessage("当前没有可一键下载的推荐资源。", "error");
    return;
  }
  $("downloadRecommendedBtn").disabled = true;
  let succeeded = 0;
  try {
    // 逐个累计 batchQueued，让并发上限在一次批量里也真正生效（此前会一次性推送全部推荐）。
    for (const torrent of torrents) {
      if (await enqueueTorrent(torrent, { batchQueued: succeeded })) succeeded += 1;
    }
  } finally {
    $("downloadRecommendedBtn").disabled = false;
  }
  setQbMessage(
    `批量提交 ${torrents.length} 个：成功 ${succeeded}，拒绝或失败 ${torrents.length - succeeded}。`,
    succeeded ? "success" : "error"
  );
};

const renderCounts = () => {
  const all = state.evaluated.length;
  const recommend = state.evaluated.filter((item) => item.decision === "recommend").length;
  const risk = state.evaluated.filter((item) => item.decision === "risk").length;
  const reject = state.evaluated.filter((item) => item.decision === "reject").length;

  $("countAll").textContent = all;
  $("countRecommend").textContent = recommend;
  $("countRisk").textContent = risk;
  $("countReject").textContent = reject;
};

const renderAccount = () => {
  const account = state.scan?.account || {};
  const qbSeeding = state.qbSeedingSummary;
  const ratio = Number(account.ratio);
  const bonus = Number(account.bonus);
  const bonusPerHour = Number(account.bonusPerHour);
  $("ratio").textContent = Number.isFinite(ratio) && ratio > 0 ? ratio.toFixed(3) : "-";
  $("uploaded").textContent = account.uploadedBytes ? formatBytes(account.uploadedBytes) : account.uploadedText || "-";
  $("downloaded").textContent = account.downloadedBytes ? formatBytes(account.downloadedBytes) : account.downloadedText || "-";
  $("bonus").textContent = Number.isFinite(bonus) && bonus >= 0 ? bonus.toLocaleString("zh-CN") : "-";
  $("bonusPerHour").textContent = Number.isFinite(bonusPerHour) && bonusPerHour >= 0 ? `${bonusPerHour.toFixed(3)}/h` : "-";
  const displayedSeedingCount = qbSeeding?.count ?? account.seedingCount;
  const displayedSeedingSize = qbSeeding?.sizeBytes ?? account.seedingSizeBytes;
  $("seedingCount").textContent = Number.isFinite(Number(displayedSeedingCount)) ? `${Number(displayedSeedingCount)} 个` : "-";
  $("seedingSize").textContent = displayedSeedingSize ? formatBytes(displayedSeedingSize) : account.seedingSizeText || "-";
  $("bonusFormulaNote").textContent = account.source === "mteam-api"
    ? `qB 全库统计包含所有已完成的 M-Team 任务；站点当前实际认可 ${account.trackerSeedingCount} 个、${formatBytes(account.trackerSeedingSizeBytes)}，魔力产出以 Tracker 返回值为准。`
    : "";
  const fallbackAssessment = globalThis.PT_AGENT_ASSESSMENT.calculate({
    bonus: account.bonus,
    bonusPerHour: account.bonusPerHour,
    createdDate: account.createdDate,
    uploadedBytes: account.uploadedBytes,
    downloadedBytes: account.downloadedBytes,
    seedingCount: account.trackerSeedingCount,
    seedingSizeBytes: account.trackerSeedingSizeBytes,
    target: 6000,
    assessmentDays: 30
  });
  const assessment = fallbackAssessment;
  const etaDays = Number.isFinite(assessment.etaHours) ? `${(assessment.etaHours / 24).toFixed(1)} 天` : "无法估算";
  const requiredRate = Number.isFinite(assessment.requiredRate) ? `${assessment.requiredRate.toFixed(2)}/h` : "已超过估算期限";
  const recommendedPlan = assessment.recommendedPlan || {};
  const safeTargetRate = Number.isFinite(recommendedPlan.targetRate)
    ? `${recommendedPlan.targetRate.toFixed(2)}/h`
    : "无法估算";
  const additionalRate = Number.isFinite(recommendedPlan.additionalRate)
    ? `${recommendedPlan.additionalRate.toFixed(2)}/h`
    : "无法估算";
  const deadline = assessment.deadlineAt
    ? formatDeadline(new Date(assessment.deadlineAt).toISOString())
    : "以站内通知为准";
  const queuedShare = qbSeeding?.count > 0 ? qbSeeding.queuedCount / qbSeeding.count : 0;
  const currentTrackerSize = Number(assessment.seedingSizeBytes || 0);
  const estimatedTargetSize = Number(recommendedPlan.estimatedTargetSeedSizeBytes);
  const estimatedLow = Number(recommendedPlan.estimatedAdditionalSeedBytesLow);
  const estimatedHigh = Number(recommendedPlan.estimatedAdditionalSeedBytesHigh);
  const seedingScale = queuedShare >= 0.5
    ? `先激活现有 ${formatBytes(qbSeeding.sizeBytes)}`
    : Number.isFinite(estimatedTargetSize) && estimatedTargetSize > 0
      ? formatBytes(estimatedTargetSize)
      : "需先建立效率基准";
  const additionalSeedSize = Number.isFinite(estimatedLow) && Number.isFinite(estimatedHigh)
    ? estimatedHigh > 0
      ? `${formatBytes(estimatedLow)}～${formatBytes(estimatedHigh)}`
      : "无需新增"
    : "无法估算";
  const safetyMargin = Number.isFinite(assessment.safetyMarginHours)
    ? assessment.safetyMarginHours >= 0
      ? `${(assessment.safetyMarginHours / 24).toFixed(1)} 天`
      : `落后 ${Math.abs(assessment.safetyMarginHours / 24).toFixed(1)} 天`
    : "无法估算";
  const projectedBonus = Number.isFinite(assessment.projectedAtDeadline)
    ? assessment.projectedAtDeadline.toFixed(0)
    : "无法估算";
  const statusLabels = {
    achieved: "已完成",
    on_track: "进度安全",
    at_risk: "余量偏低",
    critical: "临界危险",
    off_track: "当前无法完成",
    expired: "已过期",
    unknown: "信息不足"
  };
  const statusLabel = statusLabels[assessment.status] || assessment.status;
  const queueWarning = qbSeeding?.queuedCount
    ? `qB 有 ${qbSeeding.queuedCount} 个已完成 M-Team 任务处于 queuedUP，当前活跃做种仅 ${qbSeeding.activeCount} 个；应先处理上传队列，让任务实际向 Tracker 汇报。`
    : `qB 当前活跃 M-Team 做种 ${qbSeeding?.activeCount ?? "-"} 个。`;
  $("newbieAssessment").innerHTML = `
    <div class="assessment-head">
      <div>
        <div class="panel-kicker">NEW USER ASSESSMENT</div>
        <strong>新手考核 · 6000 魔力</strong>
      </div>
      <span class="assessment-status ${escapeHtml(assessment.status)}">${escapeHtml(statusLabel)} · ${assessment.progress.toFixed(1)}%</span>
    </div>
    <div class="assessment-progress"><i style="width:${assessment.progress.toFixed(1)}%"></i></div>
    <div class="assessment-metrics">
      <div><span>当前 / 目标</span><b>${assessment.current.toFixed(1)} / 6000</b></div>
      <div><span>魔力还差</span><b>${assessment.remaining.toFixed(1)}</b></div>
      <div><span>上传还差</span><b>${assessment.remainingUploadedBytes > 0 ? formatBytes(assessment.remainingUploadedBytes) : "已达标"}</b></div>
      <div><span>下载还差</span><b>${assessment.remainingDownloadedBytes > 0 ? formatBytes(assessment.remainingDownloadedBytes) : "已达标"}</b></div>
      <div><span>当前产出</span><b>${assessment.rate.toFixed(3)}/h</b></div>
      <div><span>截止底线</span><b>${requiredRate}</b></div>
      <div><span>提前 5 天目标</span><b>${safeTargetRate}</b></div>
      <div><span>还需提升</span><b>${additionalRate}</b></div>
      <div><span>Tracker 认可做种</span><b>${assessment.seedingCount} 个 · ${formatBytes(currentTrackerSize)}</b></div>
      <div><span>建议总做种规模</span><b>${seedingScale}</b></div>
      <div><span>预计还需新增</span><b>${additionalSeedSize}</b></div>
      <div><span>当前安全余量</span><b>${safetyMargin}</b></div>
      <div><span>截止预计魔力</span><b>${projectedBonus}</b></div>
      <div><span>当前速度预计</span><b>${etaDays}</b></div>
      <div><span>30 天估算截止</span><b>${deadline}</b></div>
    </div>
    <div class="assessment-advice">${escapeHtml(queueWarning)} 新手期按原始做种魔力估算；建议容量区间按当前 Tracker 效率计算，并用 2 倍作为保守上限。实际结果还受种龄、体积和同种人数影响，最终以 M-Team 站内通知为准。</div>
  `;
};

const renderSiteStatus = () => {
  const site = state.scan?.site;
  if (!site) return;
  const title = site.matched ? `${site.siteName} · ${site.mode}` : "未适配站点";
  const status = site.usable ? "可用" : site.mode === "partial" ? "部分可用" : "未适配";
  $("siteName").textContent = title;
  $("siteStatus").textContent = status;
  $("siteStatus").className = `site-status ${site.usable ? "ok" : site.mode === "partial" ? "warn" : "bad"}`;
  $("sidebarSiteName").textContent = site.siteName || "未适配站点";
  $("sidebarSiteMode").textContent = `${status} · ${state.evaluated.length} 个资源`;

  const fields = site.fields || {};
  const labels = {
    rows: "种子行",
    title: "标题",
    downloadUrl: "下载链接",
    size: "大小",
    freeLabel: "Free 标识",
    freeEnd: "Free 截止",
    seeders: "做种",
    leechers: "下载",
    hr: "HR"
  };
  $("siteFields").innerHTML = Object.entries(labels).map(([key, label]) => {
    const ok = !!fields[key];
    return `<span class="field ${ok ? "ok" : "missing"}">${ok ? "✓" : "!"} ${label}</span>`;
  }).join("");
  $("siteWarnings").textContent = (site.warnings || []).join("；");
};

const renderList = () => {
  renderCounts();
  renderAccount();
  renderSiteStatus();

  const list = $("list");
  const freeRemainingSortValue = (item) => {
    if (item.leftHours === null || item.leftHours === undefined) return -Infinity;
    const value = Number(item.leftHours);
    return Number.isFinite(value) ? value : -Infinity;
  };
  const rows = state.evaluated
    .filter((item) => !isTorrentExcluded(item))
    .filter((item) => state.filter === "all" || item.decision === state.filter)
    .sort((a, b) => freeRemainingSortValue(b) - freeRemainingSortValue(a));

  const matchedInQb = state.qbTorrents.length
    ? rows.filter((item) => qbResourceStatus(item)).length
    : 0;
  debug("render:list", {
    evaluated: state.evaluated.length,
    rows: rows.length,
    filter: state.filter,
    qbTorrents: state.qbTorrents.length,
    matchedInQb
  });

  if (!rows.length) {
    list.innerHTML = state.evaluated.length
      ? `<div class="empty">当前「${state.filter}」筛选下没有资源，点顶部标签切换。</div>`
      : `<div class="empty">点击右上角「重新扫描」加载 M-Team 当前 Free 资源。</div>`;
    return;
  }

  list.innerHTML = rows.map((item) => {
    const decisionText = item.decision === "recommend" ? "推荐" : item.decision === "risk" ? "风险" : "拒绝";
    const peers = `${item.seeders || 0} / ${item.leechers || 0}`;
    const leftText = formatLeft(item.leftHours);
    const deadlineText = formatDeadline(item.freeEndAt);
    const publishedText = formatPublishedAt(item.publishedAt);
    const title = escapeHtml(item.title || "(未命名资源)");
    const titleContent = item.detailUrl
      ? `<a class="title" href="${escapeHtml(item.detailUrl)}" target="_blank" rel="noreferrer">${title}</a>`
      : `<span class="title">${title}</span>`;
    const detailAction = item.detailUrl
      ? `<a class="row-action" href="${escapeHtml(item.detailUrl)}" target="_blank" rel="noreferrer">详情</a>`
      : "";
    const downloadAction = item.downloadUrl
      ? `<a class="row-action" href="${escapeHtml(item.downloadUrl)}" target="_blank" rel="noreferrer">浏览器下载</a>`
      : "";
    const qbKey = `${item.site}:${item.torrentId || item.rowIndex}`;
    const qbPushStatus = state.qbPushStatus.get(qbKey);
    const resourceStatus = qbResourceStatus(item);
    const admission = admissionFor(item);
    const policyBlocked = item.decision === "reject";
    // 推荐资源若被本地准入拦截（并发已满、评分不足等），在按钮上直接说明，避免点下去才看到失败提示。
    const admissionBlocked = item.decision === "recommend" && !admission.allowed;
    const qbLabel =
      qbPushStatus === "loading" ? "发送中…" :
      resourceStatus === "downloaded" ? "已下载" :
      resourceStatus === "downloading" ? "下载中" :
      qbPushStatus === "success" ? "已发送" :
      qbPushStatus === "error" ? "重试下载" :
      policyBlocked ? "安全策略拦截" :
      admissionBlocked ? "准入拦截" :
      "一键下载";
    const qbAction = `<button class="row-action qb-download-button ${resourceStatus || (qbPushStatus === "success" ? "sent" : "")}" type="button" data-row-index="${item.rowIndex}" title="${escapeHtml(admission.reasons.join("；"))}" ${qbPushStatus === "loading" || resourceStatus || policyBlocked ? "disabled" : ""}>${qbLabel}</button>`;
    return `
      <article class="card">
        <div class="resource-main">
          ${titleContent}
          <div class="subtitle">${escapeHtml(item.category || item.site || "unknown")} · ${escapeHtml(item.freeType || "unknown")} · score ${item.score}</div>
          <div class="reason">${item.reasons.map(escapeHtml).join("；")}</div>
        </div>
        <div>
          <span class="cell-label">决策</span>
          <span class="badge ${item.decision}">${decisionText}</span>
        </div>
        <div class="cell">
          <span class="cell-label">大小</span>
          ${escapeHtml(item.sizeText || bytesToGB(item.sizeBytes))}
        </div>
        <div class="cell">
          <span class="cell-label">做种 / 下载</span>
          ${peers}
        </div>
        <div class="cell left-time ${item.leftHours !== null && item.leftHours <= 0 ? "expired" : ""}">
          <span class="cell-label">Free 剩余</span>
          ${leftText}
        </div>
        <div class="cell deadline ${item.freeEndAt ? "" : "missing"}">
          <span class="cell-label">Free 截止时间</span>
          ${escapeHtml(deadlineText)}
        </div>
        <div class="cell published-at">
          <span class="cell-label">发布时间</span>
          ${escapeHtml(publishedText)}
        </div>
        <div class="row-actions">
          ${detailAction}
          ${downloadAction}
          ${qbAction}
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll(".qb-download-button").forEach((button) => {
    button.addEventListener("click", () => {
      const rowIndex = Number(button.dataset.rowIndex);
      const torrent = state.evaluated.find((item) => item.rowIndex === rowIndex);
      if (!torrent) return;
      const manualOverride = torrent.decision === "risk";
      enqueueTorrent(torrent, { manualOverride });
    });
  });
};

const escapeHtml = (value) => {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
};

// 用当前策略重新评估已扫描到的资源。改了下载策略后不必重新拉一遍 M-Team。
const reevaluateScannedTorrents = (
  settings = state.policySettings || defaultSettings,
  { render = true } = {}
) => {
  state.evaluated = (state.scan?.torrents || [])
    .filter((torrent) => !isTorrentExcluded(torrent))
    .map((torrent) => evaluateTorrent(torrent, settings))
    .sort((a, b) => publishedTimestamp(b.publishedAt) - publishedTimestamp(a.publishedAt));
  if (render) renderList();
  return state.evaluated;
};

const runScan = async () => {
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  debug("scan:start", null, operationId);
  $("list").innerHTML = `<div class="empty">正在从 M-Team API 加载当前 Free…</div>`;
  try {
    const settings = state.policySettings || await getSettings();
    state.policySettings = settings;
    const [accountResult, catalogResult] = await Promise.allSettled([
      fetchMteamAccount(operationId),
      fetchMteamFreeCatalog(operationId)
    ]);
    debug(
      "scan:fetched",
      {
        account: accountResult.status,
        catalog: catalogResult.status,
        catalogCount: catalogResult.status === "fulfilled" ? catalogResult.value?.torrents?.length : null,
        catalogError: catalogResult.status === "rejected" ? String(catalogResult.reason?.message || catalogResult.reason) : null
      },
      operationId
    );
    if (catalogResult.status === "fulfilled") {
      const catalog = catalogResult.value;
      state.scan = {
        page: {
          title: "M-Team 当前 Free",
          url: siteUrl(),
          scannedAt: new Date().toISOString()
        },
        site: {
          matched: true,
          siteId: "mteam",
          siteName: "M-Team",
          usable: true,
          mode: "api",
          fields: {
            rows: true,
            title: true,
            downloadUrl: true,
            size: true,
            freeLabel: true,
            freeEnd: true,
            seeders: true,
            leechers: true,
            hr: true
          },
          warnings: [
            `独立 API 模式 · 普通区 ${catalog.stats.normalPages} 页、成人区 ${catalog.stats.adultPages} 页`
          ]
        },
        account: accountResult.status === "fulfilled" ? accountResult.value : {},
        torrents: catalog.torrents,
        catalogStats: catalog.stats
      };
    } else {
      let fallbackScan;
      try {
        fallbackScan = await scanSourceTab();
      } catch (_) {
        throw new Error(`M-Team API 加载失败：${catalogResult.reason?.message || String(catalogResult.reason)}`);
      }
      state.scan = fallbackScan;
      state.scan.site.warnings = [
        ...(state.scan.site.warnings || []),
        `独立 API 加载失败，已降级为当前页面：${catalogResult.reason?.message || String(catalogResult.reason)}`
      ];
      if (accountResult.status === "fulfilled") {
        state.scan.account = { ...(state.scan.account || {}), ...accountResult.value };
      }
    }
    reevaluateScannedTorrents(settings, { render: false });
    const catalogStats = state.scan?.catalogStats;
    $("pageInfo").textContent = catalogStats
      ? `M-Team 当前 Free · ${catalogStats.total} 个资源 · 普通区 ${catalogStats.normalPages} 页 / 成人区 ${catalogStats.adultPages} 页`
      : `${state.scan?.page?.title || "当前页面"} · ${state.evaluated.length} 个资源`;
    debug(
      "scan:evaluated",
      { evaluated: state.evaluated.length, filter: state.filter, qbTorrents: state.qbTorrents.length },
      operationId
    );
    renderList();
  } catch (error) {
    debug("scan:error", String(error?.message || error), operationId);
    $("list").innerHTML = `<div class="empty">扫描失败：${escapeHtml(error.message || String(error))}</div>`;
  }
};

const focusSourceTab = async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.create({
      url: siteUrl(),
      active: true,
      windowId: activeTab?.windowId
    });
  } catch (error) {
    $("pageInfo").textContent = error.message || String(error);
  }
};

const openFullscreenDashboard = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const dashboardUrl = new URL(chrome.runtime.getURL("popup.html"));
    dashboardUrl.searchParams.set("mode", "dashboard");
    if (Number.isInteger(state.sourceTabId)) {
      dashboardUrl.searchParams.set("sourceTabId", String(state.sourceTabId));
    }
    await chrome.tabs.create({
      url: dashboardUrl.toString(),
      active: true,
      windowId: tab?.windowId
    });
  } catch (error) {
    $("pageInfo").textContent = error.message || String(error);
  }
};

const switchView = (view) => {
  state.activeView = ["downloads", "settings", "logs"].includes(view) ? view : "resources";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === state.activeView);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  if (state.activeView === "downloads" && state.downloaders.some((item) => item.password)) {
    refreshQbTorrents({ silent: true });
  }
  if (state.activeView === "settings") {
    renderDownloaderSettings();
    renderSiteSettings();
  }
  if (state.activeView === "logs") {
    logPage = 0;
    renderLogs();
  }
};

const exportPayload = () => {
  return {
    page: state.scan?.page || null,
    account: state.scan?.account || null,
    torrents: state.evaluated
  };
};

const copyJson = async () => {
  const json = JSON.stringify(exportPayload(), null, 2);
  await navigator.clipboard.writeText(json);
  $("copyBtn").textContent = "已复制";
  setTimeout(() => {
    $("copyBtn").textContent = "复制 JSON";
  }, 900);
};

const downloadJson = () => {
  const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pt-agent-scan-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const exportAuditJson = () => {
  const safe = globalThis.PT_AGENT_LOGGER.redact(state.auditEvents);
  const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pt-agent-audit-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const applyTheme = (theme) => {
  const resolved = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = resolved;
  const btn = $("themeBtn");
  if (btn) btn.textContent = resolved === "light" ? "☀️" : "🌙";
};

const initTheme = async () => {
  const stored = await chrome.storage.local.get("ptAgentTheme");
  applyTheme(stored.ptAgentTheme || "dark");
  $("themeBtn")?.addEventListener("click", async () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    await chrome.storage.local.set({ ptAgentTheme: next });
  });
};

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  const isDashboard = params.get("mode") === "dashboard";
  debug("boot", { mode: isDashboard ? "dashboard" : "popup", url: location.href });
  await loadDebugLog();
  await initTheme();
  document.documentElement.className = isDashboard ? "mode-dashboard" : "mode-popup";
  document.body.className = isDashboard ? "mode-dashboard" : "mode-popup";
  const sourceTabId = Number(new URLSearchParams(location.search).get("sourceTabId"));
  state.sourceTabId = Number.isInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null;
  if (!state.sourceTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.sourceTabId = activeTab?.id || null;
  }
  [state.policySettings, state.downloaders, state.sites, state.excludedTorrents] = await Promise.all([
    getSettings(),
    downloaderStore.list(),
    siteStore.list(),
    exclusionStore.list()
  ]);
  fillGuardSettingsForm(state.policySettings);
  fillPolicySettingsForm(state.policySettings);
  await renderDownloaderSettings();
  renderSiteSettings();
  await loadAuditEvents();
  renderExcludedTorrents();
  $("scanBtn").addEventListener("click", runScan);
  $("sourceBtn").addEventListener("click", focusSourceTab);
  $("fullscreenBtn").addEventListener("click", openFullscreenDashboard);
  $("addDownloaderBtn").addEventListener("click", addDownloader);
  $("reprobeDownloadersBtn").addEventListener("click", reprobeDownloaders);
  $("addSiteBtn").addEventListener("click", addSite);
  $("testQbBtn").addEventListener("click", testQbConnection);
  $("diagnoseQbBtn").addEventListener("click", diagnoseQbConnection);
  $("backfillDeadlineBtn").addEventListener("click", backfillMteamDeadlines);
  $("refreshQbBtn").addEventListener("click", refreshQbTorrents);
  $("saveGuardBtn").addEventListener("click", saveGuardSettings);
  $("savePolicyBtn").addEventListener("click", savePolicySettings);
  $("resetPolicyBtn").addEventListener("click", resetPolicySettings);
  $("downloadRecommendedBtn").addEventListener("click", pushRecommended);
  $("copyBtn").addEventListener("click", copyJson);
  $("downloadBtn").addEventListener("click", downloadJson);
  $("exportAuditBtn").addEventListener("click", exportAuditJson);
  $("refreshLogsBtn").addEventListener("click", renderLogs);
  $("exportLogsBtn").addEventListener("click", exportLogs);
  $("clearLogsBtn").addEventListener("click", clearLogs);
  renderLogs();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter;
      renderList();
    });
  });
  const usableDownloaders = state.downloaders.filter((item) => item.enabled && item.password);
  debug("boot:kickoff", {
    downloaders: state.downloaders.length,
    usableDownloaders: usableDownloaders.length,
    sites: state.sites.length,
    hasSiteApiKey: Boolean(activeSite()?.apiKey)
  });
  runScan();
  if (usableDownloaders.length) refreshQbTorrents({ silent: true });
});
