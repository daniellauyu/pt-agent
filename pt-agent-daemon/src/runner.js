"use strict";

const { createSiteClient } = require("./mteam");
const { connect } = require("./downloader");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hoursLeft = (iso, nowMs = Date.now()) => {
  const timestamp = Date.parse(iso || "");
  return Number.isFinite(timestamp) ? (timestamp - nowMs) / 3600000 : null;
};

// 剩余时间未知的排最后：连截止时间都读不到的资源，最不该优先推送。
const freeRemainingSortValue = (item) => {
  const value = Number(item?.leftHours);
  return Number.isFinite(value) ? value : -Infinity;
};

/**
 * 已经在下载器里的资源不再重复推送。
 * 匹配优先级：持久化关联（infoHash 精确）> ptagent-source 标签 > 名称模糊匹配。
 */
const findExisting = (engines, torrent, tasks, linkIndex) => {
  const linked = linkIndex.forResource(torrent.site, torrent.torrentId);
  if (linked) {
    const task = tasks.find((item) => String(item.hash || "").toLowerCase() === linked.hash);
    if (task) return { task, matchedBy: "link" };
  }
  const matched = engines.qb.matchTorrent(torrent, tasks);
  return matched.torrent ? { task: matched.torrent, matchedBy: matched.matchedBy } : null;
};

/** 入队后下载器要解析元数据才会出现在任务列表里，轮询几轮确认真的落地了。 */
const verifyEnqueued = async (ctx, client, torrent, { operationId, attempts = 4, delayMs = 1500 }) => {
  const { engines, logger } = ctx;
  if (attempts <= 0) return null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sleep(delayMs);
    const tasks = await client.listTorrents("all").catch(() => []);
    const matched = engines.qb.matchTorrent(torrent, tasks);
    logger.debug("push:verify", {
      title: torrent.title,
      attempt,
      landed: Boolean(matched.torrent),
      matchedBy: matched.matchedBy
    }, { operationId });
    if (matched.torrent) {
      await ctx.links.link({
        site: torrent.site,
        torrentId: torrent.torrentId,
        hash: matched.torrent.hash,
        siteTitle: torrent.title,
        qbName: matched.torrent.name
      });
      return matched.torrent;
    }
  }
  logger.warn("push:not-landed", {
    title: torrent.title,
    waitedSeconds: (attempts * delayMs) / 1000,
    hint: "下载器接受了请求但任务没出现，常见原因：保存目录无效、种子被拒、或元数据解析很慢"
  }, { operationId });
  return null;
};

const enqueueOne = async (ctx, { client, downloader, siteClient, torrent, operationId }) => {
  const { engines, logger } = ctx;
  const category = downloader.category || "PT_AGENT";
  const savePath = downloader.savePath || "";

  const downloadUrl = await siteClient.resolveDownloadUrl(torrent);
  const file = await siteClient.fetchTorrentFile(downloadUrl);
  await client.ensureCategory(category, savePath);

  const tag = [
    engines.qb.torrentTags(torrent.freeEndAt || ""),
    engines.qb.sourceTag(torrent.site, torrent.torrentId)
  ].filter(Boolean).join(", ");
  const safeName = String(torrent.title || torrent.torrentId || "download")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);

  logger.info("push:add", {
    title: torrent.title,
    route: file ? "file" : "url",
    fileSize: file?.size || 0,
    downloader: downloader.name,
    category,
    freeEndAt: torrent.freeEndAt || null,
    score: torrent.score
  }, { operationId });

  const result = await client.addTorrent({
    url: downloadUrl,
    file,
    filename: `${safeName}.torrent`,
    tag,
    savePath,
    category
  });

  return {
    duplicate: Boolean(result?.duplicate),
    route: file ? "file" : "url",
    downloader: downloader.name,
    category
  };
};

/**
 * 跑一轮完整的扫描 → 决策 → 推送。
 *
 * 「只下载推荐的」在这里有两道关：决策引擎必须给出 recommend，
 * 本地安全准入还要再过一遍评分、体积、Free 剩余和分享率。并发只提示不拦截——
 * 下载器自己有队列，超出上限的任务会排队而不是丢失。
 */
