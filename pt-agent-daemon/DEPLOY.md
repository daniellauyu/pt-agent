# 部署指南

守护进程要一直跑着才有意义——它靠定时扫描抢 Free，也靠定时检查在 Free 到期前清掉下载不完的任务。
所以本质上是选一台**常开的机器**（NAS、软路由、小主机、云服务器），装上去让它开机自启。

本文按「最快能跑起来」到「跑得住」的顺序写。

---

## 一、最快路径

```bash
cd pt-agent-daemon
./install.sh
```

脚本做六件事，全程不写任何密钥、不覆盖已有配置：

1. 检查 Node ≥ 20
2. 校验 `vendor/engines/`（决策逻辑的完整性）
3. 建数据目录（默认 `~/.ptagent`）
4. 没有 `.env` 就从 `.env.example` 生成一份
5. 装一个 `ptagent` 命令到 PATH 里
6. 跑一次 `ptagent doctor`

装完编辑 `.env` 填上密钥，再 `ptagent doctor` 到全绿，然后：

```bash
ptagent scan --dry-run     # 先空跑一轮，看它会挑什么
ptagent start              # 前台跑起来
```

**非交互安装**（脚本里调用）：

```bash
./install.sh --yes --home /volume1/docker/ptagent --bin-dir /usr/local/bin
```

| 参数 | 说明 |
|---|---|
| `--home <目录>` | 数据目录，配置和日志都在这里 |
| `--bin-dir <目录>` | `ptagent` 命令装到哪；默认挑一个 PATH 里可写的 |
| `--no-link` | 不装命令，只做初始化 |
| `--yes` | 不提问，全用默认值 |

---

## 二、装成后台服务

```bash
./scripts/service.sh install     # Linux 用 systemd，macOS 用 launchd
./scripts/service.sh status
./scripts/service.sh logs        # 跟踪日志
./scripts/service.sh restart     # 改完 .env 后用这个
./scripts/service.sh uninstall   # 只移除服务，不动数据目录
```

### Linux（systemd）

默认装成 **system 服务**：开机自启，需要 sudo。

```bash
./scripts/service.sh install
```

不想用 sudo 就装用户级：

```bash
./scripts/service.sh install --user
# 用户级服务默认只在登录后运行，要开机就跑：
sudo loginctl enable-linger $(whoami)
```

生成的 unit 有两个刻意的设定：

- `Restart=always` + `RestartSec=30` —— 站点或下载器暂时不通时进程本来就不会退出；
  真退出了隔 30 秒重来。不用更短的间隔，连不上通常是网络或对方服务的问题，猛重试没有意义。
- 日志写数据目录，journal 只留启动和崩溃信息。查运行细节用 `ptagent logs`，不是 `journalctl`。

### macOS（launchd）

```bash
./scripts/service.sh install
```

装的是 LaunchAgent，**登录后**自动运行。

Mac 睡眠时不会跑扫描，醒来后按原节奏继续。想要 24 小时不间断，还是部署到 NAS 或服务器上。

---

## 三、Docker

适合群晖等不方便直接装 Node 的环境。

```bash
cd pt-agent-daemon
mkdir -p data
cp .env.example data/.env
vi data/.env                                  # 填密钥

export PTAGENT_WEB_TOKEN=$(openssl rand -hex 16)
docker compose up -d
docker compose logs -f
```

WebUI：`http://127.0.0.1:7788/?token=<你刚才生成的 token>`

几个刻意的设定：

- **必须给 `PTAGENT_WEB_TOKEN`**，不给就启动失败。容器里 WebUI 得绑 `0.0.0.0` 才能从宿主机访问，
  而绑非回环地址时守护进程强制要求令牌——配置文件里有下载器密码和站点 API Key。
- 容器以非 root 运行、文件系统只读、`no-new-privileges`。
  这个进程能删下载器里的文件，没理由给它多余的权限。
- 端口映射写死 `127.0.0.1:7788`。要从局域网别的机器访问，改成 `7788:7788` 并确保令牌够强。

### 群晖

1. 把 `pt-agent-daemon/` 整个目录传到 `/volume1/docker/ptagent/`
2. SSH 上去，`cd /volume1/docker/ptagent && docker compose up -d`
3. 或者用「Container Manager → 项目 → 新增」，指向这个目录的 `docker-compose.yml`

**下载器地址填什么**：qBittorrent 也在这台群晖上时，填群晖的局域网 IP（如 `http://192.168.1.10:8080/`），
不要填 `127.0.0.1`——那是容器自己，不是宿主机。

---

