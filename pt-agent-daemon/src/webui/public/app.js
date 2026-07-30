"use strict";

// 守护进程 WebUI。令牌只放当前标签页的 sessionStorage，并通过 Authorization 发送；
// 不写进 URL、浏览器历史、代理访问日志或 Referer。
const TOKEN_KEY = "ptAgentWebToken";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
let tokenPrompt = null;

const $ = (id) => document.getElementById(id);
const state = {
  view: "overview",
  filter: "all",
  settings: null,
  resources: [],
  scannedAt: null,
  status: null
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const askForToken = async () => {
  if (tokenPrompt) return tokenPrompt;
  tokenPrompt = Promise.resolve().then(() => {
    const supplied = window.prompt("请输入 PT Agent WebUI 访问令牌。令牌只保留在当前标签页：", "");
    const next = String(supplied || "").trim();
    if (!next) throw new Error("需要访问令牌才能打开 WebUI。");
    token = next;
    sessionStorage.setItem(TOKEN_KEY, token);
    return token;
  }).finally(() => {
    tokenPrompt = null;
  });
  return tokenPrompt;
};

const api = async (method, path, body, retryAuth = true) => {
  const url = new URL(path, location.origin);
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    if (retryAuth) {
      await askForToken();
      return api(method, path, body, false);
    }
  }
  if (!response.ok) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  return payload;
};

// ---------- 通用 UI ----------
const toastStack = document.createElement("div");
toastStack.className = "toast-stack";
document.body.appendChild(toastStack);

const toast = (message, type = "info") => {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  toastStack.appendChild(node);
  setTimeout(() => node.remove(), type === "error" ? 9000 : 4500);
};

const setMessage = (id, text, type = "") => {
  const node = $(id);
  if (!node) return;
  node.textContent = text || "";
  node.className = `downloader-message${type ? ` ${type}` : ""}`;
};

const busy = async (button, task) => {
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "处理中…";
  }
  try {
    return await task();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
};

const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const formatSpeed = (bytes) => (Number(bytes) > 0 ? `${formatBytes(bytes)}/s` : "-");

const formatLeft = (hours) => {
  if (hours === null || hours === undefined || !Number.isFinite(Number(hours))) return "未知";
  const value = Number(hours);
  if (value <= 0) return "已到期";
  if (value < 1) return `${Math.round(value * 60)} 分钟`;
  if (value < 48) return `${value.toFixed(1)} 小时`;
  return `${(value / 24).toFixed(1)} 天`;
};

const formatTime = (iso) => {
  if (!iso) return "-";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return String(iso);
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};

const relativeTime = (iso) => {
  const timestamp = Date.parse(iso || "");
  if (!Number.isFinite(timestamp)) return "-";
  const deltaMinutes = Math.round((timestamp - Date.now()) / 60000);
  if (deltaMinutes > 0) return `${deltaMinutes} 分钟后`;
  if (deltaMinutes === 0) return "就在此刻";
  return `${-deltaMinutes} 分钟前`;
};

// ---------- 视图切换 ----------
const VIEW_TITLES = {
  overview: "运行总览",
  resources: "种子下载决策",
  downloads: "下载中的任务",
  settings: "设置",
  logs: "运行日志"
};

const switchView = (view) => {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((node) => {
    node.classList.toggle("active", node.dataset.view === view);
  });
  document.querySelectorAll("[data-view-panel]").forEach((node) => {
    node.classList.toggle("active", node.dataset.viewPanel === view);
  });
  $("viewTitle").textContent = VIEW_TITLES[view] || view;
  if (view === "downloads") void loadTasks();
  if (view === "logs") void loadLogs();
  if (view === "settings") void loadSettings();
};

