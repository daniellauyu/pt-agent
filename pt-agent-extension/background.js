importScripts("private-config.js", "guard-engine.js", "qb-client.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["ptAgentSettings", "ptAgentQbSettings", "ptAgentCoreSettings"], (stored) => {
    const updates = {};
    const privateConfig = globalThis.PT_AGENT_PRIVATE_CONFIG;
    updates.ptAgentSettings = {
      guardMinutes: 10,
      minFreeHoursForAutoDownload: 12,
      maxTorrentSizeGB: 50,
      minimumScore: 80,
      maxActiveDownloads: 3,
      minimumRatio: 1,
      guardMonitorEnabled: true,
      autoDeleteExpired: false,
      rejectHr: true,
      rejectMissingFreeEnd: true,
      ...(stored.ptAgentSettings || {}),
      maxTorrentSizeGB: Math.min(50, Number(stored.ptAgentSettings?.maxTorrentSizeGB || 50)),
      minimumScore: Math.max(80, Number(stored.ptAgentSettings?.minimumScore || 80)),
      maxActiveDownloads: Math.min(3, Number(stored.ptAgentSettings?.maxActiveDownloads || 3))
    };
    updates.ptAgentQbSettings = {
      ...(stored.ptAgentQbSettings || {}),
      address: privateConfig.qbAddress,
      username: privateConfig.qbUsername,
      password: privateConfig.qbPassword,
      savePath: stored.ptAgentQbSettings?.savePath || privateConfig.qbSavePath,
      mteamApiKey: privateConfig.mteamApiKey
    };
    updates.ptAgentCoreSettings = {
      address: stored.ptAgentCoreSettings?.address || privateConfig.coreServiceUrl,
      autoSync: stored.ptAgentCoreSettings?.autoSync ?? true
    };
    if (Object.keys(updates).length) chrome.storage.local.set(updates);
  });
  chrome.alarms.create("ptAgentFreeGuard", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("ptAgentFreeGuard", { periodInMinutes: 1 });
});

const appendAuditEvent = async (event) => {
  const stored = await chrome.storage.local.get("ptAgentAuditLog");
  const events = Array.isArray(stored.ptAgentAuditLog) ? stored.ptAgentAuditLog : [];
  events.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...event
  });
  await chrome.storage.local.set({ ptAgentAuditLog: events.slice(0, 500) });
};

const runFreeGuard = async () => {
  const stored = await chrome.storage.local.get([
    "ptAgentSettings",
    "ptAgentQbSettings",
    "ptAgentGuardStates"
  ]);
  const settings = {
    guardMinutes: 10,
    guardMonitorEnabled: true,
    autoDeleteExpired: false,
    ...(stored.ptAgentSettings || {})
  };
  if (!settings.guardMonitorEnabled) return;

  const privateConfig = globalThis.PT_AGENT_PRIVATE_CONFIG;
  const qbSettings = {
    address: privateConfig.qbAddress,
    username: privateConfig.qbUsername,
    password: privateConfig.qbPassword,
    ...(stored.ptAgentQbSettings || {})
  };
  if (!qbSettings.address || !qbSettings.username || !qbSettings.password) return;

  try {
    const client = globalThis.PT_AGENT_QB.createClient(qbSettings);
    await client.login();
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
        await appendAuditEvent({
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
      if (settings.autoDeleteExpired && ["expiring", "expired"].includes(result.status)) {
        await client.deleteTorrents(torrent.hash, true);
        nextStates[torrent.hash] = "deleted";
        await appendAuditEvent({
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
    await chrome.storage.local.set({ ptAgentGuardStates: nextStates });
  } catch (error) {
    await appendAuditEvent({
      action: "guard_error",
      status: "failed",
      reason: error.message || String(error),
      deleteFiles: false
    });
  }
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ptAgentFreeGuard") runFreeGuard();
});
