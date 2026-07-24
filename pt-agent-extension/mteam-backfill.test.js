const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "mteam-backfill.js"), "utf8");
const context = vm.createContext({ globalThis: null });
context.globalThis = context;
vm.runInContext(source, context);
const core = context.PT_AGENT_MTEAM_BACKFILL;

test("builds M-Team search keywords from a dotted qBittorrent task name", () => {
  const keywords = Array.from(core.keywordCandidates(
    "Click.2006.BluRay.2160p.HDR.x265.Atmos.TrueHD.7.1-MTeam"
  ));
  assert.equal(keywords[0], "Click 2006 BluRay 2160p HDR x265 Atmos TrueHD 7 1-MTeam");
  assert.ok(keywords.includes("Click 2006 BluRay 2160p HDR"));
});

test("requires exact byte size when matching a historical task", () => {
  const task = {
    name: "Click.2006.BluRay.2160p.HDR.x265.Atmos.TrueHD.7.1-MTeam",
    size: 34193839470
  };
  const rows = [
    {
      id: "1213981",
      name: "Click 2006 BluRay 1080p x265 Atmos TrueHD 7.1-MTeam",
      size: "10990572733"
    },
    {
      id: "1213980",
      name: "Click 2006 BluRay 2160p HDR x265 Atmos TrueHD 7.1-MTeam",
      size: "34193839470"
    }
  ];
  assert.equal(core.findExactMatch(task, rows).id, "1213980");
});

test("returns a deadline only for a Free promotion", () => {
  assert.equal(core.freeDeadline({
    status: {
      discount: "FREE",
      discountEndTime: "2026-07-24 23:32:27"
    }
  }), "2026-07-24 23:32:27");
  assert.equal(core.freeDeadline({
    status: {
      discount: "PERCENT_50",
      discountEndTime: null
    }
  }), "");
});

test("searches adult mode first for coded adult releases", () => {
  assert.deepEqual(Array.from(core.searchModes("SONE-788.2026.1080p")), ["adult", "normal"]);
  assert.deepEqual(Array.from(core.searchModes("Click.2006.BluRay")), ["normal", "adult"]);
});
