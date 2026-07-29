"use strict";

const { connect } = require("./downloader");
const { createSiteClient } = require("./mteam");

const COOLDOWN_KEY = "ptAgentDaemonAuthCooldown";
const STATES_KEY = "ptAgentDaemonGuardStates";

/**
 * Free 到期保护。
 *
 * 入队时把 Free 截止时间写进标签（ptagent-free-end=...），这里定期回读：
 * 到期前还没下完的任务就删掉，连文件一起。不删的话既白占盘，
 * 站点那边过了 Free 还在下载会真实计入下载量。
 */
const runGuard = async (ctx, { operationId: suppliedId = null, dryRun = false } = {}) => {
  const { engines, logger } = ctx;
  const operationId = suppliedId || logger.newOperationId();
  const policy = await ctx.config.readPolicy();
  if (!policy.guardMonitorEnabled) {
    return { skipped: "guardMonitorEnabled=false", checked: 0, warnings: [], deleted: [] };
  }

  const stored = await ctx.storage.get([COOLDOWN_KEY, STATES_KEY]);
  const cooldownUntil = Number(stored?.[COOLDOWN_KEY] || 0);
  if (cooldownUntil > Date.now()) {
    const resumesInSeconds = Math.round((cooldownUntil - Date.now()) / 1000);
    logger.warn("guard:auth-cooldown", { resumesInSeconds }, { operationId });
    return { skipped: "auth-cooldown", resumesInSeconds, checked: 0, warnings: [], deleted: [] };
  }

  const previousStates = stored?.[STATES_KEY] || {};
  const nextStates = { ...previousStates };
  const warnings = [];
  const deleted = [];

  try {
    const { client, downloader } = await connect(ctx, { operationId });
    const torrents = await client.listTorrents("all");

    for (const torrent of torrents) {
      const result = engines.guard.evaluate(torrent, { guardMinutes: policy.guardMinutes });
      if (!result.managed || result.status === "completed") continue;
      const previous = previousStates[torrent.hash];
      nextStates[torrent.hash] = result.status;

      if (previous !== result.status && ["cannot_finish", "expiring", "expired", "missing_deadline"].includes(result.status)) {
        const reason = result.status === "cannot_finish"
          ? "按当前下载速度无法在保护窗口前完成"
          : result.status === "missing_deadline"
            ? "缺少 Free 截止标签"
            : result.status === "expired"
              ? "Free 已到期且任务未完成"
              : "已进入 Free 到期保护窗口";
        warnings.push({ hash: torrent.hash, title: torrent.name, status: result.status, reason, progress: result.progress });
        logger.warn("guard:warning", {
          title: torrent.name,
          status: result.status,
          progress: Number(result.progress || 0).toFixed(3),
          deadline: result.deadline,
          reason
        }, { operationId });
        await logger.appendAudit({
          operation_id: operationId,
          action: "guard_warning",
          status: result.status,
          hash: torrent.hash,
          title: torrent.name,
          deadline: result.deadline,
          progress: result.progress,
          reason,
          deleteFiles: false
        });
      }

      if (policy.autoDeleteExpired && ["expiring", "expired"].includes(result.status)) {
        if (dryRun) {
          deleted.push({ hash: torrent.hash, title: torrent.name, status: result.status, dryRun: true });
          continue;
        }
        await client.deleteTorrents(torrent.hash, true);
        nextStates[torrent.hash] = "deleted";
        deleted.push({ hash: torrent.hash, title: torrent.name, status: result.status, progress: result.progress });
        logger.warn("guard:deleted", {
          title: torrent.name,
          status: result.status,
          progress: Number(result.progress || 0).toFixed(3),
          downloader: downloader.name
        }, { operationId });
        await logger.appendAudit({
          operation_id: operationId,
          action: "guard_delete",
          status: "deleted",
          hash: torrent.hash,
          title: torrent.name,
          deadline: result.deadline,
          progress: result.progress,
          downloader: downloader.name,
          reason: result.status === "expired" ? "Free 已到期保护删除" : "Free 到期前保护删除",
          deleteFiles: true
        });
      }
    }

    // 任务被删掉后，把不再存在的关联一并清掉，避免关联表无限增长。
    await ctx.links.prune(torrents.map((item) => item.hash));
    await ctx.storage.set({ [STATES_KEY]: nextStates, [COOLDOWN_KEY]: 0 });
    await ctx.state.merge({ lastGuardAt: new Date().toISOString() });
    logger.debug("guard:done", { checked: torrents.length, warnings: warnings.length, deleted: deleted.length }, { operationId });
    return { checked: torrents.length, warnings, deleted, downloader: downloader.name };
  } catch (error) {
    const reason = String(error?.message || error);
    // 认证类失败必须退避。守护进程每分钟一次，被 qB 封禁后还继续重试，
    // 封禁窗口会被不断刷新，永远等不到自动恢复。
    const cooldownMinutes = error.code === "QB_IP_BANNED"
      ? 30
      : error.code === "QB_LOGIN_FAILED" || /账号或密码错误|登录失败/.test(reason)
        ? 10
        : 0;
    if (cooldownMinutes > 0) {
      await ctx.storage.set({ [COOLDOWN_KEY]: Date.now() + cooldownMinutes * 60000 });
      logger.warn("guard:auth-backoff", { code: error.code || null, cooldownMinutes }, { operationId });
    }
    logger.error("guard:error", { error: reason }, { operationId });
    await logger.appendAudit({
      operation_id: operationId,
      action: "guard_error",
      status: "failed",
      reason: cooldownMinutes > 0 ? `${reason}（暂停保护检查 ${cooldownMinutes} 分钟）` : reason,
      deleteFiles: false
    });
    throw error;
  }
};

/** 给下载器里缺 Free 截止标签的任务回查并补标签，补上后它们才受保护。 */
const backfillDeadlines = async (ctx, { operationId: suppliedId = null } = {}) => {
  const { engines, logger } = ctx;
  const operationId = suppliedId || logger.newOperationId();
  const site = await ctx.activeSite();
  const siteClient = createSiteClient(site, { logger, operationId });
  const { client } = await connect(ctx, { operationId });
  const torrents = await client.listTorrents("all");

  const candidates = torrents.filter((torrent) => {
    let trackerHost = "";
    try { trackerHost = new URL(torrent.tracker || "").hostname; } catch (_) {}
    const downloading = Number(torrent.progress || 0) < 1;
    return trackerHost.endsWith("m-team.cc") && downloading && !engines.backfill.hasDeadlineTag(torrent.tags);
  }).map((torrent) => ({ hash: torrent.hash, name: torrent.name, size: torrent.size }));

  if (!candidates.length) {
    logger.info("backfill:none", { checked: torrents.length }, { operationId });
    return { checked: torrents.length, candidates: 0, updated: [] };
  }

  const updates = await siteClient.findFreeDeadlines(candidates);
  for (const update of updates) {
    await client.addTags(update.hash, engines.qb.torrentTags(update.deadline));
  }
  logger.info("backfill:done", { candidates: candidates.length, updated: updates.length }, { operationId });
  return { checked: torrents.length, candidates: candidates.length, updated: updates };
};

module.exports = { runGuard, backfillDeadlines, COOLDOWN_KEY, STATES_KEY };
