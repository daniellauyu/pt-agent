// 统一下载器适配层。上层（popup / background）只依赖这里定义的接口，不再直接调用 qb-client。
//
// 适配器接口：
//   probe({ timeoutMs })            -> { ok, status?, latencyMs, error? }   仅可达性，不登录
//   login()                         -> true | throw
//   getVersion()                    -> string
//   diagnose()                      -> { ok, failedStage?, stages[], version? }
//   listTorrents(filter)            -> NormalizedTask[]
//   addTorrent({ url, file, filename, tag })  -> { success_count }
//   addTags(hashes, tags)           -> true
//   deleteTorrents(hashes, files)   -> true
//   ensureCategory(category, path)  -> boolean
//
// NormalizedTask 采用 qBittorrent 的字段命名作为规范形状，其它下载器实现时需转换成同一形状：
//   { hash, name, size, total_size, progress, state, dlspeed, tags, tracker, amount_left }
globalThis.PT_AGENT_DOWNLOADER_TYPES = (() => {
  "use strict";

  const qbittorrent = {
    id: "qbittorrent",
    name: "qBittorrent",
    implemented: true,
    defaultAddress: "http://127.0.0.1:8080/",
    // Free Guard 依赖标签保存 Free 截止时间，分类用于隔离插件任务。
    capabilities: { tags: true, categories: true, torrentFileUpload: true },
    create: (config, { fetchImpl, onLog } = {}) => {
      const client = globalThis.PT_AGENT_QB.createClient(
        {
          address: config.address,
          username: config.username,
          password: config.password
        },
        fetchImpl,
        onLog
      );
      const category = config.category || "PT_AGENT";
      const savePath = config.savePath || "";
      return {
        type: "qbittorrent",
        capabilities: qbittorrent.capabilities,
        probe: (options) => client.probe(options),
        login: () => client.login(),
        getVersion: () => client.getVersion(),
        diagnose: () => client.diagnose(),
        listTorrents: (filter) => client.listTorrents(filter),
        addTags: (hashes, tags) => client.addTags(hashes, tags),
        deleteTorrents: (hashes, deleteFiles) => client.deleteTorrents(hashes, deleteFiles),
        ensureCategory: (name = category, path = savePath) => client.ensureCategory(name, path),
        addTorrent: (payload = {}) => client.addTorrent({
          savePath,
          category,
          ...payload
        })
      };
    }
  };

  // 预留位：数据结构和设置界面已经按多类型设计，实现补齐后把 implemented 打开即可。
  // Transmission 用 label 而非 category，Deluge 的 label 依赖插件，接入时需在 create 里补转换。
  const planned = (id, name, defaultAddress, capabilities) => ({
    id,
    name,
    implemented: false,
    defaultAddress,
    capabilities,
    create: () => {
      throw new Error(`${name} 适配器尚未实现，目前只能使用 qBittorrent`);
    }
  });

  const TYPES = {
    qbittorrent,
    transmission: planned("transmission", "Transmission", "http://127.0.0.1:9091/", {
      tags: true,
      categories: false,
      torrentFileUpload: true
    }),
    deluge: planned("deluge", "Deluge", "http://127.0.0.1:8112/", {
      tags: true,
      categories: false,
      torrentFileUpload: true
    })
  };

  const get = (type) => TYPES[String(type || "")] || null;

  const list = () => Object.values(TYPES).map(({ id, name, implemented, defaultAddress, capabilities }) => ({
    id,
    name,
    implemented,
    defaultAddress,
    capabilities
  }));

  const implementedIds = () => list().filter((type) => type.implemented).map((type) => type.id);

  const createAdapter = (config = {}, options = {}) => {
    const type = get(config.type) || TYPES.qbittorrent;
    if (!type.implemented) {
      throw new Error(`${type.name} 适配器尚未实现，目前只能使用 qBittorrent`);
    }
    if (!config.address) throw new Error("下载器地址为空");
    return type.create(config, options);
  };

  return { TYPES, get, list, implementedIds, createAdapter };
})();
