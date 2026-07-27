importScripts("logger.js", "private-config.js", "guard-engine.js", "qb-client.js");

globalThis.PT_AGENT_LOGGER.installStorageOwner();

chrome.runtime.onInstalled.addListener(() => {
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
      scarceOpportunityMaxSizeGB: 10,
      scarceOpportunityMinFreeHours: 6,
      scarceOpportunityMaxRequiredSpeedBps: 524288,
      scarceOpportunityMinLeechers: 20,
      scarceOpportunityMinDemandRatio: 10,
      guardMonitorEnabled: true,
      autoDeleteExpired: false,
      guardExecutor: "extension",
      rejectHr: true,
      rejectMissingFreeEnd: true,
      ...(stored.ptAgentSettings || {}),
      guardExecutor: "extension",
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
    "ptAgentQbSettings",
    "ptAgentGuardStates"
  ]);
  const settings = {
    guardMinutes: 10,
    guardMonitorEnabled: true,
    autoDeleteExpired: false,
    ...(stored.ptAgentSettings || {}),
    guardExecutor: "extension"
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
    globalThis.PT_AGENT_LOGGER.legacy("guard:scan-start", null, { operationId });
    const client = globalThis.PT_AGENT_QB.createClient(
      qbSettings,
      undefined,
      (event, data) => globalThis.PT_AGENT_LOGGER.legacy(event, data, { operationId })
    );
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
    await chrome.storage.local.set({ ptAgentGuardStates: nextStates });
    globalThis.PT_AGENT_LOGGER.legacy(
      "guard:scan-completed",
      { torrents: torrents.length },
      { operationId }
    );
  } catch (error) {
    globalThis.PT_AGENT_LOGGER.legacy(
      "guard:scan-error",
      { error: error.message || String(error) },
      { operationId }
    );
    await globalThis.PT_AGENT_LOGGER.appendAudit({
      operation_id: operationId,
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