// ---------- 总览 ----------
const renderStatus = (status) => {
  state.status = status;
  const daemon = status.daemon || {};
  const scheduler = status.scheduler || {};
  const nextScanAt = scheduler.nextScanAt || status.nextScanAt;

  $("sidebarNextScan").textContent = nextScanAt ? relativeTime(nextScanAt) : "未调度";
  $("sidebarInterval").textContent = `${daemon.scanIntervalMinMinutes}–${daemon.scanIntervalMaxMinutes} 分钟随机`;
  $("sidebarDownloader").textContent = status.lastScan?.downloader || `${status.downloaderCount} 台已配置`;
  $("sidebarGuardState").textContent = status.policy?.autoDeleteExpired
    ? "Free 到期自动删除：开"
    : "Free 到期自动删除：关";
  $("sidebarHome").textContent = status.home || "";

  $("mNextScan").textContent = nextScanAt ? `${relativeTime(nextScanAt)}` : "-";
  $("mInterval").textContent = `${daemon.scanIntervalMinMinutes}–${daemon.scanIntervalMaxMinutes} 分钟`;
  $("mLastScan").textContent = status.lastScanAt ? relativeTime(status.lastScanAt) : "从未";
  $("mAutoDownload").textContent = daemon.autoDownload ? "开启" : "关闭（只评估）";
  $("mMaxPush").textContent = daemon.maxPushPerScan > 0 ? `${daemon.maxPushPerScan} 个/轮` : "不限";
  $("mSlots").textContent = status.lastScan?.slots
    ? `${status.lastScan.slots.occupying} 占用 / ${status.lastScan.slots.held} 挂起`
    : "-";

  $("pageInfo").textContent = scheduler.scanning
    ? "正在扫描中…"
    : nextScanAt
      ? `下次扫描 ${formatTime(nextScanAt)}（${relativeTime(nextScanAt)}）`
      : "调度器未运行——当前可能是通过 CLI 单次命令打开的 WebUI";
  $("overviewNote").textContent = `配置与日志目录：${status.home}`;

  const last = status.lastScan;
  $("lastScanTitle").textContent = last ? `${last.site} → ${last.downloader}` : "尚未扫描";
  $("lastScanStatus").textContent = last
    ? `${last.pushed.length} 推送 / ${last.failed.length} 失败`
    : "无数据";
  $("lastScanStatus").className = `site-status ${last ? (last.failed.length ? "bad" : "ok") : "bad"}`;
  $("lastScanFields").innerHTML = last
    ? [
      ["扫描时间", formatTime(last.at)],
      ["耗时", `${(last.durationMs / 1000).toFixed(1)} 秒`],
      ["Free 资源总数", last.counts.total],
      ["推荐 / 风险 / 拒绝", `${last.counts.recommend} / ${last.counts.risk} / ${last.counts.reject}`],
      ["可推送候选", last.candidates],
      ["实际推送", last.pushed.length],
      ["准入拦下", last.skipped.length],
      ["推送失败", last.failed.length]
    ].map(([label, value]) => `
      <div class="field-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
    `).join("")
    : `<div class="empty compact-empty">还没有扫描记录。</div>`;
};

const loadStatus = async () => {
  try {
    renderStatus(await api("GET", "/api/status"));
  } catch (error) {
    setMessage("overviewMessage", error.message, "error");
  }
};

const loadAudit = async () => {
  try {
    const { records, total } = await api("GET", "/api/audit?limit=60");
    $("auditCount").textContent = `${total} 条`;
    $("auditList").innerHTML = records.length
      ? records.slice().reverse().map((record) => `
        <div class="audit-row">
          <span>${escapeHtml(formatTime(record.at))}</span>
          <span class="audit-action">${escapeHtml(record.action)} · ${escapeHtml(record.status)}</span>
          <span>${escapeHtml(record.title || record.hash || "-")}</span>
          <span>${escapeHtml(record.reason || "")}</span>
        </div>
      `).join("")
      : `<div class="empty compact-empty">暂无记录。</div>`;
  } catch (error) {
    setMessage("overviewMessage", error.message, "error");
  }
};

const showActionResult = (payload) => {
  const node = $("actionResult");
  node.hidden = false;
  node.textContent = JSON.stringify(payload, null, 2);
};

