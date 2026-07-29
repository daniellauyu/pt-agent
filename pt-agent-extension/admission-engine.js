globalThis.PT_AGENT_ADMISSION = (() => {
  const evaluate = ({
    torrent,
    account = {},
    activeDownloads = 0,
    batchQueued = 0,
    settings = {}
  }) => {
    const config = {
      minimumScore: 80,
      maxTorrentSizeGB: 50,
      minFreeHoursForAutoDownload: 12,
      maxActiveDownloads: 3,
      minimumRatio: 1,
      ...settings
    };
    const reasons = [];
    // 并发不再是拦截条件：下载器自己有队列，超出上限的任务会排队而不是丢失。
    // 但仍然提示出来，因为 Free 资源有截止时间，排太久可能在 Free 窗口内轮不到。
    const warnings = [];
    const sizeGB = Number(torrent?.sizeBytes || 0) / 1024 ** 3;
    const score = Number(torrent?.score || 0);
    const ratio = Number(account?.ratio);

    if (torrent?.decision !== "recommend") reasons.push("资源未达到推荐级别");
    if (score < config.minimumScore) reasons.push(`评分低于 ${config.minimumScore}`);
    if (sizeGB > config.maxTorrentSizeGB) reasons.push(`体积超过 ${config.maxTorrentSizeGB}GB`);
    if (torrent?.leftHours === null || !Number.isFinite(Number(torrent?.leftHours))) {
      reasons.push("无法确认 Free 剩余时间");
    } else if (
      Number(torrent.leftHours) < config.minFreeHoursForAutoDownload &&
      torrent?.scarceHighDemandOpportunity !== true
    ) {
      reasons.push(`Free 剩余不足 ${config.minFreeHoursForAutoDownload} 小时`);
    }
    if (activeDownloads + batchQueued >= config.maxActiveDownloads) {
      warnings.push(
        `已有 ${activeDownloads + batchQueued} 个下载占用中，超过提醒阈值 ${config.maxActiveDownloads}；` +
        `新任务会在下载器里排队，注意 Free 是否来得及`
      );
    }
    if (Number.isFinite(ratio) && ratio > 0 && ratio < config.minimumRatio) {
      reasons.push(`分享率低于 ${config.minimumRatio.toFixed(1)}`);
    }

    const allowed = reasons.length === 0;
    return {
      allowed,
      reasons,
      warnings,
      activeAfterEnqueue: activeDownloads + batchQueued + (allowed ? 1 : 0)
    };
  };

  return { evaluate };
})();
