"use strict";

// 部署脚本出错的代价比代码高：装到一半失败、把已有配置覆盖掉、或者把密钥暴露出去，
// 都不是重跑一次就能收拾的。这组测试锁住几条最要紧的性质。
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

const bashCheck = (name) => {
  execFileSync("bash", ["-n", path.join(ROOT, name)], { stdio: "pipe" });
};

test("shell 脚本语法正确且可执行", () => {
  for (const name of ["install.sh", "scripts/service.sh"]) {
    bashCheck(name);
    const mode = fs.statSync(path.join(ROOT, name)).mode;
    assert.ok(mode & 0o111, `${name} 没有可执行权限`);
  }
});

test("脚本开启了严格模式，出错就停而不是带着半截状态往下走", () => {
  for (const name of ["install.sh", "scripts/service.sh"]) {
    assert.match(read(name), /set -euo pipefail/, `${name} 缺少 set -euo pipefail`);
  }
});

test("install.sh 不覆盖已有的 .env", () => {
  const text = read("install.sh");
  // 只有在目标不存在时才从模板拷贝，否则会把用户填好的密钥冲掉。
  assert.match(text, /if \[ -f "\$ENV_FILE" \][\s\S]*?保持不动/);
  const copyLine = text.slice(text.indexOf('cp "$SCRIPT_DIR/.env.example"'));
  assert.ok(copyLine.length > 0, "找不到从模板拷贝的那一步");
});

test("install.sh 生成的 .env 权限是 600", () => {
  assert.match(read("install.sh"), /chmod 600 "\$ENV_FILE"/);
});

test("install.sh 拒绝低于 20 的 Node", () => {
  assert.match(read("install.sh"), /NODE_MAJOR" -lt 20/);
});

test("install.sh 在装之前先校验决策引擎", () => {
  const text = read("install.sh");
  const engineStep = text.indexOf("sync-engines.js");
  const doctorStep = text.indexOf("bin/ptagent.js\" doctor");
  assert.ok(engineStep > 0 && engineStep < doctorStep, "引擎校验要排在体检之前");
});

test("service.sh 的卸载只动服务，不碰数据目录", () => {
  const text = read("scripts/service.sh");
  // rm 只能出现在删 unit / plist 上；误删数据目录是不可逆的。
  const removals = text.match(/rm -[rf]+ [^\n]*/g) || [];
  removals.forEach((line) => {
    assert.doesNotMatch(line, /DATA_HOME/, `卸载不该删数据目录：${line}`);
    assert.ok(/unit|PLIST|\$TARGET/.test(line), `意料之外的删除操作：${line}`);
  });
  assert.match(text, /数据目录 \$DATA_HOME 保持不动/);
});

test("systemd 单元用固定重试间隔，不做无意义的猛重试", () => {
  const text = read("scripts/service.sh");
  assert.match(text, /Restart=always/);
  const seconds = Number(text.match(/RestartSec=(\d+)/)?.[1]);
  assert.ok(seconds >= 15, `RestartSec=${seconds} 太短：连不上通常是网络问题，重试再快也没用`);
});

test("服务以当前用户身份运行，不是 root", () => {
  const text = read("scripts/service.sh");
  assert.match(text, /User=%s/, "system 级服务必须显式指定 User");
  assert.doesNotMatch(text, /User=root/);
});

test("Dockerfile 用非 root 运行并带上 vendor 目录", () => {
  const text = read("Dockerfile");
  assert.match(text, /^USER node$/m, "这个进程能删文件，没理由用 root 跑");
  assert.match(text, /COPY .*vendor\//, "漏掉 vendor 的话镜像里没有决策引擎");
  const userLine = text.indexOf("\nUSER node");
  const copyLines = [...text.matchAll(/^COPY /gm)].map((match) => match.index);
  copyLines.forEach((index) => assert.ok(index < userLine, "COPY 要排在 USER 之前"));
});

test("compose 强制要求 WebUI 令牌", () => {
  const text = read("docker-compose.yml");
  // 容器里 WebUI 必须绑 0.0.0.0，没有令牌等于把密码和 API Key 挂到网上。
  assert.match(text, /PTAGENT_WEB_TOKEN: "\$\{PTAGENT_WEB_TOKEN:\?/);
  assert.match(text, /127\.0\.0\.1:7788:7788/, "默认端口映射要限制在本机");
});

test(".env.example 是模板，不含任何真实密钥", () => {
  const text = read(".env.example");
  for (const key of ["PTAGENT_SITE_API_KEY", "PTAGENT_DOWNLOADER_1_PASSWORD", "PTAGENT_WEB_TOKEN"]) {
    assert.match(text, new RegExp(`^${key}=\\s*$`, "m"), `${key} 在模板里必须留空`);
  }
  // 模板要覆盖全部可配置项，否则用户根本不知道有这些开关。
  for (const key of ["PTAGENT_SCAN_MIN_MINUTES", "PTAGENT_AUTO_DELETE_EXPIRED", "PTAGENT_MIN_SCORE", "PTAGENT_HOME"]) {
    assert.match(text, new RegExp(`^${key}=`, "m"), `模板缺少 ${key}`);
  }
});

test("真实的 .env 绝不会被打包发布", () => {
  const files = JSON.parse(read("package.json")).files;
  assert.ok(files.includes(".env.example"));
  assert.ok(!files.includes(".env"), "打包清单里不能出现 .env");
  const ignored = fs.readFileSync(path.join(ROOT, "..", ".gitignore"), "utf8");
  assert.match(ignored, /pt-agent-daemon\/\.env$/m);
});

test("发布清单带齐了部署所需的一切", () => {
  const files = JSON.parse(read("package.json")).files;
  ["bin/", "src/", "vendor/", "scripts/", "install.sh", "DEPLOY.md"]
    .forEach((entry) => assert.ok(files.includes(entry), `发布清单缺少 ${entry}`));
});

test("install.sh 在隔离目录里能跑通", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ptagent-install-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  try {
    // doctor 会因为连不上站点/下载器而返回非 0，这里只关心脚本本身没崩。
    const output = execFileSync("bash", [
      path.join(ROOT, "install.sh"), "--yes", "--home", path.join(home, "data"), "--bin-dir", bin
    ], { encoding: "utf8", stdio: "pipe" });
    assert.match(output, /安装完成/);
    assert.ok(fs.existsSync(path.join(home, "data", "logs")), "没有建出日志目录");
    const wrapper = path.join(bin, "ptagent");
    assert.ok(fs.existsSync(wrapper), "没有装出 ptagent 命令");
    assert.match(fs.readFileSync(wrapper, "utf8"), /bin\/ptagent\.js/);
    assert.ok(fs.statSync(wrapper).mode & 0o111, "ptagent 命令没有可执行权限");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
