globalThis.PT_AGENT_ASSESSMENT = (() => {
  const calculate = ({
    bonus,
    bonusPerHour,
    createdDate,
    uploadedBytes = 0,
    downloadedBytes = 0,
    seedingCount = 0,
    seedingSizeBytes = 0,
    target = 6000,
    targetUploadBytes = 30 * 1024 ** 3,
    targetDownloadBytes = 15 * 1024 ** 3,
    assessmentDays = 30,
    nowMs = Date.now()
  }) => {
    const current = Math.max(0, Number(bonus || 0));
    const rate = Math.max(0, Number(bonusPerHour || 0));
    const remaining = Math.max(0, target - current);
    const createdAt = Date.parse(createdDate || "");
    const deadlineAt = Number.isFinite(createdAt)
      ? createdAt + assessmentDays * 24 * 3600000
      : null;
    const hoursLeft = deadlineAt === null ? null : Math.max(0, (deadlineAt - nowMs) / 3600000);
    const requiredRate = remaining === 0
      ? 0
      : hoursLeft > 0
        ? remaining / hoursLeft
        : Infinity;
    const etaHours = remaining === 0
      ? 0
      : rate > 0
        ? remaining / rate
        : Infinity;
    const uploaded = Math.max(0, Number(uploadedBytes || 0));
    const downloaded = Math.max(0, Number(downloadedBytes || 0));
    const seedSize = Math.max(0, Number(seedingSizeBytes || 0));
    const seedCount = Math.max(0, Number(seedingCount || 0));
    const safetyMarginHours = Number.isFinite(hoursLeft) && Number.isFinite(etaHours)
      ? hoursLeft - etaHours
      : null;
    const projectedAtDeadline = Number.isFinite(hoursLeft)
      ? current + rate * hoursLeft
      : null;
    const efficiencyPerByte = rate > 0 && seedSize > 0 ? rate / seedSize : null;
    const safetyPlans = [0, 3, 5, 7].map((bufferDays) => {
      const availableHours = hoursLeft === null
        ? null
        : Math.max(0, hoursLeft - bufferDays * 24);
      const targetRate = remaining === 0
        ? 0
        : availableHours > 0
          ? remaining / availableHours
          : Infinity;
      const additionalRate = Number.isFinite(targetRate)
        ? Math.max(0, targetRate - rate)
        : Infinity;
      const estimatedLow = additionalRate === 0
        ? 0
        : efficiencyPerByte
          ? additionalRate / efficiencyPerByte
          : null;
      const estimatedHigh = estimatedLow === null ? null : estimatedLow * 2;
      return {
        bufferDays,
        availableHours,
        targetRate,
        additionalRate,
        estimatedAdditionalSeedBytesLow: estimatedLow,
        estimatedAdditionalSeedBytesHigh: estimatedHigh,
        estimatedTargetSeedSizeBytes: estimatedHigh === null ? null : seedSize + estimatedHigh
      };
    });
    const allAchieved = remaining === 0
      && uploaded >= targetUploadBytes
      && downloaded >= targetDownloadBytes;
    const status = allAchieved
      ? "achieved"
      : hoursLeft === null
        ? "unknown"
        : hoursLeft <= 0
          ? "expired"
          : safetyMarginHours === null || safetyMarginHours < 0
            ? "off_track"
            : safetyMarginHours < 24
              ? "critical"
              : safetyMarginHours < 72
                ? "at_risk"
                : "on_track";
    return {
      target,
      current,
      remaining,
      progress: Math.min(100, target > 0 ? current / target * 100 : 100),
      rate,
      uploaded,
      downloaded,
      seedingCount: seedCount,
      seedingSizeBytes: seedSize,
      remainingUploadedBytes: Math.max(0, targetUploadBytes - uploaded),
      remainingDownloadedBytes: Math.max(0, targetDownloadBytes - downloaded),
      deadlineAt,
      hoursLeft,
      requiredRate,
      etaHours,
      projectedAtDeadline,
      safetyMarginHours,
      status,
      safetyPlans,
      recommendedPlan: safetyPlans.find((plan) => plan.bufferDays === 5),
      rateMultiplier: rate > 0 && Number.isFinite(requiredRate) ? requiredRate / rate : Infinity,
      achieved: allAchieved
    };
  };

  return { calculate };
})();
