const state = {
  scan: null,
  evaluated: [],
  filter: "all",
  activeView: "resources",
  sourceTabId: null,
  policySettings: null,
  coreSettings: null,
  coreSyncing: false,
  coreSyncQueued: false,
  corePrediction: null,
  qbSettings: null,
  qbTorrents: [],
  qbSeedingSummary: null,
  qbPushStatus: new Map(),
  auditEvents: []
};

const $ = (id) => document.getElementById(id);

const defaultSettings = {
  guardMinutes: 10,
  minFreeHoursForAutoDownload: 12,
  maxTorrentSizeGB: 50,
  minimumScore: 80,
  maxActiveDownloads: 3,
  minimumRatio: 1,
  scarceOpportunityMaxSizeGB: 10,
  scarceOpportunityMinFreeHours: 6,
  scarceOpportunityMaxRequiredSpeedBps: 512 * 1024,
  scarceOpportunityMinLeechers: 20,
  scarceOpportunityMinDemandRatio: 10,
  guardMonitorEnabled: true,
  autoDeleteExpired: false,
  guardExecutor: "core",
  rejectHr: true,
  rejectMissingFreeEnd: true
};

const defaultQbSettings = {
  address: globalThis.PT_AGENT_PRIVATE_CONFIG.qbAddress,
  username: globalThis.PT_AGENT_PRIVATE_CONFIG.qbUsername,
  password: globalThis.PT_AGENT_PRIVATE_CONFIG.qbPassword,
  savePath: globalThis.PT_AGENT_PRIVATE_CONFIG.qbSavePath,
  mteamApiKey: globalThis.PT_AGENT_PRIVATE_CONFIG.mteamApiKey
};

const defaultCoreSettings = {
  address: globalThis.PT_AGENT_PRIVATE_CONFIG.coreServiceUrl,
  apiToken: globalThis.PT_AGENT_PRIVATE_CONFIG.coreApiToken || "",
  autoSync: true
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

const getSettings = async () => {
  const data = await chrome.storage.local.get("ptAgentSettings");
  const merged = { ...defaultSettings, ...(data.ptAgentSettings || {}) };
  return {
    ...merged,
    maxTorrentSizeGB: Math.min(50, Number(merged.maxTorrentSizeGB || 50)),
    minimumScore: Math.max(80, Number(merged.minimumScore || 80)),
    maxActiveDownloads: Math.min(3, Number(merged.maxActiveDownloads || 3))
  };
};

const fillGuardSettingsForm = (settings) => {
  $("guardMonitorEnabled").checked = settings.guardMonitorEnabled !== false;
  $("guardMinutes").value = String(settings.guardMinutes || 10);
  $("autoDeleteExpired").checked = settings.autoDeleteExpired === true;
  $("autoDeleteExpired").disabled = settings.guardExecutor !== "extension";
};

const saveGuardSettings = async () => {
  const next = {
    ...(state.policySettings || defaultSettings),
    guardMonitorEnabled: $("guardMonitorEnabled").checked,
    guardMinutes: Math.max(1, Math.min(120, Number($("guardMinutes").value || 10))),
    autoDeleteExpired: $("autoDeleteExpired").checked
  };
  if (
    next.guardExecutor === "extension" &&
    next.autoDeleteExpired &&
    !state.policySettings?.autoDeleteExpired
  ) {
    const confirmed = confirm("开启后，带 ptagent 标签且未完成的任务进入保护窗口时，会从 qB 删除任务并同步删除文件。确定开启吗？");
    if (!confirmed) {
      $("autoDeleteExpired").checked = false;
      next.autoDeleteExpired = false;
    }
  }
  state.policySettings = next;
  await chrome.storage.local.set({ ptAgentSettings: next });
  setQbMessage(
    next.guardExecutor !== "extension"
      ? "Free Guard 已保存：Core 是唯一删除执行者，扩展仅做只读预警。"
      : next.autoDeleteExpired
      ? `Free Guard 已开启自动保护：到期前 ${next.guardMinutes} 分钟删除未完成任务和文件。`
      : `Free Guard 已保存：后台监控${next.guardMonitorEnabled ? "开启" : "关闭"}，自动删除关闭。`,
    "success"
  );
  renderQbTorrents();
};

const loadAuditEvents = async () => {
  const stored = await chrome.storage.local.get("ptAgentAuditLog");
  state.auditEvents = Array.isArray(stored.ptAgentAuditLog) ? stored.ptAgentAuditLog : [];
  renderAuditEvents();
};

const appendAuditEvent = async (event) => {
  const stored = await chrome.storage.local.get("ptAgentAuditLog");
  const events = Array.isArray(stored.ptAgentAuditLog) ? stored.ptAgentAuditLog : [];
  events.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...event
  });
  state.auditEvents = events.slice(0, 500);
  await chrome.storage.local.set({ ptAgentAuditLog: state.auditEvents });
  renderAuditEvents();
};

