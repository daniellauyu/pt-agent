#!/usr/bin/env bash
# PT Agent 守护进程安装脚本。
#
# 做的事：检查 Node 版本 → 校验决策引擎完整性 → 建数据目录 → 准备 .env
#         → 装一个 ptagent 命令 → 跑一次体检。
# 不做的事：不启动服务、不写任何密钥、不碰已有的 .env 和 config.json。
#
# 用法：
#   ./install.sh                     交互式安装
#   ./install.sh --home /vol1/ptagent --bin-dir /usr/local/bin
#   ./install.sh --yes               不提问，全用默认值
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PTAGENT_HOME_ARG=""
BIN_DIR=""
ASSUME_YES=0
SKIP_LINK=0

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
# 非交互终端（CI、管道）里不要输出颜色转义符，那会变成一堆乱码。
if [ ! -t 1 ]; then RED=""; GREEN=""; YELLOW=""; DIM=""; BOLD=""; RESET=""; fi

ok()   { printf '%s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%s✘%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }
hint() { printf '%s  %s%s\n' "$DIM" "$1" "$RESET"; }

usage() {
  cat <<'EOF'
用法：./install.sh [选项]

  --home <目录>      数据目录，默认 ~/.ptagent（也可用环境变量 PTAGENT_HOME）
  --bin-dir <目录>   把 ptagent 命令装到哪里，默认自动挑一个 PATH 里可写的目录
  --no-link          不安装 ptagent 命令，只做初始化
  --yes              不提问，全用默认值
  -h, --help         显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home)     PTAGENT_HOME_ARG="${2:-}"; shift 2 ;;
    --bin-dir)  BIN_DIR="${2:-}"; shift 2 ;;
    --no-link)  SKIP_LINK=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "未知参数 $1（--help 看用法）" ;;
  esac
done

ask() {
  # $1=提示 $2=默认值
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then printf '%s' "$2"; return; fi
  local answer
  read -r -p "$1 [$2]: " answer </dev/tty || answer=""
  printf '%s' "${answer:-$2}"
}

# ---------------------------------------------------------------- Node
step "1/6 检查 Node.js"
command -v node >/dev/null 2>&1 || die "没有找到 node。需要 Node.js 20 或更高：https://nodejs.org/"
NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $NODE_VERSION 太旧。守护进程用到了 fetch、Blob、AbortSignal.timeout，需要 20 或更高。"
fi
ok "Node $NODE_VERSION"

# ---------------------------------------------------------------- 决策引擎
step "2/6 校验决策引擎"
# vendor/engines 是插件源文件的副本，缺了或被改过都会让判定规则和插件对不上。
if node "$SCRIPT_DIR/scripts/sync-engines.js" --check; then
  :
else
  die "决策引擎校验未通过。完整仓库里执行 npm run sync-engines 重新同步。"
fi

# ---------------------------------------------------------------- 数据目录
step "3/6 准备数据目录"
DEFAULT_HOME="${PTAGENT_HOME:-$HOME/.ptagent}"
if [ -n "$PTAGENT_HOME_ARG" ]; then
  DATA_HOME="$PTAGENT_HOME_ARG"
else
  DATA_HOME="$(ask "数据目录（配置、日志都放这里）" "$DEFAULT_HOME")"
fi
# 展开开头的 ~
case "$DATA_HOME" in "~"|"~/"*) DATA_HOME="$HOME${DATA_HOME#\~}" ;; esac
mkdir -p "$DATA_HOME/logs"
chmod 700 "$DATA_HOME" 2>/dev/null || true
ok "数据目录 $DATA_HOME"

# ---------------------------------------------------------------- .env
step "4/6 准备配置文件"
ENV_FILE="$DATA_HOME/.env"
if [ -f "$ENV_FILE" ]; then
  ok "已有配置 ${ENV_FILE}，保持不动"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  # 项目目录下已经有一份（比如从另一台机器拷过来的），直接用它，不覆盖。
  ok "使用项目目录下的 $SCRIPT_DIR/.env"
  ENV_FILE="$SCRIPT_DIR/.env"
else
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  warn "已从模板生成 ${ENV_FILE}，里面的密钥还是空的"
  hint "接下来要填：PTAGENT_SITE_API_KEY、PTAGENT_DOWNLOADER_1_ADDRESS / USERNAME / PASSWORD"
fi

# ---------------------------------------------------------------- ptagent 命令
step "5/6 安装 ptagent 命令"
if [ "$SKIP_LINK" = "1" ]; then
  hint "已跳过（--no-link）。直接用：node $SCRIPT_DIR/bin/ptagent.js <命令>"
else
  if [ -z "$BIN_DIR" ]; then
    # 优先挑不需要 sudo 的目录。
    for candidate in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
      if [ -d "$candidate" ] && [ -w "$candidate" ]; then BIN_DIR="$candidate"; break; fi
    done
    [ -z "$BIN_DIR" ] && BIN_DIR="$HOME/.local/bin"
  fi
  mkdir -p "$BIN_DIR"
  TARGET="$BIN_DIR/ptagent"
  # 用 wrapper 而不是软链或 npm link：软链在某些系统上会让 __dirname 指向链接位置，
  # wrapper 里写死绝对路径最稳，也不需要 npm。
  cat > "$TARGET" <<EOF
#!/usr/bin/env bash
# 由 pt-agent-daemon/install.sh 生成
exec node "$SCRIPT_DIR/bin/ptagent.js" "\$@"
EOF
  chmod +x "$TARGET"
  ok "已安装 $TARGET"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR 不在 PATH 里，ptagent 命令暂时用不了"
       hint "加进 shell 配置：export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
fi

# ---------------------------------------------------------------- 体检
step "6/6 体检"
export PTAGENT_HOME="$DATA_HOME"
set +e
node "$SCRIPT_DIR/bin/ptagent.js" doctor
DOCTOR_STATUS=$?
set -e

printf '\n%s安装完成。%s\n' "$BOLD" "$RESET"
if [ "$DOCTOR_STATUS" != "0" ]; then
  cat <<EOF

上面标 ✘ 的就是没过的项。常见两类：

  配置还没填 —— 编辑 ${ENV_FILE}，至少要有：
    PTAGENT_SITE_API_KEY              M-Team 控制台 → 实验室 → 存取令牌
    PTAGENT_DOWNLOADER_1_ADDRESS      下载器地址，如 http://192.168.1.10:8080/
    PTAGENT_DOWNLOADER_1_USERNAME
    PTAGENT_DOWNLOADER_1_PASSWORD

  连不上 —— 配置没问题但网络不通。确认这台机器能访问站点和下载器；
    下载器填内网地址时，这台机器必须和它在同一个网里。

改完再跑一次：
  ptagent doctor
EOF
fi

cat <<EOF

常用命令：
  ptagent doctor              体检
  ptagent scan --dry-run      空跑一轮，只评估不下载
  ptagent start               前台启动守护进程
  ./scripts/service.sh install    装成开机自启的后台服务

数据目录：$DATA_HOME
EOF
