"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/**
 * 一个和 chrome.storage.local 接口兼容的 JSON 文件存储。
 *
 * 这样做的目的很实际：插件里的 downloader-store / site-store / exclusion-store
 * 都把存储区当参数注入，只要这里的 get/set 语义一致，那几个模块就能原样复用，
 * 不必为终端版再写一套配置读写（也就不会出现两边逻辑慢慢跑偏）。
 */
const createFileStorage = (filePath) => {
  let queue = Promise.resolve();

  const readAll = async () => {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      // 配置文件损坏时不要静默重置：备份一份再从空开始，用户还能捞回来。
      if (error instanceof SyntaxError) {
        const backup = `${filePath}.broken-${Date.now()}`;
        const moved = await fsp.rename(filePath, backup).then(() => true, () => false);
        if (moved) await fsp.chmod(backup, 0o600).catch(() => {});
        const notice = new Error(`配置文件解析失败，已备份为 ${backup}`);
        notice.code = "PTAGENT_CONFIG_CORRUPT";
        throw notice;
      }
      throw error;
    }
  };

  const writeAll = async (data) => {
    const directory = path.dirname(filePath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700);
    const temporary = `${filePath}.tmp-${process.pid}`;
    await fsp.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    // 先写临时文件再重命名：进程在写到一半被杀掉也不会留下半个配置。
    await fsp.rename(temporary, filePath);
    await fsp.chmod(filePath, 0o600);
  };

  // 读-改-写必须串行，否则 WebUI 保存和后台扫描并发写入会互相覆盖。
  const serialize = (task) => {
    const next = queue.then(task, task);
    queue = next.then(() => {}, () => {});
    return next;
  };

  const get = async (keys) => {
    const data = await serialize(readAll);
    if (keys === null || keys === undefined) return data;
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.map((key) => [key, data[key]]));
  };

  const set = async (values) => serialize(async () => {
    const data = await readAll();
    await writeAll({ ...data, ...values });
  });

  const remove = async (keys) => serialize(async () => {
    const data = await readAll();
    for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    await writeAll(data);
  });

  return { get, set, remove, filePath, readAll: () => serialize(readAll) };
};

const existsSync = (filePath) => fs.existsSync(filePath);

module.exports = { createFileStorage, existsSync };
