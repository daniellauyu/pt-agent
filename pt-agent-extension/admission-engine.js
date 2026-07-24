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
    const sizeGB = Number(torrent?.sizeBytes || 0) / 1024 ** 3;
    const score = Number(torrent?.score || 0);
    const ratio = Number(account?.ratio);

    if (torrent?.decision !== "recommend") reasons.push("资源未达到推荐级别");
    if (score < config.minimumScore) reasons.push(`评分低于 ${config.minimumScore}`);
    if (sizeGB > config.maxTorrentSizeGB) reasons.push(`体积超过 ${config.maxTorrentSizeGB}GB`);
    if (torrent?.leftHours === null || !Number.isFinite(Number(torrent?.leftHours))) {
      reasons.push("无法确认 Free 剩余时间");
    } else if (Number(torrent.leftHours) < config.minFreeHoursForAutoDownload) {
      reasons.push(`Free 剩余不足 ${config.minFreeHoursForAutoDownload} 小时`);
    }
    if (activeDownloads + batchQueued >= config.maxActiveDownloads) {
      reasons.push(`活动下载已达到 ${config.maxActiveDownloads} 个`);
    }
    if (Number.isFinite(ratio) && ratio > 0 && ratio < config.minimumRatio) {
      reasons.push(`分享率低于 ${config.minimumRatio.toFixed(1)}`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      activeAfterEnqueue: activeDownloads + batchQueued + (reasons.length === 0 ? 1 : 0)
    };
  };

  return { evaluate };
})();
