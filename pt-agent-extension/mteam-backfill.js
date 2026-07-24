globalThis.PT_AGENT_MTEAM_BACKFILL = (() => {
  const normalizeName = (value) => {
    return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  };

  const keywordCandidates = (name) => {
    const readable = String(name || "")
      .replace(/[._]+/g, " ")
      .replace(/[\[\](){}]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const tokens = readable.split(" ").filter(Boolean);
    return Array.from(new Set([
      readable,
      tokens.slice(0, 8).join(" "),
      tokens.slice(0, 5).join(" ")
    ].filter((value) => value.length >= 3)));
  };

  const findExactMatch = (task, rows) => {
    const targetName = normalizeName(task.name);
    const exactSize = (rows || []).filter((row) => Number(row.size) === Number(task.size));
    return exactSize.find((row) => normalizeName(row.name) === targetName) ||
      (exactSize.length === 1 ? exactSize[0] : null);
  };

  const freeDeadline = (row) => {
    const status = row?.status || {};
    const promotionRule = status.promotionRule || {};
    const discount = promotionRule.discount || status.discount;
    if (discount !== "FREE" && !status.mallSingleFree) return "";
    return status.discountEndTime ||
      promotionRule.discountEndTime ||
      promotionRule.endTime ||
      status.mallSingleFree?.discountEndTime ||
      status.mallSingleFree?.endTime ||
      "";
  };

  const hasDeadlineTag = (tags) => {
    return /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(String(tags || ""));
  };

  const searchModes = (name) => {
    return /\b[A-Z]{2,10}-\d{3,6}\b/i.test(String(name || ""))
      ? ["adult", "normal"]
      : ["normal", "adult"];
  };

  return {
    findExactMatch,
    freeDeadline,
    hasDeadlineTag,
    keywordCandidates,
    normalizeName,
    searchModes
  };
})();
