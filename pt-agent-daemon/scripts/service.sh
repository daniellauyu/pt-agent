#!/usr/bin/env bash
# 把守护进程装成后台服务：Linux 用 systemd，macOS 用 launchd。
#
#   ./scripts/service.sh install     安装并启动
#   ./scripts/service.sh status      看运行状态
#   ./scripts/service.sh logs        跟踪日志
#   ./scripts/service.sh restart     重启（改完 .env 后用）
#   ./scripts/service.sh stop
#   ./scripts/service.sh uninstall   停止并移除服务（不动数据目录）
#
# Linux 默认装成 system 服务（开机自启，需要 sudo）。
# 加 --user 装成用户级服务，不需要 sudo，但默认只在登录后运行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="ptagent"
LABEL="com.ptagent.daemon"
USER_MODE=0
DATA_HOME="${PTAGENT_HOME:-$HOME/.ptagent}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
if [ ! -t 1 ]; then RED=""; GREEN=""; YELLOW=""; DIM=""; BOLD=""; RESET=""; fi
ok()   { printf '%s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%s✘%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
hint() { printf '%s  %s%s\n' "$DIM" "$1" "$RESET"; }

ACTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    install|uninstall|start|stop|restart|status|logs) ACTION="$1"; shift ;;
    --user) USER_MODE=1; shift ;;
    --home) DATA_HOME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数 $1" ;;
  esac
done
[ -n "$ACTION" ] || { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "找不到 node"
ENTRY="$PROJECT_DIR/bin/ptagent.js"
[ -f "$ENTRY" ] || die "找不到 $ENTRY"

PLATFORM="$(uname -s)"

# ======================================================================= systemd
systemd_unit_path() {
  if [ "$USER_MODE" = "1" ]; then printf '%s' "$HOME/.config/systemd/user/$SERVICE_NAME.service";
  else printf '%s' "/etc/systemd/system/$SERVICE_NAME.service"; fi
}

systemctl_cmd() {
  if [ "$USER_MODE" = "1" ]; then systemctl --user "$@";
  elif [ "$(id -u)" = "0" ]; then systemctl "$@";
  else sudo systemctl "$@"; fi
}

systemd_install() {
  local unit; unit="$(systemd_unit_path)"
  local content
  content="$(cat <<EOF
[Unit]
Description=PT Agent 守护进程（定时扫描 Free 资源并只下载推荐项）
Documentation=file://$PROJECT_DIR/DEPLOY.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=PTAGENT_HOME=$DATA_HOME
ExecStart=$NODE_BIN $ENTRY start
# 站点或下载器暂时不通时进程不该退出；真退出了就等 30 秒重来，
# 不用更短的间隔——连不上通常是网络或对方服务的问题，猛重试没有意义。
Restart=always
RestartSec=30
# 日志本身写在数据目录里，journal 只留启动和崩溃信息。
StandardOutput=journal
StandardError=journal
$( [ "$USER_MODE" = "1" ] || printf 'User=%s\nGroup=%s\n' "$(id -un)" "$(id -gn)" )

[Install]
WantedBy=$( [ "$USER_MODE" = "1" ] && printf 'default.target' || printf 'multi-user.target' )
EOF
)"
  if [ "$USER_MODE" = "1" ]; then
    mkdir -p "$(dirname "$unit")"
    printf '%s\n' "$content" > "$unit"
  else
    printf '%s\n' "$content" | { [ "$(id -u)" = "0" ] && tee "$unit" >/dev/null || sudo tee "$unit" >/dev/null; }
  fi
  ok "已写入 $unit"

  systemctl_cmd daemon-reload
  systemctl_cmd enable "$SERVICE_NAME"
  systemctl_cmd restart "$SERVICE_NAME"
  ok "服务已启动"
  if [ "$USER_MODE" = "1" ]; then
    warn "用户级服务默认只在你登录后运行。要开机就跑：sudo loginctl enable-linger $(id -un)"
  fi
}

systemd_uninstall() {
  systemctl_cmd stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl_cmd disable "$SERVICE_NAME" 2>/dev/null || true
  local unit; unit="$(systemd_unit_path)"
  if [ "$USER_MODE" = "1" ]; then rm -f "$unit"; else
    { [ "$(id -u)" = "0" ] && rm -f "$unit" || sudo rm -f "$unit"; }
  fi
  systemctl_cmd daemon-reload
  ok "服务已移除。数据目录 $DATA_HOME 保持不动。"
}

# ======================================================================= launchd
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchd_install() {
  mkdir -p "$(dirname "$PLIST")" "$DATA_HOME/logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ENTRY</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PTAGENT_HOME</key><string>$DATA_HOME</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- 崩溃后至少隔 30 秒再拉起：连不上站点或下载器时猛重试没有意义 -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DATA_HOME/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DATA_HOME/logs/launchd.err.log</string>
</dict>
</plist>
EOF
  ok "已写入 $PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  ok "服务已启动（登录时自动运行）"
  hint "macOS 睡眠时不会跑扫描，醒来后按原节奏继续。要 24 小时不间断请部署到 NAS 或服务器。"
}

launchd_uninstall() {
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  ok "服务已移除。数据目录 $DATA_HOME 保持不动。"
}

# ======================================================================= 分发
case "$PLATFORM" in
  Linux)
    command -v systemctl >/dev/null 2>&1 || die "这台机器没有 systemd。参考 DEPLOY.md 里的 Docker 或 nohup 方案。"
    case "$ACTION" in
      install)   systemd_install ;;
      uninstall) systemd_uninstall ;;
      start)     systemctl_cmd start "$SERVICE_NAME" ;;
      stop)      systemctl_cmd stop "$SERVICE_NAME" ;;
      restart)   systemctl_cmd restart "$SERVICE_NAME" ;;
      status)    systemctl_cmd status "$SERVICE_NAME" --no-pager || true ;;
      logs)      if [ "$USER_MODE" = "1" ]; then journalctl --user -u "$SERVICE_NAME" -f; else journalctl -u "$SERVICE_NAME" -f; fi ;;
    esac
    ;;
  Darwin)
    case "$ACTION" in
      install)   launchd_install ;;
      uninstall) launchd_uninstall ;;
      start)     launchctl load -w "$PLIST" ;;
      stop)      launchctl unload "$PLIST" ;;
      restart)   launchctl unload "$PLIST" 2>/dev/null || true; launchctl load -w "$PLIST" ;;
      status)
        if launchctl list | grep -q "$LABEL"; then
          ok "服务在运行"
          launchctl list | grep "$LABEL"
        else
          warn "服务没有运行"
        fi
        ;;
      logs)
        # 守护进程自己的结构化日志比 launchd 的 stdout 有用得多。
        exec node "$ENTRY" logs -n 80
        ;;
    esac
    ;;
  *) die "暂不支持 ${PLATFORM}。参考 DEPLOY.md 里的 Docker 方案。" ;;
esac
