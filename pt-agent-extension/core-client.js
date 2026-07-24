globalThis.PT_AGENT_CORE = (() => {
  const normalizeAddress = (value) => `${String(value || "").trim().replace(/\/+$/, "")}/`;

  const createClient = (settings, fetchImpl = globalThis.fetch.bind(globalThis)) => {
    const request = async (path, options = {}) => {
      const response = await fetchImpl(
        new URL(String(path).replace(/^\/+/, ""), normalizeAddress(settings.address)).toString(),
        {
          headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
          },
          ...options
        }
      );
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`PT Core 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
      }
      return response.json();
    };

    const health = () => request("/health");

    const importTorrents = ({ scan, torrents }) => request("/api/torrents/import", {
      method: "POST",
      body: JSON.stringify({
        site_code: scan?.site?.siteId || torrents?.[0]?.site || "mteam",
        site_name: scan?.site?.siteName || "M-Team",
        base_url: scan?.page?.url || "",
        page: scan?.page || null,
        site: scan?.site || null,
        torrents: torrents || []
      })
    });

    const createAccountSnapshot = ({ account, qbSeedingSummary, capturedAt }) => {
      return request("/api/account/snapshots", {
        method: "POST",
        body: JSON.stringify({
          site_code: "mteam",
          site_name: "M-Team",
          captured_at: capturedAt || new Date().toISOString(),
          createdDate: account?.createdDate || null,
          uploadedBytes: Number(account?.uploadedBytes || 0),
          downloadedBytes: Number(account?.downloadedBytes || 0),
          ratio: Number.isFinite(Number(account?.ratio)) ? Number(account.ratio) : null,
          bonus: Number(account?.bonus || 0),
          bonusPerHour: Number(account?.bonusPerHour || 0),
          seedingCount: Number(qbSeedingSummary?.count ?? account?.seedingCount ?? 0),
          seedingSizeBytes: Number(qbSeedingSummary?.sizeBytes ?? account?.seedingSizeBytes ?? 0)
        })
      });
    };

    const importAudit = (events) => request("/api/audit/import", {
      method: "POST",
      body: JSON.stringify({
        source: "chrome-extension",
        events: events || []
      })
    });

    const sync = async ({ scan, torrents, qbSeedingSummary, auditEvents }) => {
      const service = await health();
      const tasks = [
        importTorrents({ scan, torrents }),
        importAudit(auditEvents)
      ];
      if (scan?.account && Object.keys(scan.account).length) {
        tasks.push(createAccountSnapshot({
          account: scan.account,
          qbSeedingSummary,
          capturedAt: scan?.page?.scannedAt
        }));
      }
      const [torrentResult, auditResult, accountResult = null] = await Promise.all(tasks);
      return { service, torrentResult, auditResult, accountResult };
    };

    return {
      createAccountSnapshot,
      health,
      importAudit,
      importTorrents,
      sync
    };
  };

  return { createClient, normalizeAddress };
})();