## 四、搬到另一台机器

配置全部装在一个 `.env` 里，所以搬迁就是拷两样东西。

**在旧机器上导出：**

```bash
ptagent config export-env ptagent.env
```

**在新机器上：**

```bash
# 1. 拷贝整个 pt-agent-daemon 目录（决策引擎已内置在 vendor/，不需要插件源码）
# 2. 把 ptagent.env 放到数据目录
mkdir -p ~/.ptagent && cp ptagent.env ~/.ptagent/.env && chmod 600 ~/.ptagent/.env
# 3. 装
./install.sh --yes
ptagent doctor
```

`.env` 里有密码和 API Key，**用 scp/U 盘传，别走聊天软件或网盘**。

### 从浏览器插件搬过来

插件里：**设置 → 配置迁移 → 导出配置 JSON**，然后：

```bash
ptagent import pt-agent-config-xxx.json
ptagent doctor
ptagent config export-env ~/.ptagent/.env
```

---

## 五、跑起来之后

### 先观察再放手

新装的机器建议先关掉自动推送，跑两三轮看看它挑的东西合不合意：

```bash
ptagent config set autoDownload false   # 或在 .env 里设 PTAGENT_AUTO_DOWNLOAD=false
ptagent start
# 过几小时
ptagent resources --filter recommend
```

觉得没问题再打开。

### 日常查看

```bash
ptagent status                    # 下次扫描时间、上一轮结果
ptagent tasks                     # 下载器当前任务和保护状态
ptagent logs --level error -n 50  # 只看错误
ptagent audit -n 30               # 什么被加了、什么被删了
```

**`ptagent audit` 是排查「我的文件为什么没了」的正确入口**：
删文件只会出现在 `action: guard_delete` 且 `deleteFiles: true` 的记录里。

### 改配置

优先级：**进程环境变量 > `.env` 文件 > `config.json`**。

| 改哪里 | 什么时候生效 |
|---|---|
| systemd 的 `Environment=` / Docker 的 `-e` | 重启服务后，且压过 `.env` |
| `.env` | 重启服务后（`./scripts/service.sh restart`） |
| WebUI / `ptagent config set` | 立即，但**下次启动会被上面两者覆盖** |

被环境托管的项，`ptagent config set` 会当场警告。`ptagent doctor` 的「配置来源」一项
会告诉你当前有多少项来自 `.env` 或环境变量。要永久改，改 `.env` 或服务定义。

---

## 六、常见问题

**装不上：`Node vXX 太旧`**
需要 Node 20+。群晖的套件中心版本通常偏低，用 Docker 方案更省事。

**`doctor` 站点连通性失败**
- `key無效` —— API Key 填错了，或已在站点后台失效，重新生成
- `fetch failed` —— 这台机器上不了网，或被墙/被 DNS 污染

**`doctor` 下载器连通性失败**
下载器填的是内网地址时，这台机器必须和它在同一个网里。
配了多台的话，把内网地址放在 `PTAGENT_DOWNLOADER_1_*`、公网放 `_2_*`——
守护进程按顺序探测，连得上的第一台就用它。

**`qBittorrent 已封禁当前 IP`**
密码错误导致连续登录失败触发的。守护进程会自动退避 30 分钟不再重试
（继续撞只会把封禁窗口无限续期）。改对密码后到 qB 的
「设置 → Web UI → 封禁客户端」解封，或重启 qB。

**任务发出去了但下载器里没有**
`ptagent logs --prefix push:` 搜 `push:not-landed`。
常见原因是保存目录无效或种子被下载器拒绝。慢的 NAS 可以调大 `PTAGENT_VERIFY_ATTEMPTS`。

**WebUI 打不开**
默认只绑 `127.0.0.1`。要从别的机器访问：

```bash
ptagent config set webHost 0.0.0.0
ptagent config set webToken $(openssl rand -hex 16)
```

不设令牌直接绑非回环地址会被拒绝启动——配置文件里有密码和 API Key。

**服务起不来**
```bash
./scripts/service.sh status
journalctl -u ptagent -n 50        # Linux
cat ~/.ptagent/logs/launchd.err.log # macOS
```

---

## 七、卸载

```bash
./scripts/service.sh uninstall    # 移除服务
rm -f ~/.local/bin/ptagent        # 移除命令（路径以安装时输出为准）
rm -rf ~/.ptagent                 # 移除配置和日志（含密钥，确认后再删）
```

卸载不会动下载器里的任何任务和文件。
本工具添加的任务带 `ptagent` 标签，想一并清理可以在 qB 里按标签筛选。
