#!/bin/bash
# BewlyCat Safari 扩展的无人值守重建脚本。
#
# 由 launchd 定时调用，也可手动执行：
#   ./scripts/rebuild-safari.sh          # 有新提交才重建
#   ./scripts/rebuild-safari.sh --force  # 无条件重建
#
# 退出码：0 成功或无需重建；非 0 表示失败（launchd 会把输出写进日志）。

set -euo pipefail

BRANCH="refactor/safari-only"
REPO_URL="https://github.com/HopeKira/BewlyCat-Safari.git"
REPO="$HOME/Library/Application Support/BewlyCat-Safari"
APP="/Applications/BewlyCat.app"
APPEX="$APP/Contents/PlugIns/BewlyCat Extension.appex"
TEAM="S89Z4QW6TN"
CACHE="$HOME/Library/Caches/BewlyCat-Safari"
LSREG="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"

FORCE=0
for arg in "$@"; do
  [ "$arg" = "--force" ] && FORCE=1
done

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() {
  log "错误: $*"
  osascript -e "display notification \"$*\" with title \"BewlyCat 重建失败\"" >/dev/null 2>&1 || true
  exit 1
}

# launchd 的环境极简，必须自己找 pnpm
NODE_BIN=""
while IFS= read -r d; do
  [ -x "$d/pnpm" ] && { NODE_BIN="$d"; break; }
done < <(ls -d "$HOME"/.workbuddy/binaries/node/versions/*/bin 2>/dev/null | sort -Vr)
if [ -z "$NODE_BIN" ]; then
  for d in /opt/homebrew/bin /usr/local/bin; do
    [ -x "$d/pnpm" ] && { NODE_BIN="$d"; break; }
  done
fi
[ -n "$NODE_BIN" ] || die "找不到 pnpm"
export PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"

log "启动，pnpm = $NODE_BIN/pnpm"

# 首次运行自动克隆
if [ ! -d "$REPO/.git" ]; then
  log "首次运行，克隆到 $REPO"
  mkdir -p "$(dirname "$REPO")"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$REPO" || die "克隆失败"
fi

cd "$REPO"
git fetch --quiet origin "$BRANCH" || die "拉取失败"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" -eq 0 ] && [ -d "$APP" ]; then
  log "无更新（${LOCAL:0:8}），跳过"
  exit 0
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  log "更新 ${LOCAL:0:8} → ${REMOTE:0:8}"
  git merge --ff-only "origin/$BRANCH" || die "无法快进合并（本地可能有未提交改动）"
fi

log "安装依赖"
# lockfile 与 package.json 不同步时（上游改依赖），退回常规安装
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || die "依赖安装失败"

log "构建"
pnpm build >/dev/null 2>&1 || die "构建失败"

# 转换器会复用已存在的目录，不清理就会把旧资源打包进去
rm -rf extension-safari-macos

log "生成 Xcode 工程"
xcrun safari-web-extension-converter ./extension-safari \
  --project-location ./extension-safari-macos \
  --macos-only --no-prompt --no-open --copy-resources >/dev/null 2>&1 \
  || die "转换失败"

log "签名构建"
if ! xcodebuild -project extension-safari-macos/BewlyCat/BewlyCat.xcodeproj \
  -scheme BewlyCat -configuration Release \
  -derivedDataPath extension-safari-macos/build \
  -destination 'platform=macOS' \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Apple Development" \
  -allowProvisioningUpdates >"/tmp/bewlycat-xcodebuild.log" 2>&1; then
  tail -n 20 /tmp/bewlycat-xcodebuild.log
  die "xcodebuild 失败（详见 /tmp/bewlycat-xcodebuild.log）"
fi

NEW_APP="extension-safari-macos/build/Build/Products/Release/BewlyCat.app"
[ -d "$NEW_APP" ] || die "未找到构建产物"
codesign --verify --deep --strict "$NEW_APP" || die "签名校验失败"

log "安装到 /Applications"
mkdir -p "$CACHE"
pkill -x BewlyCat 2>/dev/null || true
if [ -d "$APP" ]; then
  mv "$APP" "$CACHE/BewlyCat.app.$(date +%Y%m%d-%H%M%S)"
fi
cp -R "$NEW_APP" /Applications/ || die "复制到 /Applications 失败"

# 只保留最近两份旧包，其余进废纸篓
ls -dt "$CACHE"/BewlyCat.app.* 2>/dev/null | tail -n +3 | while IFS= read -r old; do
  mv "$old" "$HOME/.Trash/" 2>/dev/null || true
done

"$LSREG" -f "$APP" >/dev/null 2>&1 || true
pluginkit -a "$APPEX" >/dev/null 2>&1 || true

# 工程目录里是一个完整的 .app，留着会被 Spotlight 索引成第二个「BewlyCat」，
# 在聚焦搜索/启动台里看起来像装了两遍。装完就删。
rm -rf extension-safari-macos

log "完成：$(git log --oneline -1)"
log "提醒：免费证书未公证，Safari 每次启动会取消勾选，需要手动在 设置 → 扩展 里重新启用"