const getCoreSettings = async () => {
  const stored = await chrome.storage.local.get("ptAgentCoreSettings");
  return { ...defaultCoreSettings, ...(stored.ptAgentCoreSettings || {}) };
};

const fillCoreSettingsForm = (settings) => {
  $("coreServiceUrl").value = settings.address || "";
  $("coreApiToken").value = settings.apiToken || "";
  $("coreAutoSync").checked = settings.autoSync !== false;
};

const setCoreStatus = (text, type, detail = "") => {
  $("coreStatus").textContent = text;
  $("coreStatus").className = `site-status ${type}`;
  $("coreStatus").title = detail;
};

const saveCoreSettings = async ({ announce = true } = {}) => {
  const settings = {
    address: $("coreServiceUrl").value.trim(),
    apiToken: $("coreApiToken").value,
    autoSync: $("coreAutoSync").checked
  };
  if (!/^https?:\/\//i.test(settings.address)) {
    throw new Error("PT Core 地址必须以 http:// 或 https:// 开头");
  }
  state.coreSettings = settings;
  await chrome.storage.local.set({ ptAgentCoreSettings: settings });
  if (announce) setQbMessage("PT Core 设置已保存。", "success");
  return settings;
};

const syncToCore = async ({ silent = false } = {}) => {
  if (!state.scan) {
    if (!silent) setQbMessage("请先加载 M-Team 资源，再同步 PT Core。", "error");
    return null;
  }
  if (state.coreSyncing) {
    state.coreSyncQueued = true;
    return null;
  }
  state.coreSyncing = true;
  $("coreSyncBtn").disabled = true;
  setCoreStatus("Core 同步中", "warn");
  try {
    state.coreSettings = await saveCoreSettings({ announce: false });
    await loadAuditEvents();
    const client = globalThis.PT_AGENT_CORE.createClient(state.coreSettings);
    const result = await client.sync({
      scan: state.scan,
      torrents: state.evaluated,
      qbSeedingSummary: state.qbSeedingSummary,
      auditEvents: state.auditEvents
    });
    if (result.predictionResult) {
      state.corePrediction = result.predictionResult;
      renderAccount();
    }
    const coreEvaluations = result.evaluationResult?.items || [];
    if (coreEvaluations.length === state.evaluated.length) {
      state.evaluated = state.evaluated.map((torrent, index) => ({
        ...torrent,
        decision: coreEvaluations[index].decision,
        score: coreEvaluations[index].score,
        reasons: coreEvaluations[index].reasons,
        decisionSource: "core"
      }));
      renderList();
    }
    const version = result.service?.version ? ` v${result.service.version}` : "";
    setCoreStatus(`Core 已连接${version}`, "ok");
    if (!silent) {
      setQbMessage(
        `PT Core 同步完成：资源新增 ${result.torrentResult.created}、更新 ${result.torrentResult.updated}；审计新增 ${result.auditResult.created}、跳过 ${result.auditResult.skipped}。`,
        "success"
      );
    }
    return result;
  } catch (error) {
    setCoreStatus("Core 离线", "bad", error.message || String(error));
    if (!silent) setQbMessage(error.message || String(error), "error");
    return null;
  } finally {
    state.coreSyncing = false;
    $("coreSyncBtn").disabled = false;
    if (state.coreSyncQueued) {
      state.coreSyncQueued = false;
      setTimeout(() => syncToCore({ silent: true }), 0);
    }
  }
};

const getQbSettings = async () => {
  const data = await chrome.storage.local.get("ptAgentQbSettings");
  const stored = data.ptAgentQbSettings || {};
  return {
    ...defaultQbSettings,
    ...stored,
    address: stored.address || defaultQbSettings.address,
    username: stored.username || defaultQbSettings.username,
    password: stored.password || defaultQbSettings.password,
    mteamApiKey: stored.mteamApiKey || defaultQbSettings.mteamApiKey
  };
};

const readQbSettingsForm = () => ({
  address: $("qbAddress").value.trim(),
  username: $("qbUsername").value.trim(),
  password: $("qbPassword").value,
  savePath: $("qbSavePath").value.trim(),
  mteamApiKey: $("mteamApiKey").value.trim()
});