const runScan = async (ctx, { dryRun = false, force = false, operationId: suppliedId = null } = {}) => {
  const { engines, logger } = ctx;
  const operationId = suppliedId || logger.newOperationId();
  const startedAt = Date.now();
  const policy = await ctx.config.readPolicy();
  const daemon = await ctx.config.readDaemon();
  const autoDownload = force ? true : daemon.autoDownload;

  logger.info("scan:start", { dryRun, autoDownload, maxPushPerScan: daemon.maxPushPerScan }, { operationId });

  const site = await ctx.activeSite();
  const siteClient = createSiteClient(site, { logger, operationId });

  let account = null;
  try {
    account = await siteClient.fetchAccount();
  } catch (error) {
    // 账号信息只影响分享率这一条准入，取不到不该让整轮扫描失败。
    logger.warn("scan:account-unavailable", { error: String(error?.message || error) }, { operationId });
  }

  const catalog = await siteClient.fetchFreeCatalog();
  logger.info("scan:catalog", catalog.stats, { operationId });

  const { client, downloader } = await connect(ctx, { operationId });
  const tasks = await client.listTorrents("all");
  await ctx.links.backfillFromTasks(tasks, (tags) => engines.qb.sourceFromTags(tags));
  const linkIndex = engines.links.createIndex(await ctx.links.list());
  const excluded = await ctx.exclusions.list();
  const slots = engines.qb.summarizeDownloadSlots(tasks);

  const evaluated = catalog.torrents
    .map((torrent) => engines.decision.evaluateTorrent(torrent, policy))
    .map((torrent) => {
      const existing = findExisting(engines, torrent, tasks, linkIndex);
      return {
        ...torrent,
        excluded: ctx.exclusions.isExcluded(torrent, excluded),
        existingHash: existing?.task?.hash || null,
        existingMatchedBy: existing?.matchedBy || null
      };
    })
    // 按 Free 剩余时间从多到少排，和插件列表的排序一致。
    // 这同时也是推送优先级：剩余时间越长，越有把握在 Free 结束前下完；
    // 快到期的即使评分高，也很可能被 Free 保护删掉，先推它是浪费带宽。
    .sort((a, b) => freeRemainingSortValue(b) - freeRemainingSortValue(a));

  const counts = {
    total: evaluated.length,
    recommend: evaluated.filter((item) => item.decision === "recommend").length,
    risk: evaluated.filter((item) => item.decision === "risk").length,
    reject: evaluated.filter((item) => item.decision === "reject").length
  };

  const candidates = evaluated.filter((item) => item.decision === "recommend" && !item.excluded && !item.existingHash);
  const limited = daemon.maxPushPerScan > 0 ? candidates.slice(0, daemon.maxPushPerScan) : candidates;

  logger.info("scan:evaluated", {
    ...counts,
    alreadyInDownloader: evaluated.filter((item) => item.existingHash).length,
    excluded: evaluated.filter((item) => item.excluded).length,
    candidates: candidates.length,
    willPush: autoDownload && !dryRun ? limited.length : 0,
    occupyingSlots: slots.occupying
  }, { operationId });

  const pushed = [];
  const skipped = [];
  const failed = [];

  if (autoDownload && !dryRun) {
    let batchQueued = 0;
    for (const torrent of limited) {
      const admission = engines.admission.evaluate({
        torrent,
        account: account || {},
        activeDownloads: slots.occupying,
        batchQueued,
        settings: policy
      });
      if (admission.warnings?.length) {
        logger.warn("push:admission-warning", {
          title: torrent.title,
          warnings: admission.warnings
        }, { operationId });
      }
      if (!admission.allowed) {
        logger.info("push:admission-rejected", {
          title: torrent.title,
          reasons: admission.reasons
        }, { operationId });
        skipped.push({ title: torrent.title, torrentId: torrent.torrentId, reasons: admission.reasons });
        continue;
      }
      try {
        const result = await enqueueOne(ctx, { client, downloader, siteClient, torrent, operationId });
        batchQueued += 1;
        pushed.push({
          title: torrent.title,
          torrentId: torrent.torrentId,
          score: torrent.score,
          sizeBytes: torrent.sizeBytes,
          freeEndAt: torrent.freeEndAt,
          duplicate: result.duplicate,
          route: result.route
        });
        await ctx.logger.appendAudit({
          operation_id: operationId,
          action: "enqueue",
          status: result.duplicate ? "already_present" : "queued",
          title: torrent.title,
          site: torrent.site,
          torrentId: torrent.torrentId,
          deadline: torrent.freeEndAt,
          progress: 0,
          downloader: result.downloader,
          reason: result.duplicate
            ? `种子已存在于下载器 ${result.downloader}，未重复添加`
            : `自动扫描准入通过，评分 ${torrent.score}，分类 ${result.category}`,
          deleteFiles: false
        });
        await verifyEnqueued(ctx, client, torrent, {
          operationId,
          attempts: daemon.verifyAttempts,
          delayMs: daemon.verifyDelayMs
        });
      } catch (error) {
        const reason = String(error?.message || error);
        logger.error("push:error", { title: torrent.title, error: reason }, { operationId });
        failed.push({ title: torrent.title, torrentId: torrent.torrentId, error: reason });
        await ctx.logger.appendAudit({
          operation_id: operationId,
          action: "enqueue_error",
          status: "failed",
          title: torrent.title,
          site: torrent.site,
          torrentId: torrent.torrentId,
          deadline: torrent.freeEndAt,
          progress: 0,
          reason,
          deleteFiles: false
        });
      }
    }
  }

  const summary = {
    operationId,
    at: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    dryRun,
    autoDownload,
    site: site.name,
    downloader: downloader.name,
    counts,
    slots,
    candidates: candidates.length,
    pushed,
    skipped,
    failed,
    account: account && {
      username: account.username,
      ratio: account.ratio,
      bonus: account.bonus,
      bonusPerHour: account.bonusPerHour
    }
  };

  await ctx.state.merge({
    lastScan: summary,
    lastScanAt: summary.at,
    // 完整评估结果单独存，WebUI 的资源列表直接读它，不必每次开页面都去打站点接口。
    lastEvaluated: evaluated.slice(0, 300)
  });

  logger.info("scan:done", {
    durationMs: summary.durationMs,
    pushed: pushed.length,
    skipped: skipped.length,
    failed: failed.length
  }, { operationId });

  return { summary, evaluated };
};

