(() => {
  const siteDefinitions = globalThis.PT_AGENT_SITE_DEFINITIONS || [];

  const parseSizeToBytes = (value) => {
    if (!value) return 0;
    const text = String(value).trim().replace(/,/g, "");
    const match = text.match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)/i);
    if (!match) return Number(text) || 0;
    const amount = Number(match[1]);
    const unit = match[2].toUpperCase();
    const power = unit.startsWith("T") ? 4 : unit.startsWith("G") ? 3 : unit.startsWith("M") ? 2 : unit.startsWith("K") ? 1 : 0;
    return Math.round(amount * Math.pow(1024, power));
  };

  const text = (root, selector) => {
    if (!selector) return "";
    const node = safeQuery(root, selector);
    return node ? node.textContent.trim() : "";
  };

  const attr = (root, selector, name) => {
    if (!selector || !name) return "";
    const node = safeQuery(root, selector);
    return node ? node.getAttribute(name) || "" : "";
  };

  const safeQuery = (root, selector) => {
    try {
      return root.querySelector(selector);
    } catch (_) {
      return null;
    }
  };

  const safeQueryAll = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  };

  const rowAttr = (row, definition, key) => {
    const attrName = definition?.attributes?.[key];
    return attrName ? row.getAttribute(attrName) || "" : "";
  };

  const normalizeFreeType = (value) => {
    const normalized = String(value || "").toLowerCase().replace(/[\s_-]+/g, "");
    if (normalized.includes("2xfree")) return "2xfree";
    if (normalized.includes("free")) return "free";
    return "unknown";
  };

  const promotionNodeText = (node) => {
    if (!node) return "";
    return [
      node.textContent,
      node.getAttribute("alt"),
      node.getAttribute("title"),
      node.getAttribute("class"),
      node.getAttribute("src")
    ].filter(Boolean).join(" ");
  };

  const extractPromotionEnd = (value) => {
    const match = String(value || "").match(/截止日期[：:]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    return match ? match[1] : "";
  };

  const parsePromotion = (row, definition, selectors) => {
    const labelNode = safeQuery(row, selectors.freeLabel || "x");
    const endNode = safeQuery(row, selectors.freeEnd || "x");
    const leftNode = safeQuery(row, selectors.freeLeft || "x");
    const deadlineNode = safeQuery(row, "[title*='截止日期']");
    const endTitle =
      deadlineNode?.getAttribute("title") ||
      endNode?.getAttribute("title") ||
      labelNode?.getAttribute("title") ||
      "";
    const rawType = rowAttr(row, definition, "freeType") || promotionNodeText(labelNode) || promotionNodeText(endNode);

    return {
      freeType: normalizeFreeType(rawType),
      freeEndAt:
        rowAttr(row, definition, "freeEnd") ||
        endNode?.getAttribute("data-free-end") ||
        extractPromotionEnd(endTitle) ||
        endNode?.getAttribute("datetime") ||
        "",
      freeLeftText: leftNode?.getAttribute("data-free-left") || leftNode?.textContent?.trim() || ""
    };
  };

  const matchesDefinition = (definition) => {
    const hostname = location.hostname;
    const domainMatch = (definition.domains || []).some((domain) => {
      if (domain === "") return location.protocol === "file:";
      return hostname === domain || hostname.endsWith(`.${domain}`);
    });
    const urlMatch = (definition.urlIncludes || []).some((part) => location.href.includes(part));
    return domainMatch || urlMatch;
  };

  const getMatchedDefinition = () => {
    return siteDefinitions.find(matchesDefinition) || null;
  };

  const getFieldStatus = (definition, rows) => {
    if (!definition) {
      return {
        matched: false,
        siteId: "generic",
        siteName: "未适配站点",
        usable: false,
        mode: "generic",
        fields: {}
      };
    }

    const firstRow = rows[0] || null;
    const fields = {};
    const checks = {
      rows: rows.length > 0,
      title: !!firstRow?.title,
      downloadUrl: !!firstRow?.downloadUrl,
      size: !!firstRow?.sizeBytes,
      freeLabel: !!firstRow && firstRow.freeType !== "unknown",
      freeEnd: !!firstRow?.freeEndAt,
      seeders: !!firstRow && Number.isFinite(firstRow.seeders),
      leechers: !!firstRow && Number.isFinite(firstRow.leechers),
      hr: !!firstRow && typeof firstRow.hasHr === "boolean"
    };

    Object.entries(checks).forEach(([key, ok]) => {
      fields[key] = !!ok;
    });

    const required = definition.requiredFields || ["rows", "title", "downloadUrl", "freeEnd"];
    const usable = required.every((field) => fields[field]);
    const warnings = [];
    if (!fields.freeEnd) warnings.push("未识别 Free 截止时间");
    if (!fields.seeders || !fields.leechers) warnings.push("未完整识别做种/下载人数");
    if (!fields.hr) warnings.push("未识别 HR 状态，需人工确认");

    return {
      matched: true,
      siteId: definition.id,
      siteName: definition.name,
      usable,
      mode: usable ? "adapted" : "partial",
      requiredFields: required,
      fields,
      warnings
    };
  };

  const absoluteUrl = (url) => {
    if (!url) return "";
    try {
      return new URL(url, location.href).toString();
    } catch (_) {
      return url;
    }
  };

  const parseBool = (value) => {
    return String(value || "").toLowerCase() === "true";
  };

  const parseAccount = (definition) => {
    const accountSelectors = definition?.accountSelectors || {};
    const userStats = safeQuery(document, accountSelectors.root || "#user-stats");
    const getAccountText = (key, fallbackSelector) => {
      const selector = accountSelectors[key] || fallbackSelector;
      const node = selector ? safeQuery(document, selector) : null;
      return node?.getAttribute(`data-user-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`) || node?.textContent?.trim() || "";
    };

    return {
      username: userStats?.getAttribute(accountSelectors.usernameAttr || "data-username") || "",
      uploadedText: getAccountText("uploaded", "[data-user-uploaded]"),
      downloadedText: getAccountText("downloaded", "[data-user-downloaded]"),
      ratio: Number(getAccountText("ratio", "[data-user-ratio]") || 0),
      bonus: Number(getAccountText("bonus", "[data-user-bonus]") || 0),
      seedingSizeText: getAccountText("seedingSize", "[data-user-seeding-size]")
    };
  };

  const parseRowsByDefinition = (definition) => {
    if (!definition) return [];
    const selectors = definition.selectors || {};
    return safeQueryAll(document, selectors.rows || ".torrent-row").map((row, index) => {
      const sizeText = attr(row, selectors.size, "data-size") || text(row, selectors.size);
      const promotion = parsePromotion(row, definition, selectors);
      const detailUrl = rowAttr(row, definition, "detailUrl") || attr(row, selectors.detailUrl, "href");
      const downloadUrl = rowAttr(row, definition, "downloadUrl") || attr(row, selectors.downloadUrl, "href");
      const torrentId =
        rowAttr(row, definition, "torrentId") ||
        String(detailUrl || "").match(/(?:\/detail\/|[?&]id=)(\d+)/)?.[1] ||
        "";
      return {
        rowIndex: index,
        site: row.dataset.site || definition.id,
        torrentId,
        infoHash: rowAttr(row, definition, "infoHash"),
        title: rowAttr(row, definition, "title") || text(row, selectors.title),
        subtitle: text(row, selectors.subtitle),
        category: text(row, selectors.category),
        sizeBytes: Number(rowAttr(row, definition, "sizeBytes") || 0) || parseSizeToBytes(sizeText),
        sizeText,
        freeType: promotion.freeType,
        freeStartAt: rowAttr(row, definition, "freeStart"),
        freeEndAt: promotion.freeEndAt,
        freeLeftText: promotion.freeLeftText,
        seeders: Number(rowAttr(row, definition, "seeders") || text(row, selectors.seeders) || 0),
        leechers: Number(rowAttr(row, definition, "leechers") || text(row, selectors.leechers) || 0),
        completed: Number(rowAttr(row, definition, "completed") || text(row, selectors.completed) || 0),
        hasHr: parseBool(rowAttr(row, definition, "hr")) || !!safeQuery(row, selectors.hr || "x"),
        detailUrl: absoluteUrl(detailUrl),
        downloadUrl: absoluteUrl(downloadUrl),
        publishedAt: attr(row, selectors.publishedAt, "datetime") || text(row, selectors.publishedAt),
        source: "chrome"
      };
    });
  };

  const parseGenericRows = () => {
    const rows = safeQueryAll(document, "table tr").filter((row) => {
      return safeQuery(row, "a[href*='download'], a[href*='download.php'], a[href*='/download/']");
    });
    return rows.map((row, index) => {
      const download = safeQuery(row, "a[href*='download'], a[href*='download.php'], a[href*='/download/']");
      const detail = safeQuery(row, "a[href*='detail'], a[href*='details'], a[href*='torrent']");
      const body = row.textContent.trim();
      return {
        rowIndex: index,
        site: location.hostname,
        torrentId: row.getAttribute("id") || "",
        infoHash: "",
        title: detail?.textContent.trim() || download?.textContent.trim() || body.slice(0, 80),
        subtitle: "",
        category: "",
        sizeBytes: parseSizeToBytes(body),
        sizeText: "",
        freeType: /2x\s*free/i.test(body) ? "2xfree" : /free/i.test(body) ? "free" : "unknown",
        freeStartAt: "",
        freeEndAt: "",
        freeLeftText: "",
        seeders: 0,
        leechers: 0,
        completed: 0,
        hasHr: /HR|H&R/i.test(body),
        detailUrl: absoluteUrl(detail?.getAttribute("href") || ""),
        downloadUrl: absoluteUrl(download?.getAttribute("href") || ""),
        publishedAt: "",
        source: "chrome-generic"
      };
    });
  };

  const definition = getMatchedDefinition();
  const torrents = parseRowsByDefinition(definition);
  const fallbackTorrents = torrents.length ? [] : parseGenericRows();
  const siteStatus = getFieldStatus(definition, torrents);
  if (!torrents.length && fallbackTorrents.length) {
    siteStatus.mode = "generic";
    siteStatus.usable = false;
    siteStatus.warnings = ["未匹配站点配置，已使用通用下载链接扫描，Free 截止时间不可靠"];
  }

  return {
    page: {
      title: document.title,
      url: location.href,
      scannedAt: new Date().toISOString()
    },
    site: siteStatus,
    account: parseAccount(definition),
    torrents: torrents.length ? torrents : fallbackTorrents
  };
})();