// ---------- 资源列表 ----------
const renderResources = () => {
  const rows = state.resources.filter((item) => state.filter === "all" || item.decision === state.filter);
  $("countAll").textContent = state.resources.length;
  $("countRecommend").textContent = state.resources.filter((item) => item.decision === "recommend").length;
  $("countRisk").textContent = state.resources.filter((item) => item.decision === "risk").length;
  $("countReject").textContent = state.resources.filter((item) => item.decision === "reject").length;
  $("resourceScannedAt").textContent = state.scannedAt ? `扫描于 ${formatTime(state.scannedAt)}` : "尚未扫描";

  if (!rows.length) {
    $("list").innerHTML = state.resources.length
      ? `<div class="empty">当前筛选下没有资源，点上方标签切换。</div>`
      : `<div class="empty">还没有扫描结果，点右上角「立即扫描」。</div>`;
    return;
  }

  $("list").innerHTML = rows.map((item) => {
    const decisionText = item.decision === "recommend" ? "推荐" : item.decision === "risk" ? "风险" : "拒绝";
    const inDownloader = Boolean(item.existingHash);
    const label = inDownloader ? "已在下载器" : item.excluded ? "已排除" : item.decision === "recommend" ? "发送" : "覆盖发送";
    return `
      <article class="card">
        <div class="resource-main">
          ${item.detailUrl
            ? `<a class="title" href="${escapeHtml(item.detailUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || "(未命名资源)")}</a>`
            : `<span class="title">${escapeHtml(item.title || "(未命名资源)")}</span>`}
          <div class="subtitle">${escapeHtml(item.category || item.site)} · ${escapeHtml(item.freeType)} · score ${item.score}</div>
          <div class="reason">${(item.reasons || []).map(escapeHtml).join("；")}</div>
        </div>
        <div><span class="cell-label">决策</span><span class="badge ${escapeHtml(item.decision)}">${decisionText}</span></div>
        <div class="cell"><span class="cell-label">大小</span>${escapeHtml(formatBytes(item.sizeBytes))}</div>
        <div class="cell"><span class="cell-label">做种 / 下载</span>${item.seeders || 0} / ${item.leechers || 0}</div>
        <div class="cell left-time ${item.leftHours !== null && item.leftHours <= 0 ? "expired" : ""}">
          <span class="cell-label">Free 剩余</span>${escapeHtml(formatLeft(item.leftHours))}
        </div>
        <div class="cell deadline ${item.freeEndAt ? "" : "missing"}">
          <span class="cell-label">Free 截止时间</span>${escapeHtml(formatTime(item.freeEndAt))}
        </div>
        <div class="cell published-at"><span class="cell-label">发布时间</span>${escapeHtml(formatTime(item.publishedAt))}</div>
        <div class="row-actions">
          <button class="row-action push-button" type="button"
                  data-torrent-id="${escapeHtml(item.torrentId)}"
                  data-override="${item.decision === "recommend" ? "false" : "true"}"
                  ${inDownloader || item.excluded ? "disabled" : ""}>${label}</button>
        </div>
      </article>
    `;
  }).join("");

  $("list").querySelectorAll(".push-button").forEach((button) => {
    button.addEventListener("click", () => void busy(button, async () => {
      try {
        const result = await api("POST", "/api/push", {
          torrentIds: [button.dataset.torrentId],
          manualOverride: button.dataset.override === "true"
        });
        if (result.failed.length) {
          toast(`发送失败：${result.failed[0].error}`, "error");
        } else {
          const item = result.pushed[0];
          toast(item?.duplicate ? `已在下载器中，无需重复添加：${item.title}` : `已发送：${item?.title}`, "success");
        }
        await loadResources();
      } catch (error) {
        toast(error.message, "error");
      }
    }));
  });
};

const loadResources = async () => {
  try {
    const { evaluated, scannedAt } = await api("GET", "/api/resources");
    state.resources = evaluated;
    state.scannedAt = scannedAt;
    renderResources();
  } catch (error) {
    setMessage("resourceMessage", error.message, "error");
  }
};

// ---------- 下载中 ----------
const GUARD_LABELS = {
  safe: "安全", expiring: "即将到期", expired: "已到期", cannot_finish: "可能下不完",
  missing_deadline: "缺截止标签", protected: "已保护", completed: "已完成", unmanaged: "非本工具"
};

const loadTasks = async () => {
  setMessage("taskMessage", "正在读取下载器…");
  try {
    const { tasks, slots, downloader } = await api("GET", "/api/tasks");
    setMessage("taskMessage", "");
    $("taskStatus").textContent = `${downloader} · ${slots.occupying} 占用槽`;
    $("taskStatus").className = "site-status ok";
    const active = tasks.filter((task) => Number(task.progress || 0) < 1);
    $("taskList").innerHTML = active.length
      ? active.map((task) => {
        const progress = Math.max(0, Math.min(100, Number(task.progress || 0) * 100));
        return `
          <div class="qb-row">
            <div>
              <div class="qb-name">${escapeHtml(task.name || "(未命名任务)")}</div>
              ${task.resource ? `<div class="qb-resource">↳ ${escapeHtml(task.resource.siteTitle || task.resource.torrentId)}</div>` : ""}
              <div class="qb-subtext">${escapeHtml(task.hash || "")}</div>
            </div>
            <div class="cell">${escapeHtml(task.state || "unknown")}</div>
            <div>
              <div class="progress-track"><div class="progress-bar" style="width:${progress.toFixed(1)}%"></div></div>
              <div class="progress-text">${progress.toFixed(1)}%</div>
            </div>
            <div class="cell">${escapeHtml(formatSpeed(task.dlspeed))}</div>
            <div>
              <div class="deadline ${task.deadline ? "" : "missing"}">${escapeHtml(task.deadline || "未设置截止标签")}</div>
              <div class="qb-subtext">${escapeHtml(task.tags || "无标签")}</div>
            </div>
            <div class="qb-actions"></div>
          </div>
        `;
      }).join("")
      : `<div class="empty compact-empty">下载器当前没有未完成的任务。</div>`;
  } catch (error) {
    $("taskStatus").textContent = "未连接";
    $("taskStatus").className = "site-status bad";
    setMessage("taskMessage", error.message, "error");
    $("taskList").innerHTML = `<div class="empty compact-empty">无法读取任务列表。</div>`;
  }
};

// ---------- 设置 ----------
const fillSettingsForms = (settings) => {
  const { policy, daemon } = settings;
  $("dScanMin").value = daemon.scanIntervalMinMinutes;
  $("dScanMax").value = daemon.scanIntervalMaxMinutes;
  $("dMaxPush").value = daemon.maxPushPerScan;
  $("dGuardInterval").value = daemon.guardIntervalSeconds;
  $("dAutoDownload").checked = daemon.autoDownload;
  $("dScanOnStart").checked = daemon.scanOnStart;

  $("pMaxActive").value = policy.maxActiveDownloads;
  $("pMinScore").value = policy.minimumScore;
  $("pMaxSize").value = policy.maxTorrentSizeGB;
  $("pMinFreeHours").value = policy.minFreeHoursForAutoDownload;
  $("pMinRatio").value = policy.minimumRatio;
  $("pRejectHr").checked = policy.rejectHr;
  $("pRejectMissingFreeEnd").checked = policy.rejectMissingFreeEnd;

  $("gMonitorEnabled").checked = policy.guardMonitorEnabled;
  $("gMinutes").value = policy.guardMinutes;
  $("gAutoDelete").checked = policy.autoDeleteExpired;
};

const renderDownloaderCards = (settings) => {
  const types = settings.downloaderTypes || [];
  $("downloaderList").innerHTML = settings.downloaders.map((item, index) => `
    <div class="settings-card" data-downloader-id="${escapeHtml(item.id)}">
      <div class="settings-card-head">
        <div class="settings-card-title">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="settings-chip">${escapeHtml(item.type)}</span>
          <span class="settings-chip ${item.enabled ? "ok" : "off"}">${item.enabled ? "已启用" : "已停用"}</span>
          <span class="settings-chip ${item.hasPassword ? "ok" : "warn"}">${item.hasPassword ? "已设密码" : "缺少密码"}</span>
          ${item.isPrivate ? `<span class="settings-chip">内网</span>` : ""}
          <span class="settings-chip">探测顺序 ${index + 1}</span>
        </div>
        <div class="settings-card-order">
          <button class="btn btn-quiet icon-btn" type="button" data-move="-1">↑</button>
          <button class="btn btn-quiet icon-btn" type="button" data-move="1">↓</button>
        </div>
      </div>
      <div class="settings-card-body">
        <label><span>名称</span><input data-field="name" type="text" value="${escapeHtml(item.name)}"></label>
        <label>
          <span>类型</span>
          <select data-field="type">
            ${types.map((type) => `<option value="${escapeHtml(type.id)}" ${type.id === item.type ? "selected" : ""} ${type.implemented ? "" : "disabled"}>${escapeHtml(type.name)}${type.implemented ? "" : "（未实现）"}</option>`).join("")}
          </select>
        </label>
        <label class="full-width"><span>地址</span><input data-field="address" type="text" value="${escapeHtml(item.address)}" placeholder="http://192.168.1.10:8080/"></label>
        <label><span>账号</span><input data-field="username" type="text" value="${escapeHtml(item.username)}"></label>
        <label>
          <span>密码</span>
          <input data-field="password" type="password" value="" autocomplete="new-password" placeholder="${item.hasPassword ? "留空表示不修改" : "请填写密码"}">
        </label>
        <label><span>保存目录</span><input data-field="savePath" type="text" value="${escapeHtml(item.savePath)}"></label>
        <label><span>分类</span><input data-field="category" type="text" value="${escapeHtml(item.category)}"></label>
        <label class="settings-switch"><input data-field="enabled" type="checkbox" ${item.enabled ? "checked" : ""}><span>启用</span></label>
        <div class="settings-card-actions">
          <button class="btn btn-quiet" type="button" data-action="test">测试连接</button>
          <button class="btn btn-danger" type="button" data-action="delete">删除</button>
          <button class="btn btn-primary" type="button" data-action="save">保存</button>
        </div>
      </div>
    </div>
  `).join("") || `<div class="empty compact-empty">还没有下载器，点右上角「新增下载器」。</div>`;

  $("downloaderList").querySelectorAll("[data-downloader-id]").forEach((card) => {
    const id = card.dataset.downloaderId;
    const collect = () => {
      const record = { id };
      card.querySelectorAll("[data-field]").forEach((input) => {
        record[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
      });
      return record;
    };
    card.querySelector('[data-action="save"]').addEventListener("click", (event) => void busy(event.target, async () => {
      try {
        await api("POST", "/api/downloaders", collect());
        setMessage("downloaderMessage", "已保存。", "success");
        await loadSettings();
      } catch (error) {
        setMessage("downloaderMessage", error.message, "error");
      }
    }));
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm("确定删除这个下载器？")) return;
      await api("DELETE", `/api/downloaders/${encodeURIComponent(id)}`);
      await loadSettings();
    });
    card.querySelector('[data-action="test"]').addEventListener("click", (event) => void busy(event.target, async () => {
      try {
        const result = await api("POST", `/api/downloaders/${encodeURIComponent(id)}/test`);
        setMessage(
          "downloaderMessage",
          result.ok
            ? `连接正常：qBittorrent ${result.version}`
            : `第 ${result.stages.length} 步「${result.stages.at(-1)?.label}」失败：${result.stages.at(-1)?.detail}`,
          result.ok ? "success" : "error"
        );
      } catch (error) {
        setMessage("downloaderMessage", error.message, "error");
      }
    }));
    card.querySelectorAll("[data-move]").forEach((button) => {
      button.addEventListener("click", async () => {
        await api("POST", `/api/downloaders/${encodeURIComponent(id)}/move`, { offset: Number(button.dataset.move) });
        await loadSettings();
      });
    });
  });
};

const renderSiteCards = (settings) => {
  const types = settings.siteTypes || [];
  $("siteList").innerHTML = settings.sites.map((item) => `
    <div class="settings-card" data-site-id="${escapeHtml(item.id)}">
      <div class="settings-card-head">
        <div class="settings-card-title">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="settings-chip">${escapeHtml(item.type)}</span>
          <span class="settings-chip ${item.enabled ? "ok" : "off"}">${item.enabled ? "已启用" : "已停用"}</span>
          <span class="settings-chip ${item.hasApiKey ? "ok" : "warn"}">${item.hasApiKey ? "已设 API Key" : "缺少 API Key"}</span>
        </div>
      </div>
      <div class="settings-card-body">
        <label><span>名称</span><input data-field="name" type="text" value="${escapeHtml(item.name)}"></label>
        <label>
          <span>类型</span>
          <select data-field="type">
            ${types.map((type) => `<option value="${escapeHtml(type.id)}" ${type.id === item.type ? "selected" : ""}>${escapeHtml(type.name)}</option>`).join("")}
          </select>
        </label>
        <label><span>站点地址</span><input data-field="siteUrl" type="text" value="${escapeHtml(item.siteUrl)}"></label>
        <label><span>API 地址</span><input data-field="apiUrl" type="text" value="${escapeHtml(item.apiUrl)}"></label>
        <label class="full-width">
          <span>API Key</span>
          <input data-field="apiKey" type="password" value="" autocomplete="new-password" placeholder="${item.hasApiKey ? "留空表示不修改" : "请填写 API Key"}">
        </label>
        <label class="settings-switch"><input data-field="enabled" type="checkbox" ${item.enabled ? "checked" : ""}><span>启用</span></label>
        <div class="settings-card-actions">
          <button class="btn btn-danger" type="button" data-action="delete">删除</button>
          <button class="btn btn-primary" type="button" data-action="save">保存</button>
        </div>
      </div>
    </div>
  `).join("") || `<div class="empty compact-empty">还没有站点，点右上角「新增站点」。</div>`;

  $("siteList").querySelectorAll("[data-site-id]").forEach((card) => {
    const id = card.dataset.siteId;
    card.querySelector('[data-action="save"]').addEventListener("click", (event) => void busy(event.target, async () => {
      const record = { id };
      card.querySelectorAll("[data-field]").forEach((input) => {
        record[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
      });
      try {
        await api("POST", "/api/sites", record);
        setMessage("siteMessage", "已保存。", "success");
        await loadSettings();
      } catch (error) {
        setMessage("siteMessage", error.message, "error");
      }
    }));
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm("确定删除这个站点？")) return;
      await api("DELETE", `/api/sites/${encodeURIComponent(id)}`);
      await loadSettings();
    });
  });
};

const loadSettings = async () => {
  try {
    const settings = await api("GET", "/api/settings");
    state.settings = settings;
    fillSettingsForms(settings);
    renderDownloaderCards(settings);
    renderSiteCards(settings);
  } catch (error) {
    setMessage("daemonMessage", error.message, "error");
  }
};

// ---------- 日志 ----------
const loadLogs = async () => {
  try {
    const params = new URLSearchParams({ limit: "300" });
    if ($("logLevel").value) params.set("level", $("logLevel").value);
    if ($("logPrefix").value.trim()) params.set("prefix", $("logPrefix").value.trim());
    const { records, total } = await api("GET", `/api/logs?${params}`);
    $("logCount").textContent = `${records.length} / ${total} 条`;
    $("logList").innerHTML = records.length
      ? records.slice().reverse().map((record, index) => {
        const detail = record.data === null ? "" : JSON.stringify(record.data, null, 2);
        const summary = detail.replace(/\s+/g, " ").slice(0, 200);
        const tone = record.level === "error" ? "error" : record.level === "warn" ? "warn" : "ok";
        return `
          <div class="log-row ${tone} ${detail ? "expandable" : ""}" data-index="${index}">
            <div class="log-main">
              <span class="log-time">${escapeHtml(formatTime(record.at))}</span>
              <span class="log-level">${escapeHtml(record.level)}</span>
              <span class="log-tag">${escapeHtml(record.event)}</span>
              <span class="log-caret">${detail ? "›" : ""}</span>
            </div>
            ${detail ? `<div class="log-summary" style="padding:0 24px 8px">${escapeHtml(summary)}</div><pre class="log-data">${escapeHtml(detail)}</pre>` : ""}
          </div>
        `;
      }).join("")
      : `<div class="empty compact-empty">没有匹配的日志。</div>`;

    $("logList").querySelectorAll(".log-row.expandable .log-main").forEach((node) => {
      node.addEventListener("click", () => node.parentElement.classList.toggle("open"));
    });
  } catch (error) {
    setMessage("overviewMessage", error.message, "error");
  }
};

// ---------- 事件绑定 ----------
const bind = () => {
  document.querySelectorAll("[data-view]").forEach((node) => {
    node.addEventListener("click", () => switchView(node.dataset.view));
  });
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      state.filter = tab.dataset.filter;
      renderResources();
    });
  });

  $("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("ptAgentTheme", next);
    $("themeBtn").textContent = next === "light" ? "☀️" : "🌙";
  });

  const runScan = (dryRun) => (event) => void busy(event.target, async () => {
    setMessage("overviewMessage", dryRun ? "正在评估（不下载）…" : "正在扫描并推送…");
    try {
      const summary = await api("POST", "/api/scan", { dryRun });
      showActionResult(summary);
      setMessage(
        "overviewMessage",
        `扫描完成：Free ${summary.counts.total} 个，推荐 ${summary.counts.recommend} 个，` +
        `推送 ${summary.pushed.length}，准入拦下 ${summary.skipped.length}，失败 ${summary.failed.length}。`,
        summary.failed.length ? "error" : "success"
      );
      await Promise.all([loadStatus(), loadResources(), loadAudit()]);
    } catch (error) {
      setMessage("overviewMessage", error.message, "error");
      toast(error.message, "error");
    }
  });

  $("scanBtn").addEventListener("click", runScan(false));
  $("dryRunBtn").addEventListener("click", runScan(true));
  $("pushRecommendedBtn").addEventListener("click", runScan(false));

  $("guardRunBtn").addEventListener("click", (event) => void busy(event.target, async () => {
    try {
      const result = await api("POST", "/api/guard/run", {});
      showActionResult(result);
      setMessage("overviewMessage", `保护检查完成：检查 ${result.checked} 个，警告 ${result.warnings.length}，删除 ${result.deleted.length}。`, "success");
      await loadAudit();
    } catch (error) {
      setMessage("overviewMessage", error.message, "error");
    }
  }));

  $("backfillBtn").addEventListener("click", (event) => void busy(event.target, async () => {
    try {
      const result = await api("POST", "/api/backfill", {});
      showActionResult(result);
      setMessage("overviewMessage", `回填完成：候选 ${result.candidates} 个，补上标签 ${result.updated.length} 个。`, "success");
    } catch (error) {
      setMessage("overviewMessage", error.message, "error");
    }
  }));

  $("refreshBtn").addEventListener("click", () => void Promise.all([loadStatus(), loadResources(), loadAudit()]));
  $("refreshTasksBtn").addEventListener("click", () => void loadTasks());
  $("refreshLogsBtn").addEventListener("click", () => void loadLogs());
  $("logLevel").addEventListener("change", () => void loadLogs());
  $("logPrefix").addEventListener("change", () => void loadLogs());
  $("clearLogsBtn").addEventListener("click", async () => {
    if (!confirm("确定清空运行日志？审计记录不受影响。")) return;
    await api("DELETE", "/api/logs");
    await loadLogs();
  });

  $("saveDaemonBtn").addEventListener("click", (event) => void busy(event.target, async () => {
    try {
      await api("PUT", "/api/settings/daemon", {
        scanIntervalMinMinutes: Number($("dScanMin").value),
        scanIntervalMaxMinutes: Number($("dScanMax").value),
        maxPushPerScan: Number($("dMaxPush").value),
        guardIntervalSeconds: Number($("dGuardInterval").value),
        autoDownload: $("dAutoDownload").checked,
        scanOnStart: $("dScanOnStart").checked
      });
      setMessage("daemonMessage", "已保存。间隔改动会在下一轮重排时生效。", "success");
      await loadStatus();
    } catch (error) {
      setMessage("daemonMessage", error.message, "error");
    }
  }));

  const savePolicy = (messageId) => async (event) => busy(event.target, async () => {
    try {
      await api("PUT", "/api/settings/policy", {
        maxActiveDownloads: Number($("pMaxActive").value),
        minimumScore: Number($("pMinScore").value),
        maxTorrentSizeGB: Number($("pMaxSize").value),
        minFreeHoursForAutoDownload: Number($("pMinFreeHours").value),
        minimumRatio: Number($("pMinRatio").value),
        rejectHr: $("pRejectHr").checked,
        rejectMissingFreeEnd: $("pRejectMissingFreeEnd").checked,
        guardMonitorEnabled: $("gMonitorEnabled").checked,
        guardMinutes: Number($("gMinutes").value),
        autoDeleteExpired: $("gAutoDelete").checked
      });
      setMessage(messageId, "已保存。", "success");
      await loadStatus();
    } catch (error) {
      setMessage(messageId, error.message, "error");
    }
  });
  $("savePolicyBtn").addEventListener("click", savePolicy("policyMessage"));
  $("saveGuardBtn").addEventListener("click", savePolicy("guardMessage"));

  $("addDownloaderBtn").addEventListener("click", async () => {
    await api("POST", "/api/downloaders", {
      name: `下载器 ${(state.settings?.downloaders.length || 0) + 1}`,
      type: "qbittorrent",
      address: "http://127.0.0.1:8080/",
      username: "admin",
      password: "adminadmin",
      category: "PT_AGENT",
      enabled: false
    }).catch((error) => setMessage("downloaderMessage", error.message, "error"));
    await loadSettings();
  });

  $("addSiteBtn").addEventListener("click", async () => {
    await api("POST", "/api/sites", {
      name: "M-Team",
      type: "mteam",
      siteUrl: "https://kp.m-team.cc/",
      apiUrl: "https://api.m-team.cc/",
      apiKey: "PLEASE_REPLACE",
      enabled: false
    }).catch((error) => setMessage("siteMessage", error.message, "error"));
    await loadSettings();
  });
};

const start = async () => {
  const theme = localStorage.getItem("ptAgentTheme") || "dark";
  document.documentElement.dataset.theme = theme;
  $("themeBtn").textContent = theme === "light" ? "☀️" : "🌙";
  bind();
  await Promise.all([loadStatus(), loadResources(), loadAudit()]);
  // 定时刷新状态，让「下次扫描还有多久」保持准确，也能看到后台自动跑完的那一轮。
  setInterval(() => {
    if (state.view === "overview") void Promise.all([loadStatus(), loadAudit()]);
  }, 20000);
};

// 页面里的任何未捕获错误也要能被看见，不然只有打开控制台才知道出了问题。
window.addEventListener("error", (event) => toast(`页面错误：${event.message}`, "error"));
window.addEventListener("unhandledrejection", (event) => {
  toast(`未处理的失败：${String(event.reason?.message || event.reason)}`, "error");
});

void start();
