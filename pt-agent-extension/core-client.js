globalThis.PT_AGENT_CORE = (() => {
  const normalizeAddress = (value) => `${String(value || "").trim().replace(/\/+$/, "")}/`;

  const createClient = (settings, fetchImpl = globalThis.fetch.bind(globalThis)) => {
    const request = async (path, options = {}) => {
      const response = await fetchImpl(
        new URL(String(path).replace(/^\/+/, ""), normalizeAddress(settings.address)).toString(),
        {
          headers: {
            "Content-Type": "application/json",
            ...(settings.apiToken ? { "X-PT-Agent-Token": settings.apiToken } : {}),
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
          seedingCount: Number(
            account?.trackerSeedingCount ?? account?.seedingCount ?? qbSeedingSummary?.count ?? 0
          ),
          seedingSizeBytes: Number(
            account?.trackerSeedingSizeBytes ?? account?.seedingSizeBytes ?? qbSeedingSummary?.sizeBytes ?? 0
          )
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

    const novicePrediction = () => request("/api/account/novice-prediction");

    const evaluateTorrent = (torrentId) => request(`/api/torrents/${torrentId}/evaluate`, {
      method: "POST",
      body: "{}"
    });

    const evaluateTorrents = (torrentIds) => request("/api/torrents/evaluate-batch", {
      method: "POST",
      body: JSON.stringify({ torrent_ids: torrentIds })
    });

    const enqueueTorrent = async ({
      scan,
      torrent,
      downloadUrl,
      savePath = "",
      manualOverride = false
    }) => {
      try {
        await health();
      } catch (error) {
        const unavailable = new Error(error.message || String(error));
        unavailable.code = "CORE_UNAVAILABLE";
        unavailable.cause = error;
        throw unavailable;
      }
      const imported = await importTorrents({ scan, torrents: [torrent] });
      const torrentId = imported?.torrent_ids?.[0];
      if (!torrentId) throw new Error("PT Core 未返回资源 ID");
      const evaluation = await evaluateTorrent(torrentId);
      const automaticAllowed =
        evaluation.decision === "recommend" && Number(evaluation.score || 0) >= 80;
      const manualAllowed = manualOverride && evaluation.decision === "risk";
      if ((!manualOverride && !automaticAllowed) || (manualOverride && !manualAllowed)) {
        throw new Error(`Core 安全准入未通过：${(evaluation.reasons || []).join("；")}`);
      }
      const task = await request("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          torrent_id: torrentId,
          download_url: downloadUrl,
          save_path: savePath || null,
          admission_mode: manualOverride ? "manual_override" : "automatic"
        })
      });
      return { imported, evaluation, task };
    };

    const sync = async ({ scan, torrents, qbSeedingSummary, auditEvents }) => {
      const service = await health();
      const torrentResult = await importTorrents({ scan, torrents });
      const tasks = [importAudit(auditEvents)];
      if (scan?.account && Object.keys(scan.account).length) {
        tasks.push(createAccountSnapshot({
          account: scan.account,
          qbSeedingSummary,
          capturedAt: scan?.page?.scannedAt
        }));
      }
      const [auditResult, accountResult = null] = await Promise.all(tasks);
      const predictionResult = accountResult ? await novicePrediction() : null;
      const evaluationResult = torrentResult.torrent_ids?.length
        ? await evaluateTorrents(torrentResult.torrent_ids)
        : { items: [], total: 0 };
      return {
        service,
        torrentResult,
        auditResult,
        accountResult,
        predictionResult,
        evaluationResult
      };
    };

    return {
      createAccountSnapshot,
      enqueueTorrent,
      evaluateTorrent,
      evaluateTorrents,
      health,
      importAudit,
      importTorrents,
      novicePrediction,
      sync
    };
  };

  return { createClient, normalizeAddress };
})();