const fillQbSettingsForm = (settings) => {
  $("qbAddress").value = settings.address || "";
  $("qbUsername").value = settings.username || "";
  $("qbPassword").value = settings.password || "";
  $("qbSavePath").value = settings.savePath || "";
  $("mteamApiKey").value = settings.mteamApiKey || "";
};

const saveQbSettings = async ({ announce = true } = {}) => {
  const settings = readQbSettingsForm();
  if (!/^https?:\/\//i.test(settings.address)) {
    throw new Error("qB 地址必须以 http:// 或 https:// 开头");
  }
  state.qbSettings = settings;
  await chrome.storage.local.set({ ptAgentQbSettings: settings });
  if (announce) setQbMessage("下载器设置已保存。", "success");
  return settings;
};

const setQbMessage = (message, type = "") => {
  $("qbMessage").textContent = message;
  $("qbMessage").className = `downloader-message ${type}`.trim();
};

const setQbStatus = (text, type) => {
  $("qbStatus").textContent = text;
  $("qbStatus").className = `site-status ${type}`;
};

const createQbClient = () => {
  if (!state.qbSettings) throw new Error("请先保存下载器设置");
  if (!state.qbSettings.password) throw new Error("请先填写 qBittorrent 密码");
  return globalThis.PT_AGENT_QB.createClient(state.qbSettings);
};

