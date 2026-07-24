globalThis.PT_AGENT_GUARD = (() => {
  const deadlineFromTags = (tags) => {
    const match = String(tags || "").match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    return match ? match[0] : "";
  };

  const hasAgentTag = (tags) => {
    return String(tags || "")
      .split(",")
      .some((tag) => tag.trim().toLowerCase() === "ptagent");
  };

  const evaluate = (torrent, { guardMinutes = 10, nowMs = Date.now() } = {}) => {
    const managed = hasAgentTag(torrent?.tags);
    const progress = Math.max(0, Math.min(1, Number(torrent?.progress || 0)));
    const deadline = deadlineFromTags(torrent?.tags);
    const deadlineMs = deadline ? Date.parse(deadline.replace(" ", "T")) : NaN;
    const remainingBytes = Math.max(
      0,
      Number(torrent?.amount_left ?? (Number(torrent?.size || 0) * (1 - progress)))
    );
    const speed = Math.max(0, Number(torrent?.dlspeed || 0));
    const etaSeconds = remainingBytes === 0 ? 0 : speed > 0 ? remainingBytes / speed : Infinity;

    if (!managed) return { status: "unmanaged", managed, deadline, progress, remainingBytes, etaSeconds };
    if (progress >= 1) return { status: "completed", managed, deadline, progress, remainingBytes: 0, etaSeconds: 0 };
    if (!Number.isFinite(deadlineMs)) {
      return { status: "missing_deadline", managed, deadline, progress, remainingBytes, etaSeconds };
    }

    const secondsLeft = (deadlineMs - nowMs) / 1000;
    const guardSeconds = Math.max(0, Number(guardMinutes || 0)) * 60;
    const usableSeconds = secondsLeft - guardSeconds;
    const common = {
      managed,
      deadline,
      deadlineMs,
      progress,
      remainingBytes,
      speed,
      etaSeconds,
      secondsLeft,
      usableSeconds
    };
    if (secondsLeft <= 0) return { ...common, status: "expired" };
    if (secondsLeft <= guardSeconds) return { ...common, status: "expiring" };
    if (!Number.isFinite(etaSeconds) || etaSeconds > usableSeconds) {
      return { ...common, status: "cannot_finish" };
    }
    return { ...common, status: "safe" };
  };

  return { deadlineFromTags, evaluate, hasAgentTag };
})();
