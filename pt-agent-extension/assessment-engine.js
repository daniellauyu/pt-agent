globalThis.PT_AGENT_ASSESSMENT = (() => {
  const calculate = ({
    bonus,
    bonusPerHour,
    createdDate,
    target = 6000,
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
    return {
      target,
      current,
      remaining,
      progress: Math.min(100, target > 0 ? current / target * 100 : 100),
      rate,
      deadlineAt,
      hoursLeft,
      requiredRate,
      etaHours,
      rateMultiplier: rate > 0 && Number.isFinite(requiredRate) ? requiredRate / rate : Infinity,
      achieved: remaining === 0
    };
  };

  return { calculate };
})();
