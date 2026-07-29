"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createFileStorage } = require("../src/storage");

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ptagent-store-")), "config.json");

test("读写往返，并且和 chrome.storage.local 的取值语义一致", async () => {
  const storage = createFileStorage(tempFile());
  await storage.set({ a: 1, b: { c: 2 } });
  assert.deepEqual(await storage.get("a"), { a: 1 });
  assert.deepEqual(await storage.get(["a", "b"]), { a: 1, b: { c: 2 } });
  // 缺失的键返回 undefined 而不是报错，调用方靠 ?? 兜底。
  assert.deepEqual(await storage.get("missing"), { missing: undefined });
});

test("set 是合并而不是整体替换", async () => {
  const storage = createFileStorage(tempFile());
  await storage.set({ a: 1 });
  await storage.set({ b: 2 });
  assert.deepEqual(await storage.get(["a", "b"]), { a: 1, b: 2 });
});

test("并发写入不会互相覆盖", async () => {
  const storage = createFileStorage(tempFile());
  // 读-改-写如果不串行，这 20 次并发写只会剩下最后一个键。
  await Promise.all(Array.from({ length: 20 }, (_, index) => storage.set({ [`k${index}`]: index })));
  const all = await storage.readAll();
  assert.equal(Object.keys(all).length, 20);
  assert.equal(all.k7, 7);
});

test("文件不存在时读出空对象，而不是抛错", async () => {
  const storage = createFileStorage(tempFile());
  assert.deepEqual(await storage.readAll(), {});
});

test("配置损坏时先备份再从空开始，用户还能捞回去", async () => {
  const file = tempFile();
  fs.writeFileSync(file, "{ 这不是 JSON");
  const storage = createFileStorage(file);
  await assert.rejects(() => storage.readAll(), /已备份为/);
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".broken-"));
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8"), /这不是 JSON/);
});

test("remove 只删指定键", async () => {
  const storage = createFileStorage(tempFile());
  await storage.set({ a: 1, b: 2 });
  await storage.remove("a");
  assert.deepEqual(await storage.readAll(), { b: 2 });
});

test("写入过程不留下半个文件", async () => {
  const file = tempFile();
  const storage = createFileStorage(file);
  await storage.set({ big: "x".repeat(200000) });
  // 先写临时文件再 rename，所以目录里不该残留 .tmp-*
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).big.length, 200000);
});
