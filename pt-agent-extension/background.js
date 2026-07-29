importScripts(
  "logger.js",
  "private-config.js",
  "guard-engine.js",
  "qb-client.js",
  "downloader-registry.js",
  "downloader-store.js",
  "site-store.js",
  "network-router.js",
  "host-permissions.js",
  "request-rules.js"
);

globalThis.PT_AGENT_LOGGER.installStorageOwner();
globalThis.PT_AGENT_LOGGER.installErrorCapture();
globalThis.PT_AGENT_LOGGER.installConsoleCapture();

// 旧版的单下载器 / 站点配置在这里一次性迁移到多下载器、多站点结构。
const migrateStores = async () => {
  try {
    await globalThis.PT_AGENT_DOWNLOADER_STORE.createStore().list();
    await globalThis.PT_AGENT_SITE_STORE.createStore().list();
  } catch (error) {
    globalThis.PT_AGENT_LOGGER.legacy("settings:migrate-error", {
      error: error.message || String(error)
    });
  }
};

chrome.runtime.onInstalled.addListener(() => {
  void migrateStores();
  chrome.storage.local.get(["ptAgentSettings", "ptAgentQbSettings"], (stored) => {
    const updates = {};
    const privateConfig = globalThis.PT_AGENT_PRIVATE_CONFIG;
    updates.ptAgentSettings = {
      guardMinutes: 10,
      minFreeHoursForAutoDownload: 12,
      maxTorrentSizeGB: 50,
      minimumScore: 80,
      maxActiveDownloads: 3,
      minimumRatio: 1,
      scarceOpportunityMinFreeHours: 6,
      scarceOpportunityMaxRequiredSpeedBps: 524288,
      scarceOpportunityMinLeechers: 20,
      scarceOpportunityMinDemandRatio: 10,
      guardMonitorEnabled: true,
      autoDeleteExpired: false,
      guardExecutor: "extension",
      rejectHr: true,
      rejectMissingFreeEnd: true,
      // 上面的字面量只在对应键缺失时兜底；准入阈值由「设置 → 下载策略」决定，这里不再收紧。
      ...(stored.ptAgentSettings || {}),
      guardExecutor: "extension"
    };
    // 稀缺资源机会模型统一沿用 maxTorrentSizeGB，这个从未生效的专用上限已废弃，顺带清掉历史残留。
    delete updates.ptAgentSettings.scarceOpportunityMaxSizeGB;
    // 本地预设只用于补齐尚未填写的字段；用户在面板里保存过的地址、账号、密码不能被扩展更新覆盖。
    updates.ptAgentQbSettings = {
      ...(stored.ptAgentQbSettings || {}),
      address: stored.ptAgentQbSettings?.address || privateConfig.qbAddress,
      username: stored.ptAgentQbSettings?.username || privateConfig.qbUsername,
      password: stored.ptAgentQbSettings?.password || privateConfig.qbPassword,
      savePath: stored.ptAgentQbSettings?.savePath || privateConfig.qbSavePath,
      mteamApiKey: stored.ptAgentQbSettings?.mteamApiKey || privateConfig.mteamApiKey
    };
    if (Object.keys(updates).length) chrome.storage.local.set(updates);
  });
  chrome.alarms.create("ptAgentFreeGuard", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("ptAgentFreeGuard", { periodInMinutes: 1 });
});

const runFreeGuard = async () => {
  const operationId = globalThis.PT_AGENT_LOGGER.newOperationId();
  const stored = await chrome.storage.local.get([
    "ptAgentSettings",
    "ptAgentGuardStates",
    "ptAgentGuardRoute",
    "ptAgentGuardAuthCooldown"
  ]);
  const settings = {
    guardMinutes: 10,
    guardMonitorEnabled: true,
    autoDeleteExpired: false,
    ...(stored.ptAgentSettings || {}),
    guardExecutor: "extension"
  };
  if (!settings.guardMonitorEnabled) return;

  const onLog = (event, data) => globalThis.PT_AGENT_LOGGER.legacy(event, data, { operationId });
  // Service Worker 发出的请求 tabId 为 -1，不会被 excludedTabIds 排除，规则正常生效。
  const downloaderFetch = globalThis.PT_AGENT_REQUEST_RULES
    .createManager({ onLog })
    .wrapFetch(globalThis.fetch.bind(globalThis));
  const permissions = globalThis.PT_AGENT_HOST_PERMISSIONS.createManager();
  const downloaders = await globalThis.PT_AGENT_DOWNLOADER_STORE.createStore().list();
  const usable = downloaders.filter((item) => item.enabled && item.address && item.password);
  if (!usable.length) return;

  // 认证类失败要退避。后台每分钟一次，若被 qB 封禁还继续重试，封禁窗口会被不断刷新，
  // 用户永远等不到自动恢复。
  const cooldownUntil = Number(stored.ptAgentGuardAuthCooldown || 0);
  if (cooldownUntil > Date.now()) {
    onLog("guard:auth-cooldown", {
      resumesInSeconds: Math.round((cooldownUntil - Date.now()) / 1000)
    });
    return;
  }

  try {
    globalThis.PT_AGENT_LOGGER.legacy("guard:scan-start", { downloaders: usable.length }, { operationId });
    // Service Worker 里不能弹权限申请（没有用户手势），只能检查；缺权限的下载器直接跳过并记审计。
    const selection = await globalThis.PT_AGENT_NETWORK_ROUTER.selectDownloader(usable, {
      probe: async (downloader) => {
        if (!(await permissions.has(downloader.address))) {
          return { ok: false, error: "缺少主机访问权限，请在插件设置里授权" };
        }
        return globalThis.PT_AGENT_DOWNLOADER_TYPES
          .createAdapter(downloader, { fetchImpl: downloaderFetch, onLog })
          .probe({ timeoutMs: globalThis.PT_AGENT_NETWORK_ROUTER.DEFAULT_TIMEOUT_MS });
      },
      cache: stored.ptAgentGuardRoute
    });
    await chrome.storage.local.set({ ptAgentGuardRoute: selection.cache });
    onLog("guard:route", {
      reason: selection.reason,
      active: selection.downloader?.name || null,
      probes: selection.probes
    });
    if (!selection.downloader || selection.reason === "fallback") {
      throw new Error(globalThis.PT_AGENT_NETWORK_ROUTER.describe(selection));
    }
    const client = globalThis.PT_AGENT_DOWNLOADER_TYPES.createAdapter(
      selection.downloader,
      { fetchImpl: downloaderFetch, onLog }
    );
    // 后台每分钟跑一次，绝不能每次都登录：那正是把 IP 打到被 qB 封禁的原因。
    const torrents = await client.listTorrents("all");
    const previousStates = stored.ptAgentGuardStates || {};
    const nextStates = { ...previousStates };

    for (const torrent of torrents) {
      const result = globalThis.PT_AGENT_GUARD.evaluate(torrent, {
        guardMinutes: settings.guardMinutes
      });
      if (!result.managed || result.status === "completed") continue;
      const previous = previousStates[torrent.hash];
      nextStates[torrent.hash] = result.status;
      if (previous !== result.status && ["cannot_finish", "expiring", "expired", "missing_deadline"].includes(result.status)) {
        await globalThis.PT_AGENT_LOGGER.appendAudit({
          operation_id: operationId,
          action: "guard_warning",
          status: result.status,
          hash: torrent.hash,
          title: torrent.name,
          deadline: result.deadline,
          progress: result.progress,
          reason: result.status === "cannot_finish"
            ? "按当前下载速度无法在保护窗口前完成"
            : result.status === "missing_deadline"
              ? "缺少 Free 截止标签"
              : result.status === "expired"
                ? "Free 已到期且任务未完成"
                : "已进入 Free 到期保护窗口",
          deleteFiles: false
        });
      }
      if (
        settings.guardExecutor === "extension" &&
        settings.autoDeleteExpired &&
        ["expiring", "expired"].includes(result.status)
      ) {
        await client.deleteTorrents(torrent.hash, true);
        nextStates[torrent.hash] = "deleted";
        await globalThis.PT_AGENT_LOGGER.appendAudit({
          operation_id: operationId,
          action: "guard_delete",
          status: "deleted",
          hash: torrent.hash,
          title: torrent.name,
          deadline: result.deadline,
          progress: result.progress,
          reason: result.status === "expired" ? "Free 已到期保护删除" : "Free 到期前保护删除",
          deleteFiles: true
        });
      }
    }
    await chrome.storage.local.set({
      ptAgentGuardStates: nextStates,
      ptAgentGuardAuthCooldown: 0
    });
    globalThis.PT_AGENT_LOGGER.legacy(
      "guard:scan-completed",
      { torrents: torrents.length },
      { operationId }
    );
  } catch (error) {
    const reason = error.message || String(error);
    // 被封禁退避 30 分钟，普通登录失败退避 10 分钟；其余错误（网络不通等）不退避。
    const cooldownMinutes = error.code === "QB_IP_BANNED"
      ? 30
      : error.code === "QB_LOGIN_FAILED" || /账号或密码错误|登录失败/.test(reason)
        ? 10
        : 0;
    if (cooldownMinutes > 0) {
      await chrome.storage.local.set({
        ptAgentGuardAuthCooldown: Date.now() + cooldownMinutes * 60000
      });
      onLog("guard:auth-backoff", { code: error.code || null, cooldownMinutes });
    }
    globalThis.PT_AGENT_LOGGER.legacy("guard:scan-error", { error: reason }, { operationId });
    await globalThis.PT_AGENT_LOGGER.appendAudit({
      operation_id: operationId,
      action: "guard_error",
      status: "failed",
      reason: cooldownMinutes > 0 ? `${reason}（暂停后台检查 ${cooldownMinutes} 分钟）` : reason,
      deleteFiles: false
    });
  }
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ptAgentFreeGuard") runFreeGuard();
});