/**
 * 手动推送指定的资源（WebUI 里点单个「发送」用）。
 * manualOverride 为 true 时跳过本地安全准入——那是用户在明确覆盖机器判断，
 * 但仍然照常记审计，事后能查出哪些是人工放行的。
 */
const pushSelected = async (ctx, torrentIds, { manualOverride = false, operationId: suppliedId = null } = {}) => {
  const { engines, logger } = ctx;
  const operationId = suppliedId || logger.newOperationId();
  const wanted = new Set((torrentIds || []).map((id) => String(id)));
  if (!wanted.size) throw new Error("没有指定要推送的资源");

  const stored = await ctx.state.read();
  const pool = stored.lastEvaluated || [];
  const targets = pool.filter((item) => wanted.has(String(item.torrentId)));
  if (!targets.length) throw new Error("指定的资源不在最近一次扫描结果里，请先重新扫描");

  const policy = await ctx.config.readPolicy();
  const daemon = await ctx.config.readDaemon();
  const site = await ctx.activeSite();
  const siteClient = createSiteClient(site, { logger, operationId });
  const { client, downloader } = await connect(ctx, { operationId });
  const tasks = await client.listTorrents("all");
  const slots = engines.qb.summarizeDownloadSlots(tasks);

  const pushed = [];
  const failed = [];
  let batchQueued = 0;

  for (const torrent of targets) {
    try {
      if (!manualOverride) {
        const admission = engines.admission.evaluate({
          torrent,
          activeDownloads: slots.occupying,
          batchQueued,
          settings: policy
        });
        if (!admission.allowed) throw new Error(`本地安全准入拒绝：${admission.reasons.join("；")}`);
      }
      const result = await enqueueOne(ctx, { client, downloader, siteClient, torrent, operationId });
      batchQueued += 1;
      pushed.push({ title: torrent.title, torrentId: torrent.torrentId, duplicate: result.duplicate });
      await logger.appendAudit({
        operation_id: operationId,
        action: manualOverride ? "enqueue_manual_override" : "enqueue",
        status: result.duplicate ? "already_present" : "queued",
        title: torrent.title,
        site: torrent.site,
        torrentId: torrent.torrentId,
        deadline: torrent.freeEndAt,
        progress: 0,
        downloader: result.downloader,
        reason: manualOverride
          ? `用户在 WebUI 手动覆盖准入，评分 ${torrent.score}`
          : `手动推送且准入通过，评分 ${torrent.score}`,
        deleteFiles: false
      });
      await verifyEnqueued(ctx, client, torrent, {
        operationId,
        attempts: daemon.verifyAttempts,
        delayMs: daemon.verifyDelayMs
      });
    } catch (error) {
      const reason = String(error?.message || error);
      logger.error("push:error", { title: torrent.title, error: reason }, { operationId });
      failed.push({ title: torrent.title, torrentId: torrent.torrentId, error: reason });
      await logger.appendAudit({
        operation_id: operationId,
        action: "enqueue_error",
        status: "failed",
        title: torrent.title,
        site: torrent.site,
        torrentId: torrent.torrentId,
        deadline: torrent.freeEndAt,
        progress: 0,
        reason,
        deleteFiles: false
      });
    }
  }

  return { operationId, pushed, failed, downloader: downloader.name };
};

module.exports = { runScan, pushSelected, verifyEnqueued, enqueueOne, findExisting, hoursLeft };
