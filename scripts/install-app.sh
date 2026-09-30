#!/bin/bash
set -euo pipefail
set -E

step='准备安装'
backup=''
trap 'printf "安装失败：%s（第 %s 行）。\n" "$step" "$LINENO" >&2; if [[ -n "$backup" ]]; then printf "旧版保存在：%s\n" "$backup" >&2; fi' ERR
cd "$(dirname "$0")/.."
app="$PWD/dist/mac-arm64/派活工作台.app"
installed='/Applications/派活工作台.app'
# 2026-09-30 以前叫“派活台”：装新版时把旧名字的应用一起关掉、移进废纸篓，免得装出两个。
legacy='/Applications/派活台.app'

step='构建并打包'
npm run pack
[[ -d "$app" ]]
step='给新应用做本地签名'
codesign --force --deep --sign - "$app"
step='验证新应用签名'
codesign --verify --deep --strict "$app"

# 只选派活工作台主进程：不要误伤其他 Electron 应用或当前安装脚本。
# ps 在没有设语言环境时会把中文路径转义成 M-f… 这样的字，匹配不上“派活工作台”，旧进程就关不掉，所以固定用 UTF-8。
running_pids() {
  LC_ALL=en_US.UTF-8 ps -axo pid=,command= | LC_ALL=en_US.UTF-8 awk '
    { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "") }
    /^\/Applications\/派活工作台\.app\/Contents\/MacOS\/派活工作台([[:space:]]|$)/ ||
    /^\/Applications\/派活台\.app\/Contents\/MacOS\/派活台([[:space:]]|$)/ ||
    /^([^[:space:]]*\/)?Electron[[:space:]]+([^[:space:]]*\/)?out\/main\/index\.js([[:space:]]|$)/ { print pid }
  '
}
step='退出正在运行的派活工作台（开发版和已装版）'
pids="$(running_pids)"
for pid in $pids; do
  # 进程可能刚好自己退出；仍在运行却发不出信号才算失败。
  if ! kill -TERM "$pid"; then
    if kill -0 "$pid" 2>/dev/null; then
      printf '安装失败：无法退出派活工作台进程 %s，未替换应用。\n' "$pid" >&2
      exit 1
    fi
  fi
done
for ((attempt=0; attempt<50; attempt++)); do
  pids="$(running_pids)"
  [[ -n "$pids" ]] || break
  sleep 0.2
done
if [[ -n "$pids" ]]; then
  printf '安装失败：旧派活工作台在 10 秒内没有退出，未替换应用。请退出后重试。\n' >&2
  exit 1
fi

step='把旧版移到废纸篓'
if [[ -e "$installed" || -L "$installed" || -e "$legacy" || -L "$legacy" ]]; then
  mkdir -p "$HOME/.Trash"
  backup="$(mktemp -d "$HOME/.Trash/派活工作台-安装-XXXXXXXX")"
  if [[ -e "$installed" || -L "$installed" ]]; then mv "$installed" "$backup/派活工作台.app"; fi
  if [[ -e "$legacy" || -L "$legacy" ]]; then mv "$legacy" "$backup/派活台.app"; fi
fi
# 改名前的应用数据（窗口位置、本机记住的折叠状态、通知记录）在“派活台”目录里。新旧两版都已退出，这时挪最稳：
# 旧目录还在就用它替换新目录（新目录先移进废纸篓），挪完旧目录就没了，不会重复。
# 不能按“新目录用没用过”判断：新版一启动 Electron 就建好新目录，退出时还会写窗口位置；也不能在应用里挪，理由同上。
step='把旧版的应用数据挪到新名字下'
support="$HOME/Library/Application Support"
if [[ -d "$support/派活台" ]]; then
  if [[ -e "$support/派活工作台" ]]; then
    [[ -n "$backup" ]] || { mkdir -p "$HOME/.Trash"; backup="$(mktemp -d "$HOME/.Trash/派活工作台-安装-XXXXXXXX")"; }
    mv "$support/派活工作台" "$backup/应用数据-未用过的新目录"
  fi
  mv "$support/派活台" "$support/派活工作台"
fi
step='复制到应用程序'
ditto "$app" "$installed"
step='验证安装后的签名'
codesign --verify --deep --strict "$installed"
step='打开派活工作台'
open "$installed"
printf '派活工作台已装进“应用程序”并打开。\n'
if [[ -n "$backup" ]]; then printf '旧版保存在：%s\n' "$backup"; fi
