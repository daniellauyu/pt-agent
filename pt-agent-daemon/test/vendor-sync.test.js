"use strict";

// vendor/engines 是插件源文件的副本。有两份副本，最大的风险不是它们不同步，
// 而是不同步了却没人发现——插件那边改了评分权重，终端版还按老规则跑。
// 这组测试就是那个「会发现」的机制。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { MODULES, VENDOR_DIR, SOURCE_DIR, MANIFEST_PATH, check, sha256 } = require("../scripts/sync-engines");
const { load, provenance, SHARED_MODULES } = require("../src/engines");

test("vendor 副本齐全且带有 MANIFEST", () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), "缺少 MANIFEST.json，跑 npm run sync-engines");
  for (const name of MODULES) {
    assert.ok(fs.existsSync(path.join(VENDOR_DIR, name)), `vendor 里缺少 ${name}`);
  }
});

test("vendor 副本没有被手工改动过", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  for (const name of MODULES) {
    const actual = sha256(fs.readFileSync(path.join(VENDOR_DIR, name)));
    assert.equal(actual, manifest.files[name], `${name} 与 MANIFEST 记录的哈希不符——vendor 目录不该手改`);
  }
});

test("vendor 副本与插件源文件逐字节一致", { skip: !fs.existsSync(SOURCE_DIR) && "当前是单独发布的副本，没有插件源码可比对" }, () => {
  for (const name of MODULES) {
    const vendored = fs.readFileSync(path.join(VENDOR_DIR, name));
    const source = fs.readFileSync(path.join(SOURCE_DIR, name));
    assert.equal(
      sha256(vendored),
      sha256(source),
      `${name} 落后于插件源文件。改判定规则要改插件那边，然后跑 npm run sync-engines`
    );
  }
});

test("check() 在一切正常时通过", () => {
  const result = check();
  assert.equal(result.ok, true, result.problems.join("；"));
});

test("engines.js 的加载清单和同步脚本的清单一致", () => {
  // 两边任一处漏加模块，运行时才会以 undefined 的形式炸出来，这里提前挡住。
  assert.deepEqual(SHARED_MODULES, MODULES);
});

test("12 个引擎都能在 Node 里加载出来", () => {
  const engines = load();
  for (const [name, value] of Object.entries(engines)) {
    assert.ok(value, `引擎 ${name} 没有被加载`);
  }
  // 抽查几个真正会被调用的入口，光有对象不够。
  assert.equal(typeof engines.decision.evaluateTorrent, "function");
  assert.equal(typeof engines.admission.evaluate, "function");
  assert.equal(typeof engines.guard.evaluate, "function");
  assert.equal(typeof engines.qb.createClient, "function");
  assert.equal(typeof engines.downloaderTypes.createAdapter, "function");
});

test("能报出决策逻辑的来源版本，便于确认跑的是哪一版", () => {
  const info = provenance();
  assert.equal(info.source, "pt-agent-extension");
  assert.equal(info.moduleCount, MODULES.length);
  assert.ok(Date.parse(info.syncedAt), "syncedAt 不是合法时间");
});

test("守护进程的源码不再直接引用插件目录", () => {
  // 引用一旦漏网，单独发布出去的副本会在运行时才炸。
  const roots = [path.join(__dirname, "..", "src"), path.join(__dirname, "..", "bin")];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes("pt-agent-extension")) {
        offenders.push(path.relative(path.join(__dirname, ".."), full));
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], "这些文件仍然引用插件目录，单独发布会跑不起来");
});