const mteamRequest = async (path, { json, form } = {}) => {
  if (!state.qbSettings?.mteamApiKey) throw new Error("缺少 M-Team API Key");
  const headers = { "x-api-key": state.qbSettings.mteamApiKey };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form;
  }
  const response = await fetch(
    new URL(String(path).replace(/^\/+/, ""), globalThis.PT_AGENT_PRIVATE_CONFIG.mteamApiUrl),
    { method: "POST", headers, body }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.message !== "SUCCESS") {
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

const fetchMteamAccount = async () => {
  const [profile, statistics, bonusData] = await Promise.all([
    mteamRequest("/api/member/profile"),
    mteamRequest("/api/tracker/myPeerStatistics"),
    mteamRequest("/api/tracker/mybonus")
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

const fetchMteamFreeCatalog = async () => {
  const core = globalThis.PT_AGENT_MTEAM_BACKFILL;
  const pageSize = 100;
  const maxPages = 10;
  const fetchMode = async (mode) => {
    const torrents = [];
    let pagesRead = 0;
    let emptyFreePages = 0;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const data = await mteamRequest("/api/torrent/search", {
        json: { mode, pageNumber, pageSize, discount: "FREE" }
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
        detailUrl: new URL(`/detail/${row.id}`, globalThis.PT_AGENT_PRIVATE_CONFIG.mteamSiteUrl).toString(),
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

const findMteamFreeDeadlines = async (tasks) => {
  const core = globalThis.PT_AGENT_MTEAM_BACKFILL;
  const search = async (keyword, mode) => {
    const data = await mteamRequest("/api/torrent/search", {
      json: { mode, pageNumber: 1, pageSize: 100, keyword }
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
  const button = $("backfillDeadlineBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在回查…";
  try {
    state.qbSettings = await saveQbSettings({ announce: false });
    if (!state.qbSettings.mteamApiKey) throw new Error("缺少 M-Team API Key");
    const client = createQbClient();
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
    const updates = await findMteamFreeDeadlines(candidates);
    for (const update of updates) {
      await client.addTags(update.hash, globalThis.PT_AGENT_QB.torrentTags(update.deadline));
    }
    await refreshQbTorrents({ silent: true });
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

const resolveTorrentDownloadUrl = async (torrent) => {
  if (torrent.downloadUrl) return torrent.downloadUrl;
  if (torrent.site !== "mteam") {
    throw new Error("当前资源没有可用的种子下载链接");
  }
  if (!torrent.torrentId) {
    throw new Error("无法识别 M-Team 种子 ID");
  }
  if (!state.qbSettings?.mteamApiKey) {
    throw new Error("请先填写 M-Team API Key");
  }
  const body = new FormData();
  body.set("id", String(torrent.torrentId));
  const downloadUrl = await mteamRequest("/api/torrent/genDlToken", { form: body });
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
  if (torrent?.decisionSource === "core") {
    const allowed = torrent.decision === "recommend" && Number(torrent.score || 0) >= 80;
    return {
      allowed,
      reasons: allowed ? [] : (torrent.reasons || ["Core 安全准入未通过"])
    };
  }
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
    guard_error: "保护异常"
  };
  list.innerHTML = state.auditEvents.slice(0, 30).map((event) => `
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
      </div>
    `;
  }).join("");
};

const refreshQbTorrents = async ({ silent = false } = {}) => {
  try {
    state.qbSettings = await saveQbSettings({ announce: false });
    const client = createQbClient();
    await client.login();
    state.qbTorrents = await client.listTorrents("all");
    state.qbSeedingSummary = globalThis.PT_AGENT_QB.summarizeMteamSeeding(state.qbTorrents);
    renderQbTorrents();
    await loadAuditEvents();
    if (state.evaluated.length) renderList();
    setQbStatus("已连接", "ok");
    const downloadingCount = state.qbTorrents.filter(isActiveDownload).length;
    if (!silent) setQbMessage(`qBittorrent 当前有 ${downloadingCount} 个下载中任务。`, "success");
    if (state.coreSettings?.autoSync && state.scan) syncToCore({ silent: true });
    return true;
  } catch (error) {
    setQbStatus("连接失败", "bad");
    setQbMessage(error.message || String(error), "error");
    return false;
  }
};

const testQbConnection = async () => {
  try {
    state.qbSettings = await saveQbSettings({ announce: false });
    const client = createQbClient();
    await client.login();
    const version = await client.getVersion();
    setQbStatus("已连接", "ok");
    setQbMessage(`qBittorrent ${version || "未知版本"} 连接成功。`, "success");
    await refreshQbTorrents({ silent: true });
  } catch (error) {
    setQbStatus("连接失败", "bad");
    setQbMessage(
      `${error.message || String(error)}。若账号无误，请检查 qB WebUI 的 CSRF、Host Header 和跨域设置。`,
      "error"
    );
  }
};

const enqueueTorrentDirectToQb = async (torrent, downloadUrl) => {
  state.qbSettings = await saveQbSettings({ announce: false });
  const client = createQbClient();
  const savePath = state.qbSettings?.savePath || "";
  await client.login();
  await client.ensureCategory("PT_AGENT", savePath);
  await client.addTorrent({
    url: downloadUrl,
    tag: globalThis.PT_AGENT_QB.torrentTags(torrent.freeEndAt || ""),
    savePath,
    category: "PT_AGENT"
  });
  return {
    route: "qb_fallback",
    evaluation: {
      decision: torrent.decision,
      score: Number(torrent.score || 0)
    }
  };
};

const enqueueTorrentViaCore = async (torrent, { manualOverride = false } = {}) => {
  const key = `${torrent.site}:${torrent.torrentId || torrent.rowIndex}`;
  state.qbPushStatus.set(key, "loading");
  renderList();
  try {
    if (!torrent.freeEndAt && !manualOverride) {
      throw new Error("缺少 Free 截止时间，未发送到 qBittorrent");
    }
    state.coreSettings = await saveCoreSettings({ announce: false });
    const downloadUrl = await resolveTorrentDownloadUrl(torrent);
    const client = globalThis.PT_AGENT_CORE.createClient(state.coreSettings);
    let route = "core";
    let coreUnavailableReason = "";
    let result;
    try {
      result = await client.enqueueTorrent({
        scan: state.scan,
        torrent,
        downloadUrl,
        savePath: state.qbSettings?.savePath || "",
        manualOverride
      });
    } catch (error) {
      if (error.code !== "CORE_UNAVAILABLE") throw error;
      route = "qb_fallback";
      coreUnavailableReason = error.message || String(error);
      try {
        result = await enqueueTorrentDirectToQb(torrent, downloadUrl);
      } catch (qbError) {
        throw new Error(
          `Core 不可用（${coreUnavailableReason}）；插件直连 qB 失败：${qbError.message || String(qbError)}`
        );
      }
    }
    const deadline = torrent.freeEndAt;
    const usedFallback = route === "qb_fallback";
    await appendAuditEvent({
      action: usedFallback
        ? (manualOverride ? "enqueue_manual_override_qb_fallback" : "enqueue_qb_fallback")
        : (manualOverride ? "enqueue_manual_override" : "enqueue"),
      status: "queued",
      title: torrent.title,
      site: torrent.site,
      torrentId: torrent.torrentId || "",
      deadline,
      progress: 0,
      reason: usedFallback
        ? `Core 不可用，Chrome 插件直连 qB；分类 PT_AGENT，评分 ${result.evaluation.score}`
        : manualOverride
          ? `用户手动覆盖 risk 准入，分类 PT_AGENT，评分 ${result.evaluation.score}`
          : `通过 Core 安全准入，分类 PT_AGENT，评分 ${result.evaluation.score}`,
      deleteFiles: false
    }).catch(() => {});
    state.qbPushStatus.set(key, "success");
    setCoreStatus(
      usedFallback ? "Core 离线 · 插件直连 qB" : "Core 已连接",
      usedFallback ? "bad" : "ok",
      usedFallback ? coreUnavailableReason : ""
    );
    setQbMessage(
      usedFallback
        ? `已由 Chrome 插件直连 qB：${torrent.title}；分类：PT_AGENT`
        : manualOverride
        ? `已按你的判断手动发送：${torrent.title}；风险原因已记录`
        : `已由 PT Core 安全发送：${torrent.title}；分类：PT_AGENT`,
      "success"
    );
    setTimeout(() => refreshQbTorrents({ silent: true }), 1000);
    return true;
  } catch (error) {
    state.qbPushStatus.set(key, "error");
    await appendAuditEvent({
      action: "enqueue_error",
      status: "failed",
      title: torrent.title,
      site: torrent.site,
      torrentId: torrent.torrentId || "",
      deadline: formatDeadline(torrent.freeEndAt),
      progress: 0,
      reason: error.message || String(error),
      deleteFiles: false
    }).catch(() => {});
    setQbMessage(`${torrent.title}：${error.message || String(error)}`, "error");
    return false;
  } finally {
    renderList();
  }
};

const pushRecommendedViaCore = async () => {
  const torrents = state.evaluated.filter((torrent) => torrent.decision === "recommend");
  if (!torrents.length) {
    setQbMessage("当前没有可一键下载的推荐资源。", "error");
    return;
  }
  $("downloadRecommendedBtn").disabled = true;
  let succeeded = 0;
  for (const torrent of torrents) {
    if (await enqueueTorrentViaCore(torrent)) succeeded += 1;
  }
  $("downloadRecommendedBtn").disabled = false;
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
  const corePrediction = state.corePrediction;
  const assessment = corePrediction ? {
    target: corePrediction.targets.bonus_points,
    current: corePrediction.current.bonus_points,
    remaining: corePrediction.remaining.bonus_points,
    progress: corePrediction.progress_percent,
    rate: corePrediction.current.bonus_per_hour,
    deadlineAt: corePrediction.estimated_deadline
      ? Date.parse(corePrediction.estimated_deadline)
      : null,
    hoursLeft: corePrediction.hours_left,
    requiredRate: corePrediction.required_bonus_per_hour,
    etaHours: corePrediction.estimated_completion_at && corePrediction.hours_left !== null
      ? Math.max(
        0,
        (Date.parse(corePrediction.estimated_completion_at) - Date.now()) / 3600000
      )
      : Infinity,
    projectedAtDeadline: corePrediction.projected_bonus_at_deadline,
    safetyMarginHours: corePrediction.safety_margin_hours,
    status: corePrediction.assessment_status,
    remainingUploadedBytes: corePrediction.remaining.uploaded_bytes,
    remainingDownloadedBytes: corePrediction.remaining.downloaded_bytes,
    seedingCount: corePrediction.current.seed_count,
    seedingSizeBytes: corePrediction.current.seed_size_bytes,
    recommendedPlan: {
      bufferDays: corePrediction.recommended_plan.buffer_days,
      targetRate: corePrediction.recommended_plan.target_bonus_per_hour,
      additionalRate: corePrediction.recommended_plan.additional_bonus_per_hour,
      estimatedAdditionalSeedBytesLow:
        corePrediction.recommended_plan.estimated_additional_seed_bytes_low,
      estimatedAdditionalSeedBytesHigh:
        corePrediction.recommended_plan.estimated_additional_seed_bytes_high,
      estimatedTargetSeedSizeBytes:
        corePrediction.recommended_plan.estimated_target_seed_size_bytes
    },
    achieved: corePrediction.achieved
  } : fallbackAssessment;
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
    .filter((item) => state.filter === "all" || item.decision === state.filter)
    .sort((a, b) => freeRemainingSortValue(b) - freeRemainingSortValue(a));

  if (!rows.length) {
    list.innerHTML = `<div class="empty">当前筛选没有资源。</div>`;
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
    const qbLabel =
      qbPushStatus === "loading" ? "发送中…" :
      resourceStatus === "downloaded" ? "已下载" :
      resourceStatus === "downloading" ? "下载中" :
      qbPushStatus === "success" ? "已发送" :
      qbPushStatus === "error" ? "重试下载" :
      policyBlocked ? "安全策略拦截" :
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
      enqueueTorrentViaCore(torrent, { manualOverride });
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

const runScan = async () => {
  $("list").innerHTML = `<div class="empty">正在从 M-Team API 加载当前 Free…</div>`;
  try {
    const settings = state.policySettings || await getSettings();
    state.policySettings = settings;
    const [accountResult, catalogResult] = await Promise.allSettled([
      fetchMteamAccount(),
      fetchMteamFreeCatalog()
    ]);
    if (catalogResult.status === "fulfilled") {
      const catalog = catalogResult.value;
      state.scan = {
        page: {
          title: "M-Team 当前 Free",
          url: globalThis.PT_AGENT_PRIVATE_CONFIG.mteamSiteUrl,
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
    state.evaluated = (state.scan?.torrents || [])
      .map((torrent) => evaluateTorrent(torrent, settings))
      .sort((a, b) => publishedTimestamp(b.publishedAt) - publishedTimestamp(a.publishedAt));
    const catalogStats = state.scan?.catalogStats;
    $("pageInfo").textContent = catalogStats
      ? `M-Team 当前 Free · ${catalogStats.total} 个资源 · 普通区 ${catalogStats.normalPages} 页 / 成人区 ${catalogStats.adultPages} 页`
      : `${state.scan?.page?.title || "当前页面"} · ${state.evaluated.length} 个资源`;
    renderList();
    if (state.coreSettings?.autoSync) syncToCore({ silent: true });
  } catch (error) {
    $("list").innerHTML = `<div class="empty">扫描失败：${escapeHtml(error.message || String(error))}</div>`;
  }
};

const focusSourceTab = async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.create({
      url: globalThis.PT_AGENT_PRIVATE_CONFIG.mteamSiteUrl,
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
  state.activeView = view === "downloads" ? "downloads" : "resources";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === state.activeView);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeView);
  });
  if (state.activeView === "downloads" && state.qbSettings?.password) {
    refreshQbTorrents({ silent: true });
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
  const blob = new Blob([JSON.stringify(state.auditEvents, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pt-agent-audit-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  const isDashboard = params.get("mode") === "dashboard";
  document.documentElement.className = isDashboard ? "mode-dashboard" : "mode-popup";
  document.body.className = isDashboard ? "mode-dashboard" : "mode-popup";
  const sourceTabId = Number(new URLSearchParams(location.search).get("sourceTabId"));
  state.sourceTabId = Number.isInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null;
  if (!state.sourceTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.sourceTabId = activeTab?.id || null;
  }
  [state.policySettings, state.qbSettings, state.coreSettings] = await Promise.all([
    getSettings(),
    getQbSettings(),
    getCoreSettings()
  ]);
  fillGuardSettingsForm(state.policySettings);
  fillQbSettingsForm(state.qbSettings);
  fillCoreSettingsForm(state.coreSettings);
  await loadAuditEvents();
  $("scanBtn").addEventListener("click", runScan);
  $("sourceBtn").addEventListener("click", focusSourceTab);
  $("fullscreenBtn").addEventListener("click", openFullscreenDashboard);
  $("saveQbBtn").addEventListener("click", async () => {
    try {
      await saveQbSettings();
    } catch (error) {
      setQbMessage(error.message || String(error), "error");
    }
  });
  $("testQbBtn").addEventListener("click", testQbConnection);
  $("backfillDeadlineBtn").addEventListener("click", backfillMteamDeadlines);
  $("refreshQbBtn").addEventListener("click", refreshQbTorrents);
  $("saveGuardBtn").addEventListener("click", saveGuardSettings);
  $("saveCoreBtn").addEventListener("click", async () => {
    try {
      await saveCoreSettings();
      await syncToCore({ silent: true });
    } catch (error) {
      setCoreStatus("Core 配置错误", "bad", error.message || String(error));
      setQbMessage(error.message || String(error), "error");
    }
  });
  $("coreSyncBtn").addEventListener("click", () => syncToCore());
  $("downloadRecommendedBtn").addEventListener("click", pushRecommendedViaCore);
  $("copyBtn").addEventListener("click", copyJson);
  $("downloadBtn").addEventListener("click", downloadJson);
  $("exportAuditBtn").addEventListener("click", exportAuditJson);
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
  runScan();
  if (state.qbSettings.password) refreshQbTorrents({ silent: true });
});
