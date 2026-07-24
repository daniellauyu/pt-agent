const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionDir = __dirname;
const definitionsSource = fs.readFileSync(path.join(extensionDir, "site-definitions.js"), "utf8");
const parserSource = fs.readFileSync(path.join(extensionDir, "content-parser.js"), "utf8");

class FakeNode {
  constructor({ textContent = "", attributes = {}, selectors = {}, dataset = {} } = {}) {
    this.textContent = textContent;
    this.attributes = attributes;
    this.selectors = selectors;
    this.dataset = dataset;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  querySelector(selector) {
    return this.selectors[selector] || null;
  }

  querySelectorAll(selector) {
    const value = this.selectors[selector];
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }
}

const runParser = ({ definitionId, hostname, href, row }) => {
  const document = new FakeNode();
  document.title = "Fixture";

  const context = vm.createContext({
    URL,
    document,
    location: { hostname, href, protocol: "https:" }
  });

  vm.runInContext(definitionsSource, context);
  const definition = context.PT_AGENT_SITE_DEFINITIONS.find(({ id }) => id === definitionId);
  document.selectors[definition.selectors.rows] = [row];

  return vm.runInContext(parserSource, context);
};

test("parses M-Team promotion deadline from the title attribute", () => {
  const definitionsContext = vm.createContext({});
  vm.runInContext(definitionsSource, definitionsContext);
  const selectors = definitionsContext.PT_AGENT_SITE_DEFINITIONS.find(({ id }) => id === "mteam").selectors;

  const title = new FakeNode({
    textContent: "Click 2006 BluRay 2160p HDR x265 Atmos TrueHD 7.1-MTeam",
    attributes: { href: "/detail/1213980" }
  });
  const promotion = new FakeNode({
    textContent: "Free 23h 53min",
    attributes: {
      title: "促銷, 截止日期：2026-07-24 23:32:27",
      class: "ant-tag ant-tag-solid"
    }
  });
  const row = new FakeNode({
    dataset: {},
    selectors: {
      [selectors.title]: title,
      [selectors.detailUrl]: title,
      [selectors.size]: new FakeNode({ textContent: "31.84\nGB" }),
      [selectors.freeLabel]: promotion,
      [selectors.freeEnd]: promotion,
      [selectors.freeLeft]: promotion,
      [selectors.seeders]: new FakeNode({ textContent: "1" }),
      [selectors.leechers]: new FakeNode({ textContent: "258" })
    }
  });

  const result = runParser({
    definitionId: "mteam",
    hostname: "m-team.cc",
    href: "https://m-team.cc/browse",
    row
  });

  assert.equal(result.torrents[0].freeType, "free");
  assert.equal(result.torrents[0].freeEndAt, "2026-07-24 23:32:27");
  assert.equal(result.torrents[0].torrentId, "1213980");
  assert.match(result.torrents[0].freeLeftText, /23h 53min/);
  assert.equal(result.site.fields.freeLabel, true);
  assert.equal(result.site.fields.freeEnd, true);
  assert.equal(result.site.usable, true);
});

test("keeps supporting data-free-end and canonicalizes 2xFree", () => {
  const definitionsContext = vm.createContext({});
  vm.runInContext(definitionsSource, definitionsContext);
  const definition = definitionsContext.PT_AGENT_SITE_DEFINITIONS.find(({ id }) => id === "mock-mteam");
  const selectors = definition.selectors;
  const promotion = new FakeNode({ textContent: "2xFree 43h 06m" });
  const end = new FakeNode({ attributes: { "data-free-end": "2026-07-25T10:00:00+08:00" } });
  const row = new FakeNode({
    attributes: {
      "data-title": "Legacy fixture",
      "data-size-bytes": "1024",
      "data-free-type": "2xfree",
      "data-free-end": "2026-07-25T10:00:00+08:00"
    },
    dataset: {},
    selectors: {
      [selectors.freeLabel]: promotion,
      [selectors.freeEnd]: end
    }
  });

  const result = runParser({
    definitionId: "mock-mteam",
    hostname: "localhost",
    href: "https://localhost/mock-pt-site.html",
    row
  });

  assert.equal(result.torrents[0].freeType, "2xfree");
  assert.equal(result.torrents[0].freeEndAt, "2026-07-25T10:00:00+08:00");
});
