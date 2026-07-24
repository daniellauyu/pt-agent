globalThis.PT_AGENT_SITE_DEFINITIONS = [
  {
    id: "mock-mteam",
    name: "M-Team Mock",
    domains: ["mock-pt-site.local", "localhost", "127.0.0.1", ""],
    urlIncludes: ["mock-pt-site.html"],
    selectors: {
      rows: ".torrent-row",
      title: ".torrent-title-link",
      subtitle: ".torrent-desc",
      category: ".category-icon",
      size: ".size",
      freeLabel: ".free-label",
      freeEnd: ".free-end",
      freeLeft: ".time-left",
      seeders: ".seeders b",
      leechers: ".leechers b",
      completed: ".completed b",
      hr: ".tag-hr",
      detailUrl: ".torrent-title-link",
      downloadUrl: ".torrent-download",
      publishedAt: ".published-at"
    },
    attributes: {
      torrentId: "data-torrent-id",
      infoHash: "data-info-hash",
      title: "data-title",
      sizeBytes: "data-size-bytes",
      freeType: "data-free-type",
      freeStart: "data-free-start",
      freeEnd: "data-free-end",
      seeders: "data-seeders",
      leechers: "data-leechers",
      completed: "data-completed",
      hr: "data-hr",
      detailUrl: "data-detail-url",
      downloadUrl: "data-download-url"
    },
    accountSelectors: {
      root: "#user-stats",
      usernameAttr: "data-username",
      uploaded: "[data-user-uploaded]",
      downloaded: "[data-user-downloaded]",
      ratio: "[data-user-ratio]",
      bonus: "[data-user-bonus]",
      seedingSize: "[data-user-seeding-size]"
    },
    requiredFields: ["rows", "title", "downloadUrl", "size", "freeLabel", "freeEnd"]
  },
  {
    id: "mteam",
    name: "M-Team",
    domains: ["m-team.cc", "kp.m-team.cc", "xp.m-team.cc"],
    selectors: {
      rows: "div.app-content__inner table.w-full > tbody > tr, tbody.bg-\\[\\#bccad6\\] > tr, table.torrents > tbody > tr, table.torrentname > tbody > tr, .torrent-row",
      title: "a[href*='/detail/'] strong, a[href*='details'] strong, a[href*='details'], a[href*='/detail'], .torrent-title-link",
      subtitle: "a[href*='/detail/'] + br + div > span:nth-last-child(1), .torrent-desc, .subtitle",
      category: "a[href^='/browse?cat='] > span, a[href*='cat'] img, .category-icon",
      size: "td:nth-last-child(4), td:nth-last-child(3), .size",
      freeLabel: ".free-label, img[src*='free'], img[alt*='Free'], [class*='free'], [class*='Free'], [title*='促銷'], [title*='促销'], [title*='截止日期']",
      freeEnd: ".free-end, [datetime], [data-free-end], [title*='剩余'], [title*='Free'], [title*='促銷'], [title*='促销'], [title*='截止日期']",
      freeLeft: ".time-left, [data-free-left], [title*='剩余'], [title*='Free'], [title*='促銷'], [title*='促销'], [title*='截止日期']",
      seeders: "td:nth-last-child(3) span.align-middle:nth-last-child(1), span[aria-label='arrow-up'] + span, a[href*='seeders'], .seeders b",
      leechers: "td:nth-last-child(2) span.align-middle:nth-last-child(1), span[aria-label='arrow-down'] + span, a[href*='leechers'], .leechers b",
      completed: "td:nth-last-child(1), a[href*='snatches'], .completed b",
      hr: ".tag-hr, img[src*='hr'], img[alt*='HR']",
      detailUrl: "a[href*='/detail/'], a[href*='details']",
      downloadUrl: "a[href*='download'], a[href*='download.php'], a[href*='/download/']",
      publishedAt: ".published-at"
    },
    attributes: {
      torrentId: "data-torrent-id",
      infoHash: "data-info-hash",
      title: "data-title",
      sizeBytes: "data-size-bytes",
      freeType: "data-free-type",
      freeStart: "data-free-start",
      freeEnd: "data-free-end",
      seeders: "data-seeders",
      leechers: "data-leechers",
      completed: "data-completed",
      hr: "data-hr",
      detailUrl: "data-detail-url",
      downloadUrl: "data-download-url"
    },
    accountSelectors: {
      root: "#user-stats",
      usernameAttr: "data-username",
      uploaded: "[data-user-uploaded]",
      downloaded: "[data-user-downloaded]",
      ratio: "[data-user-ratio]",
      bonus: "[data-user-bonus]",
      seedingSize: "[data-user-seeding-size]"
    },
    requiredFields: ["rows", "title", "size", "freeLabel", "freeEnd"]
  }
];
