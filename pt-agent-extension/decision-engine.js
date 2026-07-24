globalThis.PT_AGENT_DECISION = (() => {
  const hoursLeftAt = (iso, nowMs = Date.now()) => {
    if (!iso) return null;
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return null;
    return (timestamp - nowMs) / 3600000;
  };

  const evaluateTorrent = (torrent, settings, nowMs = Date.now()) => {
    const reasons = [];
    const freeType = String(torrent.freeType || "unknown").toLowerCase();
    const isFree = freeType === "free" || freeType === "2xfree" || freeType === "_2x_free";
    const left = hoursLeftAt(torrent.freeEndAt, nowMs);
    const sizeGB = Number(torrent.sizeBytes || 0) / 1024 ** 3;
    const seeders = Number(torrent.seeders || 0);
    const leechers = Number(torrent.leechers || 0);
    const demandRatio = seeders > 0 ? leechers / seeders : Infinity;

    if (settings.rejectHr && torrent.hasHr) {
      return { ...torrent, decision: "reject", score: 0, leftHours: left, reasons: ["HR 任务，新手期默认拒绝"] };
    }

    if (!isFree) {
      return { ...torrent, decision: "reject", score: 0, leftHours: left, reasons: ["不是明确 Free / 2xFree"] };
    }

    if (!torrent.freeEndAt && settings.rejectMissingFreeEnd) {
      return { ...torrent, decision: "risk", score: 30, leftHours: left, reasons: ["缺少 Free 截止时间，需要二次确认"] };
    }

    if (left !== null && left <= 0) {
      return { ...torrent, decision: "reject", score: 0, leftHours: left, reasons: ["Free 已到期"] };
    }

    if (left !== null && left * 60 <= settings.guardMinutes) {
      reasons.push(`进入 ${settings.guardMinutes} 分钟保护窗口`);
    } else if (left !== null && left < settings.minFreeHoursForAutoDownload) {
      reasons.push(`Free 剩余不足 ${settings.minFreeHoursForAutoDownload} 小时`);
    }

    if (sizeGB > settings.maxTorrentSizeGB) {
      reasons.push(`体积超过 ${settings.maxTorrentSizeGB}GB`);
    }

    if (seeders === 0) {
      reasons.push("当前 0 做种，无法保证完成下载");
    } else if (seeders <= 2 && leechers >= 20) {
      reasons.push(`仅 ${seeders} 做种、${leechers} 下载，首发供给不足且竞争过高`);
    } else if (seeders < 5 && demandRatio >= 8) {
      reasons.push(`做种仅 ${seeders}，下载/做种比达到 ${demandRatio.toFixed(1)}，完成时间不稳定`);
    }
    if (leechers <= seeders) {
      reasons.push(`下载 ${leechers} 不高于做种 ${seeders}，不进入推荐`);
    }

    if (reasons.length > 0) {
      return { ...torrent, decision: "risk", score: 40, leftHours: left, reasons };
    }

    let score = 60;
    const scoreReasons = ["Free 截止时间明确"];
    if (freeType.includes("2")) {
      score += 10;
      scoreReasons.push("2xFree 上传收益更高");
    }
    if (left !== null && left >= 24) {
      score += 8;
      scoreReasons.push("Free 剩余至少 24 小时");
    }
    if (seeders >= 10) {
      score += 10;
      scoreReasons.push("做种供给充足");
    } else if (seeders >= 5) {
      score += 6;
      scoreReasons.push("做种供给较稳定");
    } else if (seeders >= 3) {
      score += 3;
      scoreReasons.push("做种供给基本可用");
    }
    if (seeders >= 3 && demandRatio > 1 && demandRatio <= 4) {
      score += 8;
      scoreReasons.push("下载需求与做种供给较均衡");
    }
    if (sizeGB >= 5 && sizeGB <= settings.maxTorrentSizeGB) score += 4;

    return {
      ...torrent,
      decision: "recommend",
      score: Math.min(100, score),
      leftHours: left,
      reasons: scoreReasons
    };
  };

  return { evaluateTorrent, hoursLeftAt };
})();
