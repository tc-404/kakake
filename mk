#!/bin/bash
# mk - Linux 服务器 / Termux（安卓手机）管理工具

set -euo pipefail

# 保存原始命令行参数，供自更新后重载时透传使用
MK_ORIG_ARGS=("$@")

readonly MK_VERSION="2.7.0"

# ==================== 运行平台 ====================
# Termux 里没有 root、没有 systemd，/usr/local 与 /var/log 都不可写，
# 因此安装路径整体改挂到 $PREFIX 下；除路径与自启方式外，其余逻辑与 Linux 共用同一份代码。
mk_detect_termux() {
    [[ -n "${TERMUX_VERSION:-}" ]] && return 0
    [[ "${PREFIX:-}" == *com.termux* ]] && return 0
    [[ -d /data/data/com.termux/files/usr ]] && return 0
    return 1
}

if mk_detect_termux; then
    readonly MK_PLATFORM="termux"
    readonly TERMUX_PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
    readonly INSTALL_DIR="${TERMUX_PREFIX}/lib/mk-tools"
    readonly INSTALL_BIN_DIR="${TERMUX_PREFIX}/bin"
    readonly LOG_DIR="${TERMUX_PREFIX}/var/log/mk-tools"
    readonly TERMUX_BOOT_DIR="${HOME}/.termux/boot"
    # 安卓没有 /tmp，临时文件一律走 $PREFIX/tmp
    readonly MK_TMP="${TMPDIR:-${TERMUX_PREFIX}/tmp}"
else
    readonly MK_PLATFORM="linux"
    readonly TERMUX_PREFIX=""
    readonly INSTALL_DIR="/usr/local/lib/mk-tools"
    readonly INSTALL_BIN_DIR="/usr/local/bin"
    readonly LOG_DIR="/var/log/mk-tools"
    readonly TERMUX_BOOT_DIR=""
    readonly MK_TMP="/tmp"
fi

readonly INSTALL_BIN="${INSTALL_BIN_DIR}/mk"
# 大小写不敏感呼出：mk / MK / Mk / mK（仅英文字母大小写）
readonly INSTALL_BIN_ALIASES=(mk MK Mk mK)
readonly SCRIPT_FILE="mk"
readonly AUTOSTART_NAPCAT_UNIT="mk-napcat.service"
readonly AUTOSTART_KAKAKE_UNIT="mk-kakake.service"
# Termux:Boot 开机脚本（systemd 的替代品）
readonly TERMUX_BOOT_KAKAKE="20-kakake.sh"
readonly NAPCAT_PATCHES_DIR="${INSTALL_DIR}/napcat-patches"

mk_is_termux() { [[ "$MK_PLATFORM" == "termux" ]]; }
mk_platform_label() {
    if mk_is_termux; then
        printf '%s' "Termux（安卓手机）"
    else
        printf '%s' "Linux 服务器"
    fi
}

# ==================== 局域网地址探测 ====================
# 手机上不能只取“第一个非回环 IPv4”：安卓按网卡序号排列，蜂窝数据（rmnet/ccmni）
# 往往排在 wlan0 前面，而运营商给蜂窝分配的也常是 10.x/172.x 私网地址，
# 看着像内网却根本无法从局域网访问。所以必须按网卡名分类后再排序。

# 网卡类别权重，数字越小越优先（awk 里同样有一份，改动请同步）
mk_nic_kind() {
    local n="${1,,}"
    case "$n" in
        lo|lo:*)                                   printf '%s' 'loopback' ;;
        tun*|tap*|ipsec*|utun*|wg*|ppp*)           printf '%s' 'vpn' ;;
        rmnet*|ccmni*|cc2mni*|pdp*|wwan*|v4-rmnet*|clat*) printf '%s' 'cellular' ;;
        dummy*|docker*|br-*|veth*|virbr*)          printf '%s' 'virtual' ;;
        ap[0-9]*|swlan*|softap*|rndis*|usb*|bt-pan*) printf '%s' 'tether' ;;
        wlan*|wl*)                                 printf '%s' 'wifi' ;;
        eth*|en*|em*|eno*|ens*|enp*)               printf '%s' 'ethernet' ;;
        *)                                         printf '%s' 'other' ;;
    esac
}

mk_nic_kind_label() {
    case "$(mk_nic_kind "$1")" in
        wifi)     printf '%s' 'Wi-Fi' ;;
        ethernet) printf '%s' '有线' ;;
        tether)   printf '%s' '热点/USB 共享' ;;
        cellular) printf '%s' '蜂窝数据' ;;
        vpn)      printf '%s' 'VPN' ;;
        virtual)  printf '%s' '虚拟网卡' ;;
        loopback) printf '%s' '本机回环' ;;
        *)        printf '%s' '未知网卡' ;;
    esac
}

# 这个网卡上的地址是否真能被同一局域网的其它设备访问到
mk_nic_is_lan() {
    case "$(mk_nic_kind "$1")" in
        wifi|ethernet|tether) return 0 ;;
        *) return 1 ;;
    esac
}

# 输出候选地址，每行 "IP<TAB>网卡名"，已按最可能连得上的顺序排好
mk_lan_ipv4_candidates() {
    local raw=""
    if command -v ip >/dev/null 2>&1; then
        raw="$(ip -o -4 addr show 2>/dev/null \
            | awk '{ split($4, a, "/"); if (a[1] != "") print a[1] "\t" $2 }' || true)"
    fi
    if [[ -z "$raw" ]] && command -v ifconfig >/dev/null 2>&1; then
        # 兼容 toybox 与老 net-tools 两种 ifconfig 输出
        raw="$(ifconfig 2>/dev/null | awk '
            /^[A-Za-z0-9_.:-]+/ { iface = $1; sub(/:$/, "", iface) }
            /inet (addr:)?[0-9]/ {
                for (i = 1; i <= NF; i++) {
                    if ($i ~ /^(addr:)?([0-9]{1,3}\.){3}[0-9]{1,3}$/) {
                        ip = $i; sub(/^addr:/, "", ip)
                        if (iface != "") print ip "\t" iface
                        break
                    }
                }
            }' || true)"
    fi
    [[ -z "$raw" ]] && return 0

    printf '%s\n' "$raw" | awk -F'\t' '
        function rank(n) {
            n = tolower(n)
            if (n ~ /^lo/)                                          return 99
            if (n ~ /^(dummy|docker|br-|veth|virbr)/)               return 60
            if (n ~ /^(tun|tap|ipsec|utun|wg|ppp)/)                 return 50
            if (n ~ /^(rmnet|ccmni|cc2mni|pdp|wwan|v4-rmnet|clat)/) return 40
            if (n ~ /^(ap[0-9]|swlan|softap|rndis|usb|bt-pan)/)     return 20
            if (n ~ /^(wlan|wl)/)                                   return 0
            if (n ~ /^(eth|en|em|eno|ens|enp)/)                     return 10
            return 30
        }
        # 同类之间：家用路由最常用 192.168 段，10.x 更多见于运营商与 VPN
        function sub_rank(ip) {
            if (ip ~ /^192\.168\./) return 0
            if (ip ~ /^172\./)      return 1
            return 2
        }
        $1 != "" && $1 !~ /^127\./ && $1 !~ /^169\.254\./ {
            printf "%02d%d\t%s\t%s\n", rank($2), sub_rank($1), $1, $2
        }
    ' | sort -n -k1,1 | cut -f2,3
}

# 取排序后最优的那一个，输出 "IP<TAB>网卡名"；一个都没有时输出空
mk_lan_ipv4_best() {
    local line=""
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        printf '%s\n' "$line"
        return 0
    done < <(mk_lan_ipv4_candidates)
    return 0
}

readonly BAOTA_LOG="${LOG_DIR}/baota-install.log"
readonly BAOTA_PID="${LOG_DIR}/baota-install.pid"
readonly BAOTA_START="${LOG_DIR}/baota-install.start"
readonly BAOTA_URL_FILE="${LOG_DIR}/baota-install.url"
readonly BAOTA_VER_LABEL="${LOG_DIR}/baota-install.version.label"
readonly BAOTA_BOOT_LOG="/tmp/panelBoot.pl"

readonly RED=$'\033[0;31m'
readonly GREEN=$'\033[0;32m'
readonly YELLOW=$'\033[1;33m'
readonly BLUE=$'\033[0;34m'
readonly CYAN=$'\033[0;36m'
readonly BOLD=$'\033[1m'
readonly NC=$'\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

title() {
    echo
    echo -e "${BOLD}${CYAN}======================================${NC}"
    echo -e "${BOLD}${CYAN}  $*${NC}"
    echo -e "${BOLD}${CYAN}======================================${NC}"
    echo
}

get_script_dir() {
    local src="${BASH_SOURCE[0]}"
    local dir=""
    while [[ -L "$src" ]]; do
        dir="$(cd -P "$(dirname "$src")" && pwd)"
        src="$(readlink "$src")"
        [[ "$src" != /* ]] && src="${dir}/${src}"
    done
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    printf '%s' "$dir"
}

resolve_self_path() {
    local src="${BASH_SOURCE[0]}"
    local dir=""
    while [[ -L "$src" ]]; do
        dir="$(cd -P "$(dirname "$src")" && pwd)"
        src="$(readlink "$src")"
        [[ "$src" != /* ]] && src="${dir}/${src}"
    done
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    printf '%s/%s' "$dir" "$(basename "$src")"
}

SELF_PATH="$(resolve_self_path)"

require_root() {
    # Termux 里没有 root，安装路径都在 $PREFIX 下，本来就属于当前用户，无需提权
    if mk_is_termux; then
        return 0
    fi
    if [[ $EUID -ne 0 ]]; then
        error "呜哇！ 此操作得有 root 权限才行，请使用: sudo mk 呀喵 (。•́︿•̀。)"
        return 1
    fi
}

# 仅限 Linux 服务器的功能（宝塔 / NapCat / snowLuma / 字体等）在 Termux 上统一拦住，
# 并说清原因，免得用户在手机上反复试。
mk_require_server() {
    if mk_is_termux; then
        title "该功能仅限 Linux 服务器 咯喵 (๑>◡<๑)"
        warn "诶…… ${1:-此功能依赖 root、systemd 或桌面图形环境} 喵♪ (。•́︿•̀。)"
        echo
        echo "  当前环境: $(mk_platform_label) · 无 root、无 systemd、无 X11 桌面 啦喵 ₍˄·͈༝·͈˄₎"
        echo "  手机上可用: 「咔咔珂操作」「端口验证」「开机自启（Termux:Boot）」 哦喵 (๑ᵕᴗᵕ๑)"
        echo
        press_enter
        return 1
    fi
    return 0
}

press_enter() {
    echo
    read -r -p "按 Enter 继续 咯喵 (｡•́︿•̀｡)"
}

normalize_choice() {
    local raw="$1"
    raw="${raw//$'\r'/}"
    raw="${raw//$'\n'/}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    raw="${raw//０/0}"
    raw="${raw//１/1}"
    raw="${raw//２/2}"
    raw="${raw//３/3}"
    raw="${raw//４/4}"
    raw="${raw//５/5}"
    raw="${raw//６/6}"
    raw="${raw//７/7}"
    raw="${raw//８/8}"
    raw="${raw//９/9}"
    printf '%s' "$raw"
}

read_choice() {
    local -n _out_var="$1"
    local prompt="${2:-请选择嘛喵～}"
    local raw=""
    if [[ -r /dev/tty ]]; then
        read -r -p "${prompt}: " raw </dev/tty
    else
        read -r -p "${prompt}: " raw
    fi
    _out_var="$(normalize_choice "$raw")"
}

syntax_check() {
    local target="$1"
    if ! bash -n "$target" 2>/dev/null; then
        error "呜哇！ 脚本语法检查失败: $target 喵～ (。•́︿•̀。)"
        bash -n "$target" || true
        return 1
    fi
}

install_self() {
    require_root || return 1

    mkdir -p "$INSTALL_DIR" "$LOG_DIR"
    chmod 755 "$LOG_DIR"

    local source_path="$SELF_PATH"
    local installed="${INSTALL_DIR}/${SCRIPT_FILE}"
    local tmp="${INSTALL_DIR}/${SCRIPT_FILE}.tmp"

    if [[ ! -f "$source_path" ]]; then
        if [[ -f "$installed" ]]; then
            source_path="$installed"
        else
            error "小MK喵吓一跳！ 找不到 mk 脚本源文件: ${SELF_PATH} 哇～ (。•́︿•̀。)"
            return 1
        fi
    fi

    if ! tr -d '\r' < "$source_path" > "$tmp"; then
        rm -f "$tmp"
        error "呜哇！ 没法读取脚本: ${source_path} 喵♪ (´･ω･)"
        return 1
    fi
    chmod 755 "$tmp"

    if ! syntax_check "$tmp"; then
        rm -f "$tmp"
        return 1
    fi

    mv -f "$tmp" "$installed"
    local bin_name=""
    mkdir -p "$INSTALL_BIN_DIR"
    for bin_name in "${INSTALL_BIN_ALIASES[@]}"; do
        ln -sf "$installed" "${INSTALL_BIN_DIR}/${bin_name}"
    done

    # NapCat 魔改资源只在服务器上用得到，且解压依赖 python3；Termux 直接跳过
    if ! mk_is_termux; then
        mk_embed_extract_patches "${INSTALL_DIR}/napcat-patches" || warn "诶…… NapCat 魔改资源解压失败 呢喵 (；´д｀)"

        cat > /etc/systemd/system/mk-tools.service << 'EOF'
[Unit]
Description=MK Tools
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true

[Install]
WantedBy=multi-user.target
EOF

        systemctl daemon-reload
        systemctl enable mk-tools.service >/dev/null 2>&1 || true
    fi

    info "呐呐，mk 工具已经装好/更新好啦 版本: ${MK_VERSION} 呀喵 ₍˄·͈༝·͈˄₎"
    info "喵～ 运行平台: $(mk_platform_label) 咯～ (๑ᵕᴗᵕ๑)"
    info "小MK喵：安装路径: ${INSTALL_DIR}/${SCRIPT_FILE} 哇～ (｡•̀ᴗ-)✧"
    info "诶嘿～ 全局命令: mk / MK / Mk / mK（大小写均可） 喵♪ (๑>◡<๑)"
    if mk_is_termux; then
        info "喵～ 命令目录: ${INSTALL_BIN_DIR}（Termux 无 systemd，开机自启走 Termux:Boot） 呀～ ✧٩(ˊωˋ*)و✧"
    fi
}

uninstall_self() {
    require_root || return 1

    local confirm=""
    read -r -p "确认卸载 mk 工具? 哦喵 (,,>﹏<,,) [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        info "诶嘿～ 那就不拆啦 (๑>◡<๑)"
        return 0
    fi

    if mk_is_termux; then
        autostart_kakake_disable >/dev/null 2>&1 || true
    else
        systemctl disable mk-tools.service >/dev/null 2>&1 || true
        systemctl stop mk-tools.service >/dev/null 2>&1 || true
        rm -f /etc/systemd/system/mk-tools.service
        autostart_napcat_disable >/dev/null 2>&1 || true
        autostart_kakake_disable >/dev/null 2>&1 || true
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi

    rm -f "$INSTALL_BIN"
    local bin_name=""
    for bin_name in "${INSTALL_BIN_ALIASES[@]}"; do
        rm -f "${INSTALL_BIN_DIR}/${bin_name}"
    done
    rm -rf "$INSTALL_DIR"

    info "喵～ mk 工具已卸载 咯～ (๑ᵕᴗᵕ๑)"
    info "小MK喵：日志目录保留在: ${LOG_DIR} 哇～ (｡•̀ᴗ-)✧"
}

auto_install_if_needed() {
    local installed="${INSTALL_DIR}/${SCRIPT_FILE}"
    if [[ "$SELF_PATH" != "$installed" ]]; then
        if [[ ! -f "$SELF_PATH" ]]; then
            if [[ -f "$installed" ]]; then
                return 0
            fi
            error "呜哇！ 找不到 mk 脚本: ${SELF_PATH} 哦喵 (,,>﹏<,,)"
            exit 1
        fi
        if ! mk_is_termux && [[ $EUID -ne 0 ]]; then
            error "诶诶！ 首次安装得有 root 权限才行 喵♪ (｡•́︿•̀｡)"
            echo "请执行: sudo bash $(basename "$SELF_PATH") 喵～ ✧٩(ˊωˋ*)و✧"
            exit 1
        fi
        title "MK 工具 - 安装/更新 呀喵 (｡•̀ᴗ-)✧"
        install_self || exit 1
        info "小MK喵：现在可以直接输入 mk / MK 使用菜单 哦～ (๑•̀ㅂ•́)و✧"
    fi
}

mk_embed_extract_patches() {
    local dest="${1:-${NAPCAT_PATCHES_DIR}}"
    mkdir -p "$dest"
    python3 - "$SELF_PATH" "$dest" "$MK_VERSION" <<'PY'
import base64, os, re, sys
src, dest, ver = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src, encoding="utf-8", errors="surrogateescape").read()
pattern = r"__MK_EMBED_FILE__:([^\n]+)__\n([A-Za-z0-9+/=\n]+)__MK_EMBED_END__"
found = 0
for name, b64 in re.findall(pattern, text):
    data = base64.b64decode(re.sub(r"\s+", "", b64))
    out = os.path.join(dest, name)
    with open(out, "wb") as f:
        f.write(data)
    found += 1
if found < 3:
    print("embed_incomplete")
    sys.exit(3)
with open(os.path.join(dest, ".mk-embed-version"), "w", encoding="utf-8") as f:
    f.write(ver)
print(dest)
PY
}

mk_embed_ensure_patches() {
    local dest="${NAPCAT_PATCHES_DIR}" ver_file
    if [[ "$SELF_PATH" != "${INSTALL_DIR}/${SCRIPT_FILE}" ]]; then
        dest="${LOG_DIR}/napcat-patches-cache"
    fi
    ver_file="${dest}/.mk-embed-version"
    if [[ -f "${dest}/plugin-NCp3.js" && -f "${dest}/import_reload.snippet.js" ]]; then
        if [[ -f "$ver_file" ]] && [[ "$(cat "$ver_file" 2>/dev/null)" == "$MK_VERSION" ]]; then
            echo "$dest"
            return 0
        fi
    fi
    mk_embed_extract_patches "$dest" && echo "$dest"
}

is_baota_installed() {
    [[ -f /etc/init.d/bt ]] || [[ -f /www/server/panel/BT-Panel ]] || command -v bt >/dev/null 2>&1
}

baota_install_running() {
    if [[ ! -f "$BAOTA_PID" ]]; then
        return 1
    fi
    local pid=""
    pid="$(cat "$BAOTA_PID" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

baota_save_start_time() {
    date +%s > "$BAOTA_START"
}

baota_get_start_time() {
    local ts=""

    if [[ -f "$BAOTA_START" ]]; then
        ts="$(tr -d '[:space:]' < "$BAOTA_START" 2>/dev/null || true)"
        if [[ "$ts" =~ ^[0-9]+$ ]]; then
            echo "$ts"
            return 0
        fi
    fi

    if [[ -f "$BAOTA_LOG" ]]; then
        ts="$(grep -m1 '^\[MK-START\]' "$BAOTA_LOG" 2>/dev/null | awk '{print $2}' || true)"
        if [[ "$ts" =~ ^[0-9]+$ ]]; then
            echo "$ts" > "$BAOTA_START"
            echo "$ts"
            return 0
        fi
    fi

    if [[ -f "$BAOTA_LOG" ]]; then
        local start_line=""
        start_line="$(grep -m1 'baota install start:' "$BAOTA_LOG" 2>/dev/null | sed 's/.*start:[[:space:]]*//' || true)"
        if [[ -n "$start_line" ]]; then
            ts="$(date -d "$start_line" +%s 2>/dev/null || true)"
            if [[ "$ts" =~ ^[0-9]+$ ]]; then
                echo "$ts" > "$BAOTA_START"
                echo "$ts"
                return 0
            fi
        fi
    fi

    if [[ -f "$BAOTA_LOG" ]]; then
        ts="$(stat -c %Y "$BAOTA_LOG" 2>/dev/null || stat -f %m "$BAOTA_LOG" 2>/dev/null || true)"
        if [[ "$ts" =~ ^[0-9]+$ ]]; then
            echo "$ts" > "$BAOTA_START"
            echo "$ts"
            return 0
        fi
    fi

    date +%s
}

baota_clear_install_state() {
    rm -f "$BAOTA_PID" "$BAOTA_START" "$BAOTA_URL_FILE" "$BAOTA_VER_LABEL" 2>/dev/null || true
}

baota_collect_logs() {
    local content=""
    if [[ -f "$BAOTA_LOG" ]]; then
        content+="$(tail -200 "$BAOTA_LOG" 2>/dev/null || true)"
        content+=$'\n'
    fi
    if [[ -f "$BAOTA_BOOT_LOG" ]]; then
        content+="$(tail -200 "$BAOTA_BOOT_LOG" 2>/dev/null || true)"
    fi
    printf '%s' "$content"
}

baota_detect_progress() {
    local content="$1"
    local percent=0
    local stage="等待开始"
    local wget_pct=0

    if echo "$content" | grep -qiE '\[ERROR\]|unsupported os|安装失败|failed|error:'; then
        if ! echo "$content" | grep -qiE 'Installed successfully|安装完成|外网面板地址|panel address'; then
            echo "failed|安装出错，请查看日志|0"
            return
        fi
    fi

    if echo "$content" | grep -qiE 'Installed successfully|安装完成|外网面板地址|panel address|Congratulations'; then
        echo "100|安装完成|100"
        return
    fi

    if echo "$content" | grep -q '\[MK-STEP\] 6/6'; then
        percent=95
        stage="收尾配置中"
    elif echo "$content" | grep -q '\[MK-STEP\] 5/6'; then
        percent=80
        stage="宝塔面板安装中"
    elif echo "$content" | grep -q '\[MK-STEP\] 4/6'; then
        percent=55
        stage="执行宝塔安装脚本"
    elif echo "$content" | grep -q '\[MK-STEP\] 3/6'; then
        percent=35
        stage="下载宝塔安装脚本"
    elif echo "$content" | grep -q '\[MK-STEP\] 2/6'; then
        percent=20
        stage="安装 wget 和 curl"
    elif echo "$content" | grep -q '\[MK-STEP\] 1/6'; then
        percent=10
        stage="准备安装环境"
    fi

    if echo "$content" | grep -qiE 'Downloading|下载面板|install panel|BT-Panel'; then
        (( percent < 70 )) && percent=70 && stage="下载面板文件"
    fi
    if echo "$content" | grep -qiE 'pip|python|PyPI|setuptools'; then
        (( percent < 85 )) && percent=85 && stage="安装 Python 环境"
    fi
    if echo "$content" | grep -qiE 'nginx|firewall|安全入口|8888'; then
        (( percent < 92 )) && percent=92 && stage="配置面板服务"
    fi

    wget_pct="$(echo "$content" | grep -oE '[0-9]{1,3}%' | tail -1 | tr -d '%' || true)"
    if [[ -n "$wget_pct" && "$wget_pct" =~ ^[0-9]+$ ]]; then
        if (( wget_pct > 0 && wget_pct < 100 )); then
            local dl_pct=$(( 25 + wget_pct * 15 / 100 ))
            if (( dl_pct > percent )); then
                percent=$dl_pct
                stage="下载中 ${wget_pct}%"
            fi
        fi
    fi

    if echo "$content" | grep -qiE 'apt-get|yum|dpkg|rpm'; then
        (( percent < 18 )) && percent=18 && stage="安装系统依赖"
    fi

    if [[ -f "$BAOTA_BOOT_LOG" && ! -s "$BAOTA_BOOT_LOG" ]]; then
        (( percent < 45 )) && percent=45 && stage="初始化宝塔安装器"
    fi

    if [[ "$percent" -eq 0 && -n "$content" ]]; then
        percent=5
        stage="启动安装任务"
    fi

    echo "running|${stage}|${percent}"
}

baota_make_bar() {
    local percent="$1"
    local width=30
    local filled=0
    local empty=0
    local i=0
    local bar=""

    if (( percent < 0 )); then percent=0; fi
    if (( percent > 100 )); then percent=100; fi

    filled=$(( percent * width / 100 ))
    empty=$(( width - filled - 1 ))
    if (( empty < 0 )); then empty=0; fi

    bar='['
    for ((i=0; i<filled; i++)); do bar+='#'; done
    if (( filled < width )); then bar+='>'; fi
    for ((i=0; i<empty; i++)); do bar+='-'; done
    bar+=']'

    printf '%s %3d%%' "$bar" "$percent"
}

readonly BAOTA_PANEL_LINES=8

baota_panel_cursor_up() {
    local i=0
    for ((i=0; i<BAOTA_PANEL_LINES; i++)); do
        printf '%s' $'\033[1A\033[2K'
    done
}

baota_draw_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  宝塔安装进度 呀喵 ₍˄·͈༝·͈˄₎"
    echo "--------------------------------------"
    if [[ -f "$BAOTA_VER_LABEL" ]]; then
        echo "  安装版本: $(cat "$BAOTA_VER_LABEL" 2>/dev/null || echo 未知)"
    fi
    echo "  当前步骤: ${stage}"
    printf '  进度: '
    baota_make_bar "$percent"
    echo
    echo "  已用时间: ${elapsed} 秒    状态: ${spin} 运行中"
    echo "--------------------------------------"
}

baota_watch_install() {
    local pid=""
    local last_percent=-1
    local spinner=('|' '/' '-' '+')
    local spin_idx=0
    local result="" stage="" percent=0 state=""
    local start_ts="" now_ts="" elapsed=0
    local tick=0
    local panel_active=0

    if ! baota_install_running; then
        if is_baota_installed; then
            info "诶嘿～ 宝塔已经装好啦 (๑ᵕᴗᵕ๑)"
            return 0
        fi
        warn "诶…… 当前没有正在进行的宝塔安装任务 呀喵 (｡•́︿•̀｡)"
        return 1
    fi

    pid="$(cat "$BAOTA_PID")"
    start_ts="$(baota_get_start_time)"

    echo
    info "小MK喵：正盯着宝塔安装进度，进程号=${pid} 呢～ ₍˄·͈༝·͈˄₎"
    info "诶嘿～ 日志文件: ${BAOTA_LOG} 咯喵 (๑ᵕᴗᵕ๑)"
    info "呐呐，按 Ctrl+C 可退出监听，后台安装不会停止 喵♪ (｡•̀ᴗ-)✧"
    echo

    trap 'echo; info "诶嘿～ 已退出监听，安装仍在后台继续 哦喵 ✧٩(ˊωˋ*)و✧"; trap - INT; return 0' INT

    while baota_install_running; do
        local content
        content="$(baota_collect_logs)"
        result="$(baota_detect_progress "$content")"
        IFS='|' read -r state stage percent <<< "$result"

        if [[ "$state" == "failed" ]]; then
            trap - INT
            echo
            error "${stage}"
            return 1
        fi

        if (( percent < last_percent )); then
            percent=$last_percent
        else
            last_percent=$percent
        fi

        now_ts=$(date +%s)
        elapsed=$(( now_ts - start_ts ))
        spin_idx=$(( (spin_idx + 1) % 4 ))
        tick=$(( tick + 1 ))

        if (( panel_active == 1 )); then
            baota_panel_cursor_up
        fi
        baota_draw_progress_panel "$percent" "$stage" "$elapsed" "${spinner[$spin_idx]}"
        panel_active=1

        if [[ "$state" == "100" || "$percent" -ge 100 ]]; then
            break
        fi

        sleep 1
    done

    trap - INT

    local final_content
    final_content="$(baota_collect_logs)"
    result="$(baota_detect_progress "$final_content")"
    IFS='|' read -r state stage percent <<< "$result"

    if [[ "$state" == "failed" ]]; then
        echo
        error "${stage}"
        return 1
    fi

    if is_baota_installed || [[ "$state" == "100" ]]; then
        if (( panel_active == 1 )); then
            baota_panel_cursor_up
        fi
        baota_draw_progress_panel 100 "安装完成" "$elapsed" "OK"
        echo
        info "喵～ 宝塔装好啦，可使用菜单查看登录密码 啦～ (๑>◡<๑)"
        baota_clear_install_state
        return 0
    fi

    if (( panel_active == 1 )); then
        baota_panel_cursor_up
    fi
    baota_draw_progress_panel "$last_percent" "$stage" "$elapsed" ".."
    echo
    warn "诶…… 安装进程已结束，看看日志确认结果 喵～ (,,>﹏<,,)"
    info "呐呐，日志: tail -f ${BAOTA_LOG} 啦喵 (｡•̀ᴗ-)✧"
    return 0
}

BAOTA_INSTALL_URL=""
BAOTA_INSTALL_LABEL=""

menu_baota_select_stable() {
    while true; do
        title "宝塔稳定版 呀喵 ✧٩(ˊωˋ*)و✧"
        show_nav_hint
        echo "  [2] 9.0 LTS 长期支持版啦"
        echo "  [3] 10.0 LTS 长期支持版啦"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back ;;
            2)
                BAOTA_INSTALL_URL="https://download.bt.cn/install/install_lts.sh"
                BAOTA_INSTALL_LABEL="稳定版 9.0 LTS"
                return 0
                ;;
            3)
                BAOTA_INSTALL_URL="https://download.bt.cn/install/installStable.sh"
                BAOTA_INSTALL_LABEL="稳定版 10.0 LTS"
                return 0
                ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (。•́︿•̀。)" ;;
        esac
    done
}

menu_baota_select_version() {
    while true; do
        title "选择宝塔安装版本 呀喵 (๑>◡<๑)"
        show_nav_hint
        echo "  [2] 正式版 (最新 11.x，推荐)啦"
        echo "  [3] 稳定版 (9.0 / 10.0 LTS)啦"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                BAOTA_INSTALL_URL="https://download.bt.cn/install/install_panel.sh"
                BAOTA_INSTALL_LABEL="正式版 11.x"
                return 0
                ;;
            3)
                menu_baota_select_stable || true
                if mk_nav_bubble_up; then
                    return 0
                fi
                if [[ -n "$BAOTA_INSTALL_URL" ]]; then
                    return 0
                fi
                ;;
            *) warn "诶…… 看不懂选项，请重新输入 喵～ (´･ω･)" ;;
        esac
    done
}
baota_do_install() {
    require_root || return 1

    if baota_install_running; then
        baota_watch_install
        return $?
    fi

    if is_baota_installed; then
        local reinstall=""
        warn "呜喵… 小MK发现宝塔已经装好啦 (；´д｀)"
        read -r -p "是否重新安装? 啦喵 (´･ω･) [y/N]: " reinstall
        [[ "$reinstall" =~ ^[Yy]$ ]] || return 0
    fi

    BAOTA_INSTALL_URL=""
    BAOTA_INSTALL_LABEL=""
    menu_baota_select_version || return 0
    if mk_nav_bubble_up; then
        return 0
    fi

    mkdir -p "$LOG_DIR"
    : > "$BAOTA_LOG"
    baota_save_start_time
    echo "$BAOTA_INSTALL_URL" > "$BAOTA_URL_FILE"
    echo "$BAOTA_INSTALL_LABEL" > "$BAOTA_VER_LABEL"

    info "小MK喵：正在后台启动宝塔安装: ${BAOTA_INSTALL_LABEL} 呢～ ₍˄·͈༝·͈˄₎"

    nohup bash -s >> "$BAOTA_LOG" 2>&1 << 'BTEOF' &
set -e
URL_FILE="/var/log/mk-tools/baota-install.url"
VER_FILE="/var/log/mk-tools/baota-install.version.label"
echo "[MK-START] $(date +%s)"
echo "[MK-VERSION] $(cat "$VER_FILE" 2>/dev/null || echo unknown)"
log_step() { echo "[MK-STEP] $1"; }

log_step "1/6 准备安装环境"
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq 2>/dev/null || true
    log_step "2/6 安装 wget 和 curl"
    apt-get install -y wget curl 2>/dev/null || true
elif command -v yum >/dev/null 2>&1; then
    log_step "2/6 安装 wget 和 curl"
    yum install -y wget curl 2>/dev/null || true
else
    echo "[ERROR] unsupported os" >&2
    exit 1
fi

if [[ ! -f "$URL_FILE" ]]; then
    echo "[ERROR] missing install url file" >&2
    exit 1
fi
URL="$(tr -d '[:space:]' < "$URL_FILE")"

echo "========================================"
echo " baota install start: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"

log_step "3/6 下载宝塔安装脚本"
if wget -O /tmp/bt_install.sh "$URL" 2>/dev/null; then
    :
else
    curl -fsSL "$URL" -o /tmp/bt_install.sh
fi

log_step "4/6 执行宝塔安装脚本"
yes y | bash /tmp/bt_install.sh ed8484bec || bash /tmp/bt_install.sh ed8484bec

log_step "5/6 宝塔面板安装中"
log_step "6/6 收尾配置中"

echo "========================================"
echo " baota install done: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
rm -f /tmp/bt_install.sh
BTEOF

    local pid=$!
    echo "$pid" > "$BAOTA_PID"
    sleep 0.3
    baota_watch_install
}

baota_fetch_default_output() {
    if command -v bt >/dev/null 2>&1; then
        bt default 2>/dev/null
        return 0
    fi
    if [[ -f /etc/init.d/bt ]]; then
        /etc/init.d/bt default 2>/dev/null
        return 0
    fi
    return 1
}

baota_extract_line_value() {
    local line="$1"
    line="${line#*:}"
    line="${line#*：}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    printf '%s' "$line"
}

baota_show_password() {
    if ! is_baota_installed; then
        error "诶诶！ 宝塔还没装呢 (；´д｀)"
        if [[ -f "$BAOTA_LOG" ]]; then
            info "小MK喵：最近安装日志末尾 10 行 呢～:"
            tail -10 "$BAOTA_LOG" 2>/dev/null || true
        fi
        if baota_install_running; then
            warn "诶…… 宝塔正在后台努力装 啦喵 (´･ω･)"
            baota_watch_install
        fi
        return 1
    fi

    local raw="" line=""
    local panel_url="" panel_inner="" username="" password=""

    raw="$(baota_fetch_default_output)" || {
        error "小MK喵吓一跳！ 找不到 bt 命令 哇～ (´･ω･)"
        return 1
    }

    while IFS= read -r line; do
        case "$line" in
            *外网*面板地址*|*panel\ address*)
                panel_url="$(baota_extract_line_value "$line")"
                ;;
            *内网面板地址*)
                panel_inner="$(baota_extract_line_value "$line")"
                ;;
            username:*)
                username="${line#username:}"
                username="${username#"${username%%[![:space:]]*}"}"
                username="${username%"${username##*[![:space:]]}"}"
                ;;
            password:*)
                password="${line#password:}"
                password="${password#"${password%%[![:space:]]*}"}"
                password="${password%"${password##*[![:space:]]}"}"
                ;;
        esac
    done <<< "$raw"

    [[ -z "$panel_url" ]] && panel_url="$panel_inner"

    title "宝塔面板登录信息 呀喵 ✧٩(ˊωˋ*)و✧"
    echo "  面板地址: ${panel_url:-没拿到喵} 呢喵 ₍˄·͈༝·͈˄₎"
    if [[ -n "$panel_inner" && "$panel_inner" != "$panel_url" ]]; then
        echo "  内网地址: ${panel_inner} 喵♪ (｡•̀ᴗ-)✧"
    fi
    echo "  用户名:   ${username:-没拿到喵} 啦喵 (๑•̀ㅂ•́)و✧"
    echo "  密码:     ${password:-没拿到喵} 哦喵 ✧٩(ˊωˋ*)و✧"
    echo
    warn "诶…… 若没法访问，请在安全组放行面板端口 呢喵 (´･ω･)"
}

show_nav_hint() {
    echo -e "${YELLOW}  [0] 返回首页    [1] 返回上一步 啦喵 ✧٩(ˊωˋ*)و✧${NC}"
    echo -e "${YELLOW}  --------------------------------${NC}"
}

MK_GO_HOME=0

mk_nav_home() {
    MK_GO_HOME=1
    return 0
}

mk_nav_back() {
    return 0
}

mk_nav_bubble_up() {
    [[ "${MK_GO_HOME:-}" == "1" ]]
}

menu_baota() {
    if baota_install_running; then
        info "呐呐，小MK发现宝塔正在后台安装，正在找回进度显示 啦喵 (｡•̀ᴗ-)✧"
        baota_watch_install
        echo
    fi

    while true; do
        title "宝塔操作 喵～ (｡•̀ᴗ-)✧"
        show_nav_hint
        echo "  [2] 安装宝塔-后台安装呀"
        echo "  [3] 查看宝塔登录密码呀"
        if baota_install_running; then
            echo "  [4] 查看安装进度呀"
            echo
            echo -e "  ${YELLOW}* 宝塔正在后台努力装 喵～ (๑>◡<๑)${NC}"
        elif is_baota_installed; then
            echo
            echo -e "  ${GREEN}* 宝塔已经装好啦 ₍˄·͈༝·͈˄₎${NC}"
        fi
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) baota_do_install || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            3) baota_show_password; press_enter ;;
            4)
                if baota_install_running; then
                    baota_watch_install
                    press_enter
                else
                    warn "呜喵… 当前没有安装任务 啦～ (,,>﹏<,,)"
                fi
                ;;
            *) warn "呜喵… 看不懂选项，请重新输入 呢～ (´･ω･)" ;;
        esac
    done
}


# ==================== NapCat ====================

NAPCAT_QQ_BIN=""
NAPCAT_WEBUI_CFG=""
readonly NAPCAT_INSTALLER_URL="https://git.yylx.win/https://github.com/NapNeko/NapCat-Installer/blob/main/script/install.sh"
readonly NAPCAT_LOG="${LOG_DIR}/napcat-runtime.log"
readonly NAPCAT_PID_FILE="${LOG_DIR}/napcat.pid"
readonly NAPCAT_INSTALL_LOG="${LOG_DIR}/napcat-install.log"
readonly NAPCAT_INSTALL_PID="${LOG_DIR}/napcat-install.pid"
readonly NAPCAT_INSTALL_START="${LOG_DIR}/napcat-install.start"
readonly NAPCAT_INSTALL_TAG_FILE="${LOG_DIR}/napcat-install.tag"
readonly NAPCAT_INSTALL_PROXY_FILE="${LOG_DIR}/napcat-install.proxy"
readonly NAPCAT_INSTALL_VER_LABEL="${LOG_DIR}/napcat-install.version.label"
readonly NAPCAT_VER_FILE="${LOG_DIR}/napcat.version"

NAPCAT_PROXY_INDEX="0"
NAPCAT_VERSION_TAG="latest"
NAPCAT_VERSION_LABEL=""

napcat_mirror_labels=(
    "直连 GitHub (国外/可访问 GitHub 的服务器)"
    "ghfast.top"
    "git.yylx.win"
    "gh-proxy.com"
    "ghfile.geekertao.top"
    "gh-proxy.net"
    "j.1win.ggff.net"
    "ghm.078465.xyz"
    "gitproxy.127731.xyz"
    "jiashu.1win.eu.org"
    "github.tbedu.top"
)

napcat_mirror_urls=(
    ""
    "https://ghfast.top"
    "https://git.yylx.win/"
    "https://gh-proxy.com"
    "https://ghfile.geekertao.top"
    "https://gh-proxy.net"
    "https://j.1win.ggff.net"
    "https://ghm.078465.xyz"
    "https://gitproxy.127731.xyz"
    "https://jiashu.1win.eu.org"
    "https://github.tbedu.top"
)

napcat_detect_paths() {
    if [[ -x "${HOME}/Napcat/opt/QQ/qq" ]]; then
        NAPCAT_QQ_BIN="${HOME}/Napcat/opt/QQ/qq"
        NAPCAT_WEBUI_CFG="${HOME}/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json"
        return 0
    fi
    if [[ -x "/opt/QQ/qq" ]]; then
        NAPCAT_QQ_BIN="/opt/QQ/qq"
        NAPCAT_WEBUI_CFG="/opt/QQ/resources/app/app_launcher/napcat/config/webui.json"
        return 0
    fi
    NAPCAT_QQ_BIN=""
    NAPCAT_WEBUI_CFG=""
    return 1
}

napcat_is_installed() {
    napcat_detect_paths || return 1
    [[ -n "$NAPCAT_QQ_BIN" ]]
}

napcat_is_running() {
    napcat_detect_paths || return 1
    if pgrep -f "Napcat/opt/QQ/qq" >/dev/null 2>&1; then
        return 0
    fi
    if [[ -n "$NAPCAT_QQ_BIN" ]] && pgrep -f "$NAPCAT_QQ_BIN" >/dev/null 2>&1; then
        return 0
    fi
    if pgrep -f "/opt/QQ/qq" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

napcat_get_display_version() {
    local ver="" tag=""

    if napcat_install_running && [[ -f "$NAPCAT_INSTALL_TAG_FILE" ]]; then
        ver="$(tr -d '[:space:]' < "$NAPCAT_INSTALL_TAG_FILE" 2>/dev/null || true)"
        if [[ "$ver" == "latest" ]]; then
            echo "最新版"
        elif [[ -n "$ver" ]]; then
            echo "$ver"
        fi
        return 0
    fi

    if [[ -f "$NAPCAT_VER_FILE" ]]; then
        ver="$(cat "$NAPCAT_VER_FILE" 2>/dev/null || true)"
        ver="${ver//$'\r'/}"
        ver="${ver#"${ver%%[![:space:]]*}"}"
        ver="${ver%"${ver##*[![:space:]]}"}"
        if [[ "$ver" == *最新版* || "$ver" == "latest" ]]; then
            echo "最新版"
            return 0
        fi
        tag="$(echo "$ver" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
        if [[ -n "$tag" ]]; then
            echo "$tag"
        elif [[ -n "$ver" ]]; then
            echo "$ver"
        fi
    fi
}

napcat_get_server_ip() {
    local ip=""

    # Termux：手机在运营商 NAT 后面，公网 IP 查出来也连不上，
    # 真正有用的是同一 Wi-Fi 下的局域网地址（wlan0）。
    # 注意不能取“第一个非 127 地址”：蜂窝数据与 VPN 也是私网地址，
    # 而且在安卓上经常排在 wlan0 前面，选中了就会让人以为地址错了。
    if mk_is_termux; then
        ip="$(mk_lan_ipv4_best | cut -f1)"
        if [[ -n "$ip" ]]; then
            echo "$ip"
        else
            echo "手机局域网IP"
        fi
        return 0
    fi

    ip="$(curl -4 -fsSL --max-time 3 ip.sb 2>/dev/null || curl -4 -fsSL --max-time 3 ifconfig.me 2>/dev/null || true)"
    if [[ -z "$ip" ]]; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
    if [[ -n "$ip" ]]; then
        echo "$ip"
    else
        echo "服务器IP"
    fi
}

napcat_build_download_url() {
    local raw_url="$1"
    local proxy_idx="$2"
    local proxy=""

    if [[ "$proxy_idx" -gt 0 && "$proxy_idx" -lt ${#napcat_mirror_urls[@]} ]]; then
        proxy="${napcat_mirror_urls[$proxy_idx]}"
        proxy="${proxy%/}"
        echo "${proxy}/${raw_url}"
    else
        echo "$raw_url"
    fi
}

napcat_firewall_open_port() {
    local port="$1"
    [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && return 1

    # Termux：没有 root、没有 ufw/firewalld/iptables 权限。安卓本身不拦本机监听端口，
    # 同一 Wi-Fi 下别的设备可以直接访问，不需要（也无法）在这里放行。
    if mk_is_termux; then
        return 0
    fi

    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
        ufw allow "${port}/tcp" >/dev/null 2>&1 || true
        info "喵～ 已通过 ufw 放行 ${port} 端口 呀～ ✧٩(ˊωˋ*)و✧"
    elif command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        info "喵～ 已通过 firewalld 放行 ${port} 端口 啦～ (๑>◡<๑)"
    elif command -v iptables >/dev/null 2>&1; then
        iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || \
            iptables -I INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || true
        info "喵～ 已通过 iptables 放行 ${port} 端口 咯～ (๑ᵕᴗᵕ๑)"
    else
        warn "呜喵… 小MK没找到常见防火墙，手动放行 ${port} 端口 啦～ (。•́︿•̀。)"
    fi
    warn "小MK喵小声说：请在云服务商安全组放行 ${port} 端口 呀～ (´･ω･)"
}

napcat_firewall_close_port() {
    local port="$1"
    [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && return 1

    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
        ufw delete allow "${port}/tcp" >/dev/null 2>&1 || true
        info "小MK喵：已通过 ufw 关闭 ${port} 端口 哇～ (｡•̀ᴗ-)✧"
    elif command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --remove-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        info "小MK喵：已通过 firewalld 关闭 ${port} 端口 呢～ ₍˄·͈༝·͈˄₎"
    elif command -v iptables >/dev/null 2>&1; then
        while iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; do
            iptables -D INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || break
        done
        info "诶嘿～ 已通过 iptables 关闭 ${port} 端口 喵♪ ✧٩(ˊωˋ*)و✧"
    else
        warn "诶…… 小MK没找到常见防火墙，手动关闭 ${port} 端口 啦喵 (´･ω･)"
    fi
}

napcat_open_port_6099() {
    napcat_firewall_open_port 6099
}

napcat_show_login_info() {
    napcat_detect_paths || true
    local token="" port="6099" host_ip=""
    host_ip="$(napcat_get_server_ip)"

    if [[ -f "$NAPCAT_WEBUI_CFG" ]]; then
        token="$(grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$NAPCAT_WEBUI_CFG" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
        local p=""
        p="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$NAPCAT_WEBUI_CFG" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
        [[ -n "$p" ]] && port="$p"
    fi

    if [[ -z "$token" && -f "$NAPCAT_LOG" ]]; then
        token="$(grep -oE 'token=[A-Za-z0-9_-]+' "$NAPCAT_LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
        if [[ -z "$token" ]]; then
            token="$(grep -oE 'WebUi Token: [A-Za-z0-9_-]+' "$NAPCAT_LOG" 2>/dev/null | tail -1 | awk '{print $NF}' || true)"
        fi
    fi

    local url="http://${host_ip}:${port}/webui"
    if [[ -n "$token" ]]; then
        url="${url}?token=${token}"
    fi

    title "NapCat WebUI 登录信息 咯喵 (๑>◡<๑)"
    echo "  面板地址: ${url} 喵♪ (๑•̀ㅂ•́)و✧"
    echo "  登录密钥: ${token:-没拿到喵，请先启动框架或查看日志} 喵～ ✧٩(ˊωˋ*)و✧"
    if [[ -f "$NAPCAT_VER_FILE" ]]; then
        echo "  安装版本: $(cat "$NAPCAT_VER_FILE" 2>/dev/null || echo 未知)"
    fi
    echo
    warn "诶…… 若没法访问，请在安全组放行 ${port} 端口 咯喵 (；´д｀)"
}

napcat_install_running() {
    if [[ ! -f "$NAPCAT_INSTALL_PID" ]]; then
        return 1
    fi
    local pid=""
    pid="$(cat "$NAPCAT_INSTALL_PID" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

napcat_save_install_start_time() {
    date +%s > "$NAPCAT_INSTALL_START"
}

napcat_get_install_start_time() {
    local ts=""

    if [[ -f "$NAPCAT_INSTALL_START" ]]; then
        ts="$(tr -d '[:space:]' < "$NAPCAT_INSTALL_START" 2>/dev/null || true)"
        if [[ "$ts" =~ ^[0-9]+$ ]]; then
            echo "$ts"
            return 0
        fi
    fi

    if [[ -f "$NAPCAT_INSTALL_LOG" ]]; then
        ts="$(grep -m1 '^\[MK-START\]' "$NAPCAT_INSTALL_LOG" 2>/dev/null | awk '{print $2}' || true)"
        if [[ "$ts" =~ ^[0-9]+$ ]]; then
            echo "$ts" > "$NAPCAT_INSTALL_START"
            echo "$ts"
            return 0
        fi
    fi

    if [[ -f "$NAPCAT_INSTALL_LOG" ]]; then
        local start_line=""
        start_line="$(grep -m1 'napcat install start:' "$NAPCAT_INSTALL_LOG" 2>/dev/null | sed 's/.*start:[[:space:]]*//' || true)"
        if [[ -n "$start_line" ]]; then
            ts="$(date -d "$start_line" +%s 2>/dev/null || true)"
            if [[ "$ts" =~ ^[0-9]+$ ]]; then
                echo "$ts" > "$NAPCAT_INSTALL_START"
                echo "$ts"
                return 0
            fi
        fi
    fi

    if [[ -f "$NAPCAT_INSTALL_LOG" ]]; then
        ts="$(stat -c %Y "$NAPCAT_INSTALL_LOG" 2>/dev/null || stat -f %m "$NAPCAT_INSTALL_LOG" 2>/dev/null || true)"
        if [[ "$ts" =~ ^[0-9]+$ ]]; then
            echo "$ts" > "$NAPCAT_INSTALL_START"
            echo "$ts"
            return 0
        fi
    fi

    date +%s
}

napcat_clear_install_state() {
    rm -f "$NAPCAT_INSTALL_PID" "$NAPCAT_INSTALL_START" \
        "$NAPCAT_INSTALL_TAG_FILE" "$NAPCAT_INSTALL_PROXY_FILE" \
        "$NAPCAT_INSTALL_VER_LABEL" 2>/dev/null || true
}

napcat_collect_install_logs() {
    if [[ -f "$NAPCAT_INSTALL_LOG" ]]; then
        tail -200 "$NAPCAT_INSTALL_LOG" 2>/dev/null || true
    fi
}

napcat_detect_install_progress() {
    local content="$1"
    local percent=0
    local stage="等待开始"
    local curl_pct=0

    if echo "$content" | grep -qiE '\[ERROR\]|下载.*失败|安装失败|Docker启动失败'; then
        if ! echo "$content" | grep -qiE '\[MK-NAPCAT\] install done|安装成功|Shell \(Rootless\) 安装完成'; then
            echo "failed|安装出错，请查看日志|0"
            return
        fi
    fi

    if echo "$content" | grep -qiE '\[MK-NAPCAT\] install done|\[MK-STEP\] 4/4'; then
        if echo "$content" | grep -q '\[MK-NAPCAT\] install done'; then
            echo "100|安装完成|100"
            return
        fi
    fi

    if echo "$content" | grep -q '\[MK-STEP\] 4/4'; then
        percent=95
        stage="开放端口并收尾"
    elif echo "$content" | grep -q '\[MK-STEP\] 3/4'; then
        percent=70
        stage="执行 NapCat 安装"
    elif echo "$content" | grep -q '\[MK-STEP\] 2/4'; then
        percent=40
        stage="下载 NapCat 程序包"
    elif echo "$content" | grep -q '\[MK-STEP\] 1/4'; then
        percent=15
        stage="下载安装脚本"
    fi

    if echo "$content" | grep -qiE 'Downloading|下载|NapCat\.Shell|curl.*#'; then
        (( percent < 55 )) && percent=55 && stage="下载资源文件"
    fi
    if echo "$content" | grep -qiE 'apt-get|yum|dpkg|安装.*依赖|xvfb'; then
        (( percent < 65 )) && percent=65 && stage="安装系统依赖"
    fi
    if echo "$content" | grep -qiE 'QQ|注入|install_napcat|Napcat 配置'; then
        (( percent < 88 )) && percent=88 && stage="配置 QQ 与 NapCat"
    fi

    curl_pct="$(echo "$content" | grep -oE '[0-9]{1,3}%' | tail -1 | tr -d '%' || true)"
    if [[ -n "$curl_pct" && "$curl_pct" =~ ^[0-9]+$ ]]; then
        if (( curl_pct > 0 && curl_pct < 100 )); then
            local dl_pct=$(( 30 + curl_pct * 25 / 100 ))
            if (( dl_pct > percent )); then
                percent=$dl_pct
                stage="下载中 ${curl_pct}%"
            fi
        fi
    fi

    if [[ "$percent" -eq 0 && -n "$content" ]]; then
        percent=5
        stage="启动安装任务"
    fi

    echo "running|${stage}|${percent}"
}

readonly NAPCAT_PANEL_LINES=8

napcat_panel_cursor_up() {
    local i=0
    for ((i=0; i<NAPCAT_PANEL_LINES; i++)); do
        printf '%s' $'\033[1A\033[2K'
    done
}

napcat_draw_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  NapCat 安装进度 呀喵 ₍˄·͈༝·͈˄₎"
    echo "--------------------------------------"
    if [[ -f "$NAPCAT_INSTALL_VER_LABEL" ]]; then
        echo "  安装版本: $(cat "$NAPCAT_INSTALL_VER_LABEL" 2>/dev/null || echo 未知)"
    fi
    echo "  当前步骤: ${stage}"
    printf '  进度: '
    baota_make_bar "$percent"
    echo
    echo "  已用时间: ${elapsed} 秒    状态: ${spin} 运行中"
    echo "--------------------------------------"
}

napcat_watch_install() {
    local pid=""
    local last_percent=-1
    local spinner=('|' '/' '-' '+')
    local spin_idx=0
    local result="" stage="" percent=0 state=""
    local start_ts="" now_ts="" elapsed=0
    local panel_active=0

    if ! napcat_install_running; then
        if napcat_is_installed; then
            info "呐呐，NapCat 已经装好啦 ₍˄·͈༝·͈˄₎"
            return 0
        fi
        warn "呜喵… 当前没有正在进行的 NapCat 安装任务 啦～ (。•́︿•̀。)"
        return 1
    fi

    pid="$(cat "$NAPCAT_INSTALL_PID")"
    start_ts="$(napcat_get_install_start_time)"

    echo
    info "诶嘿～ 正盯着 NapCat 安装进度，进程号=${pid} 呀喵 ✧٩(ˊωˋ*)و✧"
    info "呐呐，日志文件: ${NAPCAT_INSTALL_LOG} 呢喵 ₍˄·͈༝·͈˄₎"
    info "喵～ 按 Ctrl+C 可退出监听，后台安装不会停止 咯～ (๑ᵕᴗᵕ๑)"
    echo

    trap 'echo; info "呐呐，已退出监听，安装仍在后台继续 啦喵 (๑•̀ㅂ•́)و✧"; trap - INT; return 0' INT

    while napcat_install_running; do
        local content
        content="$(napcat_collect_install_logs)"
        result="$(napcat_detect_install_progress "$content")"
        IFS='|' read -r state stage percent <<< "$result"

        if [[ "$state" == "failed" ]]; then
            trap - INT
            echo
            error "${stage}"
            return 1
        fi

        if (( percent < last_percent )); then
            percent=$last_percent
        else
            last_percent=$percent
        fi

        now_ts=$(date +%s)
        elapsed=$(( now_ts - start_ts ))
        spin_idx=$(( (spin_idx + 1) % 4 ))
        if (( panel_active == 1 )); then
            napcat_panel_cursor_up
        fi
        napcat_draw_progress_panel "$percent" "$stage" "$elapsed" "${spinner[$spin_idx]}"
        panel_active=1

        if [[ "$state" == "100" || "$percent" -ge 100 ]]; then
            break
        fi

        sleep 1
    done

    trap - INT

    local final_content
    final_content="$(napcat_collect_install_logs)"
    result="$(napcat_detect_install_progress "$final_content")"
    IFS='|' read -r state stage percent <<< "$result"

    if [[ "$state" == "failed" ]]; then
        echo
        error "${stage}"
        return 1
    fi

    if napcat_is_installed || [[ "$state" == "100" ]]; then
        if (( panel_active == 1 )); then
            napcat_panel_cursor_up
        fi
        napcat_draw_progress_panel 100 "安装完成" "$elapsed" "OK"
        echo
        info "呐呐，NapCat 装好啦，已开放 6099 端口 啦喵 ₍˄·͈༝·͈˄₎"
        info "喵～ 未自动启动，请使用菜单「启动框架」手动启动 咯～ (๑ᵕᴗᵕ๑)"
        napcat_clear_install_state
        return 0
    fi

    if (( panel_active == 1 )); then
        napcat_panel_cursor_up
    fi
    napcat_draw_progress_panel "$last_percent" "$stage" "$elapsed" ".."
    echo
    warn "小MK喵小声说：安装进程已结束，看看日志确认结果 呀～ (。•́︿•̀。)"
    info "呐呐，日志: tail -f ${NAPCAT_INSTALL_LOG} 喵♪ ₍˄·͈༝·͈˄₎"
    return 0
}

menu_napcat_select_version() {
    while true; do
        title "选择 NapCat 安装版本 咯喵 ₍˄·͈༝·͈˄₎"
        show_nav_hint
        echo "  [2] 最新版 (官方一键脚本)嘛"
        echo "  [3] v4.18.5 (插件最后支持)嘛"
        echo "  [4] v4.17.23 (支持上传插件)嘛"
        echo "  [5] v4.15.0"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                NAPCAT_VERSION_TAG="latest"
                NAPCAT_VERSION_LABEL="最新版"
                return 0
                ;;
            3)
                NAPCAT_VERSION_TAG="v4.18.5"
                NAPCAT_VERSION_LABEL="v4.18.5 (插件最后支持)"
                return 0
                ;;
            4)
                NAPCAT_VERSION_TAG="v4.17.23"
                NAPCAT_VERSION_LABEL="v4.17.23 (支持上传插件)"
                return 0
                ;;
            5)
                NAPCAT_VERSION_TAG="v4.15.0"
                NAPCAT_VERSION_LABEL="v4.15.0"
                return 0
                ;;
            *) warn "呜喵… 看不懂选项，请重新输入 啦～ (。•́︿•̀。)" ;;
        esac
    done
}

menu_napcat_select_mirror() {
    local i=0
    local idx=0

    while true; do
        title "选择下载镜像源 喵♪ (๑ᵕᴗᵕ๑)"
        show_nav_hint
        echo "  国内服务器若没法访问 GitHub，请选择嘛镜像源 啦喵 (๑>◡<๑)"
        echo

        for ((i=0; i<${#napcat_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            echo "  [${idx}] ${napcat_mirror_labels[$i]}"
        done
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#napcat_mirror_labels[@]} )); then
                        NAPCAT_PROXY_INDEX="$idx"
                        info "小MK喵：已选择: ${napcat_mirror_labels[$idx]} 哦～ (๑•̀ㅂ•́)و✧"
                        return 0
                    fi
                fi
                warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (。•́︿•̀。)"
                ;;
        esac
    done
}

napcat_do_install() {
    if napcat_install_running; then
        napcat_watch_install
        return $?
    fi

    if napcat_is_installed; then
        local reinstall=""
        warn "诶…… 小MK发现 NapCat 已经装好啦 (,,>﹏<,,)"
        read -r -p "是否重新安装? 呢喵 (。•́︿•̀。) [y/N]: " reinstall
        [[ "$reinstall" =~ ^[Yy]$ ]] || return 0
        napcat_stop || true
    fi

    NAPCAT_VERSION_TAG="latest"
    NAPCAT_VERSION_LABEL=""
    NAPCAT_PROXY_INDEX="0"
    menu_napcat_select_version || return 0
    if mk_nav_bubble_up; then
        return 0
    fi
    menu_napcat_select_mirror || return 0
    if mk_nav_bubble_up; then
        return 0
    fi

    mkdir -p "$LOG_DIR"
    : > "$NAPCAT_INSTALL_LOG"
    napcat_save_install_start_time
    echo "$NAPCAT_VERSION_TAG" > "$NAPCAT_INSTALL_TAG_FILE"
    echo "$NAPCAT_PROXY_INDEX" > "$NAPCAT_INSTALL_PROXY_FILE"
    echo "$NAPCAT_VERSION_LABEL" > "$NAPCAT_INSTALL_VER_LABEL"

    info "喵～ 正在后台启动 NapCat 安装: ${NAPCAT_VERSION_LABEL} 呀～ ✧٩(ˊωˋ*)و✧"

    nohup bash -s >> "$NAPCAT_INSTALL_LOG" 2>&1 << 'NAPEOF' &
set -e
LOG_DIR="/var/log/mk-tools"
TAG_FILE="${LOG_DIR}/napcat-install.tag"
PROXY_FILE="${LOG_DIR}/napcat-install.proxy"
VER_FILE="${LOG_DIR}/napcat-install.version.label"
VER_OUT="${LOG_DIR}/napcat.version"
INSTALLER_URL="https://git.yylx.win/https://github.com/NapNeko/NapCat-Installer/blob/main/script/install.sh"
WORK_DIR="${HOME}"

log_step() { echo "[MK-STEP] $1"; }

build_dl_url() {
    local raw_url="$1"
    local proxy_idx="$2"
    case "$proxy_idx" in
        1)  echo "https://ghfast.top/${raw_url}" ;;
        2)  echo "https://git.yylx.win/${raw_url}" ;;
        3)  echo "https://gh-proxy.com/${raw_url}" ;;
        4)  echo "https://ghfile.geekertao.top/${raw_url}" ;;
        5)  echo "https://gh-proxy.net/${raw_url}" ;;
        6)  echo "https://j.1win.ggff.net/${raw_url}" ;;
        7)  echo "https://ghm.078465.xyz/${raw_url}" ;;
        8)  echo "https://gitproxy.127731.xyz/${raw_url}" ;;
        9)  echo "https://jiashu.1win.eu.org/${raw_url}" ;;
        10) echo "https://github.tbedu.top/${raw_url}" ;;
        *)  echo "$raw_url" ;;
    esac
}

open_port_6099() {
    local port=6099
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
        ufw allow "${port}/tcp" >/dev/null 2>&1 || true
        echo "[INFO] ufw 已放行 ${port} 端口"
    elif command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        echo "[INFO] firewalld 已放行 ${port} 端口"
    elif command -v iptables >/dev/null 2>&1; then
        iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || \
            iptables -I INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || true
        echo "[INFO] iptables 已放行 ${port} 端口"
    fi
}

ver_tag="$(tr -d '[:space:]' < "$TAG_FILE" 2>/dev/null || echo latest)"
proxy_idx="$(tr -d '[:space:]' < "$PROXY_FILE" 2>/dev/null || echo 0)"
ver_label="$(cat "$VER_FILE" 2>/dev/null || echo unknown)"

echo "[MK-START] $(date +%s)"
echo "========================================"
echo " napcat install start: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
echo "[MK-NAPCAT] version: ${ver_label}"
echo "[MK-NAPCAT] proxy index: ${proxy_idx}"

cd "$WORK_DIR" || exit 1
rm -f napcat.sh

log_step "1/4 下载 NapCat 安装脚本"
if ! curl -fsSL -o napcat.sh "$INSTALLER_URL"; then
    echo "[ERROR] 下载 napcat.sh 失败"
    exit 1
fi
chmod +x napcat.sh

if [[ "$ver_tag" != "latest" ]]; then
    log_step "2/4 下载指定版本 ${ver_tag}"
    zip_url="https://github.com/NapNeko/NapCatQQ/releases/download/${ver_tag}/NapCat.Shell.zip"
    dl_url="$(build_dl_url "$zip_url" "$proxy_idx")"
    rm -f NapCat.Shell.zip napcat.zip
    if ! curl -fL --retry 3 --connect-timeout 30 -o NapCat.Shell.zip "$dl_url"; then
        echo "[ERROR] 下载 NapCat.Shell.zip 失败: ${dl_url}"
        exit 1
    fi
    echo "[INFO] 已下载 NapCat.Shell.zip"
else
    log_step "2/4 使用官方脚本拉取最新版"
fi

log_step "3/4 执行 NapCat 安装 (不自动启动)"
bash napcat.sh --docker n --cli n --proxy "$proxy_idx" --force

log_step "4/4 开放 6099 端口"
open_port_6099
echo "$ver_label" > "$VER_OUT"

echo "========================================"
echo " napcat install done: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"
echo "[MK-NAPCAT] install done: $(date '+%Y-%m-%d %H:%M:%S')"
NAPEOF

    local pid=$!
    echo "$pid" > "$NAPCAT_INSTALL_PID"
    sleep 0.3
    napcat_watch_install
}

napcat_ensure_xvfb() {
    if command -v xvfb-run >/dev/null 2>&1; then
        return 0
    fi
    warn "呜喵… xvfb-run 还没装呢，正在尝试安装 啦～ (。•́︿•̀。)"
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1 || true
        apt-get install -y xvfb >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y xorg-x11-server-Xvfb >/dev/null 2>&1 || true
    fi
    command -v xvfb-run >/dev/null 2>&1
}

napcat_start() {
    napcat_detect_paths || {
        error "诶诶！ NapCat 还没装呢，请先安装框架 喵～ (｡•́︿•̀｡)"
        return 1
    }

    if napcat_is_running; then
        warn "呜喵… NapCat 已在后台运行 啦～ (｡•́︿•̀｡)"
        napcat_show_login_info
        return 0
    fi

    if ! napcat_ensure_xvfb; then
        error "呜哇！ 少了 xvfb-run，没法启动 NapCat 呢喵 (,,>﹏<,,)"
        return 1
    fi

    mkdir -p "$LOG_DIR"
    echo "===== NapCat start $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$NAPCAT_LOG"

    nohup bash -c "xvfb-run -a '${NAPCAT_QQ_BIN}' --no-sandbox" >> "$NAPCAT_LOG" 2>&1 &
    local pid=$!
    echo "$pid" > "$NAPCAT_PID_FILE"
    sleep 2

    if ! napcat_is_running; then
        sleep 3
        if ! napcat_is_running; then
            error "呜哇！ 启动失败了喵，看看日志: ${NAPCAT_LOG} 咯喵 (,,>﹏<,,)"
            tail -15 "$NAPCAT_LOG" 2>/dev/null || true
            return 1
        fi
    fi

    info "呐呐，正在等待 WebUI 就绪 呢喵 ₍˄·͈༝·͈˄₎"
    local i=0
    while (( i < 60 )); do
        if grep -qE 'WebUi.*(Panel Url|Token)' "$NAPCAT_LOG" 2>/dev/null; then
            break
        fi
        if ! napcat_is_running; then
            error "诶诶！ 进程已退出，启动失败了喵 (´･ω･)"
            tail -15 "$NAPCAT_LOG" 2>/dev/null || true
            return 1
        fi
        sleep 1
        ((i++)) || true
    done

    napcat_open_port_6099
    info "呐呐，NapCat 启动好啦 (后台运行) 喵♪ (๑•̀ㅂ•́)و✧"
    info "喵～ 退出 mk 菜单不会停止 NapCat，请使用「停止框架」关闭 呀～ ✧٩(ˊωˋ*)و✧"
    napcat_show_login_info
}

napcat_stop() {
    local pid=""

    if [[ -f "$NAPCAT_PID_FILE" ]]; then
        pid="$(tr -d '[:space:]' < "$NAPCAT_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$NAPCAT_PID_FILE"
    fi

    pkill -f "Napcat/opt/QQ/qq" 2>/dev/null || true
    pkill -f "/opt/QQ/qq" 2>/dev/null || true
    screen -S napcat -X quit 2>/dev/null || true

    sleep 1
    if napcat_is_running; then
        pkill -9 -f "Napcat/opt/QQ/qq" 2>/dev/null || true
        pkill -9 -f "/opt/QQ/qq" 2>/dev/null || true
    fi

    if napcat_is_running; then
        warn "呜喵… 部分进程可能仍在运行，手动检查 啦～ (。•́︿•̀。)"
        return 1
    fi

    info "喵～ NapCat 已经停下来啦 (๑ᵕᴗᵕ๑)"
}

napcat_restart() {
    info "喵～ 正在重启 NapCat 呀～ ✧٩(ˊωˋ*)و✧"
    napcat_stop || true
    sleep 2
    napcat_start
}

napcat_show_logs() {
    if [[ ! -f "$NAPCAT_LOG" ]]; then
        warn "诶…… 暂无运行日志 哦喵 (；´д｀)"
        if [[ -f "$NAPCAT_INSTALL_LOG" ]]; then
            info "诶嘿～ 可查看安装日志: ${NAPCAT_INSTALL_LOG} 呢喵 (๑>◡<๑)"
        fi
        return 1
    fi

    title "NapCat 运行日志 (最近 80 行) 哦喵 (｡•̀ᴗ-)✧"
    tail -n 80 "$NAPCAT_LOG"
    echo
    echo "  完整日志: ${NAPCAT_LOG} 咯喵 ✧٩(ˊωˋ*)و✧"
    echo "  实时跟踪: tail -f ${NAPCAT_LOG} 喵♪ ₍˄·͈༝·͈˄₎"
    echo
    info "小MK喵：退出菜单不会停止 NapCat 后台进程 哇～ (｡•̀ᴗ-)✧"
}

napcat_do_uninstall() {
    title "卸载 NapCat 框架 咯喵 ₍˄·͈༝·͈˄₎"
    echo "  将彻底删除 NapCat 目录、安装脚本及运行状态 喵♪ (๑ᵕᴗᵕ๑)"
    echo "  包括: ~/Napcat、napcat.sh、NapCat.Shell.zip 等 喵～ (｡•̀ᴗ-)✧"
    echo

    local confirm=""
    read -r -p "确认彻底卸载 NapCat? 呢喵 (,,>﹏<,,) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "小MK喵：那就不拆啦 (｡•̀ᴗ-)✧"
        return 0
    }

    napcat_stop || true

    rm -rf "${HOME}/Napcat" "${HOME}/napcat"
    rm -f "${HOME}/napcat.sh" "${HOME}/NapCat.Shell.zip" "${HOME}/napcat.zip"

    if [[ -d "/opt/QQ/resources/app/app_launcher/napcat" ]]; then
        rm -rf "/opt/QQ/resources/app/app_launcher/napcat"
        rm -f "/opt/QQ/resources/app/loadNapCat.js"
    fi

    rm -f /usr/local/bin/napcat 2>/dev/null || true
    rm -f "$NAPCAT_LOG" "$NAPCAT_PID_FILE" "$NAPCAT_INSTALL_LOG" "$NAPCAT_VER_FILE" 2>/dev/null || true
    napcat_clear_install_state

    info "呐呐，NapCat 已彻底卸载，可重新安装 呀喵 (｡•̀ᴗ-)✧"
}


napcat_get_config_dir() {
    napcat_detect_paths || return 1
    local dir=""
    dir="$(dirname "$NAPCAT_WEBUI_CFG")"
    if [[ -d "$dir" ]]; then
        echo "$dir"
        return 0
    fi
    return 1
}

napcat_cfg_require_python() {
    if command -v python3 >/dev/null 2>&1; then
        return 0
    fi
    warn "呜喵… 没找到 python3，正在尝试安装 啦～ (｡•́︿•̀｡)"
    if mk_is_termux; then
        # Termux 的包名是 python，装完提供的命令同时有 python 和 python3
        pkg install -y python >/dev/null 2>&1 || true
    elif command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1 || true
        apt-get install -y python3 >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y python3 >/dev/null 2>&1 || true
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        if mk_is_termux; then
            error "诶诶！ python3 装不上了喵，手动执行: pkg install python 喵～ (；´д｀)"
        fi
        return 1
    fi
    return 0
}

napcat_cfg_tool() {
    local config_dir=""
    config_dir="$(napcat_get_config_dir 2>/dev/null || true)"
    NAPCAT_CONFIG_DIR="$config_dir" python3 - "$@" << 'PYEOF'
import json, glob, os, sys

CONFIG_DIR = os.environ.get("NAPCAT_CONFIG_DIR", "")
CATS = [
    ("httpServers", "HTTP服务端"),
    ("httpClients", "HTTP客户端"),
    ("websocketServers", "WebSocket Server (正向)"),
    ("websocketClients", "WebSocket Client (反向)"),
    ("httpSseServers", "HTTP-SSE服务端"),
]

DEFAULT_CFG = {
    "network": {
        "httpServers": [],
        "httpSseServers": [],
        "httpClients": [],
        "websocketServers": [],
        "websocketClients": [],
        "plugins": [],
    },
    "musicSignUrl": "",
    "enableLocalFile2Url": False,
    "parseMultMsg": False,
    "imageDownloadProxy": "",
}

def find_config():
    if not CONFIG_DIR or not os.path.isdir(CONFIG_DIR):
        return None
    files = sorted(glob.glob(os.path.join(CONFIG_DIR, "onebot11_*.json")))
    if files:
        return files[-1]
    path = os.path.join(CONFIG_DIR, "onebot11.json")
    return path

def load_cfg(create=False):
    path = find_config()
    if not path:
        return None, None
    if not os.path.isfile(path):
        if not create:
            return path, None
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CFG, f, ensure_ascii=False, indent=2)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if "network" not in data:
        data["network"] = DEFAULT_CFG["network"].copy()
    for cat, _ in CATS:
        if cat not in data["network"]:
            data["network"][cat] = []
    if "plugins" not in data["network"]:
        data["network"]["plugins"] = []
    return path, data

def save_cfg(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def item_addr(cat, item):
    if cat in ("httpServers", "websocketServers", "httpSseServers"):
        host = item.get("host", "127.0.0.1")
        port = item.get("port", 0)
        return f"{host}:{port}"
    return item.get("url", "")

def parse_id(item_id):
    if ":" not in item_id:
        return None, None
    cat, idx = item_id.rsplit(":", 1)
    try:
        return cat, int(idx)
    except ValueError:
        return None, None

def cmd_list():
    path, data = load_cfg(create=False)
    if not path:
        print("ERROR|配置目录不存在", file=sys.stderr)
        sys.exit(1)
    if data is None:
        return
    for cat, label in CATS:
        arr = data["network"].get(cat, [])
        for i, item in enumerate(arr):
            name = item.get("name", "未命名")
            addr = item_addr(cat, item)
            enable = "true" if item.get("enable") else "false"
            print(f"{cat}:{i}\t{label}\t{name}\t{addr}\t{enable}\t{cat}")

def cmd_get(item_id):
    path, data = load_cfg(create=False)
    if not data:
        print("ERROR|配置文件不存在", file=sys.stderr)
        sys.exit(1)
    cat, idx = parse_id(item_id)
    if cat is None:
        sys.exit(1)
    arr = data["network"].get(cat, [])
    if idx < 0 or idx >= len(arr):
        sys.exit(1)
    item = arr[idx]
    label = dict(CATS).get(cat, cat)
    print(f"TYPE\t{label}")
    print(f"ID\t{item_id}")
    for k, v in item.items():
        print(f"{k}\t{v}")

def cmd_delete(item_id):
    path, data = load_cfg(create=False)
    if not data:
        print("ERROR|配置文件不存在", file=sys.stderr)
        sys.exit(1)
    cat, idx = parse_id(item_id)
    arr = data["network"].get(cat, [])
    if idx < 0 or idx >= len(arr):
        sys.exit(1)
    del arr[idx]
    save_cfg(path, data)
    print("OK")

def cmd_add(cat, name, addr1, addr2, token, enable):
    path, data = load_cfg(create=True)
    if not data:
        print("ERROR|无法创建配置", file=sys.stderr)
        sys.exit(1)
    item = {"name": name, "enable": enable == "y", "token": token, "debug": False}
    if cat in ("httpServers", "websocketServers", "httpSseServers"):
        item["host"] = addr1 or "0.0.0.0"
        item["port"] = int(addr2 or 3001)
        item["messagePostFormat"] = "array"
        if cat == "httpServers":
            item.update({"enableCors": True, "enableWebsocket": False})
        elif cat == "websocketServers":
            item.update({
                "reportSelfMessage": False,
                "enableForcePushEvent": True,
                "heartInterval": 30000,
            })
        elif cat == "httpSseServers":
            item.update({"enableCors": True, "reportSelfMessage": False})
    else:
        item["url"] = addr1
        item["messagePostFormat"] = "array"
        item["reportSelfMessage"] = False
        item["heartInterval"] = 30000
        if cat == "websocketClients":
            item["reconnectInterval"] = 5000
    data["network"].setdefault(cat, []).append(item)
    save_cfg(path, data)
    print(f"OK|{cat}:{len(data['network'][cat]) - 1}")

def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(1)
    action = args[0]
    if action == "list":
        cmd_list()
    elif action == "get" and len(args) >= 2:
        cmd_get(args[1])
    elif action == "delete" and len(args) >= 2:
        cmd_delete(args[1])
    elif action == "add" and len(args) >= 7:
        cmd_add(args[1], args[2], args[3], args[4], args[5], args[6])
    elif action == "path":
        print(find_config() or "")
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
PYEOF
}

napcat_port_listening() {
    local port="$1"
    [[ -z "$port" || "$port" == "0" ]] && return 1
    if command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | grep -qE ":${port}[[:space:]]" && return 0
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -tln 2>/dev/null | grep -qE ":${port}[[:space:]]" && return 0
    fi
    return 1
}

napcat_client_connected() {
    local url="$1"
    local fragment=""
    [[ -z "$url" ]] && return 1
    fragment="$(echo "$url" | sed -E 's|^https?://||; s|^wss?://||; s|/.*||')"
    [[ -z "$fragment" ]] && return 1
    if [[ -f "$NAPCAT_LOG" ]]; then
        if grep -qiF "$fragment" "$NAPCAT_LOG" 2>/dev/null; then
            if grep -qiE 'connect|connected|已连接|success' "$NAPCAT_LOG" 2>/dev/null; then
                return 0
            fi
        fi
    fi
    return 1
}

napcat_net_status_text() {
    local enable="$1" category="$2" addr="$3"
    local host="" port="" url=""

    if [[ "$enable" != "true" ]]; then
        echo -e "${YELLOW}还没打开呢 (｡•̀ᴗ-)✧${NC}"
        return
    fi
    if ! napcat_is_running; then
        echo -e "${RED}还没连上 喵～ ₍˄·͈༝·͈˄₎${NC}"
        return
    fi
    case "$category" in
        httpServers|websocketServers|httpSseServers)
            host="${addr%%:*}"
            port="${addr##*:}"
            if napcat_port_listening "$port"; then
                echo -e "${GREEN}连上啦 (｡•̀ᴗ-)✧${NC}"
            else
                echo -e "${RED}还没连上 呀喵 (๑•̀ㅂ•́)و✧${NC}"
            fi
            ;;
        httpClients|websocketClients)
            if napcat_client_connected "$addr"; then
                echo -e "${GREEN}连上啦 (๑>◡<๑)${NC}"
            else
                echo -e "${RED}还没连上 呀喵 ✧٩(ˊωˋ*)و✧${NC}"
            fi
            ;;
        *)
            echo -e "${YELLOW}未知 喵～ (๑>◡<๑)${NC}"
            ;;
    esac
}

napcat_cfg_check_ready() {
    if ! napcat_is_installed; then
        error "诶诶！ NapCat 还没装呢，请先安装框架 喵～ (｡•́︿•̀｡)"
        return 1
    fi
    if ! napcat_cfg_require_python; then
        error "小MK喵吓一跳！ 需要 python3 才能管理网络配置 哇～ (´･ω･)"
        return 1
    fi
    if [[ -z "$(napcat_get_config_dir 2>/dev/null || true)" ]]; then
        error "呜哇！ 找不到 NapCat 配置目录 啦喵 (；´д｀)"
        return 1
    fi
    return 0
}

napcat_is_server_category() {
    case "$1" in
        httpServers|websocketServers|httpSseServers) return 0 ;;
        *) return 1 ;;
    esac
}

napcat_cfg_get_field() {
    local item_id="$1" field="$2"
    napcat_cfg_tool get "$item_id" 2>/dev/null | awk -F'\t' -v f="$field" '$1==f { print $2; exit }'
}

napcat_cfg_port_used_by_others() {
    local port="$1" exclude_id="${2:-}"
    local line="" item_id="" addr="" category=""

    [[ -z "$port" ]] && return 1

    while IFS=$'\t' read -r item_id _ _ addr _ category; do
        [[ -z "$item_id" ]] && continue
        [[ -n "$exclude_id" && "$item_id" == "$exclude_id" ]] && continue
        case "$category" in
            httpServers|websocketServers|httpSseServers)
                if [[ "${addr##*:}" == "$port" ]]; then
                    return 0
                fi
                ;;
        esac
    done < <(napcat_cfg_tool list 2>/dev/null || true)
    return 1
}

napcat_cfg_delete_item() {
    local item_id="$1"
    local del_cat="" del_port=""

    del_cat="${item_id%%:*}"
    if napcat_is_server_category "$del_cat"; then
        del_port="$(napcat_cfg_get_field "$item_id" port)"
    fi

    if ! napcat_cfg_tool delete "$item_id"; then
        error "呜哇！ 删除失败 喵～ (,,>﹏<,,)"
        return 1
    fi

    info "呐呐，配置已删除，已立即生效 呢喵 (๑•̀ㅂ•́)و✧"

    if [[ -n "$del_port" && "$del_port" =~ ^[0-9]+$ && "$del_port" != "0" ]]; then
        if napcat_cfg_port_used_by_others "$del_port"; then
            info "呐呐，端口 ${del_port} 仍被其他配置使用，防火墙规则保留 啦喵 (｡•̀ᴗ-)✧"
        else
            napcat_firewall_close_port "$del_port"
        fi
    fi

    return 0
}

menu_napcat_net_add() {
    local choice="" cat="" name="" host="" port="" url="" token="" enable="y"

    while true; do
        title "新增网络配置 - 选择类型 喵～ (๑>◡<๑)"
        show_nav_hint
        echo "  [2] HTTP 服务端嘛"
        echo "  [3] HTTP 客户端嘛"
        echo "  [4] WebSocket Server (正向 WS，NapCat 监听)嘛"
        echo "  [5] WebSocket Client (反向 WS，NapCat 连出)嘛"
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back ;;
            2) cat="httpServers"; break ;;
            3) cat="httpClients"; break ;;
            4) cat="websocketServers"; break ;;
            5) cat="websocketClients"; break ;;
            *) warn "诶…… 看不懂选项，请重新输入 哦喵 (；´д｀)" ;;
        esac
    done

    echo
    read -r -p "配置名称 (唯一标识) 喵～:" name
    name="${name// /}"
    [[ -z "$name" ]] && name="NetCfg_$(date +%s)"

    if [[ "$cat" == "httpServers" || "$cat" == "websocketServers" ]]; then
        read -r -p "监听地址 咯喵 (；´д｀) [0.0.0.0]: " host
        host="${host:-0.0.0.0}"
        if [[ "$cat" == "httpServers" ]]; then
            read -r -p "监听端口 啦喵 (,,>﹏<,,) [3000]: " port
            port="${port:-3000}"
        else
            read -r -p "监听端口 呢喵 (´･ω･) [3001]: " port
            port="${port:-3001}"
        fi
        read -r -p "鉴权 Token (留空跳过) 喵～:" token
        read -r -p "是否启用? 啦喵 (；´д｀) [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        napcat_cfg_tool add "$cat" "$name" "$host" "$port" "$token" "$enable" || {
            error "呜哇！ 添加配置失败 呢喵 (,,>﹏<,,)"
            return 1
        }
        if [[ "$enable" == "y" && -n "$port" ]]; then
            napcat_firewall_open_port "$port"
        fi
    else
        if [[ "$cat" == "httpClients" ]]; then
            read -r -p "上报地址 咯喵 (´･ω･) [http://127.0.0.1:8080]: " url
            url="${url:-http://127.0.0.1:8080}"
        else
            read -r -p "连接地址 啦喵 (。•́︿•̀。) [ws://127.0.0.1:8082]: " url
            url="${url:-ws://127.0.0.1:8082}"
        fi
        read -r -p "鉴权 Token (留空跳过) 呢喵:" token
        read -r -p "是否启用? 咯喵 (,,>﹏<,,) [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        napcat_cfg_tool add "$cat" "$name" "$url" "" "$token" "$enable" || {
            error "呜哇！ 添加配置失败 啦喵 (´･ω･)"
            return 1
        }
    fi

    local cfg_path=""
    cfg_path="$(napcat_cfg_tool path 2>/dev/null || true)"
    info "喵～ 配置已保存: ${cfg_path:-onebot11.json} 咯～ (๑ᵕᴗᵕ๑)"
    info "小MK喵：网络配置已立即生效，无需重启 NapCat 哇～ (｡•̀ᴗ-)✧"
}

menu_napcat_net_detail() {
    local item_id="$1"
    local choice="" confirm=""

    while true; do
        title "网络配置详情 呀喵 (๑•̀ㅂ•́)و✧"
        show_nav_hint
        echo "  [3] 删除本配置呢"
        echo

        napcat_cfg_tool get "$item_id" 2>/dev/null | while IFS=$'\t' read -r key val; do
            case "$key" in
                TYPE) echo "  类型:     ${val}" ;;
                ID)   echo "  标识:     ${val}" ;;
                name) echo "  名称:     ${val}" ;;
                enable) echo "  启用:     ${val}" ;;
                host) echo "  监听地址: ${val}" ;;
                port) echo "  监听端口: ${val}" ;;
                url)  echo "  连接地址: ${val}" ;;
                token)
                    if [[ -n "$val" ]]; then
                        echo "  Token:    ${val}"
                    fi
                    ;;
            esac
        done
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            3)
                read -r -p "确认删除此配置? 呀喵 (；´д｀) [y/N]: " confirm
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    napcat_cfg_delete_item "$item_id"
                    press_enter
                    mk_nav_back
                    return 0
                fi
                ;;
            *) warn "诶…… 看不懂选项，请重新输入 呢喵 (,,>﹏<,,)" ;;
        esac
    done
}

menu_napcat_network() {
    napcat_cfg_check_ready || {
        press_enter
        mk_nav_back
        return 0
    }

    declare -A NET_ITEM_MAP=()

    while true; do
        local lines=()
        local line="" choice=""
        local menu_idx=4
        local item_id="" type_label="" name="" addr="" enable="" category="" status=""

        unset NET_ITEM_MAP
        declare -A NET_ITEM_MAP=()

        title "网络配置 喵♪ (๑>◡<๑)"
        show_nav_hint
        echo "  [3] 新增配置咯"
        echo

        mapfile -t lines < <(napcat_cfg_tool list 2>/dev/null || true)
        if [[ ${#lines[@]} -eq 0 || -z "${lines[0]:-}" ]]; then
            echo "  (暂无网络配置) 喵♪ (๑•̀ㅂ•́)و✧"
        else
            for line in "${lines[@]}"; do
                IFS=$'\t' read -r item_id type_label name addr enable category <<< "$line"
                status="$(napcat_net_status_text "$enable" "$category" "$addr")"
                NET_ITEM_MAP[$menu_idx]="$item_id"
                echo -e "  [${menu_idx}] ${type_label} | ${name} | ${addr} | ${status}"
                ((menu_idx++)) || true
            done
        fi
        echo
        info "配置文件: $(napcat_cfg_tool path 2>/dev/null || echo 未知)"
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            3) menu_napcat_net_add || true
               if mk_nav_bubble_up; then
                   return 0
               fi
               press_enter ;;
            *)
                if [[ -n "${NET_ITEM_MAP[$choice]:-}" ]]; then
                    menu_napcat_net_detail "${NET_ITEM_MAP[$choice]}" || true
                    if mk_nav_bubble_up; then
                        return 0
                    fi
                else
                    warn "诶…… 看不懂选项，请重新输入 啦喵 (,,>﹏<,,)"
                fi
                ;;
        esac
    done
}

menu_napcat_configure() {
    while true; do
        title "配置框架 呀喵 (๑ᵕᴗᵕ๑)"
        show_nav_hint
        echo "  [2] 网络配置啦"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) menu_napcat_network || true
               if mk_nav_bubble_up; then
                   return 0
               fi
               ;;
            *) warn "诶…… 看不懂选项，请重新输入 呢喵 (｡•́︿•̀｡)" ;;
        esac
    done
}

menu_napcat() {
    if napcat_install_running; then
        info "喵～ 小MK发现 NapCat 正在后台安装，正在找回进度显示 呀～ ✧٩(ˊωˋ*)و✧"
        napcat_watch_install
        echo
    fi

    while true; do
        local napcat_title="NapCat 操作"
        local napcat_ver=""
        napcat_ver="$(napcat_get_display_version)"
        if [[ -n "$napcat_ver" ]]; then
            napcat_title="NapCat 操作 ----- ${napcat_ver}"
        fi
        title "$napcat_title"
        show_nav_hint
        echo "  [2] 安装框架-后台安装咯"
        echo "  [3] 启动框架咯"
        echo "  [4] 停止框架咯"
        echo "  [5] 重启框架咯"
        echo "  [6] 配置框架咯"
        echo "  [7] 卸载框架咯"
        echo "  [8] 查看日志咯"
        echo "  [9] 查看NapCat面板登录密钥咯"
        if napcat_install_running; then
            echo "  [10] 查看安装进度咯"
            echo
            echo -e "  ${YELLOW}* NapCat 正在后台努力装 啦喵 ₍˄·͈༝·͈˄₎${NC}"
        elif napcat_is_running; then
            echo
            echo -e "  ${GREEN}* NapCat 正在后台运行 呢喵 (๑>◡<๑)${NC}"
        elif napcat_is_installed; then
            echo
            echo -e "  ${YELLOW}* NapCat 已经装好啦 (没在跑呢) 喵～ ₍˄·͈༝·͈˄₎${NC}"
        else
            echo
            echo -e "  ${YELLOW}* NapCat 还没装呢 (๑>◡<๑)${NC}"
        fi
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) napcat_do_install || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            3) napcat_start; press_enter ;;
            4) napcat_stop; press_enter ;;
            5) napcat_restart; press_enter ;;
            6) menu_napcat_configure || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               ;;
            7) napcat_do_uninstall; press_enter ;;
            8) napcat_show_logs; press_enter ;;
            9) napcat_show_login_info; press_enter ;;
            10)
                if napcat_install_running; then
                    napcat_watch_install
                    press_enter
                else
                    warn "小MK喵小声说：当前没有安装任务 呀～ (；´д｀)"
                fi
                ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (,,>﹏<,,)" ;;
        esac
    done
}


# ==================== SnowLuma ====================

readonly SNOWLUMA_HOME="/opt/SnowLuma"
readonly SNOWLUMA_DOCKER_IMAGE="motricseven7/snowluma:latest"
readonly SNOWLUMA_DOCKER_NAME="snowluma"
readonly SNOWLUMA_LOG="${LOG_DIR}/snowluma-runtime.log"
readonly SNOWLUMA_PID_FILE="${LOG_DIR}/snowluma.pid"
readonly SNOWLUMA_INSTALL_LOG="${LOG_DIR}/snowluma-install.log"
readonly SNOWLUMA_MODE_FILE="${LOG_DIR}/snowluma.mode"
readonly SNOWLUMA_VER_FILE="${LOG_DIR}/snowluma.version"
readonly SNOWLUMA_QQ_LOG="${LOG_DIR}/snowluma-qq.log"
readonly SNOWLUMA_QQ_PID="${LOG_DIR}/snowluma-qq.pid"
readonly SNOWLUMA_QQ_STOP_FLAG="${LOG_DIR}/snowluma-qq.stop"
readonly SNOWLUMA_WEBUI_PORT="5099"
# 常规安装扫码桌面（端口可配，默认对齐 Docker：VNC 5900 / noVNC 6081）
readonly SNOWLUMA_DISPLAY=":99"
readonly SNOWLUMA_DISPLAY_NUM="99"
readonly SNOWLUMA_VNC_PORT_DEFAULT="5900"
readonly SNOWLUMA_NOVNC_PORT_DEFAULT="6081"
readonly SNOWLUMA_VNC_PASS_DEFAULT="vncpasswd"
readonly SNOWLUMA_VNC_CFG="${LOG_DIR}/snowluma-vnc.env"
readonly SNOWLUMA_VNC_PASSFILE="${LOG_DIR}/snowluma-vnc.passwd"
readonly SNOWLUMA_XVFB_PID="${LOG_DIR}/snowluma-xvfb.pid"
readonly SNOWLUMA_WM_PID="${LOG_DIR}/snowluma-wm.pid"
readonly SNOWLUMA_VNC_PID="${LOG_DIR}/snowluma-vnc.pid"
readonly SNOWLUMA_NOVNC_PID="${LOG_DIR}/snowluma-novnc.pid"
readonly SNOWLUMA_VNC_LOG="${LOG_DIR}/snowluma-vnc.log"
readonly SNOWLUMA_NOVNC_DIR="${INSTALL_DIR}/novnc"

SNOWLUMA_VNC_PORT="$SNOWLUMA_VNC_PORT_DEFAULT"
SNOWLUMA_NOVNC_PORT="$SNOWLUMA_NOVNC_PORT_DEFAULT"
SNOWLUMA_VNC_PASS="$SNOWLUMA_VNC_PASS_DEFAULT"

snowluma_vnc_load_cfg() {
    SNOWLUMA_VNC_PORT="${SNOWLUMA_VNC_PORT_DEFAULT}"
    SNOWLUMA_NOVNC_PORT="${SNOWLUMA_NOVNC_PORT_DEFAULT}"
    SNOWLUMA_VNC_PASS="${SNOWLUMA_VNC_PASS_DEFAULT}"
    if [[ -f "$SNOWLUMA_VNC_CFG" ]]; then
        # shellcheck disable=SC1090
        source "$SNOWLUMA_VNC_CFG" 2>/dev/null || true
    fi
    [[ -n "${MK_SNOWLUMA_VNC_PORT:-}" ]] && SNOWLUMA_VNC_PORT="$MK_SNOWLUMA_VNC_PORT"
    [[ -n "${MK_SNOWLUMA_NOVNC_PORT:-}" ]] && SNOWLUMA_NOVNC_PORT="$MK_SNOWLUMA_NOVNC_PORT"
    [[ -n "${MK_SNOWLUMA_VNC_PASS:-}" ]] && SNOWLUMA_VNC_PASS="$MK_SNOWLUMA_VNC_PASS"
    [[ "$SNOWLUMA_VNC_PORT" =~ ^[0-9]+$ ]] && (( SNOWLUMA_VNC_PORT >= 1 && SNOWLUMA_VNC_PORT <= 65535 )) \
        || SNOWLUMA_VNC_PORT="$SNOWLUMA_VNC_PORT_DEFAULT"
    [[ "$SNOWLUMA_NOVNC_PORT" =~ ^[0-9]+$ ]] && (( SNOWLUMA_NOVNC_PORT >= 1 && SNOWLUMA_NOVNC_PORT <= 65535 )) \
        || SNOWLUMA_NOVNC_PORT="$SNOWLUMA_NOVNC_PORT_DEFAULT"
    [[ -n "$SNOWLUMA_VNC_PASS" ]] || SNOWLUMA_VNC_PASS="$SNOWLUMA_VNC_PASS_DEFAULT"
}

snowluma_vnc_save_cfg() {
    mkdir -p "$LOG_DIR"
    cat > "$SNOWLUMA_VNC_CFG" <<EOF
# mk SnowLuma 扫码桌面端口配置（菜单可改）
SNOWLUMA_VNC_PORT="${SNOWLUMA_VNC_PORT}"
SNOWLUMA_NOVNC_PORT="${SNOWLUMA_NOVNC_PORT}"
SNOWLUMA_VNC_PASS="${SNOWLUMA_VNC_PASS}"
EOF
    if command -v x11vnc >/dev/null 2>&1; then
        x11vnc -storepasswd "$SNOWLUMA_VNC_PASS" "$SNOWLUMA_VNC_PASSFILE" >/dev/null 2>&1 || true
    fi
}

menu_snowluma_vnc_config() {
    local np vp pw
    snowluma_vnc_load_cfg
    title "配置扫码桌面端口 喵♪ (๑>◡<๑)"
    show_nav_hint
    echo "  当前 noVNC 端口: ${SNOWLUMA_NOVNC_PORT}  (浏览器扫码，默认 6081，可改) 啦喵 ✧٩(ˊωˋ*)و✧"
    echo "  当前 VNC 端口:   ${SNOWLUMA_VNC_PORT}  (客户端，默认 5900，可改) 哦喵 ₍˄·͈༝·͈˄₎"
    echo "  当前 VNC 密码:   ${SNOWLUMA_VNC_PASS} 呀喵 (๑ᵕᴗᵕ๑)"
    echo "  配置文件: ${SNOWLUMA_VNC_CFG} 呢喵 (｡•̀ᴗ-)✧"
    echo
    echo "  直接回车保留原值；改完后需重启扫码桌面/QQ 才生效 喵♪ (๑•̀ㅂ•́)و✧"
    echo
    read -r -p "noVNC 端口 啦喵 (；´д｀) [${SNOWLUMA_NOVNC_PORT}]: " np
    read -r -p "VNC 端口 哦喵 (´･ω･) [${SNOWLUMA_VNC_PORT}]: " vp
    read -r -p "VNC 密码 呀喵 (｡•́︿•̀｡) [${SNOWLUMA_VNC_PASS}]: " pw
    np="$(normalize_choice "${np:-}")"
    vp="$(normalize_choice "${vp:-}")"
    pw="${pw#"${pw%%[![:space:]]*}"}"
    pw="${pw%"${pw##*[![:space:]]}"}"
    [[ -n "$np" ]] && SNOWLUMA_NOVNC_PORT="$np"
    [[ -n "$vp" ]] && SNOWLUMA_VNC_PORT="$vp"
    [[ -n "$pw" ]] && SNOWLUMA_VNC_PASS="$pw"
    if ! [[ "$SNOWLUMA_NOVNC_PORT" =~ ^[0-9]+$ ]] || (( SNOWLUMA_NOVNC_PORT < 1 || SNOWLUMA_NOVNC_PORT > 65535 )); then
        error "小MK喵吓一跳！ noVNC 端口看不懂 呀～ (´･ω･)"
        return 1
    fi
    if ! [[ "$SNOWLUMA_VNC_PORT" =~ ^[0-9]+$ ]] || (( SNOWLUMA_VNC_PORT < 1 || SNOWLUMA_VNC_PORT > 65535 )); then
        error "呜哇！ VNC 端口看不懂 哦喵 (；´д｀)"
        return 1
    fi
    if [[ "$SNOWLUMA_NOVNC_PORT" == "$SNOWLUMA_VNC_PORT" ]]; then
        error "诶诶！ noVNC 与 VNC 端口不能相同 喵♪ (。•́︿•̀。)"
        return 1
    fi
    snowluma_vnc_save_cfg
    info "诶嘿～ 已保存: noVNC=${SNOWLUMA_NOVNC_PORT}  VNC=${SNOWLUMA_VNC_PORT} 呀喵 ✧٩(ˊωˋ*)و✧"
    if snowluma_vnc_is_running || snowluma_qq_is_running; then
        local restart=""
        read -r -p "扫码桌面/QQ 正在跑，是否立即按新端口重启? 喵♪ (´･ω･) [y/N]: " restart
        if [[ "$restart" =~ ^[Yy]$ ]]; then
            local qq_was=0
            snowluma_qq_is_running && qq_was=1
            snowluma_qq_stop || true
            if (( qq_was == 1 )); then
                snowluma_qq_start || true
            else
                snowluma_vnc_start_stack || true
            fi
        else
            warn "诶…… 请稍后手动「停止」再「启动」使新端口生效 呀喵 (｡•́︿•̀｡)"
        fi
    fi
}

# QQ 兼容目录：ver|arches|pkg|snow_min|note|url1;url2;...
# 官网已迁到 dldir1v6.qq.com；旧 qqdl.gtimg.cn / dldir1.qq.com 在不少网络会 404
# URL 支持 {ARCH}；以 GH: 开头的走 GitHub 镜像代理
# SnowLuma compat/qq.json 当前 allowUnknown=true
snowluma_qq_catalog=(
    "3.2.28-260429|amd64 arm64|deb|v1.0.0|官网新域名+归档|https://dldir1v6.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.28_260429_{ARCH}_01.deb;GH:https://github.com/zydou/QQ-Linux/releases/download/3.2.28-260429/QQ-3.2.28-260429-{ARCH}.deb;GH:https://github.com/libzonda/Linux-QQ-release/releases/download/3.2.28/QQ_3.2.28_260429_{ARCH}_01.deb"
    "3.2.27-260401|amd64 arm64|deb|v1.0.0|官网新域名+归档|https://dldir1v6.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.27_260401_{ARCH}_01.deb;GH:https://github.com/zydou/QQ-Linux/releases/download/3.2.27-260401/QQ-3.2.27-260401-{ARCH}.deb;GH:https://github.com/libzonda/Linux-QQ-release/releases/download/3.2.27/QQ_3.2.27_260401_{ARCH}_01.deb"
    "3.2.19-250904|amd64 arm64|deb|v1.0.0|较旧稳定归档|https://dldir1v6.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.19_250904_{ARCH}_01.deb;GH:https://github.com/zydou/QQ-Linux/releases/download/3.2.19-250904/QQ-3.2.19-250904-{ARCH}.deb"
    "3.2.32-51802|amd64 arm64|deb|v1.12.0|旧 qqdl 通道（可能 404）|https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/beta/c97651b2/linuxqq_3.2.32-51802_{ARCH}.deb"
    "3.2.31-51102|amd64 arm64|deb|v1.6.0|SnowLuma Docker 默认（旧 qqdl，可能 404）|https://qqdl.gtimg.cn/qqfile/QQNT/9.9.32/beta/c390e792/linuxqq_3.2.31-51102_{ARCH}.deb;https://qqdl.gtimg.cn/qqfile/QQNT/9.9.32/patch/c390e792/linuxqq_3.2.31-51102_{ARCH}.deb"
)

snowluma_mirror_labels=(
    "直连 GitHub (国外/可访问 GitHub 的服务器)"
    "ghfast.top"
    "git.yylx.win"
    "gh-proxy.com"
    "ghfile.geekertao.top"
    "gh-proxy.net"
    "j.1win.ggff.net"
    "ghm.078465.xyz"
    "gitproxy.127731.xyz"
    "jiashu.1win.eu.org"
    "github.tbedu.top"
)

snowluma_detect_arch() {
    local m
    m="$(uname -m 2>/dev/null || echo unknown)"
    case "$m" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) echo "$m" ;;
    esac
}

snowluma_detect_pkg() {
    if command -v dpkg >/dev/null 2>&1; then
        echo "deb"
    elif command -v rpm >/dev/null 2>&1; then
        echo "rpm"
    else
        echo "deb"
    fi
}

snowluma_ver_ge() {
    # $1 >= $2 ?  (vX.Y.Z)
    local a="${1#v}" b="${2#v}"
    [[ -z "$b" ]] && return 0
    [[ -z "$a" || "$a" == "latest" || "$a" == "unknown" || "$a" == "docker" ]] && return 0
    printf '%s\n%s\n' "$b" "$a" | sort -V | head -1 | grep -qx "$b"
}

snowluma_get_mode() {
    if [[ -f "$SNOWLUMA_MODE_FILE" ]]; then
        tr -d '[:space:]' < "$SNOWLUMA_MODE_FILE" 2>/dev/null || true
        return 0
    fi
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        echo "docker"
        return 0
    fi
    if [[ -x "${SNOWLUMA_HOME}/launcher.sh" || -f "${SNOWLUMA_HOME}/index.mjs" ]]; then
        echo "native"
        return 0
    fi
    echo ""
}

snowluma_set_mode() {
    mkdir -p "$LOG_DIR"
    printf '%s\n' "$1" > "$SNOWLUMA_MODE_FILE"
}

snowluma_get_display_version() {
    local ver="" mode=""
    mode="$(snowluma_get_mode)"
    if [[ -f "$SNOWLUMA_VER_FILE" ]]; then
        ver="$(tr -d '[:space:]' < "$SNOWLUMA_VER_FILE" 2>/dev/null || true)"
    fi
    if [[ -z "$ver" && "$mode" == "docker" ]]; then
        ver="docker"
    fi
    if [[ -z "$ver" && -f "${SNOWLUMA_HOME}/package.json" ]] && command -v python3 >/dev/null 2>&1; then
        ver="$(python3 - "$SNOWLUMA_HOME/package.json" <<'PY' 2>/dev/null || true
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8")).get("version",""))
PY
)"
        [[ -n "$ver" ]] && ver="v${ver#v}"
    fi
    printf '%s' "$ver"
}

snowluma_is_installed() {
    local mode
    mode="$(snowluma_get_mode)"
    case "$mode" in
        docker)
            docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"
            ;;
        native)
            [[ -x "${SNOWLUMA_HOME}/launcher.sh" || -f "${SNOWLUMA_HOME}/index.mjs" ]]
            ;;
        *)
            return 1
            ;;
    esac
}

snowluma_is_running() {
    local mode
    mode="$(snowluma_get_mode)"
    case "$mode" in
        docker)
            docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"
            ;;
        native)
            if [[ -f "$SNOWLUMA_PID_FILE" ]]; then
                local pid
                pid="$(tr -d '[:space:]' < "$SNOWLUMA_PID_FILE" 2>/dev/null || true)"
                if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
                    return 0
                fi
            fi
            pgrep -f "${SNOWLUMA_HOME}/.*index\.mjs" >/dev/null 2>&1 \
                || pgrep -f "${SNOWLUMA_HOME}/launcher.sh" >/dev/null 2>&1
            ;;
        *)
            return 1
            ;;
    esac
}

snowluma_qq_is_installed() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        docker exec "$SNOWLUMA_DOCKER_NAME" test -x /opt/QQ/qq >/dev/null 2>&1
        return $?
    fi
    [[ -x "/opt/QQ/qq" ]]
}

# 列出真正挂在 /opt/QQ 下的进程（按 /proc/pid/exe，避免 pgrep -f 误判）
snowluma_qq_real_pids() {
    local pid exe
    for pid in $(pgrep -f '/opt/QQ/' 2>/dev/null || true); do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        exe="$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)"
        if [[ "$exe" == /opt/QQ/* ]]; then
            printf '%s\n' "$pid"
        fi
    done
}

snowluma_qq_proc_display() {
    local pid="$1"
    local envf="/proc/${pid}/environ"
    [[ -r "$envf" ]] || return 1
    tr '\0' '\n' < "$envf" 2>/dev/null | sed -n 's/^DISPLAY=//p' | head -n1
}

# QQ 是否挂在本脚本的扫码虚拟屏上
snowluma_qq_on_mk_display() {
    local pid disp
    for pid in $(snowluma_qq_real_pids); do
        disp="$(snowluma_qq_proc_display "$pid" || true)"
        if [[ "$disp" == "$SNOWLUMA_DISPLAY" ]]; then
            return 0
        fi
    done
    return 1
}

snowluma_xvfb_is_up() {
    snowluma_pidfile_running "$SNOWLUMA_XVFB_PID" \
        || [[ -S "/tmp/.X11-unix/X${SNOWLUMA_DISPLAY_NUM}" ]] \
        || pgrep -f "Xvfb ${SNOWLUMA_DISPLAY}" >/dev/null 2>&1
}

snowluma_qq_is_running() {
    local mode pid
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        docker exec "$SNOWLUMA_DOCKER_NAME" pgrep -f '/opt/QQ/qq' >/dev/null 2>&1
        return $?
    fi
    if [[ -f "$SNOWLUMA_QQ_PID" ]]; then
        pid="$(tr -d '[:space:]' < "$SNOWLUMA_QQ_PID" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            local exe
            exe="$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)"
            if [[ "$exe" == /opt/QQ/* ]]; then
                return 0
            fi
            # pid 文件陈旧（进程已不是 QQ）
            rm -f "$SNOWLUMA_QQ_PID"
        fi
    fi
    # 精确：至少有一个 /opt/QQ/* 可执行在跑
    local any=""
    any="$(snowluma_qq_real_pids 2>/dev/null | head -n1 || true)"
    [[ -n "$any" ]]
}

snowluma_build_dl_url() {
    local raw_url="$1"
    local proxy_idx="${2:-0}"
    case "$proxy_idx" in
        1)  echo "https://ghfast.top/${raw_url}" ;;
        2)  echo "https://git.yylx.win/${raw_url}" ;;
        3)  echo "https://gh-proxy.com/${raw_url}" ;;
        4)  echo "https://ghfile.geekertao.top/${raw_url}" ;;
        5)  echo "https://gh-proxy.net/${raw_url}" ;;
        6)  echo "https://j.1win.ggff.net/${raw_url}" ;;
        7)  echo "https://ghm.078465.xyz/${raw_url}" ;;
        8)  echo "https://gitproxy.127731.xyz/${raw_url}" ;;
        9)  echo "https://jiashu.1win.eu.org/${raw_url}" ;;
        10) echo "https://github.tbedu.top/${raw_url}" ;;
        *)  echo "$raw_url" ;;
    esac
}

snowluma_open_ports() {
    local ports=("$@")
    local port
    for port in "${ports[@]}"; do
        napcat_firewall_open_port "$port" 2>/dev/null || true
        if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
            ufw allow "${port}/tcp" >/dev/null 2>&1 || true
        elif command -v firewall-cmd >/dev/null 2>&1; then
            firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
            firewall-cmd --reload >/dev/null 2>&1 || true
        elif command -v iptables >/dev/null 2>&1; then
            iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || \
                iptables -I INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || true
        fi
    done
}

menu_snowluma_select_mirror() {
    local i=0 idx=0
    SNOWLUMA_PROXY_INDEX="${SNOWLUMA_PROXY_INDEX:-0}"
    while true; do
        title "选择下载镜像源 哦喵 ₍˄·͈༝·͈˄₎"
        show_nav_hint
        echo "  国内服务器若没法访问 GitHub，请选择嘛镜像源 呢喵 (｡•̀ᴗ-)✧"
        echo
        for ((i=0; i<${#snowluma_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            echo "  [${idx}] ${snowluma_mirror_labels[$i]}"
        done
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#snowluma_mirror_labels[@]} )); then
                        SNOWLUMA_PROXY_INDEX="$idx"
                        info "诶嘿～ 已选择: ${snowluma_mirror_labels[$idx]} 喵～ (๑ᵕᴗᵕ๑)"
                        return 0
                    fi
                fi
                warn "小MK喵小声说：看不懂选项，请重新输入 呀～ (´･ω･)"
                ;;
        esac
    done
}

menu_snowluma_select_version() {
    SNOWLUMA_VERSION_TAG="latest"
    SNOWLUMA_VERSION_LABEL="最新版"
    while true; do
        title "选择 SnowLuma 版本 喵～ (๑>◡<๑)"
        show_nav_hint
        echo "  [2] 最新版 (GitHub Releases latest)嘛"
        echo "  [3] 手动输入版本号 (如 v1.13.0)嘛"
        echo
        local choice="" tag=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                SNOWLUMA_VERSION_TAG="latest"
                SNOWLUMA_VERSION_LABEL="最新版"
                return 0
                ;;
            3)
                read -r -p "请输入嘛版本号 (如 v1.13.0) 哦喵:" tag
                tag="$(normalize_choice "$tag")"
                if [[ -z "$tag" ]]; then
                    warn "诶…… 版本号不能为空 咯喵 (；´д｀)"
                    continue
                fi
                [[ "$tag" != v* ]] && tag="v${tag}"
                SNOWLUMA_VERSION_TAG="$tag"
                SNOWLUMA_VERSION_LABEL="$tag"
                return 0
                ;;
            *) warn "呜喵… 看不懂选项，请重新输入 呢～ (,,>﹏<,,)" ;;
        esac
    done
}

menu_snowluma_select_mode() {
    SNOWLUMA_INSTALL_MODE=""
    while true; do
        title "选择 SnowLuma 安装模式 喵～ (｡•̀ᴗ-)✧"
        show_nav_hint
        echo "  [2] Docker 安装 (推荐 · 内置 QQ + VNC/noVNC)"
        echo "  [3] 直接安装 (解压发行包到 ${SNOWLUMA_HOME})"
        echo
        echo "  Docker：镜像 ${SNOWLUMA_DOCKER_IMAGE} 咯喵 (๑ᵕᴗᵕ๑)"
        echo "  直接安装：需本机自行装兼容 QQ，WebUI 默认 ${SNOWLUMA_WEBUI_PORT} 喵♪ (｡•̀ᴗ-)✧"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) SNOWLUMA_INSTALL_MODE="docker"; return 0 ;;
            3) SNOWLUMA_INSTALL_MODE="native"; return 0 ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 呀～ (´･ω･)" ;;
        esac
    done
}

snowluma_resolve_release_tag() {
    local want="$1" proxy_idx="${2:-0}" api_url tag
    if [[ "$want" != "latest" ]]; then
        echo "$want"
        return 0
    fi
    api_url="$(snowluma_build_dl_url "https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest" "$proxy_idx")"
    tag="$(curl -fsSL -A 'mk-tools' "$api_url" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
    if [[ -n "$tag" ]]; then
        echo "$tag"
        return 0
    fi
    warn "诶…… 没法解析 latest，回退使用 v1.13.0 呢喵 (,,>﹏<,,)"
    echo "v1.13.0"
}

snowluma_native_asset_name() {
    local tag="$1" arch
    arch="$(snowluma_detect_arch)"
    case "$arch" in
        amd64) echo "SnowLuma-${tag}-linux-x64.tar.gz" ;;
        arm64) echo "SnowLuma-${tag}-linux-arm64.tar.gz" ;;
        *)
            error "呜哇！ 帮不上忙的架构: ${arch}（仅 amd64/arm64） 啦喵 (。•́︿•̀。)"
            return 1
            ;;
    esac
}

snowluma_install_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        error "小MK喵吓一跳！ 小MK没找到 docker，请先安装 Docker 后再选 Docker 模式 呀～ (｡•́︿•̀｡)"
        return 1
    fi

    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        local re=""
        warn "小MK喵小声说：已经有同名容器: ${SNOWLUMA_DOCKER_NAME} 呀～ (,,>﹏<,,)"
        read -r -p "是否删除并重建? 哦喵 (。•́︿•̀。) [y/N]: " re
        [[ "$re" =~ ^[Yy]$ ]] || return 0
        docker rm -f "$SNOWLUMA_DOCKER_NAME" >/dev/null 2>&1 || true
    fi

    info "诶嘿～ 拉取镜像 ${SNOWLUMA_DOCKER_IMAGE} 喵～ ✧٩(ˊωˋ*)و✧"
    if ! docker pull "$SNOWLUMA_DOCKER_IMAGE"; then
        error "诶诶！ 拉取镜像失败 哦喵 (´･ω･)"
        return 1
    fi

    info "喵～ 创建并启动容器 呀～ ✧٩(ˊωˋ*)و✧"
    docker run -d \
        --name "$SNOWLUMA_DOCKER_NAME" \
        --restart unless-stopped \
        --shm-size=1g \
        --cap-add=SYS_PTRACE \
        --security-opt seccomp=unconfined \
        -e VNC_PASSWD=vncpasswd \
        -e SNOWLUMA_WEBUI_PORT="${SNOWLUMA_WEBUI_PORT}" \
        -e SNOWLUMA_ACCEPT_EULA=1 \
        -e SNOWLUMA_ACCEPT_PRIVACY=1 \
        -e TZ=Asia/Shanghai \
        -p 5900:5900 \
        -p 6081:6081 \
        -p "${SNOWLUMA_WEBUI_PORT}:${SNOWLUMA_WEBUI_PORT}" \
        -p 3000:3000 \
        -p 3001:3001 \
        -v snowluma-data:/app/snowluma-data \
        -v snowluma-qq-config:/app/.config \
        -v snowluma-qq-data:/app/.local/share \
        "$SNOWLUMA_DOCKER_IMAGE"

    snowluma_set_mode "docker"
    echo "docker" > "$SNOWLUMA_VER_FILE"
    snowluma_open_ports 5900 6081 "$SNOWLUMA_WEBUI_PORT" 3000 3001
    info "小MK喵：Docker 装好啦 ₍˄·͈༝·͈˄₎"
    snowluma_show_login_info
}

snowluma_install_native() {
    local proxy_idx="${SNOWLUMA_PROXY_INDEX:-0}"
    local tag asset raw_url dl_url tmpdir

    require_root || return 1
    tag="$(snowluma_resolve_release_tag "${SNOWLUMA_VERSION_TAG:-latest}" "$proxy_idx")"
    asset="$(snowluma_native_asset_name "$tag")" || return 1
    raw_url="https://github.com/SnowLuma/SnowLuma/releases/download/${tag}/${asset}"
    dl_url="$(snowluma_build_dl_url "$raw_url" "$proxy_idx")"

    mkdir -p "$LOG_DIR" "$SNOWLUMA_HOME"
    tmpdir="$(mktemp -d /tmp/snowluma-install.XXXXXX)"
    info "小MK喵：下载 ${asset} 哦～ (๑•̀ㅂ•́)و✧"
    info "URL: ${dl_url}"
    if ! curl -fL --retry 3 --connect-timeout 30 -A 'mk-tools' -o "${tmpdir}/${asset}" "$dl_url"; then
        error "诶诶！ 下载失败 啦喵 (。•́︿•̀。)"
        rm -rf "$tmpdir"
        return 1
    fi

    info "小MK喵：解压到 ${SNOWLUMA_HOME} 呢～ ₍˄·͈༝·͈˄₎"
    if [[ -d "$SNOWLUMA_HOME" ]] && [[ -n "$(ls -A "$SNOWLUMA_HOME" 2>/dev/null || true)" ]]; then
        local bak="${SNOWLUMA_HOME}.bak.$(date +%Y%m%d%H%M%S)"
        warn "呜喵… 已有文件，备份到 ${bak} 啦～ (｡•́︿•̀｡)"
        mv "$SNOWLUMA_HOME" "$bak"
        mkdir -p "$SNOWLUMA_HOME"
    fi

    tar -xzf "${tmpdir}/${asset}" -C "$tmpdir"
    # 发行包可能多一层目录
    if [[ -f "${tmpdir}/launcher.sh" ]]; then
        cp -a "${tmpdir}/." "$SNOWLUMA_HOME/"
    else
        local inner
        inner="$(find "$tmpdir" -maxdepth 2 -type f -name launcher.sh 2>/dev/null | head -1 || true)"
        if [[ -n "$inner" ]]; then
            cp -a "$(dirname "$inner")/." "$SNOWLUMA_HOME/"
        else
            # lite/完整版也可能只有 index.mjs
            inner="$(find "$tmpdir" -maxdepth 2 -type f -name index.mjs 2>/dev/null | head -1 || true)"
            if [[ -z "$inner" ]]; then
                error "呜哇！ 解压后没找到 launcher.sh / index.mjs 喵♪ (；´д｀)"
                rm -rf "$tmpdir"
                return 1
            fi
            cp -a "$(dirname "$inner")/." "$SNOWLUMA_HOME/"
        fi
    fi
    chmod +x "${SNOWLUMA_HOME}/launcher.sh" 2>/dev/null || true
    rm -rf "$tmpdir"

    snowluma_set_mode "native"
    echo "$tag" > "$SNOWLUMA_VER_FILE"
    snowluma_open_ports "$SNOWLUMA_WEBUI_PORT" 3000 3001
    info "呐呐，直接装好啦: ${tag} → ${SNOWLUMA_HOME} 咯喵 (๑•̀ㅂ•́)و✧"
    info "喵～ 请先「安装 QQ」，再「启动 SnowLuma」 呀～ ✧٩(ˊωˋ*)و✧"
}

snowluma_do_install() {
    SNOWLUMA_PROXY_INDEX="0"
    SNOWLUMA_VERSION_TAG="latest"
    SNOWLUMA_VERSION_LABEL=""
    SNOWLUMA_INSTALL_MODE=""

    if snowluma_is_installed; then
        local re=""
        warn "诶…… 小MK发现 SnowLuma 已经装好啦 (模式: $(snowluma_get_mode)) 呀喵 (；´д｀)"
        read -r -p "是否重新安装? 呢喵 (´･ω･) [y/N]: " re
        [[ "$re" =~ ^[Yy]$ ]] || return 0
        snowluma_stop || true
    fi

    menu_snowluma_select_mode || return 0
    if mk_nav_bubble_up; then return 0; fi
    [[ -n "${SNOWLUMA_INSTALL_MODE:-}" ]] || return 0

    if [[ "$SNOWLUMA_INSTALL_MODE" == "native" ]]; then
        menu_snowluma_select_version || return 0
        if mk_nav_bubble_up; then return 0; fi
        menu_snowluma_select_mirror || return 0
        if mk_nav_bubble_up; then return 0; fi
        snowluma_install_native
    else
        snowluma_install_docker
    fi
}

snowluma_do_uninstall() {
    title "卸载 SnowLuma 呢喵 (｡•̀ᴗ-)✧"
    local mode
    mode="$(snowluma_get_mode)"
    echo "  当前模式: ${mode:-还没装呢} 喵～ ✧٩(ˊωˋ*)و✧"
    echo "  Docker：删除容器（默认保留数据卷） 啦喵 ₍˄·͈༝·͈˄₎"
    echo "  直接安装：删除 ${SNOWLUMA_HOME} 哦喵 (๑ᵕᴗᵕ๑)"
    echo
    local confirm=""
    read -r -p "确认卸载 SnowLuma? 咯喵 (；´д｀) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "诶嘿～ 已经取消啦 ✧٩(ˊωˋ*)و✧"; return 0; }

    snowluma_stop || true
    snowluma_qq_stop || true
    snowluma_vnc_stop_stack >/dev/null 2>&1 || true

    if [[ "$mode" == "docker" ]] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        docker rm -f "$SNOWLUMA_DOCKER_NAME" >/dev/null 2>&1 || true
        local wipe=""
        read -r -p "是否同时删除 Docker 数据卷 (扫码登录会丢失)? 啦喵 (；´д｀) [y/N]: " wipe
        if [[ "$wipe" =~ ^[Yy]$ ]]; then
            docker volume rm snowluma-data snowluma-qq-config snowluma-qq-data >/dev/null 2>&1 || true
            info "诶嘿～ 已删除数据卷 呢喵 ✧٩(ˊωˋ*)و✧"
        fi
    fi

    if [[ -d "$SNOWLUMA_HOME" ]]; then
        rm -rf "$SNOWLUMA_HOME"
    fi
    rm -f "$SNOWLUMA_MODE_FILE" "$SNOWLUMA_VER_FILE" "$SNOWLUMA_PID_FILE" \
        "$SNOWLUMA_LOG" "$SNOWLUMA_INSTALL_LOG" 2>/dev/null || true
    info "呐呐，SnowLuma 已卸载 喵♪ (｡•̀ᴗ-)✧"
}

snowluma_qq_expand_arch() {
    # $1=url_template $2=arch $3=pkg → 替换 {ARCH}
    local url="$1" arch="$2" pkg="$3" token="$2"
    # 官网 rpm 命名用 x86_64 / aarch64
    if [[ "$url" == *"/QQNT/Linux/QQ_"* && "$pkg" == "rpm" ]]; then
        case "$arch" in
            amd64) token="x86_64" ;;
            arm64) token="aarch64" ;;
        esac
    fi
    printf '%s' "${url//\{ARCH\}/$token}"
}

snowluma_qq_resolve_candidate() {
    # 解析候选：GH:url → 走镜像代理；普通 url 原样
    local raw="$1" proxy_idx="${2:-0}"
    if [[ "$raw" == GH:* ]]; then
        snowluma_build_dl_url "${raw#GH:}" "$proxy_idx"
        return 0
    fi
    printf '%s' "$raw"
}

snowluma_qq_url_alive() {
    local url="$1" code
    code="$(curl -sI -L --max-time 12 -A 'mk-tools' -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [[ "$code" == "200" || "$code" == "206" || "$code" == "302" || "$code" == "301" ]]
}

snowluma_qq_fetch_rainbow() {
    # 从官网 rainbow 拉当前下载地址，写入 SNOWLUMA_QQ_RAINBOW_*
    local js key block ver
    SNOWLUMA_QQ_RAINBOW_VER=""
    SNOWLUMA_QQ_RAINBOW_DEB=""
    SNOWLUMA_QQ_RAINBOW_RPM=""
    js="$(curl -fsSL --max-time 15 -A 'mk-tools' 'https://im.qq.com/rainbow/linuxQQDownload' 2>/dev/null || true)"
    [[ -n "$js" ]] || return 1
    ver="$(printf '%s' "$js" | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)"
    SNOWLUMA_QQ_RAINBOW_VER="$ver"
    case "$(snowluma_detect_arch)" in
        amd64) key="x64DownloadUrl" ;;
        arm64) key="armDownloadUrl" ;;
        *) return 1 ;;
    esac
    block="$(printf '%s' "$js" | grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*\\{[^}]+\\}" | head -1)"
    [[ -n "$block" ]] || return 1
    SNOWLUMA_QQ_RAINBOW_DEB="$(printf '%s' "$block" | grep -oE '"deb"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)"
    SNOWLUMA_QQ_RAINBOW_RPM="$(printf '%s' "$block" | grep -oE '"rpm"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | cut -d'"' -f4)"
    # 旧 dldir1 纠偏到 dldir1v6
    SNOWLUMA_QQ_RAINBOW_DEB="${SNOWLUMA_QQ_RAINBOW_DEB//dldir1.qq.com/dldir1v6.qq.com}"
    SNOWLUMA_QQ_RAINBOW_RPM="${SNOWLUMA_QQ_RAINBOW_RPM//dldir1.qq.com/dldir1v6.qq.com}"
    [[ -n "$SNOWLUMA_QQ_RAINBOW_DEB" || -n "$SNOWLUMA_QQ_RAINBOW_RPM" ]]
}

snowluma_list_qq_options() {
    # 全局：LABELS / URLSETS(分号) / VERS
    local arch pkg snow_ver entry ver arches fpkg smin note urls a
    local expanded c first
    arch="$(snowluma_detect_arch)"
    pkg="$(snowluma_detect_pkg)"
    snow_ver="$(snowluma_get_display_version)"
    [[ -z "$snow_ver" || "$snow_ver" == "docker" ]] && snow_ver="latest"

    SNOWLUMA_QQ_MATCH_LABELS=()
    SNOWLUMA_QQ_MATCH_URLSETS=()
    SNOWLUMA_QQ_MATCH_VERS=()

    # 1) 官网实时最新
    if snowluma_qq_fetch_rainbow; then
        local rurl=""
        if [[ "$pkg" == "rpm" && -n "${SNOWLUMA_QQ_RAINBOW_RPM:-}" ]]; then
            rurl="$SNOWLUMA_QQ_RAINBOW_RPM"
        elif [[ -n "${SNOWLUMA_QQ_RAINBOW_DEB:-}" ]]; then
            rurl="$SNOWLUMA_QQ_RAINBOW_DEB"
        fi
        if [[ -n "$rurl" ]]; then
            SNOWLUMA_QQ_MATCH_VERS+=("${SNOWLUMA_QQ_RAINBOW_VER:-latest}(官网)")
            SNOWLUMA_QQ_MATCH_URLSETS+=("$rurl")
            SNOWLUMA_QQ_MATCH_LABELS+=("${SNOWLUMA_QQ_RAINBOW_VER:-未知}  [官网 rainbow · dldir1v6]  实时拉取")
        fi
    fi

    # 2) 内置兼容目录
    for entry in "${snowluma_qq_catalog[@]}"; do
        IFS='|' read -r ver arches fpkg smin note urls <<<"$entry"
        local arch_ok=0
        for a in $arches; do
            [[ "$a" == "$arch" ]] && arch_ok=1 && break
        done
        (( arch_ok == 1 )) || continue
        snowluma_ver_ge "$snow_ver" "$smin" || continue

        expanded=""
        first=""
        IFS=';' read -r -a _cands <<<"$urls"
        for c in "${_cands[@]}"; do
            [[ -z "$c" ]] && continue
            c="$(snowluma_qq_expand_arch "$c" "$arch" "$fpkg")"
            [[ -z "$first" ]] && first="$c"
            if [[ -n "$expanded" ]]; then
                expanded="${expanded};${c}"
            else
                expanded="$c"
            fi
        done
        [[ -n "$expanded" ]] || continue

        local label="${ver} (${fpkg})  [${note}]  需 SnowLuma≥${smin}"
        if [[ "$fpkg" != "$pkg" ]]; then
            label="${label}  *包格式与系统偏好不同"
        fi
        SNOWLUMA_QQ_MATCH_VERS+=("$ver")
        SNOWLUMA_QQ_MATCH_URLSETS+=("$expanded")
        SNOWLUMA_QQ_MATCH_LABELS+=("$label")
    done
}

menu_snowluma_install_qq() {
    local arch pkg snow_ver mode i idx proxy_idx
    arch="$(snowluma_detect_arch)"
    pkg="$(snowluma_detect_pkg)"
    snow_ver="$(snowluma_get_display_version)"
    mode="$(snowluma_get_mode)"

    info "诶嘿～ 正在刷新 QQ 下载列表（官网 rainbow + 内置兼容源） 喵～ (๑>◡<๑)"
    snowluma_list_qq_options

    while true; do
        title "安装 QQ（SnowLuma 兼容列表） 呢喵 (๑ᵕᴗᵕ๑)"
        show_nav_hint
        echo "  系统架构: ${arch}    包格式偏好: ${pkg} 喵♪ (๑>◡<๑)"
        echo "  SnowLuma 版本: ${snow_ver:-还没装呢}    模式: ${mode:-无} 喵～ (๑•̀ㅂ•́)و✧"
        echo "  下载域名: 优先 dldir1v6.qq.com（官网新域名），失败自动试 GitHub 归档 啦喵 ✧٩(ˊωˋ*)و✧"
        echo "  官网: https://im.qq.com/linuxqq/index.shtml 哦喵 ₍˄·͈༝·͈˄₎"
        echo
        if [[ "$mode" == "docker" ]]; then
            echo -e "  ${YELLOW}* Docker 模式镜像已内置 QQ，一般无需再装宿主 QQ 咯喵 (๑>◡<๑)${NC}"
            echo -e "  ${YELLOW}* 下列地址供对照/备用；选安装将装到宿主机 /opt/QQ 喵♪ (๑•̀ㅂ•́)و✧${NC}"
            echo
        fi

        if ((${#SNOWLUMA_QQ_MATCH_LABELS[@]} == 0)); then
            warn "呜喵… 当前架构暂无可用直链，请到官网下载对应 ${arch} 包 啦～ (｡•́︿•̀｡)"
            echo
        else
            for ((i=0; i<${#SNOWLUMA_QQ_MATCH_LABELS[@]}; i++)); do
                idx=$((i + 2))
                echo "  [${idx}] 安装 ${SNOWLUMA_QQ_MATCH_LABELS[$i]} 哦喵"
                local u
                IFS=';' read -r -a _show <<<"${SNOWLUMA_QQ_MATCH_URLSETS[$i]}"
                for u in "${_show[@]}"; do
                    echo "       - ${u#GH:}"
                done
            done
            echo
            echo "  选择序号后会按顺序探测可用源并下载安装 呀喵 (๑•̀ㅂ•́)و✧"
        fi
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#SNOWLUMA_QQ_MATCH_URLSETS[@]} )); then
                        # 若候选含 GitHub，先选镜像
                        if [[ "${SNOWLUMA_QQ_MATCH_URLSETS[$idx]}" == *GH:* ]]; then
                            SNOWLUMA_PROXY_INDEX="${SNOWLUMA_PROXY_INDEX:-0}"
                            menu_snowluma_select_mirror || true
                            if mk_nav_bubble_up; then return 0; fi
                        fi
                        snowluma_qq_install_from_urlset \
                            "${SNOWLUMA_QQ_MATCH_URLSETS[$idx]}" \
                            "${SNOWLUMA_QQ_MATCH_VERS[$idx]}" \
                            "${SNOWLUMA_PROXY_INDEX:-0}"
                        return $?
                    fi
                fi
                warn "呜喵… 看不懂选项，请重新输入 呢～ (´･ω･)"
                ;;
        esac
    done
}

snowluma_qq_install_from_urlset() {
    local urlset="$1" ver="$2" proxy_idx="${3:-0}"
    local tmp pkgfile cand resolved ok_url="" sz
    require_root || return 1

    if [[ -x "/opt/QQ/qq" ]]; then
        local re=""
        warn "诶…… 小MK发现已安装 /opt/QQ/qq 喵～ (。•́︿•̀。)"
        read -r -p "是否覆盖安装 ${ver}? 啦喵 (；´д｀) [y/N]: " re
        [[ "$re" =~ ^[Yy]$ ]] || return 0
        snowluma_qq_stop || true
    fi

    tmp="$(mktemp -d /tmp/snowluma-qq.XXXXXX)"
    if [[ "$urlset" == *.rpm* && "$urlset" != *.deb* ]]; then
        pkgfile="${tmp}/linuxqq_${ver}.rpm"
    else
        pkgfile="${tmp}/linuxqq_${ver}.deb"
    fi

    info "小MK喵：探测可用下载源: ${ver} 哇～ (｡•̀ᴗ-)✧"
    IFS=';' read -r -a _cands <<<"$urlset"
    for cand in "${_cands[@]}"; do
        [[ -z "$cand" ]] && continue
        resolved="$(snowluma_qq_resolve_candidate "$cand" "$proxy_idx")"
        info "诶嘿～ 尝试: ${resolved} 呢喵 (๑ᵕᴗᵕ๑)"
        if snowluma_qq_url_alive "$resolved"; then
            ok_url="$resolved"
            break
        fi
        # 部分 CDN 对 HEAD 不友好，再试小段 GET
        if curl -fsSL --max-time 20 -A 'mk-tools' -r 0-1023 -o /dev/null "$resolved" 2>/dev/null; then
            ok_url="$resolved"
            break
        fi
        warn "小MK喵小声说：不可用，跳过 呀～ (｡•́︿•̀｡)"
    done

    if [[ -z "$ok_url" ]]; then
        error "呜哇！ 所有下载源均不可用（含官网 dldir1v6 与归档镜像） 呢喵 (´･ω･)"
        rm -rf "$tmp"
        return 1
    fi

    info "小MK喵：下载 QQ ${ver} 哇～ (｡•̀ᴗ-)✧"
    info "$ok_url"
    if ! curl -fL --retry 3 --connect-timeout 30 -A 'mk-tools' -o "$pkgfile" "$ok_url"; then
        error "小MK喵吓一跳！ 下载失败 呀～ (。•́︿•̀。)"
        rm -rf "$tmp"
        return 1
    fi
    sz="$(wc -c < "$pkgfile" 2>/dev/null || echo 0)"
    if [[ "${sz:-0}" -lt 1000000 ]]; then
        error "小MK喵吓一跳！ 下载文件异常偏小 (${sz} bytes)，可能仍是 404 页 呀～ (；´д｀)"
        rm -rf "$tmp"
        return 1
    fi

    info "呐呐，安装 QQ 哦喵 (๑•̀ㅂ•́)و✧"
    if [[ "$pkgfile" == *.rpm ]]; then
        if command -v rpm >/dev/null 2>&1; then
            rpm -Uvh "$pkgfile" || true
        else
            error "呜哇！ 当前系统无 rpm，没法安装 rpm 包 喵～ (；´д｀)"
            rm -rf "$tmp"
            return 1
        fi
    else
        if command -v apt-get >/dev/null 2>&1; then
            export DEBIAN_FRONTEND=noninteractive
            apt-get install -y "$pkgfile" || dpkg -i "$pkgfile" || apt-get -f install -y
        elif command -v dpkg >/dev/null 2>&1; then
            dpkg -i "$pkgfile" || true
        else
            error "小MK喵吓一跳！ 当前系统无 dpkg/apt，没法安装 deb 包 哇～ (´･ω･)"
            rm -rf "$tmp"
            return 1
        fi
    fi

    rm -rf "$tmp"
    if [[ -x "/opt/QQ/qq" ]]; then
        info "呐呐，QQ ${ver} 装好啦: /opt/QQ/qq 咯喵 (๑•̀ㅂ•́)و✧"
        snowluma_qq_ensure_runtime_deps || true
    else
        warn "诶…… 安装命令已执行，但小MK没找到 /opt/QQ/qq，帮忙检查一下输出 啦喵 (｡•́︿•̀｡)"
        return 1
    fi
}

snowluma_pidfile_running() {
    local f="$1" pid=""
    [[ -f "$f" ]] || return 1
    pid="$(tr -d '[:space:]' < "$f" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

snowluma_kill_pidfile() {
    local f="$1" pid=""
    [[ -f "$f" ]] || return 0
    pid="$(tr -d '[:space:]' < "$f" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 0.5
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
}

snowluma_vnc_is_running() {
    snowluma_pidfile_running "$SNOWLUMA_VNC_PID" \
        || pgrep -f "x11vnc.*${SNOWLUMA_DISPLAY}" >/dev/null 2>&1
}

snowluma_vnc_ensure_deps() {
    local need=0
    command -v Xvfb >/dev/null 2>&1 || need=1
    command -v x11vnc >/dev/null 2>&1 || need=1
    command -v openbox >/dev/null 2>&1 || command -v fluxbox >/dev/null 2>&1 || need=1
    if (( need == 0 )); then
        return 0
    fi
    require_root || return 1
    warn "呜喵… 少了扫码桌面依赖，正在装 Xvfb / x11vnc / 轻量窗口管理器 啦～ (；´д｀)"
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1 || true
        apt-get install -y xvfb x11vnc openbox fluxbox fonts-wqy-zenhei \
            python3-websockify novnc git ca-certificates >/dev/null 2>&1 \
            || apt-get install -y xvfb x11vnc openbox fonts-wqy-zenhei \
                python3-websockify git ca-certificates >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y xorg-x11-server-Xvfb x11vnc openbox fluxbox \
            wqy-zenhei-fonts python3-websockify git >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y xorg-x11-server-Xvfb x11vnc openbox \
            google-noto-sans-cjk-fonts python3-websockify git >/dev/null 2>&1 || true
    fi
    command -v Xvfb >/dev/null 2>&1 || { error "呜哇！ Xvfb 装不上了喵 (；´д｀)"; return 1; }
    command -v x11vnc >/dev/null 2>&1 || { error "诶诶！ x11vnc 装不上了喵 (´･ω･)"; return 1; }
    command -v openbox >/dev/null 2>&1 || command -v fluxbox >/dev/null 2>&1 \
        || { error "呜哇！ openbox/fluxbox 装不上了喵 (,,>﹏<,,)"; return 1; }
    info "呐呐，扫码桌面依赖已经准备好啦 (๑•̀ㅂ•́)و✧"
}

snowluma_vnc_resolve_webroot() {
    local d
    for d in \
        /usr/share/novnc \
        /usr/share/novnc/ \
        "${SNOWLUMA_NOVNC_DIR}" \
        /opt/noVNC
    do
        if [[ -f "${d}/vnc.html" || -f "${d}/vnc_lite.html" ]]; then
            printf '%s' "${d%/}"
            return 0
        fi
    done
    return 1
}

# 系统 novnc 包常无 index.html，根路径会变成「目录列表」；补上默认页
snowluma_vnc_ensure_index() {
    local root="$1" target=""
    [[ -n "$root" && -d "$root" ]] || return 1
    if [[ -f "${root}/index.html" ]]; then
        return 0
    fi
    if [[ -f "${root}/vnc.html" ]]; then
        target="vnc.html"
    elif [[ -f "${root}/vnc_lite.html" ]]; then
        target="vnc_lite.html"
    else
        return 1
    fi
    ln -sfn "$target" "${root}/index.html" 2>/dev/null \
        || cp -f "${root}/${target}" "${root}/index.html" 2>/dev/null \
        || true
    [[ -e "${root}/index.html" ]]
}

snowluma_vnc_ensure_novnc() {
    local root
    if root="$(snowluma_vnc_resolve_webroot)"; then
        snowluma_vnc_ensure_index "$root" || true
        printf '%s' "$root"
        return 0
    fi
    require_root || return 1
    if ! command -v git >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            export DEBIAN_FRONTEND=noninteractive
            apt-get install -y git >/dev/null 2>&1 || true
        fi
    fi
    command -v git >/dev/null 2>&1 || { error "呜哇！ 需要 git 以下载 noVNC 喵♪ (｡•́︿•̀｡)"; return 1; }
    info "小MK喵：下载 noVNC 到 ${SNOWLUMA_NOVNC_DIR} 哦～ (๑•̀ㅂ•́)و✧"
    rm -rf "$SNOWLUMA_NOVNC_DIR"
    mkdir -p "$(dirname "$SNOWLUMA_NOVNC_DIR")"
    if ! git clone --depth=1 https://github.com/novnc/noVNC.git "$SNOWLUMA_NOVNC_DIR" >>"$SNOWLUMA_VNC_LOG" 2>&1; then
        # 国内镜像兜底
        git clone --depth=1 https://ghfast.top/https://github.com/novnc/noVNC.git "$SNOWLUMA_NOVNC_DIR" >>"$SNOWLUMA_VNC_LOG" 2>&1 || true
    fi
    if [[ -d "${SNOWLUMA_NOVNC_DIR}/utils" ]]; then
        git -C "${SNOWLUMA_NOVNC_DIR}/utils" clone --depth=1 https://github.com/novnc/websockify.git websockify >>"$SNOWLUMA_VNC_LOG" 2>&1 || true
    fi
    if [[ -f "${SNOWLUMA_NOVNC_DIR}/vnc.html" ]]; then
        snowluma_vnc_ensure_index "$SNOWLUMA_NOVNC_DIR" || true
        printf '%s' "$SNOWLUMA_NOVNC_DIR"
        return 0
    fi
    error "诶诶！ noVNC 准备失败 啦喵 (,,>﹏<,,)"
    return 1
}

snowluma_vnc_start_stack() {
    local webroot wm_bin=""
    require_root || return 1
    snowluma_vnc_load_cfg
    mkdir -p "$LOG_DIR"
    echo "===== SnowLuma VNC stack $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$SNOWLUMA_VNC_LOG"

    snowluma_vnc_ensure_deps || return 1
    webroot="$(snowluma_vnc_ensure_novnc)" || return 1
    snowluma_vnc_ensure_index "$webroot" || warn "小MK喵小声说：未能写入 noVNC index.html，请改用 /vnc.html 哇～ (´･ω･)"

    # QQ 已在虚拟屏上跑时：只补远程查看，绝不重启 Xvfb（否则会杀掉 QQ）
    if snowluma_xvfb_is_up; then
        if snowluma_qq_is_running && snowluma_qq_on_mk_display; then
            info "诶嘿～ 小MK发现 QQ 已在 ${SNOWLUMA_DISPLAY} 运行，仅拉起/保持远程查看（不重启虚拟屏） 咯喵 (๑ᵕᴗᵕ๑)"
            snowluma_vnc_start_viewer "$webroot" || return 1
            return 0
        fi
        # 虚拟屏在、QQ 不在或未挂本屏：只保证远程查看可用
        if snowluma_vnc_is_running; then
            snowluma_vnc_ensure_index "$webroot" || true
            info "小MK喵：扫码桌面已在运行 哇～ (｡•̀ᴗ-)✧"
            snowluma_open_ports "$SNOWLUMA_VNC_PORT" "$SNOWLUMA_NOVNC_PORT"
            info "呐呐，若根路径是目录列表，请打开: http://$(napcat_get_server_ip):${SNOWLUMA_NOVNC_PORT}/vnc.html 喵～ (๑•̀ㅂ•́)و✧"
            return 0
        fi
        snowluma_vnc_start_viewer "$webroot" || return 1
        if ! snowluma_qq_is_running; then
            warn "呜喵… 当前还没启动 QQ：桌面可能是灰/黑空屏，请回菜单点「启动 QQ」 啦～ (；´д｀)"
        fi
        return 0
    fi

    # 无虚拟屏，但有「脱管 QQ」（没挂 :99）——不能瞎重建，也不能干等
    if snowluma_qq_is_running; then
        if snowluma_qq_on_mk_display; then
            # 极端：声称在 :99 但 X 已死 → QQ 也基本废了，必须清掉重建
            warn "呜喵… 虚拟屏 ${SNOWLUMA_DISPLAY} 已丢失，但 QQ 仍占着该 DISPLAY，将结束 QQ 后重建扫码桌面 呢～ (。•́︿•̀。)"
            snowluma_qq_kill_all || true
            sleep 1
        else
            error "诶诶！ 小MK发现脱管 QQ（未挂扫码屏 ${SNOWLUMA_DISPLAY}），且虚拟屏没在跑呢 (,,>﹏<,,)"
            error "小MK喵吓一跳！ 请先点「彻底杀死 QQ」或「启动 QQ」（启动会自动清掉脱管进程再拉起） 呀～ (。•́︿•̀。)"
            return 1
        fi
    fi

    snowluma_vnc_stop_stack >/dev/null 2>&1 || true
    snowluma_vnc_load_cfg
    rm -f "/tmp/.X${SNOWLUMA_DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${SNOWLUMA_DISPLAY_NUM}" 2>/dev/null || true
    mkdir -p /tmp/.X11-unix
    chmod 1777 /tmp/.X11-unix 2>/dev/null || true

    x11vnc -storepasswd "$SNOWLUMA_VNC_PASS" "$SNOWLUMA_VNC_PASSFILE" >/dev/null 2>&1 || true

    info "呐呐，启动 Xvfb ${SNOWLUMA_DISPLAY} 呢喵 ₍˄·͈༝·͈˄₎"
    nohup Xvfb "$SNOWLUMA_DISPLAY" -screen 0 1280x720x24 -nolisten tcp \
        >>"$SNOWLUMA_VNC_LOG" 2>&1 &
    echo $! > "$SNOWLUMA_XVFB_PID"
    local i=0
    while (( i < 50 )); do
        [[ -S "/tmp/.X11-unix/X${SNOWLUMA_DISPLAY_NUM}" ]] && break
        sleep 0.1
        ((i++)) || true
    done
    if [[ ! -S "/tmp/.X11-unix/X${SNOWLUMA_DISPLAY_NUM}" ]]; then
        error "小MK喵吓一跳！ Xvfb 启动失败了喵，见 ${SNOWLUMA_VNC_LOG} 呀～ (,,>﹏<,,)"
        return 1
    fi

    if command -v openbox >/dev/null 2>&1; then
        wm_bin="openbox"
    else
        wm_bin="fluxbox"
    fi
    info "呐呐，启动窗口管理器 ${wm_bin} 呀喵 (｡•̀ᴗ-)✧"
    nohup env DISPLAY="$SNOWLUMA_DISPLAY" "$wm_bin" >>"$SNOWLUMA_VNC_LOG" 2>&1 &
    echo $! > "$SNOWLUMA_WM_PID"
    sleep 0.5
    if command -v xsetroot >/dev/null 2>&1; then
        DISPLAY="$SNOWLUMA_DISPLAY" xsetroot -solid '#2b2b2b' >/dev/null 2>&1 || true
    fi

    snowluma_vnc_start_viewer "$webroot" || return 1
    if ! snowluma_qq_is_running; then
        warn "呜喵… 当前还没启动 QQ：桌面可能是灰/黑空屏，请回菜单点「启动 QQ」 呢～ (｡•́︿•̀｡)"
    fi
}

# 只启 x11vnc + noVNC（远程看屏），不动 Xvfb / QQ
snowluma_vnc_start_viewer() {
    local webroot="${1:-}"
    snowluma_vnc_load_cfg
    if [[ -z "$webroot" ]]; then
        webroot="$(snowluma_vnc_ensure_novnc)" || return 1
    fi
    snowluma_vnc_ensure_index "$webroot" || true
    x11vnc -storepasswd "$SNOWLUMA_VNC_PASS" "$SNOWLUMA_VNC_PASSFILE" >/dev/null 2>&1 || true

    if ! snowluma_vnc_is_running; then
        info "喵～ 启动 x11vnc :${SNOWLUMA_VNC_PORT} 啦～ (๑>◡<๑)"
        nohup x11vnc -display "$SNOWLUMA_DISPLAY" \
            -rfbport "$SNOWLUMA_VNC_PORT" \
            -rfbauth "$SNOWLUMA_VNC_PASSFILE" \
            -forever -shared -xkb -noxrecord \
            >>"$SNOWLUMA_VNC_LOG" 2>&1 &
        echo $! > "$SNOWLUMA_VNC_PID"
        sleep 0.5
        if ! snowluma_vnc_is_running; then
            error "呜哇！ x11vnc 启动失败了喵，见 ${SNOWLUMA_VNC_LOG} 哦喵 (´･ω･)"
            return 1
        fi
    fi

    if ! snowluma_pidfile_running "$SNOWLUMA_NOVNC_PID"; then
        info "呐呐，启动 noVNC :${SNOWLUMA_NOVNC_PORT} 啦喵 ₍˄·͈༝·͈˄₎"
        if [[ -x "${webroot}/utils/novnc_proxy" ]]; then
            nohup "${webroot}/utils/novnc_proxy" \
                --vnc "localhost:${SNOWLUMA_VNC_PORT}" \
                --listen "$SNOWLUMA_NOVNC_PORT" \
                >>"$SNOWLUMA_VNC_LOG" 2>&1 &
            echo $! > "$SNOWLUMA_NOVNC_PID"
        elif command -v websockify >/dev/null 2>&1; then
            nohup websockify --web="$webroot" \
                "$SNOWLUMA_NOVNC_PORT" "localhost:${SNOWLUMA_VNC_PORT}" \
                >>"$SNOWLUMA_VNC_LOG" 2>&1 &
            echo $! > "$SNOWLUMA_NOVNC_PID"
        elif [[ -f "${webroot}/utils/websockify/run" ]]; then
            nohup "${webroot}/utils/websockify/run" --web="$webroot" \
                "$SNOWLUMA_NOVNC_PORT" "localhost:${SNOWLUMA_VNC_PORT}" \
                >>"$SNOWLUMA_VNC_LOG" 2>&1 &
            echo $! > "$SNOWLUMA_NOVNC_PID"
        else
            error "呜哇！ 没找到 websockify / novnc_proxy 咯喵 (；´д｀)"
            return 1
        fi
        sleep 0.5
    fi

    snowluma_open_ports "$SNOWLUMA_VNC_PORT" "$SNOWLUMA_NOVNC_PORT"
    info "喵～ 远程查看已经准备好啦（QQ/虚拟屏保持不动） 咯～ (๑ᵕᴗᵕ๑)"
    info "noVNC: http://$(napcat_get_server_ip):${SNOWLUMA_NOVNC_PORT}/vnc.html"
    info "诶嘿～ VNC:   $(napcat_get_server_ip):${SNOWLUMA_VNC_PORT}  密码: ${SNOWLUMA_VNC_PASS} 喵～ (๑>◡<๑)"
}

# 只停远程查看（x11vnc/noVNC），保留 Xvfb + QQ
snowluma_vnc_stop_viewer() {
    snowluma_vnc_load_cfg
    snowluma_kill_pidfile "$SNOWLUMA_NOVNC_PID"
    snowluma_kill_pidfile "$SNOWLUMA_VNC_PID"
    pkill -f "x11vnc.*${SNOWLUMA_DISPLAY}" 2>/dev/null || true
    pkill -f "websockify.*${SNOWLUMA_NOVNC_PORT}" 2>/dev/null || true
    pkill -f "novnc_proxy.*${SNOWLUMA_NOVNC_PORT}" 2>/dev/null || true
    info "小MK喵：已停止远程查看 (noVNC/VNC)，QQ 与虚拟屏 ${SNOWLUMA_DISPLAY} 仍在运行 哇～ (｡•̀ᴗ-)✧"
    if snowluma_qq_is_running; then
        info "呐呐，QQ 进程未受影响 喵♪ (๑•̀ㅂ•́)و✧"
    fi
}

# 停掉整套（含 Xvfb）——会弄死挂在该屏上的 QQ，仅内部在「停止 QQ」时调用
snowluma_vnc_stop_stack() {
    snowluma_vnc_load_cfg
    snowluma_vnc_stop_viewer >/dev/null 2>&1 || true
    snowluma_kill_pidfile "$SNOWLUMA_WM_PID"
    snowluma_kill_pidfile "$SNOWLUMA_XVFB_PID"
    pkill -f "Xvfb ${SNOWLUMA_DISPLAY}" 2>/dev/null || true
    rm -f "/tmp/.X${SNOWLUMA_DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${SNOWLUMA_DISPLAY_NUM}" 2>/dev/null || true
    info "呐呐，虚拟屏与扫码桌面已全部停止 呢喵 (๑•̀ㅂ•́)و✧"
}

snowluma_show_vnc_info() {
    local host_ip
    snowluma_vnc_load_cfg
    host_ip="$(napcat_get_server_ip)"
    title "SnowLuma 扫码桌面 (VNC / noVNC) 呢喵 ✧٩(ˊωˋ*)و✧"
    echo "  用途:     浏览器打开 noVNC，在 QQ 窗口里扫码登录 咯喵 ₍˄·͈༝·͈˄₎"
    echo "  显示:     ${SNOWLUMA_DISPLAY} (虚拟屏，非完整桌面) 喵♪ (๑ᵕᴗᵕ๑)"
    if snowluma_vnc_is_running || [[ "$(snowluma_get_mode)" == "docker" ]]; then
        echo -e "  状态:     ${GREEN}运行中 啦喵 (๑>◡<๑)${NC}"
    elif snowluma_xvfb_is_up; then
        echo -e "  状态:     ${YELLOW}虚拟屏在、远程查看未开 呀喵 ✧٩(ˊωˋ*)و✧${NC}"
    else
        echo -e "  状态:     ${YELLOW}没在跑呢 (๑ᵕᴗᵕ๑)${NC}"
    fi
    if snowluma_qq_is_running && ! snowluma_qq_on_mk_display; then
        echo -e "  警告:     ${YELLOW}QQ 脱管（未挂 ${SNOWLUMA_DISPLAY}），扫码看不懂；请「启动 QQ」自动修复 啦喵 (๑•̀ㅂ•́)و✧${NC}"
    fi
    echo "  noVNC:    http://${host_ip}:${SNOWLUMA_NOVNC_PORT}/vnc.html"
    echo "            http://${host_ip}:${SNOWLUMA_NOVNC_PORT}/"
    echo "  VNC:      ${host_ip}:${SNOWLUMA_VNC_PORT}"
    echo "  密码:     ${SNOWLUMA_VNC_PASS} 喵♪ (๑>◡<๑)"
    echo "  改端口:   菜单「配置扫码端口」或编辑 ${SNOWLUMA_VNC_CFG} 喵～ (๑•̀ㅂ•́)و✧"
    if [[ "$(snowluma_get_mode)" == "docker" ]]; then
        echo "  说明:     Docker 模式由容器映射提供（改端口需改 docker -p） 哦喵 ₍˄·͈༝·͈˄₎"
    else
        echo "  日志:     ${SNOWLUMA_VNC_LOG} 呢喵 (｡•̀ᴗ-)✧"
        echo "  提示:     「启动 QQ」会自动拉起扫码桌面 咯喵 (๑>◡<๑)"
        echo "  注意:     若根路径显示目录列表，请点开 /vnc.html 喵♪ (๑•̀ㅂ•́)و✧"
        echo "  登完后:   可「仅停止远程查看」，QQ 继续跑；关浏览器即可不扫码 喵～ ✧٩(ˊωˋ*)و✧"
    fi
    echo
}

# Linux QQ（Electron）运行时依赖；缺 libasound 等会直接起不来
snowluma_qq_ensure_runtime_deps() {
    require_root || return 1
    local missing=0
    # 快速探测常见致命库
    if ! ldconfig -p 2>/dev/null | grep -q 'libasound\.so\.2'; then
        missing=1
    fi
    if (( missing == 0 )) && command -v ldd >/dev/null 2>&1 && [[ -x /opt/QQ/qq ]]; then
        if ldd /opt/QQ/qq 2>/dev/null | grep -q 'not found'; then
            missing=1
        fi
    fi
    if (( missing == 0 )); then
        return 0
    fi

    warn "呜喵… 小MK发现 QQ 少了系统库，正在装运行依赖 啦～ (｡•́︿•̀｡)"
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null 2>&1 || true
        # Debian/Ubuntu 包名随版本可能是 libasound2t64
        apt-get install -y \
            libasound2 libasound2t64 \
            libatspi2.0-0 libgtk-3-0 libgbm1 libnss3 libnspr4 \
            libnotify4 libsecret-1-0 libxss1 libxtst6 libxkbfile1 \
            libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
            libpango-1.0-0 libcairo2 libcups2 libdbus-1-3 \
            fonts-wqy-zenhei ca-certificates \
            >/dev/null 2>&1 \
            || apt-get install -y \
                libasound2t64 libatspi2.0-0 libgtk-3-0 libgbm1 libnss3 \
                libnotify4 libsecret-1-0 libxss1 libxtst6 \
                fonts-wqy-zenhei \
                >/dev/null 2>&1 \
            || apt-get install -y libasound2 libgtk-3-0 libnss3 libgbm1 >/dev/null 2>&1 || true
        # 装完再补依赖（dpkg 装 QQ deb 后常见）
        apt-get -f install -y >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y alsa-lib at-spi2-atk gtk3 mesa-libgbm nss libnotify \
            libsecret libXScrnSaver libXtst libxkbfile \
            >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y alsa-lib at-spi2-atk gtk3 mesa-libgbm nss libnotify \
            libsecret libXScrnSaver libXtst \
            >/dev/null 2>&1 || true
    fi

    if ! ldconfig -p 2>/dev/null | grep -q 'libasound\.so\.2'; then
        error "小MK喵吓一跳！ 仍少了 libasound.so.2，手动安装: apt install libasound2 或 libasound2t64 呀～ (。•́︿•̀。)"
        return 1
    fi
    if command -v ldd >/dev/null 2>&1 && [[ -x /opt/QQ/qq ]]; then
        local miss
        miss="$(ldd /opt/QQ/qq 2>/dev/null | awk '/not found/{print $1}' | head -8 | tr '\n' ' ')"
        if [[ -n "$miss" ]]; then
            warn "呜喵… 仍有缺失库: ${miss} 呢～ (´･ω･)"
            warn "可执行: ldd /opt/QQ/qq | grep 'not found' 后按包名补装"
        fi
    fi
    info "呐呐，QQ 运行依赖已处理 哦喵 (๑•̀ㅂ•́)و✧"
}

# 彻底结束宿主 /opt/QQ（含 Electron 子进程、crashpad），并短时压制自动拉起
snowluma_qq_kill_all() {
    local pid pgid exe i
    mkdir -p "$LOG_DIR"

    # 先按进程组杀（启动时用 setsid）
    if [[ -f "$SNOWLUMA_QQ_PID" ]]; then
        pid="$(tr -d '[:space:]' < "$SNOWLUMA_QQ_PID" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
            if [[ -n "$pgid" && "$pgid" =~ ^[0-9]+$ ]]; then
                kill -TERM -- "-${pgid}" 2>/dev/null || true
                sleep 1
                kill -9 -- "-${pgid}" 2>/dev/null || true
            fi
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$SNOWLUMA_QQ_PID"
    fi

    # 按可执行路径精确清理 /opt/QQ（避开 ~/Napcat/opt/QQ）
    for pid in $(pgrep -f '/opt/QQ/' 2>/dev/null || true); do
        exe="$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)"
        if [[ "$exe" == /opt/QQ/* ]]; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    sleep 1
    for pid in $(pgrep -f '/opt/QQ/' 2>/dev/null || true); do
        exe="$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)"
        if [[ "$exe" == /opt/QQ/* ]]; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    pkill -9 -f '/opt/QQ/crashpad' 2>/dev/null || true
    pkill -9 -f '/opt/QQ/qq' 2>/dev/null || true

    # Electron 常见：主进程死后 crashpad/父进程会再拉起，短窗口内反复清
    for ((i=0; i<8; i++)); do
        if ! pgrep -f '/opt/QQ/qq' >/dev/null 2>&1; then
            break
        fi
        pkill -9 -f '/opt/QQ/qq' 2>/dev/null || true
        pkill -9 -f '/opt/QQ/' 2>/dev/null || true
        sleep 0.6
    done
}

snowluma_qq_disable_autostart_hints() {
    # 关掉常见自启入口（不删包，只避免登入会话又拉起）
    local f
    for f in \
        /etc/xdg/autostart/qq.desktop \
        /usr/share/applications/qq.desktop \
        "${HOME}/.config/autostart/qq.desktop"
    do
        if [[ -f "$f" ]]; then
            # 对用户级 autostart 直接隐藏；系统级不改文件，只提示
            if [[ "$f" == "${HOME}/.config/autostart/"* ]]; then
                mkdir -p "${HOME}/.config/autostart"
                printf '%s\n' '[Desktop Entry]' 'Hidden=true' > "${HOME}/.config/autostart/qq.desktop"
            fi
        fi
    done
    # 若启用了 mk 的 NapCat 开机自启且共用 /opt/QQ，会把 QQ 再次拉起
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl is-enabled "$AUTOSTART_NAPCAT_UNIT" >/dev/null 2>&1; then
            warn "小MK喵小声说：小MK发现 ${AUTOSTART_NAPCAT_UNIT} 已启用：它也可能拉起 /opt/QQ/qq 哇～ (；´д｀)"
            warn "呜喵… 若 QQ 仍反复自启，请到主菜单「开机自启」关闭 NapCat 自启 啦～ (´･ω･)"
        fi
        systemctl --user stop qq.service >/dev/null 2>&1 || true
        systemctl --user disable qq.service >/dev/null 2>&1 || true
    fi
}

snowluma_qq_start() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
            error "呜哇！ Docker 容器没在跑呢，请先启动 SnowLuma 啦喵 (,,>﹏<,,)"
            return 1
        fi
        info "小MK喵：Docker 模式下通过 supervisor 拉起 QQ 呢～ ₍˄·͈༝·͈˄₎"
        docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl start qq >/dev/null 2>&1 \
            || docker exec -u snowluma -e DISPLAY=:1 -d "$SNOWLUMA_DOCKER_NAME" \
                sh -lc 'qq --no-sandbox ${SNOWLUMA_QQ_FLAGS:-}' >/dev/null 2>&1 || true
        sleep 2
        if snowluma_qq_is_running; then
            info "呐呐，容器内 QQ 已经跑起来啦；扫码请用 noVNC: http://$(napcat_get_server_ip):${SNOWLUMA_NOVNC_PORT}/ 呀喵 ₍˄·͈༝·͈˄₎"
        else
            warn "小MK喵小声说：未能确认 QQ 进程，请 docker logs / VNC 排查 哇～ (。•́︿•̀。)"
        fi
        return 0
    fi

    if [[ ! -x "/opt/QQ/qq" ]]; then
        error "小MK喵吓一跳！ 还没装呢宿主 QQ，请先「安装 QQ」 哇～ (；´д｀)"
        return 1
    fi

    # 已在扫码屏上正常跑：只补 VNC/noVNC
    if snowluma_qq_is_running && snowluma_qq_on_mk_display && snowluma_xvfb_is_up; then
        warn "小MK喵小声说：QQ 已在扫码屏 ${SNOWLUMA_DISPLAY} 运行 哇～ (´･ω･)"
        snowluma_vnc_start_stack || true
        snowluma_show_vnc_info
        return 0
    fi

    # 脱管：有 QQ 但不在 :99，或虚拟屏已死 —— 清掉再按正确 DISPLAY 拉起
    if snowluma_qq_is_running; then
        warn "诶…… 小MK发现脱管/残缺 QQ（未正确挂在 ${SNOWLUMA_DISPLAY} 或虚拟屏已停） 呢喵 (。•́︿•̀。)"
        info "诶嘿～ 将结束旧进程，再连同扫码桌面重新启动 咯喵 ✧٩(ˊωˋ*)و✧"
        snowluma_qq_disable_autostart_hints || true
        date '+%F %T orphan-restart' > "$SNOWLUMA_QQ_STOP_FLAG"
        snowluma_qq_kill_all || true
        local i
        for ((i=0; i<10; i++)); do
            snowluma_qq_is_running || break
            pkill -9 -f '/opt/QQ/' 2>/dev/null || true
            sleep 0.5
        done
        if snowluma_qq_is_running; then
            error "诶诶！ 没法结束脱管 QQ，请先用「彻底杀死 QQ」，并检查是否有 systemd/外部守护在拉起 哦喵 (´･ω･)"
            ps -ef | grep -E '/opt/QQ|mk-napcat' | grep -v grep || true
            return 1
        fi
        rm -f "$SNOWLUMA_QQ_STOP_FLAG"
    fi

    snowluma_qq_ensure_runtime_deps || return 1

    # 常规安装：先起 Docker 同款扫码桌面，再在同一 DISPLAY 起 QQ
    snowluma_vnc_start_stack || return 1

    mkdir -p "$LOG_DIR"
    rm -f "$SNOWLUMA_QQ_STOP_FLAG"
    echo "===== SnowLuma QQ start $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$SNOWLUMA_QQ_LOG"
    # setsid：独立进程组，停止时可整组杀掉，减少 Electron 残留拉起
    nohup setsid env DISPLAY="$SNOWLUMA_DISPLAY" \
        '/opt/QQ/qq' --no-sandbox \
        --disable-gpu --disable-software-rasterizer --disable-gpu-compositing \
        >> "$SNOWLUMA_QQ_LOG" 2>&1 &
    echo $! > "$SNOWLUMA_QQ_PID"
    sleep 3
    if snowluma_qq_is_running; then
        info "喵～ QQ 已后台启动（DISPLAY=${SNOWLUMA_DISPLAY}） 啦～ (๑>◡<๑)"
        snowluma_show_vnc_info
        info "诶嘿～ 请用手机扫 noVNC 里 QQ 窗口的二维码 喵♪ ✧٩(ˊωˋ*)و✧"
    else
        error "诶诶！ QQ 启动失败了喵，见日志: ${SNOWLUMA_QQ_LOG} 啦喵 (,,>﹏<,,)"
        tail -20 "$SNOWLUMA_QQ_LOG" 2>/dev/null || true
        if grep -q 'libasound\|not found\|shared libraries' "$SNOWLUMA_QQ_LOG" 2>/dev/null; then
            warn "像是缺系统库。可先: sudo apt-get install -y libasound2 || sudo apt-get install -y libasound2t64"
            warn "再查: ldd /opt/QQ/qq | grep 'not found'"
        fi
        return 1
    fi
}

snowluma_qq_stop() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl stop qq >/dev/null 2>&1 || true
        docker exec "$SNOWLUMA_DOCKER_NAME" pkill -9 -f '/opt/QQ/qq' >/dev/null 2>&1 || true
        info "喵～ 已尝试停止容器内 QQ 呀～ ✧٩(ˊωˋ*)و✧"
        return 0
    fi

    mkdir -p "$LOG_DIR"
    # 意图标记：便于排查「非 mk 拉起」的残留
    date '+%F %T' > "$SNOWLUMA_QQ_STOP_FLAG"
    info "呐呐，正在彻底停止宿主 QQ（含子进程，并短时压制自动拉起） 呀喵 ₍˄·͈༝·͈˄₎"
    snowluma_qq_disable_autostart_hints || true
    snowluma_qq_kill_all || true

    if snowluma_qq_is_running; then
        warn "小MK喵小声说：仍小MK发现 /opt/QQ/qq，再次强杀 呀～ (´･ω･)"
        snowluma_qq_kill_all || true
    fi

    # 先停 QQ，再拆虚拟屏（避免先拆屏导致 QQ 崩溃拉起）
    snowluma_vnc_stop_stack || true

    if snowluma_qq_is_running; then
        error "诶诶！ QQ 仍在运行（可能被 systemd/NapCat 自启或其他守护拉起） 哦喵 (。•́︿•̀。)"
        warn "小MK喵小声说：排查: systemctl status ${AUTOSTART_NAPCAT_UNIT} 哇～ (；´д｀)"
        warn "排查: ps -ef | grep -E '/opt/QQ|qq' | grep -v grep"
        return 1
    fi

    info "诶嘿～ 宿主 QQ 已经停下来啦；远程查看/虚拟屏已关闭 啦喵 (๑ᵕᴗᵕ๑)"
    info "若再次被拉起，请关闭 NapCat 开机自启，并检查: ps -ef | grep /opt/QQ"
}

# 菜单「彻底杀死 QQ」：不拆 VNC，只死磕 /opt/QQ 进程树 + 更长防拉起窗口
snowluma_qq_force_kill() {
    local mode confirm="" i left=0
    mode="$(snowluma_get_mode)"
    title "彻底杀死 QQ 哦喵 (๑>◡<๑)"
    echo "  将强制结束宿主 /opt/QQ 全部相关进程（含子进程/crashpad） 呀喵 (๑•̀ㅂ•́)و✧"
    echo "  并在约 15 秒内反复压制自动拉起 呢喵 ✧٩(ˊωˋ*)و✧"
    echo "  默认不关闭 VNC/虚拟屏（需要可再点「仅停止远程查看」） 咯喵 ₍˄·͈༝·͈˄₎"
    echo "  不会卸载 QQ 软件包 喵♪ (๑ᵕᴗᵕ๑)"
    echo
    if [[ "$mode" == "docker" ]]; then
        echo "  当前为 Docker 模式：将在容器内强杀 QQ 哦喵 (๑•̀ㅂ•́)و✧"
    fi
    read -r -p "确认彻底杀死? 呢喵 (｡•́︿•̀｡) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "喵～ 已经取消啦 (๑ᵕᴗᵕ๑)"; return 0; }

    mkdir -p "$LOG_DIR"
    date '+%F %T force-kill' > "$SNOWLUMA_QQ_STOP_FLAG"
    snowluma_qq_disable_autostart_hints || true

    if [[ "$mode" == "docker" ]]; then
        docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl stop qq >/dev/null 2>&1 || true
        for ((i=0; i<15; i++)); do
            docker exec "$SNOWLUMA_DOCKER_NAME" pkill -9 -f '/opt/QQ/' >/dev/null 2>&1 || true
            sleep 1
        done
        info "喵～ 已在容器内执行强杀 咯～ (๑ᵕᴗᵕ๑)"
        return 0
    fi

    info "喵～ 第 1 轮强杀 呀～ ✧٩(ˊωˋ*)و✧"
    snowluma_qq_kill_all || true
    info "诶嘿～ 持续压制自动拉起（约 15 秒） 哦喵 (๑ᵕᴗᵕ๑)"
    for ((i=0; i<15; i++)); do
        if pgrep -f '/opt/QQ/qq' >/dev/null 2>&1 || pgrep -f '/opt/QQ/' >/dev/null 2>&1; then
            pkill -9 -f '/opt/QQ/qq' 2>/dev/null || true
            pkill -9 -f '/opt/QQ/' 2>/dev/null || true
            pkill -9 -f '/opt/QQ/crashpad' 2>/dev/null || true
            left=1
        else
            left=0
        fi
        sleep 1
    done

    rm -f "$SNOWLUMA_QQ_PID"
    if snowluma_qq_is_running || pgrep -f '/opt/QQ/qq' >/dev/null 2>&1; then
        error "诶诶！ 压制后仍有 /opt/QQ/qq，帮忙检查一下外部守护 呀喵："
        ps -ef | grep -E '/opt/QQ|mk-napcat' | grep -v grep || true
        warn "呜喵… 可尝试: sudo systemctl stop ${AUTOSTART_NAPCAT_UNIT} && sudo systemctl disable ${AUTOSTART_NAPCAT_UNIT} 呢～ (,,>﹏<,,)"
        return 1
    fi
    info "诶嘿～ QQ 已彻底杀死 啦喵 (๑>◡<๑)"
    info "呐呐，之后请用菜单「启动 QQ」重新拉起（才会带上 VNC DISPLAY） 哦喵 (๑•̀ㅂ•́)و✧"
}

snowluma_qq_uninstall() {
    title "卸载 QQ 喵♪ (｡•̀ᴗ-)✧"
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        warn "呜喵… Docker 模式 QQ 在镜像内，卸载宿主包不会移除容器内 QQ 呢～ (；´д｀)"
        warn "诶…… 若要彻底去掉 Docker QQ，请卸载 SnowLuma 容器 呢喵 (´･ω･)"
    fi
    echo "  将卸载系统包 linuxqq（/opt/QQ） 喵♪ (๑>◡<๑)"
    echo
    local confirm=""
    read -r -p "确认卸载宿主 QQ? 哦喵 (´･ω･) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "诶嘿～ 已经取消啦 (๑ᵕᴗᵕ๑)"; return 0; }

    snowluma_qq_stop || true
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get remove -y linuxqq >/dev/null 2>&1 || dpkg -r linuxqq >/dev/null 2>&1 || true
    elif command -v rpm >/dev/null 2>&1; then
        rpm -e linuxqq >/dev/null 2>&1 || true
    fi
    if [[ -d /opt/QQ ]]; then
        local wipe=""
        read -r -p "/opt/QQ 仍在，是否强制删除目录? 喵～ (,,>﹏<,,) [y/N]: " wipe
        [[ "$wipe" =~ ^[Yy]$ ]] && rm -rf /opt/QQ
    fi
    info "喵～ QQ 拆干净啦 (๑>◡<๑)"
}

snowluma_start() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ -z "$mode" ]]; then
        error "诶诶！ SnowLuma 还没装呢 (,,>﹏<,,)"
        return 1
    fi

    if [[ "$mode" == "docker" ]]; then
        if snowluma_is_running; then
            warn "诶…… 容器已在运行 哦喵 (。•́︿•̀。)"
            snowluma_show_login_info
            return 0
        fi
        docker start "$SNOWLUMA_DOCKER_NAME" >/dev/null
        sleep 2
        if snowluma_is_running; then
            info "喵～ SnowLuma 容器已经跑起来啦 ✧٩(ˊωˋ*)و✧"
            snowluma_show_login_info
        else
            error "小MK喵吓一跳！ 启动失败了喵: docker logs ${SNOWLUMA_DOCKER_NAME} 哇～ (。•́︿•̀。)"
            return 1
        fi
        return 0
    fi

    if [[ ! -x "${SNOWLUMA_HOME}/launcher.sh" && ! -f "${SNOWLUMA_HOME}/index.mjs" ]]; then
        error "呜哇！ 没找到 ${SNOWLUMA_HOME}/launcher.sh 咯喵 (´･ω･)"
        return 1
    fi
    if snowluma_is_running; then
        warn "诶…… SnowLuma 已在运行 哦喵 (；´д｀)"
        snowluma_show_login_info
        return 0
    fi

    mkdir -p "$LOG_DIR"
    echo "===== SnowLuma start $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$SNOWLUMA_LOG"
    (
        cd "$SNOWLUMA_HOME" || exit 1
        export SNOWLUMA_ACCEPT_EULA=1
        export SNOWLUMA_ACCEPT_PRIVACY=1
        if [[ -x ./launcher.sh ]]; then
            exec ./launcher.sh
        else
            exec node ./index.mjs
        fi
    ) >> "$SNOWLUMA_LOG" 2>&1 &
    echo $! > "$SNOWLUMA_PID_FILE"
    sleep 2
    if snowluma_is_running; then
        snowluma_open_ports "$SNOWLUMA_WEBUI_PORT"
        info "呐呐，SnowLuma 已后台启动 哦喵 (๑•̀ㅂ•́)و✧"
        snowluma_show_login_info
    else
        error "诶诶！ 启动失败了喵，见日志: ${SNOWLUMA_LOG} 咯喵 (。•́︿•̀。)"
        tail -20 "$SNOWLUMA_LOG" 2>/dev/null || true
        return 1
    fi
}

snowluma_stop() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
            docker stop "$SNOWLUMA_DOCKER_NAME" >/dev/null
            info "诶嘿～ SnowLuma 容器已经停下来啦 (๑ᵕᴗᵕ๑)"
        else
            info "喵～ 容器未在运行 啦～ (๑>◡<๑)"
        fi
        return 0
    fi

    if [[ -f "$SNOWLUMA_PID_FILE" ]]; then
        local pid
        pid="$(tr -d '[:space:]' < "$SNOWLUMA_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$SNOWLUMA_PID_FILE"
    fi
    pkill -f "${SNOWLUMA_HOME}/launcher.sh" 2>/dev/null || true
    pkill -f "${SNOWLUMA_HOME}/.*index\.mjs" 2>/dev/null || true
    sleep 1
    info "诶嘿～ SnowLuma 已经停下来啦 (๑>◡<๑)"
}

snowluma_restart() {
    info "诶嘿～ 正在重启 SnowLuma 喵♪ (๑ᵕᴗᵕ๑)"
    snowluma_stop || true
    sleep 2
    snowluma_start
}

snowluma_show_logs() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        title "SnowLuma Docker 日志 (最近 80 行) 哦喵 ✧٩(ˊωˋ*)و✧"
        docker logs --tail 80 "$SNOWLUMA_DOCKER_NAME" 2>&1 || warn "呜喵… 没法读取容器日志 呢～ (´･ω･)"
        echo
        echo "  实时: docker logs -f ${SNOWLUMA_DOCKER_NAME} 咯喵 (｡•̀ᴗ-)✧"
        return 0
    fi
    if [[ ! -f "$SNOWLUMA_LOG" ]]; then
        warn "呜喵… 暂无运行日志: ${SNOWLUMA_LOG} 呢～ (｡•́︿•̀｡)"
        return 1
    fi
    title "SnowLuma 运行日志 (最近 80 行) 咯喵 (๑>◡<๑)"
    tail -n 80 "$SNOWLUMA_LOG"
    echo
    echo "  完整日志: ${SNOWLUMA_LOG} 啦喵 ₍˄·͈༝·͈˄₎"
}

snowluma_show_login_info() {
    local host_ip mode pass
    snowluma_vnc_load_cfg
    host_ip="$(napcat_get_server_ip)"
    mode="$(snowluma_get_mode)"
    title "SnowLuma WebUI 登录信息 哦喵 (｡•̀ᴗ-)✧"
    echo "  模式:     ${mode:-未知} 呀喵 (๑>◡<๑)"
    echo "  版本:     $(snowluma_get_display_version || echo 未知)"
    echo "  WebUI:    http://${host_ip}:${SNOWLUMA_WEBUI_PORT}/"
    echo "  用户名:   admin 喵♪ ₍˄·͈༝·͈˄₎"
    echo "  noVNC:    http://${host_ip}:${SNOWLUMA_NOVNC_PORT}/   (扫码登录 QQ) 喵～ (๑ᵕᴗᵕ๑)"
    echo "  VNC:      ${host_ip}:${SNOWLUMA_VNC_PORT}  密码 ${SNOWLUMA_VNC_PASS} 啦喵 (｡•̀ᴗ-)✧"
    if [[ "$mode" == "docker" ]]; then
        pass="$(docker logs "$SNOWLUMA_DOCKER_NAME" 2>&1 | grep -oE '临时密码: [^[:space:]]+|password=[^[:space:]]+' | tail -1 || true)"
        [[ -n "$pass" ]] && echo "  初始密码: ${pass}"
        echo "  查密码:   docker logs ${SNOWLUMA_DOCKER_NAME} 2>&1 | grep -E '临时密码|initial credentials'"
    else
        if [[ -f "$SNOWLUMA_LOG" ]]; then
            pass="$(grep -oE '临时密码: [^[:space:]]+|password=[^[:space:]]+' "$SNOWLUMA_LOG" 2>/dev/null | tail -1 || true)"
            [[ -n "$pass" ]] && echo "  初始密码线索: ${pass}"
        fi
        echo "  密码见启动日志: ${SNOWLUMA_LOG} 呢喵 ₍˄·͈༝·͈˄₎"
        echo "  安装目录: ${SNOWLUMA_HOME} 咯喵 (๑ᵕᴗᵕ๑)"
        if snowluma_vnc_is_running; then
            echo -e "  扫码桌面: ${GREEN}运行中${NC}（常规安装已内置 Docker 同款 VNC/noVNC） 喵～ (๑>◡<๑)"
        else
            echo -e "  扫码桌面: ${YELLOW}没在跑呢${NC}（「启动 QQ」会自动拉起） 哦喵 ✧٩(ˊωˋ*)و✧"
        fi
    fi
    echo
}

menu_snowluma() {
    while true; do
        local sl_title="snowLuma 操作" ver mode
        ver="$(snowluma_get_display_version)"
        mode="$(snowluma_get_mode)"
        if [[ -n "$ver" ]]; then
            sl_title="snowLuma 操作 ----- ${ver}"
        fi
        title "$sl_title"
        show_nav_hint
        echo "  [2] 安装 SnowLuma啦"
        echo "  [3] 卸载 SnowLuma啦"
        echo "  [4] 安装 QQ（按系统/版本列兼容下载地址）啦"
        echo "  [5] 启动 QQ（常规模式会同时拉起 VNC/noVNC 扫码桌面）啦"
        echo "  [6] 停止 QQ啦"
        echo "  [7] 彻底杀死 QQ（含子进程，防拉起约 15 秒）啦"
        echo "  [8] 卸载 QQ啦"
        echo "  [9] 启动 SnowLuma啦"
        echo "  [10] 停止 SnowLuma啦"
        echo "  [11] 重启 SnowLuma啦"
        echo "  [12] 查看日志啦"
        echo "  [13] 查看 WebUI 登录信息啦"
        echo "  [14] 查看扫码地址 (VNC/noVNC)啦"
        echo "  [15] 仅启动远程查看 (VNC/noVNC)啦"
        echo "  [16] 仅停止远程查看 (不影响 QQ)啦"
        echo "  [17] 配置扫码端口/密码啦"
        echo
        snowluma_vnc_load_cfg
        if snowluma_is_running; then
            echo -e "  ${GREEN}* SnowLuma 正在运行 (${mode:-?}) 哦喵 (๑•̀ㅂ•́)و✧${NC}"
        elif snowluma_is_installed; then
            echo -e "  ${YELLOW}* SnowLuma 已经装好啦，但没在跑呢 (${mode:-?}) 呢喵 ₍˄·͈༝·͈˄₎${NC}"
        else
            echo -e "  ${YELLOW}* SnowLuma 还没装呢 (｡•̀ᴗ-)✧${NC}"
        fi
        if snowluma_qq_is_running; then
            if snowluma_qq_on_mk_display && snowluma_xvfb_is_up; then
                echo -e "  ${GREEN}* QQ 正在运行（扫码屏 ${SNOWLUMA_DISPLAY}） 呀喵 ₍˄·͈༝·͈˄₎${NC}"
            else
                echo -e "  ${YELLOW}* QQ 脱管运行中（未挂扫码屏，点「启动 QQ」可自动修复） 咯喵 (｡•̀ᴗ-)✧${NC}"
            fi
        elif snowluma_qq_is_installed; then
            echo -e "  ${YELLOW}* QQ 已经装好啦，但没在跑呢 ✧٩(ˊωˋ*)و✧${NC}"
        fi
        if [[ "$mode" == "docker" ]] || snowluma_vnc_is_running; then
            echo -e "  ${GREEN}* 扫码桌面 VNC/noVNC 可用 :${SNOWLUMA_NOVNC_PORT} 呢喵 (｡•̀ᴗ-)✧${NC}"
        elif snowluma_xvfb_is_up; then
            echo -e "  ${YELLOW}* 虚拟屏已开，远程查看未开（可点「仅启动远程查看」） 喵♪ (๑•̀ㅂ•́)و✧${NC}"
        fi
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) snowluma_do_install || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            3) snowluma_do_uninstall; press_enter ;;
            4) menu_snowluma_install_qq || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            5) snowluma_qq_start; press_enter ;;
            6) snowluma_qq_stop; press_enter ;;
            7) snowluma_qq_force_kill; press_enter ;;
            8) snowluma_qq_uninstall; press_enter ;;
            9) snowluma_start; press_enter ;;
            10) snowluma_stop; press_enter ;;
            11) snowluma_restart; press_enter ;;
            12) snowluma_show_logs; press_enter ;;
            13) snowluma_show_login_info; press_enter ;;
            14) snowluma_show_vnc_info; press_enter ;;
            15)
                if [[ "$(snowluma_get_mode)" == "docker" ]]; then
                    info "小MK喵：Docker 模式扫码桌面由容器提供，启动 SnowLuma 即可 哇～ (｡•̀ᴗ-)✧"
                else
                    snowluma_vnc_start_stack || true
                fi
                press_enter ;;
            16)
                if [[ "$(snowluma_get_mode)" == "docker" ]]; then
                    warn "呜喵… Docker 模式请用「停止 SnowLuma」关闭容器；不能只停远程查看而保留容器内 QQ 屏 啦～ (´･ω･)"
                else
                    # 只停 noVNC/x11vnc，保留 Xvfb + QQ
                    snowluma_vnc_stop_viewer || true
                fi
                press_enter ;;
            17) menu_snowluma_vnc_config || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            *) warn "呜喵… 看不懂选项，请重新输入 啦～ (,,>﹏<,,)" ;;
        esac
    done
}

# ==================== NapCat 实验魔改 ====================

readonly NAPCAT_MOD_VER_MIN="4.18.6"
readonly NAPCAT_MOD_VER_MAX="4.18.9"
NAPCAT_MOD_VERSION=""

napcat_mod_resolve_patches_dir() {
    mk_embed_ensure_patches 2>/dev/null
}

napcat_mod_get_root() {
    napcat_detect_paths || return 1
    local qq_home
    qq_home="$(dirname "$NAPCAT_QQ_BIN")"
    NAPCAT_MOD_ROOT="${qq_home}/resources/app/app_launcher/napcat"
    NAPCAT_MOD_MJS="${NAPCAT_MOD_ROOT}/napcat.mjs"
    NAPCAT_MOD_ASSETS="${NAPCAT_MOD_ROOT}/static/assets"
    [[ -f "$NAPCAT_MOD_MJS" && -d "$NAPCAT_MOD_ASSETS" ]]
}

napcat_mod_detect_version() {
    local ver=""
    NAPCAT_MOD_VERSION=""

    napcat_mod_get_root || return 1

    ver="$(python3 - "$NAPCAT_MOD_MJS" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="ignore").read()
m = re.search(r'typeof E7 < "u" && "([^"]+)"', text)
if m:
    raw = m.group(1).split("-plg", 1)[0]
    m2 = re.match(r"(\d+\.\d+\.\d+)", raw)
    if m2:
        print(m2.group(1))
        raise SystemExit(0)
raise SystemExit(1)
PY
)" || ver=""

    if [[ -z "$ver" ]]; then
        ver="$(napcat_get_display_version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || ver=""
    fi

    if [[ -n "$ver" ]]; then
        NAPCAT_MOD_VERSION="$ver"
        echo "$ver"
        return 0
    fi
    return 1
}

napcat_mod_version_in_range() {
    local ver="${1:-}"
    python3 - "$ver" "$NAPCAT_MOD_VER_MIN" "$NAPCAT_MOD_VER_MAX" <<'PY'
import sys

def norm(v):
    p = [int(x) for x in v.split(".")[:3]]
    while len(p) < 3:
        p.append(0)
    return tuple(p)

ver, lo, hi = sys.argv[1], sys.argv[2], sys.argv[3]
raise SystemExit(0 if norm(lo) <= norm(ver) <= norm(hi) else 1)
PY
}

napcat_mod_version_support_text() {
    local ver="" status=""
    if ver="$(napcat_mod_detect_version 2>/dev/null)"; then
        if napcat_mod_version_in_range "$ver"; then
            status="支持"
        else
            status="不支持"
        fi
        echo "v${ver} (${status})"
        [[ "$status" == "支持" ]]
        return
    fi
    echo "未知版本 (不支持)"
    return 1
}

napcat_mod_check_version() {
    local ver=""
    if ! ver="$(napcat_mod_detect_version 2>/dev/null)"; then
        error "小MK喵吓一跳！ 没法识别 NapCat 版本 呀～ (；´д｀)"
        error "呜哇！ 魔改仅支持 ${NAPCAT_MOD_VER_MIN} - ${NAPCAT_MOD_VER_MAX} 咯喵 (´･ω･)"
        return 1
    fi
    if ! napcat_mod_version_in_range "$ver"; then
        error "诶诶！ 当前 NapCat 版本 v${ver} 不在支持范围 哦喵 (；´д｀)"
        error "小MK喵吓一跳！ 魔改仅支持 ${NAPCAT_MOD_VER_MIN} - ${NAPCAT_MOD_VER_MAX} 呀～ (´･ω･)"
        return 1
    fi
    return 0
}

napcat_mod_backup_mjs() {
    local bak="${NAPCAT_MOD_MJS}.bak"
    if [[ ! -f "$bak" ]]; then
        cp -a "$NAPCAT_MOD_MJS" "$bak"
        info "喵～ 已备份 napcat.mjs -> napcat.mjs.bak 啦～ (๑>◡<๑)"
    fi
}

napcat_mod_require_ready() {
    if ! napcat_mod_get_root; then
        error "呜哇！ NapCat 还没装呢或目录结构异常 咯喵 (｡•́︿•̀｡)"
        return 1
    fi
    if ! napcat_mod_check_version; then
        return 1
    fi
    if ! napcat_mod_resolve_patches_dir >/dev/null; then
        error "诶诶！ 内置魔改资源解压失败，请重新安装 mk: sudo bash mk --install 咯喵 (。•́︿•̀。)"
        return 1
    fi
    return 0
}

napcat_mod_status_whitelist() {
    if grep -q 'not in official plugin whitelist' "$NAPCAT_MOD_MJS" 2>/dev/null; then
        echo "未魔改"
        return 1
    fi
    if grep -qE 'getRejectReason\(e, n\) \{[[:space:]]*return null;' "$NAPCAT_MOD_MJS" 2>/dev/null; then
        echo "已魔改"
        return 0
    fi
    echo "未知"
    return 2
}

napcat_mod_status_import() {
    if grep -q '_napPlgImportHandler' "$NAPCAT_MOD_MJS" 2>/dev/null \
        && grep -q 'Sr.post("/Import"' "$NAPCAT_MOD_MJS" 2>/dev/null \
        && grep -q 'Sr.post("/Reload"' "$NAPCAT_MOD_MJS" 2>/dev/null; then
        echo "已魔改"
        return 0
    fi
    echo "未魔改"
    return 1
}

napcat_mod_find_webui_index() {
    python3 - "$NAPCAT_MOD_ASSETS" <<'PY'
import glob, os, re, sys

assets = sys.argv[1]
best = ""
best_score = -1
for fn in glob.glob(os.path.join(assets, "index-*.js")):
    try:
        text = open(fn, encoding="utf-8", errors="ignore").read()
    except OSError:
        continue
    score = 0
    if "__vite__mapDeps" in text:
        score += 100
    if 'path:"plugins"' in text or "path:'plugins'" in text:
        score += 50
    if re.search(r'import\("\./plugin-[^"]+\.js"\)', text):
        score += 30
    if "web_login" in text:
        score += 10
    score += len(text) / 200000
    if score > best_score:
        best_score = score
        best = fn
if best_score < 100:
    raise SystemExit(1)
print(best)
PY
}

napcat_mod_status_refresh_ui() {
    local index_file=""
    if [[ -f "${NAPCAT_MOD_ASSETS}/plugin-NCp3.js" ]] \
        && grep -q '重载完成' "${NAPCAT_MOD_ASSETS}/plugin-NCp3.js" 2>/dev/null; then
        index_file="$(napcat_mod_find_webui_index 2>/dev/null || true)"
        if [[ -n "$index_file" ]] && grep -q 'plugin-NCp3.js' "$index_file" 2>/dev/null \
            && grep -q 'plugin_manager-NCp3.js' "$index_file" 2>/dev/null; then
            echo "已魔改"
            return 0
        fi
    fi
    echo "未魔改"
    return 1
}

napcat_mod_bump_sw_cache() {
    python3 - "$NAPCAT_MOD_MJS" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
m = re.search(r'(typeof E7 < "u" && ")([^"]+)(" \|\| "1\.0\.0-dev")', text)
if not m:
    sys.exit(1)
ver = m.group(2)
if "-plg" in ver:
    base, n = ver.rsplit("-plg", 1)
    try:
        ver = f"{base}-plg{int(n) + 1}"
    except ValueError:
        ver = f"{ver}-plg1"
else:
    ver = f"{ver}-plg1"
text = text[:m.start(2)] + ver + text[m.end(2):]
open(path, "w", encoding="utf-8").write(text)
print(ver)
PY
}

napcat_mod_patch_whitelist() {
    napcat_mod_require_ready || return 1
    napcat_mod_backup_mjs

    local st
    st="$(napcat_mod_status_whitelist)"
    if [[ "$st" == "已魔改" ]]; then
        info "呐呐，白名单限制已处于魔改状态，跳过 喵♪ (｡•̀ᴗ-)✧"
        return 0
    fi

    python3 - "$NAPCAT_MOD_MJS" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
pattern = r'getRejectReason\(e, n\) \{\s*const r = this\.scanSensitiveWords\(n\);\s*return this\.isOfficialPlugin\(e\) \? null : r \? `sensitive keyword "\$\{r\}"` : "not in official plugin whitelist";\s*\}'
repl = 'getRejectReason(e, n) {\n    return null;\n  }'
new, n = re.subn(pattern, repl, text, count=1)
if n != 1:
    if 'not in official plugin whitelist' not in text:
        print('already')
        sys.exit(0)
    print('pattern_not_found')
    sys.exit(2)
open(path, 'w', encoding='utf-8').write(new)
print('ok')
PY
    local rc=$?
    if [[ $rc -eq 0 ]]; then
        info "小MK喵：魔改白名单限制完成：非官方插件不再被拦截 呢～ ₍˄·͈༝·͈˄₎"
        if napcat_is_running; then
            warn "小MK喵小声说：NapCat 正在跑，建议执行「重启框架」使改动生效 哇～ (。•́︿•̀。)"
        fi
        return 0
    fi
    error "呜哇！ 白名单魔改失败：当前 NapCat 版本可能与补丁对不上 喵♪ (,,>﹏<,,)"
    return 1
}

napcat_mod_patch_import() {
    napcat_mod_require_ready || return 1
    napcat_mod_backup_mjs

    local st patch_dir snippet
    st="$(napcat_mod_status_import)"
    if [[ "$st" == "已魔改" ]]; then
        info "诶嘿～ 插件上传 API 已处于魔改状态，跳过 呀喵 ✧٩(ˊωˋ*)و✧"
        return 0
    fi

    patch_dir="$(napcat_mod_resolve_patches_dir)"
    snippet="${patch_dir}/import_reload.snippet.js"
    if [[ ! -f "$snippet" ]]; then
        error "呜哇！ 少了内置补丁片段 呀喵 (´･ω･)"
        return 1
    fi

    python3 - "$NAPCAT_MOD_MJS" "$snippet" <<'PY'
import sys
path, snippet_path = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
if "_napPlgImportHandler" in text:
    print("already")
    sys.exit(0)
snippet = open(snippet_path, encoding="utf-8").read().strip()
if not snippet:
    print("empty_snippet")
    sys.exit(3)
anchor = "de.existsSync(pF) || de.mkdirSync(pF, { recursive: !0 });\nconst Sr = yr();"
if anchor not in text:
    print("anchor_not_found")
    sys.exit(2)
text = text.replace(anchor, "de.existsSync(pF) || de.mkdirSync(pF, { recursive: !0 });\n" + snippet + "\nconst Sr = yr();", 1)
route_anchor = 'Sr.post("/RegisterManager", mme);'
route_add = 'Sr.post("/RegisterManager", mme);\nSr.post("/Import", _napPlgImportUpload, _napPlgImportHandler);\nSr.post("/Reload", _napPlgReloadHandler);'
if 'Sr.post("/Import"' not in text:
    if route_anchor not in text:
        print("route_anchor_not_found")
        sys.exit(4)
    text = text.replace(route_anchor, route_add, 1)
open(path, "w", encoding="utf-8").write(text)
print("ok")
PY
    local rc=$?
    if [[ $rc -eq 0 ]]; then
        info "小MK喵：魔改插件上传完成：已恢复 /Plugin/Import 与 /Plugin/Reload API 哇～ (｡•̀ᴗ-)✧"
        if napcat_is_running; then
            warn "诶…… NapCat 正在跑，建议执行「重启框架」使改动生效 哦喵 (；´д｀)"
        fi
        return 0
    fi
    error "小MK喵吓一跳！ 插件上传魔改失败：当前 NapCat 版本可能与补丁对不上 哇～ (。•́︿•̀。)"
    return 1
}

napcat_mod_patch_refresh_ui() {
    napcat_mod_require_ready || return 1
    napcat_mod_backup_mjs

    local st patch_dir index_file new_ver
    st="$(napcat_mod_status_refresh_ui)"
    if [[ "$st" == "已魔改" ]]; then
        info "诶嘿～ 刷新插件按钮已处于魔改状态，跳过 呀喵 (๑ᵕᴗᵕ๑)"
        return 0
    fi

    patch_dir="$(napcat_mod_resolve_patches_dir)"
    cp -f "${patch_dir}/plugin-NCp3.js" "${NAPCAT_MOD_ASSETS}/plugin-NCp3.js"
    if [[ -f "${patch_dir}/plugin_manager-NCp3.js" ]]; then
        cp -f "${patch_dir}/plugin_manager-NCp3.js" "${NAPCAT_MOD_ASSETS}/plugin_manager-NCp3.js"
    fi

    index_file="$(napcat_mod_find_webui_index 2>/dev/null || true)"
    if [[ -z "$index_file" ]]; then
        error "诶诶！ 没找到 WebUI 主路由 index 资源（需含插件页路由） 啦喵 (｡•́︿•̀｡)"
        return 1
    fi
    info "小MK喵：定位 WebUI 主路由: $(basename "$index_file") 哦～ (๑•̀ㅂ•́)و✧"

    python3 - "$NAPCAT_MOD_ASSETS" "$index_file" <<'PY'
import glob, os, re, sys

assets, index_path = sys.argv[1], sys.argv[2]
text = open(index_path, encoding="utf-8").read()
old_name = ""

idx = -1
for marker in ('path:"plugins"', "path:'plugins'", 'path:"/plugins"', 'path:"/plugin"', "path:'/plugin'"):
    idx = text.find(marker)
    if idx >= 0:
        break

if idx >= 0:
    chunk = text[max(0, idx - 1500): idx + 200]
    names = re.findall(r'import\("\./plugin-([^"]+)\.js"\)', chunk)
    names = [n for n in names if "store" not in n.lower()]
    if names:
        old_name = names[-1]

if not old_name:
    m = re.search(r'lazy\(\(\)=>[^;]*import\("\./plugin-([^"]+)\.js"\)', text)
    if m:
        old_name = m.group(1)

if not old_name:
    names = re.findall(r'import\("\./plugin-([^"]+)\.js"\)', text)
    names = [n for n in names if "store" not in n.lower()]
    if names:
        old_name = names[-1]

if not old_name:
    print("plugin_import_not_found")
    raise SystemExit(3)

already = old_name == "NCp3" and "plugin_manager-NCp3.js" in text
if not already:
    if old_name != "NCp3":
        text = text.replace(f"./plugin-{old_name}.js", "./plugin-NCp3.js")
        dep_old = f'"assets/plugin-{old_name}.js"'
        dep_new = f'{dep_old},"assets/plugin-NCp3.js"'
        if dep_old in text and '"assets/plugin-NCp3.js"' not in text:
            text = text.replace(dep_old, dep_new, 1)
    text = text.replace("plugin_manager-CPQYiixb.js", "plugin_manager-NCp3.js")
    open(index_path, "w", encoding="utf-8").write(text)

for fn in glob.glob(os.path.join(assets, "*.js")):
    if fn == index_path:
        continue
    try:
        body = open(fn, encoding="utf-8", errors="ignore").read()
    except OSError:
        continue
    if "plugin_manager-CPQYiixb.js" in body:
        open(fn, "w", encoding="utf-8").write(
            body.replace("plugin_manager-CPQYiixb.js", "plugin_manager-NCp3.js")
        )

print(old_name)
PY
    local rc=$?
    if [[ $rc -ne 0 ]]; then
        if [[ $rc -eq 3 ]]; then
            error "呜哇！ 刷新按钮魔改失败：未在 WebUI 主路由中找到插件页 lazy import 喵♪ (；´д｀)"
        else
            error "小MK喵吓一跳！ 刷新按钮魔改失败：WebUI 路由结构与补丁对不上 呀～ (｡•́︿•̀｡)"
        fi
        return 1
    fi

    if new_ver="$(napcat_mod_bump_sw_cache 2>/dev/null)"; then
        info "诶嘿～ 已刷新 Service Worker 缓存版本: ${new_ver} 喵～ ✧٩(ˊωˋ*)و✧"
    else
        warn "诶…… 未能自动 bump 缓存版本，若页面仍显示旧 UI 请强制刷新浏览器 哦喵 (；´д｀)"
    fi

    info "呐呐，魔改刷新插件按钮完成：打开页面仅加载列表，刷新按钮执行全量重载 咯喵 (๑•̀ㅂ•́)و✧"
    if napcat_is_running; then
        warn "呜喵… NapCat 正在跑，建议执行「重启框架」；浏览器请 Ctrl+F5 强刷插件页 呢～ (；´д｀)"
    fi
    return 0
}

napcat_mod_apply_all() {
    napcat_mod_require_ready || return 1
    info "喵～ 开始一键应用全部 NapCat 魔改 咯～ (๑ᵕᴗᵕ๑)"
    local ok=0 fail=0
    napcat_mod_patch_whitelist && ok=$((ok + 1)) || fail=$((fail + 1))
    napcat_mod_patch_import && ok=$((ok + 1)) || fail=$((fail + 1))
    napcat_mod_patch_refresh_ui && ok=$((ok + 1)) || fail=$((fail + 1))
    echo
    info "诶嘿～ 完成: 成功 ${ok} 项, 失败 ${fail} 项 喵♪ (๑ᵕᴗᵕ๑)"
    [[ $fail -eq 0 ]]
}

napcat_mod_color_status() {
    local st="${1:-}"
    case "$st" in
        已魔改) echo -e "${GREEN}${st}${NC}" ;;
        未魔改) echo -e "${YELLOW}${st}${NC}" ;;
        未知)   echo -e "${RED}${st}${NC}" ;;
        *)      echo "$st" ;;
    esac
}

napcat_mod_print_version_status() {
    local ver=""
    if ver="$(napcat_mod_detect_version 2>/dev/null)"; then
        if napcat_mod_version_in_range "$ver"; then
            echo -e "  NapCat 版本: v${ver} ${GREEN}(支持) 呀喵 (๑ᵕᴗᵕ๑)${NC}"
        else
            echo -e "  NapCat 版本: v${ver} ${RED}(帮不上忙) 咯喵 (๑>◡<๑)${NC}"
        fi
        return
    fi
    echo -e "  NapCat 版本: ${RED}未知版本 (帮不上忙) 哦喵 (๑ᵕᴗᵕ๑)${NC}"
}

menu_experimental() {
    while true; do
        title "实验功能 喵～ ₍˄·͈༝·͈˄₎"
        show_nav_hint
        echo "  NapCat 插件系统魔改（内置补丁，自动检测，已魔改则跳过） 哦喵 (｡•̀ᴗ-)✧"
        echo "  支持版本: ${NAPCAT_MOD_VER_MIN} - ${NAPCAT_MOD_VER_MAX} 呀喵 (๑>◡<๑)"
        echo

        if napcat_mod_get_root 2>/dev/null; then
            local s1 s2 s3
            napcat_mod_print_version_status
            echo
            s1="$(napcat_mod_status_whitelist)"
            s2="$(napcat_mod_status_import)"
            s3="$(napcat_mod_status_refresh_ui)"
            echo "  当前状态 喵♪:"
            echo -e "    白名单限制: $(napcat_mod_color_status "$s1") 喵～ (｡•̀ᴗ-)✧"
            echo -e "    插件上传:   $(napcat_mod_color_status "$s2") 啦喵 (๑>◡<๑)"
            echo -e "    刷新按钮:   $(napcat_mod_color_status "$s3") 哦喵 (๑•̀ㅂ•́)و✧"
            if ! napcat_mod_version_in_range "${NAPCAT_MOD_VERSION:-0.0.0}" 2>/dev/null; then
                echo
                echo -e "  ${YELLOW}* 当前版本不在支持范围，魔改操作将被拒绝 咯喵 (๑ᵕᴗᵕ๑)${NC}"
            fi
        else
            echo -e "  ${YELLOW}* NapCat 还没装呢，魔改功能不可用 啦喵 (๑•̀ㅂ•́)و✧${NC}"
        fi
        echo
        echo "  [2] 魔改白名单限制呢"
        echo "  [3] 魔改插件上传呢"
        echo "  [4] 魔改刷新插件按钮呢"
        echo "  [5] 一键应用全部魔改呢"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) napcat_mod_patch_whitelist || true; press_enter ;;
            3) napcat_mod_patch_import || true; press_enter ;;
            4) napcat_mod_patch_refresh_ui || true; press_enter ;;
            5) napcat_mod_apply_all || true; press_enter ;;
            *) warn "诶…… 看不懂选项，请重新输入 咯喵 (｡•́︿•̀｡)" ;;
        esac
    done
}


# ==================== 咔咔珂 Kakake ====================

readonly KAKAKE_HOME="${HOME}/kakake"
readonly KAKAKE_DATA="${KAKAKE_HOME}/data"
readonly KAKAKE_CONNECTIONS_FILE="${KAKAKE_DATA}/connections.json"
readonly KAKAKE_CONFIG_FILE="${KAKAKE_DATA}/config.json"
readonly KAKAKE_AUTH_KEY_FILE="${KAKAKE_DATA}/auth-key.json"
# Vite SPA 产物（packages/web/dist）；旧 Next.js .next 仅作迁移检测
readonly KAKAKE_WEB_DIST_INDEX="${KAKAKE_HOME}/packages/web/dist/index.html"
readonly KAKAKE_WEB_STAMP="${KAKAKE_HOME}/packages/web/dist/.mk-web.stamp"
readonly KAKAKE_WEB_STAMP_LEGACY="${KAKAKE_HOME}/packages/web/.next/mk-web.stamp"
readonly KAKAKE_WEB_NEXT_BUILD_ID="${KAKAKE_HOME}/packages/web/.next/BUILD_ID"
readonly KAKAKE_WEB_NEXT_LEGACY="${KAKAKE_HOME}/src/web/.next/BUILD_ID"
readonly KAKAKE_LOG="${LOG_DIR}/kakake-runtime.log"
readonly KAKAKE_PID_FILE="${LOG_DIR}/kakake.pid"
readonly KAKAKE_INSTALL_LOG="${LOG_DIR}/kakake-install.log"
readonly KAKAKE_WEB_BUILD_LOG="${LOG_DIR}/kakake-web-build.log"
readonly KAKAKE_WEB_BUILD_PID="${LOG_DIR}/kakake-web-build.pid"
readonly KAKAKE_WEB_BUILD_START="${LOG_DIR}/kakake-web-build.start"
readonly KAKAKE_WEB_PANEL_LINES=8
readonly KAKAKE_START_PANEL_LINES=7
readonly KAKAKE_NODE_DIR="${INSTALL_DIR}/nodejs"
readonly KAKAKE_NODE_BIN="${INSTALL_DIR}/nodejs/bin/node"
readonly KAKAKE_NODE_STABLE_22="22.23.0"
readonly KAKAKE_NODE_STABLE_20="20.19.2"
readonly KAKAKE_DOWNLOAD_URL="https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/kakake.zip"
readonly KAKAKE_DOWNLOAD_URL_PORTABLE="https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/kakake-linux-x64.zip"
readonly KAKAKE_ADMIN_PORT=8787
readonly KAKAKE_NODE_VER_FILE="${LOG_DIR}/mk-node.version"
readonly KAKAKE_NODE_MIRROR_FILE="${LOG_DIR}/mk-node.mirror"

NODE_INSTALL_VERSION=""
NODE_INSTALL_VERSION_LABEL=""
NODE_INSTALL_MIRROR_IDX="0"

node_mirror_labels=(
    "官方 nodejs.org"
    "npmmirror (淘宝源)"
    "腾讯云镜像"
    "华为云镜像"
    "清华大学镜像"
)

node_mirror_urls=(
    "https://nodejs.org/dist"
    "https://npmmirror.com/mirrors/node"
    "https://mirrors.cloud.tencent.com/nodejs-release"
    "https://repo.huaweicloud.com/nodejs"
    "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release"
)

# 便携版：内置 runtime/bin/node + packages/server/main.mjs，无源码 bootstrap
kakake_is_portable() {
    [[ -f "${KAKAKE_HOME}/packages/server/main.mjs" ]] \
        && [[ ! -f "${KAKAKE_HOME}/scripts/bootstrap.mjs" ]] \
        && { [[ -x "${KAKAKE_HOME}/runtime/bin/node" ]] || [[ -f "${KAKAKE_HOME}/启动.sh" ]]; }
}

# 源码版：带 bootstrap（mk 下载的 zip / 开发目录）
kakake_is_source() {
    [[ -f "${KAKAKE_HOME}/package.json" && -f "${KAKAKE_HOME}/scripts/bootstrap.mjs" ]]
}

kakake_is_installed() {
    kakake_is_source || kakake_is_portable
}

kakake_edition() {
    if kakake_is_portable; then
        printf '%s' "portable"
    elif kakake_is_source; then
        printf '%s' "source"
    else
        printf '%s' "unknown"
    fi
}

kakake_edition_label() {
    case "$(kakake_edition)" in
        portable) printf '%s' "便携版" ;;
        source) printf '%s' "源码版" ;;
        *) printf '%s' "未知" ;;
    esac
}

# 相对 KAKAKE_HOME 的进程入口
kakake_server_entry() {
    if kakake_is_portable; then
        printf '%s' "packages/server/main.mjs"
    else
        printf '%s' "scripts/bootstrap.mjs"
    fi
}

# mk 私有目录里的 Node（/usr/local/lib/mk-tools/nodejs）
kakake_node_private_installed() {
    [[ -x "$KAKAKE_NODE_BIN" ]]
}

# 是否有可用 Node（便携内置 > 私有 > 系统）
kakake_node_installed() {
    kakake_resolve_node_bin >/dev/null 2>&1
}

kakake_get_node_version() {
    local bin=""
    bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    [[ -n "$bin" ]] || return 0
    "$bin" -v 2>/dev/null | head -1 || true
}

# 解析可用 node：便携内置 > mk 私有 > PATH > 常见绝对路径
kakake_resolve_node_bin() {
    local bin="" candidate=""
    if [[ -x "${KAKAKE_HOME}/runtime/bin/node" ]]; then
        printf '%s\n' "${KAKAKE_HOME}/runtime/bin/node"
        return 0
    fi
    if kakake_node_private_installed; then
        printf '%s\n' "$KAKAKE_NODE_BIN"
        return 0
    fi
    # Termux 的 node 由 pkg 装进 $PREFIX/bin，登录 shell 之外（如 Termux:Boot）PATH 可能不全
    if mk_is_termux && [[ -x "${TERMUX_PREFIX}/bin/node" ]]; then
        printf '%s\n' "${TERMUX_PREFIX}/bin/node"
        return 0
    fi
    if command -v node >/dev/null 2>&1; then
        bin="$(command -v node 2>/dev/null || true)"
        if [[ -n "$bin" && -x "$bin" ]]; then
            printf '%s\n' "$bin"
            return 0
        fi
    fi
    for candidate in \
        /usr/local/bin/node \
        /usr/bin/node \
        "${HOME}/.nvm/current/bin/node" \
        "${HOME}/.local/share/fnm/aliases/default/bin/node" \
        "${HOME}/.fnm/aliases/default/bin/node" \
        "${HOME}/.volta/bin/node"
    do
        if [[ -x "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# 状态展示用：便携内置 / mk 管理 / 系统全局
kakake_node_source_label() {
    local bin=""
    bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -n "$bin" && "$bin" == "${KAKAKE_HOME}/runtime/bin/node" ]]; then
        printf '%s' "便携内置"
    elif kakake_node_private_installed && [[ "$bin" == "$KAKAKE_NODE_BIN" ]]; then
        printf '%s' "mk 管理"
    elif mk_is_termux && [[ -n "$bin" ]]; then
        printf '%s' "Termux pkg"
    elif [[ -n "$bin" ]]; then
        printf '%s' "系统全局"
    else
        printf '%s' "未安装"
    fi
}

# 读取 data/config.json 中的后台端口，缺省 8787
kakake_get_admin_port() {
    local p=""
    if [[ -f "$KAKAKE_CONFIG_FILE" ]]; then
        p="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$KAKAKE_CONFIG_FILE" 2>/dev/null \
            | grep -oE '[0-9]+' | head -1 || true)"
    fi
    if [[ -n "$p" && "$p" =~ ^[0-9]+$ ]]; then
        printf '%s' "$p"
    else
        printf '%s' "$KAKAKE_ADMIN_PORT"
    fi
}

# 有效产物：Vite packages/web/dist/index.html
kakake_web_built() {
    [[ -f "$KAKAKE_WEB_DIST_INDEX" ]]
}

kakake_web_label() {
    if kakake_web_built; then
        echo "Vite packages/web/dist"
    elif [[ -f "$KAKAKE_WEB_NEXT_BUILD_ID" || -f "$KAKAKE_WEB_NEXT_LEGACY" ]]; then
        echo "仅残留 Next.js 产物（需重建为 Vite）"
    else
        echo "未构建"
    fi
}

# 残留旧 Next 产物时强制迁到 Vite dist
kakake_web_has_stale_next() {
    [[ -f "$KAKAKE_WEB_NEXT_BUILD_ID" || -f "$KAKAKE_WEB_NEXT_LEGACY" ]] && ! kakake_web_built
}

kakake_web_clean_legacy_next() {
    rm -rf "${KAKAKE_HOME}/packages/web/.next" "${KAKAKE_HOME}/src/web/.next" 2>/dev/null || true
    rm -f "$KAKAKE_WEB_STAMP_LEGACY" 2>/dev/null || true
}

# 源码指纹：避免 zip/scp 保留旧 mtime 导致误判「无需重建」
kakake_web_source_fingerprint() {
    local src_dir="${KAKAKE_HOME}/src/web"
    [[ -d "$src_dir" ]] || { echo "missing"; return 0; }
    (
        cd "$src_dir" || exit 0
        find . \
            \( -name node_modules -o -name .next -o -name dist -o -name .git \) -prune -o \
            -type f -printf '%P\t%s\n' 2>/dev/null \
            | LC_ALL=C sort \
            | md5sum 2>/dev/null | awk '{print $1}'
    ) || echo "unknown"
}

kakake_web_stamp_path() {
    if [[ -f "$KAKAKE_WEB_STAMP" ]]; then
        printf '%s' "$KAKAKE_WEB_STAMP"
    elif [[ -f "$KAKAKE_WEB_STAMP_LEGACY" ]]; then
        printf '%s' "$KAKAKE_WEB_STAMP_LEGACY"
    else
        printf '%s' "$KAKAKE_WEB_STAMP"
    fi
}

kakake_web_write_stamp() {
    local fp=""
    mkdir -p "$(dirname "$KAKAKE_WEB_STAMP")"
    fp="$(kakake_web_source_fingerprint)"
    printf '%s\n' "$fp" > "$KAKAKE_WEB_STAMP"
    rm -f "$KAKAKE_WEB_STAMP_LEGACY" 2>/dev/null || true
}

# src/web 是否需要重建（改了前端 / 指纹变了 / 强制 / 旧 Next）
kakake_web_needs_rebuild() {
    local force="${1:-${KAKAKE_FORCE_WEB_BUILD:-0}}"
    local src_dir="${KAKAKE_HOME}/src/web"
    local newest build_at fp stamp stamp_file

    # 便携版无前端源码，已有 dist 则不重建
    if kakake_is_portable; then
        kakake_web_built && return 1
        return 0
    fi

    [[ "$force" == "1" ]] && return 0
    kakake_web_has_stale_next && return 0

    if ! kakake_web_built; then
        return 0
    fi
    [[ -d "$src_dir" ]] || return 1

    stamp_file="$(kakake_web_stamp_path)"
    if [[ -f "$stamp_file" ]]; then
        fp="$(kakake_web_source_fingerprint)"
        stamp="$(tr -d '[:space:]' < "$stamp_file" 2>/dev/null || true)"
        if [[ -n "$fp" && -n "$stamp" && "$fp" != "unknown" && "$fp" != "$stamp" ]]; then
            return 0
        fi
        if [[ -n "$fp" && "$fp" == "$stamp" ]]; then
            return 1
        fi
    fi

    # 回退：mtime 比较（无 stamp 的旧产物）
    newest="$(find "$src_dir" \
        \( -name node_modules -o -name .next -o -name dist -o -name .git \) -prune -o \
        -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 || true)"
    [[ -z "$newest" ]] && return 1
    build_at="$(stat -c '%Y' "$KAKAKE_WEB_DIST_INDEX" 2>/dev/null || echo 0)"
    awk -v n="$newest" -v b="$build_at" 'BEGIN { exit !(n > b + 0.5) }'
}

# 从 auth-key.json / 旧 config.token / 运行日志解析登录密钥
kakake_get_auth_key() {
    local key="" kind="" line=""

    if [[ -f "$KAKAKE_AUTH_KEY_FILE" ]]; then
        key="$(grep -oE '"key"[[:space:]]*:[[:space:]]*"[^"]*"' "$KAKAKE_AUTH_KEY_FILE" 2>/dev/null \
            | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
        kind="$(grep -oE '"kind"[[:space:]]*:[[:space:]]*"[^"]*"' "$KAKAKE_AUTH_KEY_FILE" 2>/dev/null \
            | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    fi

    if [[ -z "$key" && -f "$KAKAKE_CONFIG_FILE" ]]; then
        key="$(grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$KAKAKE_CONFIG_FILE" 2>/dev/null \
            | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
        [[ -n "$key" ]] && kind="legacy"
    fi

    if [[ -z "$key" && -f "$KAKAKE_LOG" ]]; then
        line="$(grep -E '登录密钥' "$KAKAKE_LOG" 2>/dev/null | tail -1 || true)"
        if [[ -n "$line" ]]; then
            key="$(printf '%s' "$line" | sed -E 's/.*登录密钥[^:]*:[[:space:]]*//' | tr -d '\r' | awk '{print $1}')"
            if [[ "$line" == *自定义* ]]; then
                kind="custom"
            elif [[ "$line" == *初始* ]]; then
                kind="initial"
            fi
        fi
    fi

    printf '%s\t%s' "${key}" "${kind}"
}

kakake_auth_kind_label() {
    case "$1" in
        custom) echo "自定义密码" ;;
        initial) echo "初始密钥（登录后需改密）" ;;
        legacy) echo "旧版 config.token" ;;
        *) echo "未知" ;;
    esac
}

# 确保 PATH 上有 npm（源码版 Vite 构建需要；便携版跳过）
kakake_ensure_node_tools() {
    local node_bin="$1"
    local node_path=""
    [[ -n "$node_bin" && -x "$node_bin" ]] || return 1
    node_path="$(dirname "$node_bin")"
    export PATH="${node_path}:${PATH}"

    if kakake_is_portable; then
        return 0
    fi

    if ! command -v npm >/dev/null 2>&1; then
        error "诶诶！ 当前 Node 环境少了 npm: ${node_path} 啦喵 (´･ω･)"
        return 1
    fi

    # 前端由 scripts/ensure-web.mjs 用 npm 安装；pnpm 可选
    if command -v corepack >/dev/null 2>&1 && [[ -f "${KAKAKE_HOME}/pnpm-lock.yaml" ]]; then
        corepack enable >/dev/null 2>&1 || true
        corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
    fi
    return 0
}

# npm 包仓库（≠ Node 二进制镜像）。宝塔/部分面板会把 registry 误配成
# mirrors.../nodejs-release，导致 npm install 全是 404。
# 覆盖：KAKAKE_NPM_REGISTRY=https://registry.npmjs.org
kakake_export_npm_registry() {
    local cur="" forced=""
    forced="${KAKAKE_NPM_REGISTRY:-https://registry.npmmirror.com}"
    cur="$(npm config get registry 2>/dev/null || true)"
    cur="${cur//$'\r'/}"
    if [[ -z "$cur" || "$cur" == "undefined" \
        || "$cur" == *nodejs-release* \
        || "$cur" == *"/dist/"* && "$cur" == *node* \
        || "$cur" == *nodejs.org* ]]; then
        export npm_config_registry="$forced"
        info "呐呐，npm registry → ${npm_config_registry}（已避开误配的 Node 二进制镜像） 咯喵 (｡•̀ᴗ-)✧"
    elif [[ -n "${KAKAKE_NPM_REGISTRY:-}" ]]; then
        export npm_config_registry="$KAKAKE_NPM_REGISTRY"
        info "npm registry → ${npm_config_registry}（KAKAKE_NPM_REGISTRY）"
    else
        # 国内源码安装默认走 npmmirror，减少 registry.npmjs.org 超时
        export npm_config_registry="$forced"
    fi
}

# 启动前确保 Web UI（packages/ 可删；产物为 packages/web/dist）
# 构建过程写入独立日志，前台只刷新进度面板（与宝塔 / NapCat 一致）
kakake_web_build_running() {
    local pid=""
    [[ -f "$KAKAKE_WEB_BUILD_PID" ]] || return 1
    pid="$(tr -d '[:space:]' < "$KAKAKE_WEB_BUILD_PID" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

kakake_web_build_clear_state() {
    rm -f "$KAKAKE_WEB_BUILD_PID" "$KAKAKE_WEB_BUILD_START" 2>/dev/null || true
}

kakake_collect_web_build_log() {
    [[ -f "$KAKAKE_WEB_BUILD_LOG" ]] && cat "$KAKAKE_WEB_BUILD_LOG" 2>/dev/null || true
}

kakake_detect_web_build_progress() {
    local content="$1"
    local stage="准备中" percent=5 state="running"

    if echo "$content" | grep -q '\[MK-KAKAKE-WEB-ERROR\]'; then
        stage="$(echo "$content" | grep '\[MK-KAKAKE-WEB-ERROR\]' | tail -1 | sed 's/.*\[MK-KAKAKE-WEB-ERROR\] //')"
        echo "failed|${stage}|0"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-KAKAKE-WEB-DONE\]'; then
        echo "100|构建完成|100"
        return 0
    fi

    # 细粒度：ensure-web / vite 日志
    if echo "$content" | grep -q '\[ensure-web\] build ok'; then
        echo "running|校验构建产物|90"
        return 0
    fi
    if echo "$content" | grep -qiE 'building →|vite.*build|force rebuild'; then
        echo "running|编译前端 (Vite)|72"
        return 0
    fi
    if echo "$content" | grep -qiE 'installing dependencies|npm install'; then
        echo "running|安装前端依赖|48"
        return 0
    fi

    if echo "$content" | grep -q '\[MK-KAKAKE-WEB-STEP\] 4/4'; then
        echo "running|校验产物|92"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-KAKAKE-WEB-STEP\] 3/4'; then
        echo "running|构建前端|60"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-KAKAKE-WEB-STEP\] 2/4'; then
        echo "running|安装后端依赖|30"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-KAKAKE-WEB-STEP\] 1/4'; then
        echo "running|准备环境|12"
        return 0
    fi
    echo "running|${stage}|${percent}"
}

kakake_web_panel_cursor_up() {
    local i=0
    for ((i=0; i<KAKAKE_WEB_PANEL_LINES; i++)); do
        printf '%s' $'\033[1A\033[2K'
    done
}

kakake_draw_web_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  咔咔珂 Web 构建 哦喵 ₍˄·͈༝·͈˄₎"
    echo "--------------------------------------"
    echo "  当前步骤: ${stage}"
    printf '  进度: '
    baota_make_bar "$percent"
    echo
    echo "  已用时间: ${elapsed} 秒    状态: ${spin} 运行中"
    echo "  详细日志: ${KAKAKE_WEB_BUILD_LOG}"
    echo "--------------------------------------"
}

kakake_show_web_build_errors() {
    local content=""
    content="$(kakake_collect_web_build_log)"
    echo
    error "呜哇！ Web UI 编译翻车了喵，关键出错 呀喵:"
    echo "$content" | grep -E '\[MK-KAKAKE-WEB-ERROR\]|\[MK-WEB-ERROR\]|npm ERR!| ELIFECYCLE |Error:|error TS|command not found' | tail -20 || true
    echo
    info "小MK喵：完整日志: ${KAKAKE_WEB_BUILD_LOG} 呢～ ₍˄·͈༝·͈˄₎"
    info "诶嘿～ 运行日志: ${KAKAKE_LOG} 喵～ (๑ᵕᴗᵕ๑)"
}

kakake_watch_web_build() {
    local last_percent=-1 spinner=('|' '/' '-' '+') spin_idx=0
    local result="" stage="" percent=0 state=""
    local start_ts="" now_ts="" elapsed=0 panel_active=0

    if ! kakake_web_build_running; then
        # 进程已结束：根据日志判定成败
        local content=""
        content="$(kakake_collect_web_build_log)"
        result="$(kakake_detect_web_build_progress "$content")"
        IFS='|' read -r state stage percent <<< "$result"
        if [[ "$state" == "100" ]] || echo "$content" | grep -q '\[MK-KAKAKE-WEB-DONE\]'; then
            return 0
        fi
        kakake_show_web_build_errors
        return 1
    fi

    start_ts="$(tr -d '[:space:]' < "$KAKAKE_WEB_BUILD_START" 2>/dev/null || date +%s)"
    [[ "$start_ts" =~ ^[0-9]+$ ]] || start_ts=$(date +%s)

    echo
    info "呐呐，正在编译 Web UI（进度面板模式） 呢喵 (｡•̀ᴗ-)✧"
    info "喵～ 按 Ctrl+C 可退出进度显示，后台构建不会停止 啦～ (๑>◡<๑)"
    echo

    trap 'echo; info "呐呐，已退出进度显示，构建仍在后台继续 啦喵 ₍˄·͈༝·͈˄₎"; trap - INT; return 0' INT

    while kakake_web_build_running; do
        local content=""
        content="$(kakake_collect_web_build_log)"
        result="$(kakake_detect_web_build_progress "$content")"
        IFS='|' read -r state stage percent <<< "$result"

        if [[ "$state" == "failed" ]]; then
            trap - INT
            (( panel_active == 1 )) && kakake_web_panel_cursor_up
            kakake_show_web_build_errors
            return 1
        fi

        (( percent < last_percent )) && percent=$last_percent || last_percent=$percent
        now_ts=$(date +%s)
        elapsed=$(( now_ts - start_ts ))
        spin_idx=$(( (spin_idx + 1) % 4 ))
        (( panel_active == 1 )) && kakake_web_panel_cursor_up
        kakake_draw_web_progress_panel "$percent" "$stage" "$elapsed" "${spinner[$spin_idx]}"
        panel_active=1

        [[ "$state" == "100" || "$percent" -ge 100 ]] && break
        sleep 1
    done

    trap - INT

    local final=""
    # 等进程真正退出，避免日志尚未刷完
    local wait_i=0
    while kakake_web_build_running && (( wait_i < 30 )); do
        sleep 0.2
        ((wait_i++)) || true
    done
    final="$(kakake_collect_web_build_log)"
    result="$(kakake_detect_web_build_progress "$final")"
    IFS='|' read -r state stage percent <<< "$result"

    if [[ "$state" != "100" && "$state" != "failed" ]]; then
        if echo "$final" | grep -q '\[MK-KAKAKE-WEB-DONE\]'; then
            state="100"
            stage="构建完成"
            percent=100
        else
            state="failed"
            stage="构建异常结束"
        fi
    fi

    now_ts=$(date +%s)
    elapsed=$(( now_ts - start_ts ))

    if [[ "$state" == "failed" ]]; then
        (( panel_active == 1 )) && kakake_web_panel_cursor_up
        kakake_show_web_build_errors
        kakake_web_build_clear_state
        return 1
    fi

    (( panel_active == 1 )) && kakake_web_panel_cursor_up
    kakake_draw_web_progress_panel 100 "构建完成" "$elapsed" "OK"
    echo
    kakake_web_build_clear_state
    return 0
}

kakake_ensure_web_build() {
    local node_bin="$1"
    local node_path="" force="${KAKAKE_FORCE_WEB_BUILD:-0}"
    local args=(scripts/ensure-web.mjs)

    [[ -n "$node_bin" && -x "$node_bin" ]] || return 1
    node_path="$(dirname "$node_bin")"
    export PATH="${node_path}:${PATH}"

    if [[ ! -d "$KAKAKE_HOME" ]]; then
        error "呜哇！ 咔咔珂目录不存在: ${KAKAKE_HOME} 哦喵 (；´д｀)"
        return 1
    fi

    # 便携版：Web 已随包提供，不可/不需在服务器上重建
    if kakake_is_portable; then
        if kakake_web_built; then
            info "喵～ 便携版 Web UI 已随包提供 ($(kakake_web_label)) 咯～ (๑ᵕᴗᵕ๑)"
            return 0
        fi
        error "诶诶！ 便携版少了 packages/web/dist，请重新解压便携包 咯喵 (；´д｀)"
        return 1
    fi

    if [[ "$force" != "1" ]] && ! kakake_web_needs_rebuild 0; then
        info "喵～ Web UI 已是最新 ($(kakake_web_label)) 啦～ (๑>◡<๑)"
        return 0
    fi

    if kakake_web_build_running; then
        info "小MK喵：小MK发现 Web 构建仍在进行，恢复进度显示 哇～ (｡•̀ᴗ-)✧"
        if kakake_watch_web_build && kakake_web_built; then
            kakake_web_write_stamp || true
            info "喵～ Web UI 就绪 ($(kakake_web_label)) 呀～ ✧٩(ˊωˋ*)و✧"
            return 0
        fi
        return 1
    fi

    if [[ "$force" == "1" ]] || kakake_web_has_stale_next; then
        kakake_web_clean_legacy_next
    fi

    if [[ "$force" == "1" ]]; then
        args+=(build --force)
        info "喵～ 强制重建 Web UI → packages/web/dist 呀～ ✧٩(ˊωˋ*)و✧"
    else
        info "诶嘿～ 需要构建 Web UI → packages/web/dist 呢喵 (๑ᵕᴗᵕ๑)"
    fi
    if mk_is_termux; then
        warn "诶…… 手机上首次构建约 5-15 分钟（取决于机型与网络），请保持 Termux 在前台不要息屏 喵～ (；´д｀)"
    fi

    kakake_export_npm_registry
    mkdir -p "$LOG_DIR"
    : > "$KAKAKE_WEB_BUILD_LOG"
    date +%s > "$KAKAKE_WEB_BUILD_START"
    echo "===== Kakake web build $(date '+%Y-%m-%d %H:%M:%S') force=${force} =====" >> "$KAKAKE_LOG"

    nohup env \
        KAKAKE_HOME="$KAKAKE_HOME" \
        KAKAKE_NODE_BIN="$node_bin" \
        KAKAKE_NODE_PATH="$node_path" \
        KAKAKE_FORCE_WEB_BUILD="$force" \
        KAKAKE_ENSURE_ARGS="${args[*]}" \
        KAKAKE_IS_TERMUX="$(mk_is_termux && echo 1 || echo 0)" \
        TMPDIR="$MK_TMP" \
        npm_config_registry="${npm_config_registry:-}" \
        bash -s >> "$KAKAKE_WEB_BUILD_LOG" 2>&1 << 'KAKAKEWEBEOF' &
set -u
log_step() { echo "[MK-KAKAKE-WEB-STEP] $1"; }
log_err()  { echo "[MK-KAKAKE-WEB-ERROR] $1"; }

HOME_DIR="${KAKAKE_HOME:?}"
NODE_BIN="${KAKAKE_NODE_BIN:?}"
NODE_PATH="${KAKAKE_NODE_PATH:?}"
FORCE="${KAKAKE_FORCE_WEB_BUILD:-0}"
IS_TERMUX="${KAKAKE_IS_TERMUX:-0}"
export PATH="${NODE_PATH}:${PATH}"
export CI=1
[[ -n "${npm_config_registry:-}" ]] && export npm_config_registry
# 安卓没有 /tmp，npm 与 esbuild 都靠 TMPDIR 落临时文件
[[ -n "${TMPDIR:-}" ]] && { mkdir -p "$TMPDIR" 2>/dev/null || true; export TMPDIR; }
if [[ "$IS_TERMUX" == "1" ]]; then
    # 手机内存小，Vite/Rollup 默认堆容易 OOM；同时关掉 npm 的可选原生依赖
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}"
    export npm_config_audit=false
    export npm_config_fund=false
fi

cd "$HOME_DIR" || { log_err "无法进入目录: ${HOME_DIR}"; exit 1; }

log_step "1/4 准备环境"
if [[ ! -x "$NODE_BIN" ]]; then
    log_err "Node 不可用: ${NODE_BIN}"
    exit 1
fi
echo "[MK-KAKAKE-WEB] node=$("$NODE_BIN" -v 2>/dev/null || echo unknown) force=${FORCE}"

log_step "2/4 安装后端依赖"
if [[ ! -f node_modules/tsx/package.json ]]; then
    echo "[MK-WEB] 安装后端依赖 npm install…"
    echo "[MK-WEB] registry=${npm_config_registry:-"(npm default)"}"
    npm install 2>&1 || { log_err "npm install 失败"; exit 1; }
else
    echo "[MK-WEB] 后端依赖已就绪，跳过 npm install"
fi

log_step "3/4 构建前端"
# 解析 ensure 参数（空格分隔）
set -- ${KAKAKE_ENSURE_ARGS:-scripts/ensure-web.mjs}
echo "[MK-WEB] node $* …"
"$NODE_BIN" "$@" 2>&1 || { log_err "ensure-web / Vite 构建失败"; exit 1; }

log_step "4/4 校验产物"
if [[ ! -f packages/web/dist/index.html ]]; then
    log_err "缺少 packages/web/dist/index.html"
    exit 1
fi
echo "[MK-WEB-DONE] Vite dist ok ($(wc -c < packages/web/dist/index.html | tr -d ' ') bytes index.html)"
echo "[MK-KAKAKE-WEB-DONE] packages/web/dist"
KAKAKEWEBEOF
    echo $! > "$KAKAKE_WEB_BUILD_PID"
    sleep 1

    if ! kakake_watch_web_build; then
        echo "===== Kakake web build FAILED $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$KAKAKE_LOG"
        return 1
    fi

    if ! kakake_web_built; then
        error "诶诶！ 构建结束但没找到 packages/web/dist/index.html 呢喵 (´･ω･)"
        kakake_show_web_build_errors
        return 1
    fi

    # 摘要写入运行日志，便于排障
    {
        echo "===== Kakake web build OK $(date '+%Y-%m-%d %H:%M:%S') ====="
        tail -5 "$KAKAKE_WEB_BUILD_LOG" 2>/dev/null || true
    } >> "$KAKAKE_LOG"

    kakake_web_write_stamp || true
    info "诶嘿～ Web UI 就绪 ($(kakake_web_label)) 哦喵 (๑ᵕᴗᵕ๑)"
    return 0
}

kakake_is_running() {
    # 对外「是否在跑」以本机 HTTP 探活为准，避免 PID/端口误报导致无法重启
    local port=""
    port="$(kakake_get_admin_port)"
    kakake_http_alive "$port"
}

# 是否有咔咔珂相关进程（用于停止/清理，不代表服务可用）
kakake_has_process() {
    local pid="" cwd=""

    if [[ -f "$KAKAKE_PID_FILE" ]]; then
        pid="$(tr -d '[:space:]' < "$KAKAKE_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    pgrep -f "${KAKAKE_HOME}/scripts/bootstrap.mjs" >/dev/null 2>&1 && return 0
    pgrep -f "${KAKAKE_HOME}/packages/server/main.mjs" >/dev/null 2>&1 && return 0
    pgrep -f "${KAKAKE_HOME}.*src/main.ts" >/dev/null 2>&1 && return 0
    for pid in $(pgrep -f 'scripts/bootstrap.mjs' 2>/dev/null); do
        cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$KAKAKE_HOME" ]] && return 0
    done
    for pid in $(pgrep -f 'packages/server/main.mjs' 2>/dev/null); do
        cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$KAKAKE_HOME" ]] && return 0
    done
    for pid in $(pgrep -f 'src/main.ts' 2>/dev/null); do
        cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$KAKAKE_HOME" ]] && return 0
    done
    for pid in $(pgrep -f 'tsx.*src/main.ts' 2>/dev/null); do
        cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$KAKAKE_HOME" ]] && return 0
    done
    return 1
}

kakake_http_alive() {
    local port="${1:-}"
    local code=""
    [[ -z "$port" || "$port" == "0" ]] && return 1

    if command -v curl >/dev/null 2>&1; then
        code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
            "http://127.0.0.1:${port}/" 2>/dev/null || echo 000)"
    elif command -v wget >/dev/null 2>&1; then
        if wget -q -O /dev/null --timeout=5 "http://127.0.0.1:${port}/" 2>/dev/null; then
            code="200"
        else
            code="000"
        fi
    else
        # 无 curl/wget 时退回端口监听（弱校验）
        kakake_port_listening "$port" && return 0
        return 1
    fi

    # 能返回 HTTP 状态即认为 Nest 还活着（含未构建时的 503）
    [[ "$code" =~ ^(200|204|301|302|303|307|308|401|403|404|503)$ ]]
}

# 菜单用状态文案：健康 / 异常 / 未运行
kakake_status_line() {
    local port="" code="000"
    port="$(kakake_get_admin_port)"

    if command -v curl >/dev/null 2>&1; then
        code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
            "http://127.0.0.1:${port}/" 2>/dev/null || echo 000)"
    fi

    if [[ "$code" =~ ^(200|204|301|302|303|307|308|401|403|404)$ ]]; then
        if kakake_web_built; then
            echo -e "  ${GREEN}* 咔咔珂正在运行 (HTTP ${code} · ${port}) 呢喵 (｡•̀ᴗ-)✧${NC}"
        else
            echo -e "  ${YELLOW}* 服务在响应但 Web UI 未构建 (HTTP ${code})，后台页面不可用 喵♪ (๑•̀ㅂ•́)و✧${NC}"
            echo -e "  ${YELLOW}  → 请先 [6] 停止，再 [10] 构建，然后 [5] 启动 喵～ ✧٩(ˊωˋ*)و✧${NC}"
        fi
        return
    fi

    if [[ "$code" == "503" ]]; then
        echo -e "  ${YELLOW}* 服务在跑但返回 503（多半 Web UI 未构建） 喵♪ ✧٩(ˊωˋ*)و✧${NC}"
        echo -e "  ${YELLOW}  → 请 [6] 停止 → [10] 构建 → [5] 启动 喵～ ₍˄·͈༝·͈˄₎${NC}"
        return
    fi

    if kakake_has_process || kakake_port_listening "$port"; then
        echo -e "  ${RED}* 进程/端口被别的东西占着，HTTP 无响应 (code=${code}) 咯喵 ✧٩(ˊωˋ*)و✧${NC}"
        echo -e "  ${YELLOW}  → 请先 [6] 停止咔咔珂，再 [5] 重新启动 喵♪ ₍˄·͈༝·͈˄₎${NC}"
        return
    fi

    if kakake_is_installed; then
        echo -e "  ${YELLOW}* 咔咔珂已经装好啦 (没在跑呢) 呢喵 ✧٩(ˊωˋ*)و✧${NC}"
    else
        echo -e "  ${YELLOW}* 咔咔珂还没装呢 (๑ᵕᴗᵕ๑)${NC}"
    fi
}

kakake_port_listening() {
    local port="$1"
    [[ -z "$port" || "$port" == "0" ]] && return 1
    if command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | grep -qE ":${port}[[:space:]]" && return 0
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -tln 2>/dev/null | grep -qE ":${port}[[:space:]]" && return 0
    fi
    # 兜底：Termux 精简环境可能既没有 ss 也没有 netstat，直接读内核表
    # /proc/net/tcp 的 local_address 是 十六进制IP:十六进制端口，st=0A 表示 LISTEN
    local proc_file="" c1="" laddr="" c3="" st="" hexport=""
    for proc_file in /proc/net/tcp /proc/net/tcp6; do
        [[ -r "$proc_file" ]] || continue
        while read -r c1 laddr c3 st _; do
            [[ "$st" == "0A" ]] || continue
            hexport="${laddr##*:}"
            [[ "$hexport" =~ ^[0-9A-Fa-f]+$ ]] || continue
            if (( 16#$hexport == port )); then
                return 0
            fi
        done < <(tail -n +2 "$proc_file" 2>/dev/null)
    done
    return 1
}

kakake_parse_ws_target() {
    local addr="$1"
    local host="" port=""
    addr="${addr#ws://}"
    addr="${addr#wss://}"
    addr="${addr%%/*}"
    if [[ "$addr" == *:* ]]; then
        host="${addr%%:*}"
        port="${addr##*:}"
    else
        host="$addr"
    fi
    host="${host:-127.0.0.1}"
    printf '%s %s\n' "$host" "$port"
}

kakake_reverse_ws_has_client() {
    local port="$1"
    [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && return 1

    if command -v ss >/dev/null 2>&1; then
        ss -H -tn state established "( sport = :${port} )" 2>/dev/null | grep -q . && return 0
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -tn 2>/dev/null | awk -v p=":${port}" '
            $6 ~ /^ESTABLISHED$/ && $4 ~ p "([^0-9]|$)" { found=1 }
            END { exit !found }' && return 0
    fi
    return 1
}

kakake_forward_ws_has_session() {
    local host="$1" port="$2"
    [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && return 1
    host="${host:-127.0.0.1}"

    if command -v ss >/dev/null 2>&1; then
        ss -H -tn state established "( dport = :${port} )" 2>/dev/null | grep -qF "${host}" && return 0
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -tn 2>/dev/null | awk -v hp="${host}:${port}" '
            $6 ~ /^ESTABLISHED$/ && $5 ~ hp "([^0-9]|$)" { found=1 }
            END { exit !found }' && return 0
    fi

    if [[ -f "$KAKAKE_LOG" ]]; then
        tail -50 "$KAKAKE_LOG" 2>/dev/null | grep -F "${host}:${port}" 2>/dev/null | grep -qiE '连接成功|已连接|WebSocket.*open|Connected|ready' && return 0
    fi
    return 1
}

kakake_qq_official_has_session() {
    [[ -f "$KAKAKE_LOG" ]] || return 1

    if tail -30 "$KAKAKE_LOG" 2>/dev/null | grep -qiE 'disconnect|断开|连接失败|failed to connect|error.*gateway'; then
        return 1
    fi
    tail -50 "$KAKAKE_LOG" 2>/dev/null | grep -qiE 'Gateway.*(connected|就绪|open)|官方机器人.*(已连接|登录成功|连接成功)' 
}

kakake_open_admin_port() {
    napcat_firewall_open_port "$(kakake_get_admin_port)"
}

kakake_node_fetch_latest_version() {
    local ver=""
    ver="$(curl -fsSL --max-time 15 "https://nodejs.org/dist/index.json" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for item in data:
        v = str(item.get('version', '')).lstrip('v')
        if v:
            print(v)
            break
except Exception:
    pass
" 2>/dev/null || true)"
    if [[ -n "$ver" ]]; then
        echo "$ver"
        return 0
    fi
    echo "$KAKAKE_NODE_STABLE_22"
}

kakake_node_build_download_url() {
    local version="$1"
    local arch="$2"
    local mirror_idx="$3"
    local base=""

    if [[ "$mirror_idx" -ge 0 && "$mirror_idx" -lt ${#node_mirror_urls[@]} ]]; then
        base="${node_mirror_urls[$mirror_idx]}"
        base="${base%/}"
        echo "${base}/v${version}/node-v${version}-linux-${arch}.tar.xz"
    else
        echo "https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.xz"
    fi
}

menu_node_select_version() {
    local latest=""

    while true; do
        latest="$(kakake_node_fetch_latest_version)"
        title "选择 Node.js 版本 啦喵 (๑•̀ㅂ•́)و✧"
        show_nav_hint
        echo "  咔咔珂要求 Node.js >= 20 呀喵 ₍˄·͈༝·͈˄₎"
        echo "  [2] 稳定版 ${KAKAKE_NODE_STABLE_22} (22.x LTS，推荐)"
        echo "  [3] 稳定版 ${KAKAKE_NODE_STABLE_20} (20.x LTS)"
        echo "  [4] 最新版 (当前约 v${latest})"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            2)
                NODE_INSTALL_VERSION="$KAKAKE_NODE_STABLE_22"
                NODE_INSTALL_VERSION_LABEL="稳定版 ${KAKAKE_NODE_STABLE_22}"
                return 0
                ;;
            3)
                NODE_INSTALL_VERSION="$KAKAKE_NODE_STABLE_20"
                NODE_INSTALL_VERSION_LABEL="稳定版 ${KAKAKE_NODE_STABLE_20}"
                return 0
                ;;
            4)
                NODE_INSTALL_VERSION="$(kakake_node_fetch_latest_version)"
                NODE_INSTALL_VERSION_LABEL="最新版 ${NODE_INSTALL_VERSION}"
                return 0
                ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (,,>﹏<,,)" ;;
        esac
    done
}

menu_node_select_mirror() {
    local i=0 idx=0

    while true; do
        title "选择 Node.js 下载镜像 呀喵 ✧٩(ˊωˋ*)و✧"
        show_nav_hint
        echo "  国内服务器建议选择镜像源加速下载 咯喵 (๑ᵕᴗᵕ๑)"
        echo

        for ((i=0; i<${#node_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            echo "  [${idx}] ${node_mirror_labels[$i]}"
        done
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            *)
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#node_mirror_labels[@]} )); then
                        NODE_INSTALL_MIRROR_IDX="$idx"
                        info "小MK喵：已选择: ${node_mirror_labels[$idx]} 哇～ (｡•̀ᴗ-)✧"
                        return 0
                    fi
                fi
                warn "呜喵… 看不懂选项，请重新输入 呢～ (｡•́︿•̀｡)"
                ;;
        esac
    done
}

# Termux 专用装 Node：安卓是 bionic libc，nodejs.org 的 linux-arm64 包是 glibc 编译的，
# 解压后一定报 "cannot execute: required file not found"，所以只能走 pkg 仓库。
kakake_node_install_termux() {
    local confirm="" cur_ver="" pkg_name="nodejs-lts"

    if command -v node >/dev/null 2>&1; then
        cur_ver="$(node -v 2>/dev/null || true)"
        info "诶嘿～ Termux 已经装好啦 Node.js ${cur_ver:-未知} 喵♪ (๑ᵕᴗᵕ๑)"
        read -r -p "是否重新安装/升级 Node.js? 喵～ (´･ω･) [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || return 0
    fi

    title "安装 Node.js（Termux） 呢喵 ₍˄·͈༝·͈˄₎"
    echo "  安装方式: pkg install ${pkg_name} 咯喵 (๑ᵕᴗᵕ๑)"
    echo "  说明:     安卓用的是 bionic libc，官网的 Linux 版 Node 没法运行 喵♪ (｡•̀ᴗ-)✧"
    echo "            只能用 Termux 仓库里编译好的版本 喵～ (๑>◡<๑)"
    echo "  当前仓库 nodejs-lts 为 22.x，满足咔咔珂 >= 20 的要求 啦喵 (๑•̀ㅂ•́)و✧"
    echo
    warn "呜喵… nodejs 与 nodejs-lts 冲突，装前会先卸掉另一个 呢～ (´･ω･)"
    echo

    read -r -p "确认安装? 喵♪ (。•́︿•̀。) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "诶嘿～ 已取消安装 啦喵 ✧٩(ˊωˋ*)و✧"
        return 0
    }

    if ! command -v pkg >/dev/null 2>&1; then
        error "诶诶！ 找不到 pkg 命令，当前似乎不是标准 Termux 环境 喵♪ (´･ω･)"
        return 1
    fi

    info "呐呐，正在更新软件源 呀喵 (｡•̀ᴗ-)✧"
    pkg update -y >/dev/null 2>&1 || warn "呜喵… 软件源更新失败，继续尝试安装 啦～ (´･ω･)"

    # nodejs 与 nodejs-lts 互斥，先移除另一个免得 dpkg 冲突
    pkg uninstall -y nodejs >/dev/null 2>&1 || true

    info "小MK喵：正在装 ${pkg_name} 哇～ (｡•̀ᴗ-)✧"
    if ! pkg install -y "$pkg_name"; then
        error "诶诶！ 装不上了喵，请先换国内镜像源再重试: termux-change-repo 呢喵 (,,>﹏<,,)"
        return 1
    fi

    # 源码版编译原生依赖时要用到，缺了会在 npm install 阶段报 gyp ERR
    info "喵～ 正在装编译依赖（python / clang / make / git / unzip） 啦～ (๑>◡<๑)"
    pkg install -y python clang make git unzip >/dev/null 2>&1 \
        || warn "小MK喵小声说：编译依赖装不上了喵，若后续 npm install 报 gyp 出错手动安装 呀～ (；´д｀)"

    if ! command -v node >/dev/null 2>&1; then
        error "小MK喵吓一跳！ Node.js 安装校验失败 哇～ (,,>﹏<,,)"
        return 1
    fi

    printf '%s\n' "termux-pkg" > "$KAKAKE_NODE_VER_FILE" 2>/dev/null || true
    info "诶嘿～ Node.js 装好啦: $(node -v) 咯喵 (๑ᵕᴗᵕ๑)"
    info "呐呐，路径: $(command -v node) 喵♪ (｡•̀ᴗ-)✧"
}

kakake_node_install() {
    if mk_is_termux; then
        kakake_node_install_termux
        return $?
    fi

    require_root || return 1

    local install_ver="" confirm="" sys_bin="" sys_ver=""

    if kakake_node_private_installed; then
        local ver=""
        ver="$("$KAKAKE_NODE_BIN" -v 2>/dev/null || true)"
        warn "呜喵… mk 管理的 Node 已经装好啦: ${ver:-未知} 呢～ (；´д｀)"
        read -r -p "是否重新安装 Node.js? 哦喵 (´･ω･) [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || return 0
    elif sys_bin="$(kakake_resolve_node_bin 2>/dev/null)"; then
        sys_ver="$("$sys_bin" -v 2>/dev/null || echo 未知)"
        info "喵～ 小MK发现系统已有 Node.js ${sys_ver}（${sys_bin}） 呀～ ✧٩(ˊωˋ*)و✧"
        info "小MK喵：咔咔珂启动会直接使用它；也可继续安装一份 mk 私有 Node（启动时优先） 呢～ ₍˄·͈༝·͈˄₎"
        read -r -p "是否仍安装 mk 私有 Node.js? 啦喵 (｡•́︿•̀｡) [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || return 0
    fi

    NODE_INSTALL_VERSION=""
    NODE_INSTALL_VERSION_LABEL=""
    NODE_INSTALL_MIRROR_IDX="0"
    menu_node_select_version || return 0
    menu_node_select_mirror || return 0

    install_ver="$NODE_INSTALL_VERSION"

    title "安装 Node.js 喵♪ (๑ᵕᴗᵕ๑)"
    echo "  版本:     ${NODE_INSTALL_VERSION_LABEL} 喵～ (｡•̀ᴗ-)✧"
    echo "  镜像:     ${node_mirror_labels[$NODE_INSTALL_MIRROR_IDX]} 啦喵 (๑>◡<๑)"
    echo "  安装路径: ${KAKAKE_NODE_DIR} 哦喵 (๑•̀ㅂ•́)و✧"
    echo "  咔咔珂启动将优先使用此 Node 呀喵 ✧٩(ˊωˋ*)و✧"
    echo
    warn "诶…… 若服务器上已有其他 Node 项目，切换版本可能导致那些项目没法正常运行 咯喵 (；´д｀)"
    echo

    read -r -p "确认安装 Node.js v${install_ver}? 啦喵 (,,>﹏<,,) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "小MK喵：已取消安装 呢～ ₍˄·͈༝·͈˄₎"
        return 0
    }

    local arch="" url="" tmp=""
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            error "诶诶！ 帮不上忙的 CPU 架构: $(uname -m) 喵♪ (；´д｀)"
            return 1
            ;;
    esac

    if ! command -v curl >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq >/dev/null 2>&1 || true
            apt-get install -y curl xz-utils >/dev/null 2>&1 || true
        elif command -v yum >/dev/null 2>&1; then
            yum install -y curl xz >/dev/null 2>&1 || true
        fi
    fi

    url="$(kakake_node_build_download_url "$install_ver" "$arch" "$NODE_INSTALL_MIRROR_IDX")"
    tmp="$(mktemp /tmp/mk-node.XXXXXX.tar.xz)"

    info "喵～ 正在下载 Node.js v${install_ver} 啦～ (๑>◡<๑)"
    info "小MK喵：下载地址: ${url} 哦～ (๑•̀ㅂ•́)و✧"
    if ! curl -fL --retry 3 --connect-timeout 30 -o "$tmp" "$url"; then
        error "呜哇！ 下载失败，可尝试更换镜像源 咯喵 (；´д｀)"
        rm -f "$tmp"
        return 1
    fi

    mkdir -p "$INSTALL_DIR"
    rm -rf "$KAKAKE_NODE_DIR"
    mkdir -p "$KAKAKE_NODE_DIR"

    if ! tar -xJf "$tmp" -C "$KAKAKE_NODE_DIR" --strip-components=1; then
        error "诶诶！ 解压 Node.js 失败 啦喵 (；´д｀)"
        rm -f "$tmp"
        return 1
    fi
    rm -f "$tmp"

    if ! kakake_node_private_installed; then
        error "小MK喵吓一跳！ Node.js 安装校验失败 呀～ (｡•́︿•̀｡)"
        return 1
    fi

    echo "$install_ver" > "$KAKAKE_NODE_VER_FILE"
    echo "${NODE_INSTALL_MIRROR_IDX}" > "$KAKAKE_NODE_MIRROR_FILE"
    info "诶嘿～ Node.js 装好啦: $("$KAKAKE_NODE_BIN" -v) 喵～ ✧٩(ˊωˋ*)و✧"
    info "呐呐，路径: ${KAKAKE_NODE_BIN} 啦喵 ₍˄·͈༝·͈˄₎"
}

kakake_node_uninstall() {
    # Termux 的 Node 由 pkg 管，mk 没有自己的私有副本可删
    if mk_is_termux; then
        title "卸载 Node.js（Termux） 喵～ ₍˄·͈༝·͈˄₎"
        if ! command -v node >/dev/null 2>&1; then
            warn "小MK喵小声说：当前没有小MK发现 Node.js 哇～ (｡•́︿•̀｡)"
            press_enter
            return 0
        fi
        echo "  当前版本: $(node -v 2>/dev/null || echo 未知)"
        echo "  安装来源: Termux 软件仓库（pkg），不是 mk 私有副本 喵～ (๑ᵕᴗᵕ๑)"
        echo
        warn "呜喵… 卸载后咔咔珂将没法启动，其他依赖 node 的工具也会失效 啦～ (。•́︿•̀。)"
        echo
        local confirm=""
        read -r -p "确认执行 pkg uninstall nodejs-lts? 咯喵 (｡•́︿•̀｡) [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || {
            info "呐呐，那就不拆啦 (｡•̀ᴗ-)✧"
            return 0
        }
        if kakake_http_alive "$(kakake_get_admin_port)" || kakake_has_process; then
            warn "呜喵… 咔咔珂正在跑，请先停止再卸载 Node 呢～ (,,>﹏<,,)"
            return 1
        fi
        pkg uninstall -y nodejs-lts >/dev/null 2>&1 || pkg uninstall -y nodejs >/dev/null 2>&1 || true
        rm -f "$KAKAKE_NODE_VER_FILE" "$KAKAKE_NODE_MIRROR_FILE" 2>/dev/null || true
        info "喵～ Node.js 已卸载 呀～ ✧٩(ˊωˋ*)و✧"
        return 0
    fi

    require_root || return 1

    if ! kakake_node_private_installed && [[ ! -f "$KAKAKE_NODE_VER_FILE" ]]; then
        warn "呜喵… 小MK没找到 mk 安装的 Node.js 呢～ (；´д｀)"
        if kakake_node_installed; then
            info "小MK喵：系统全局 Node 仍可用: $(kakake_get_node_version)（不会被本操作卸载） 哇～ (｡•̀ᴗ-)✧"
        fi
        return 0
    fi

    local installed_ver=""
    installed_ver="$(cat "$KAKAKE_NODE_VER_FILE" 2>/dev/null || echo 未知)"

    local confirm=""
    read -r -p "确认卸载 mk 管理的 Node.js (v${installed_ver})? 喵♪ (´･ω･) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "喵～ 那就不拆啦 (๑ᵕᴗᵕ๑)"
        return 0
    }

    if kakake_http_alive "$(kakake_get_admin_port)" || kakake_has_process; then
        warn "呜喵… 咔咔珂正在跑或残留进程占用，请先停止 呢～ (,,>﹏<,,)"
        return 1
    fi

    rm -rf "$KAKAKE_NODE_DIR"
    rm -f "$KAKAKE_NODE_VER_FILE" "$KAKAKE_NODE_MIRROR_FILE"
    info "呐呐，Node.js 已卸载 (mk 管理版本) 咯喵 ₍˄·͈༝·͈˄₎"
    warn "诶…… 系统自带的 node 命令(若有)不受影响 喵♪ (；´д｀)"
}

# 重装前暂存用户目录（仅 data / plugins），安装完成后还原
kakake_preserve_user_dirs() {
    local keep_root="$1"
    local kept=0

    rm -rf "$keep_root"
    mkdir -p "$keep_root"

    [[ -d "$KAKAKE_HOME" ]] || return 0

    if [[ -d "${KAKAKE_HOME}/data" ]]; then
        mv "${KAKAKE_HOME}/data" "${keep_root}/data"
        echo "[MK-KAKAKE] preserved data/"
        kept=1
    fi
    if [[ -d "${KAKAKE_HOME}/plugins" ]]; then
        mv "${KAKAKE_HOME}/plugins" "${keep_root}/plugins"
        echo "[MK-KAKAKE] preserved plugins/"
        kept=1
    fi

    if [[ "$kept" -eq 0 ]]; then
        echo "[MK-KAKAKE] no data/ or plugins/ to preserve"
    fi
}

kakake_restore_user_dirs() {
    local keep_root="$1"

    [[ -d "$keep_root" ]] || return 0

    if [[ -d "${keep_root}/data" ]]; then
        rm -rf "${KAKAKE_HOME}/data"
        mv "${keep_root}/data" "${KAKAKE_HOME}/data"
        echo "[MK-KAKAKE] restored data/"
    fi
    if [[ -d "${keep_root}/plugins" ]]; then
        rm -rf "${KAKAKE_HOME}/plugins"
        mv "${keep_root}/plugins" "${KAKAKE_HOME}/plugins"
        echo "[MK-KAKAKE] restored plugins/"
    fi

    rm -rf "$keep_root"
}

kakake_do_install() {
    require_root || return 1

    local edition_choice="" download_url="" zip_label="" want_edition=""

    title "安装咔咔珂 呀喵 ₍˄·͈༝·͈˄₎"
    echo "  安装目录均为: ${KAKAKE_HOME} 呢喵 (๑ᵕᴗᵕ๑)"
    echo "  重新安装会保留 data/ 与 plugins/ 咯喵 (｡•̀ᴗ-)✧"
    echo
    if mk_is_termux; then
        echo "  [1] 源码版（开发版）— 下载 kakake.zip，需 Node，可构建 Web"
        echo "  [2] 便携版                                                  — 手机不可用（内置的是 x86_64 glibc 版 Node）"
        echo "  [0] 取消"
        echo
        echo "  当前环境: $(mk_platform_label) · 只能装源码版 咯喵 (๑>◡<๑)"
    else
        echo "  [1] 源码版（开发版）— 下载 kakake.zip，需 Node，可构建 Web"
        echo "  [2] 便携版                                                  — 下载 kakake-linux-x64.zip，内置 Node，免构建"
        echo "  [0] 取消"
    fi
    echo
    read_choice edition_choice
    case "$edition_choice" in
        0)
            info "喵～ 已取消安装 咯～ (๑ᵕᴗᵕ๑)"
            return 0
            ;;
        1)
            want_edition="source"
            download_url="$KAKAKE_DOWNLOAD_URL"
            zip_label="kakake.zip（源码版）"
            ;;
        2)
            if mk_is_termux; then
                error "小MK喵吓一跳！ 便携版内置的是 x86_64 + glibc 的 Node，安卓（arm64 + bionic）跑不起来 呀～ (｡•́︿•̀｡)"
                info "呐呐，请选择嘛 [1] 源码版，mk 会用 Termux 仓库里的 Node 启动 咯喵 ₍˄·͈༝·͈˄₎"
                return 1
            fi
            want_edition="portable"
            download_url="$KAKAKE_DOWNLOAD_URL_PORTABLE"
            zip_label="kakake-linux-x64.zip（便携版）"
            ;;
        *)
            warn "小MK喵小声说：看不懂选项 哇～ (´･ω･)"
            return 1
            ;;
    esac

    info "喵～ 已选择: ${zip_label} 咯～ (๑ᵕᴗᵕ๑)"

    if kakake_is_installed; then
        local reinstall=""
        warn "小MK喵小声说：小MK发现咔咔珂已经装好啦 ($(kakake_edition_label)) 呀～ (；´д｀)"
        info "小MK喵：重新安装将保留 data/ 与 plugins/，其余文件会被替换 呢～ ₍˄·͈༝·͈˄₎"
        read -r -p "是否重新安装为所选版本? 呀喵 (｡•́︿•̀｡) [y/N]: " reinstall
        [[ "$reinstall" =~ ^[Yy]$ ]] || return 0
        kakake_stop || true
    fi

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        error "诶诶！ 需要 curl 或 wget 才能下载 哦喵 (,,>﹏<,,)"
        return 1
    fi
    if ! command -v unzip >/dev/null 2>&1; then
        if mk_is_termux; then
            pkg install -y unzip >/dev/null 2>&1 || true
        elif command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq >/dev/null 2>&1 || true
            apt-get install -y unzip >/dev/null 2>&1 || true
        elif command -v yum >/dev/null 2>&1; then
            yum install -y unzip >/dev/null 2>&1 || true
        fi
    fi
    if ! command -v unzip >/dev/null 2>&1; then
        error "呜哇！ 需要 unzip 命令，请先安装 哦喵 (｡•́︿•̀｡)"
        if mk_is_termux; then
            info "喵～ Termux 执行: pkg install unzip 呀～ ✧٩(ˊωˋ*)و✧"
        fi
        return 1
    fi

    mkdir -p "$LOG_DIR"
    : > "$KAKAKE_INSTALL_LOG"

    # 安卓没有 /tmp，统一走 MK_TMP（Termux 下是 $PREFIX/tmp）
    mkdir -p "$MK_TMP"
    local tmp_zip="${MK_TMP}/kakake-mk-download.zip"
    local tmp_dir="${MK_TMP}/kakake-mk-extract"
    local keep_dir="${MK_TMP}/kakake-mk-preserve"
    local preserved=0

    if [[ -d "${KAKAKE_HOME}/data" || -d "${KAKAKE_HOME}/plugins" ]]; then
        preserved=1
    fi

    info "呐呐，正在下载咔咔珂 (${zip_label}) 哦喵 ₍˄·͈༝·͈˄₎"
    info "喵～ 地址: ${download_url} 咯～ (๑ᵕᴗᵕ๑)"
    if [[ "$preserved" -eq 1 ]]; then
        info "诶嘿～ 将保留现有 data/ 与 plugins/ 咯喵 (๑>◡<๑)"
    fi

    {
        echo "[MK-KAKAKE] install start: $(date '+%Y-%m-%d %H:%M:%S') want=${want_edition} url=${download_url}"
        if curl -fL --retry 3 -o "$tmp_zip" "$download_url"; then
            echo "[MK-KAKAKE] download ok"
        elif wget -O "$tmp_zip" "$download_url"; then
            echo "[MK-KAKAKE] download ok (wget)"
        else
            echo "[ERROR] 下载失败: ${download_url} 啦喵 (๑ᵕᴗᵕ๑)"
            exit 1
        fi

        rm -rf "$tmp_dir"
        mkdir -p "$tmp_dir"
        unzip -oq "$tmp_zip" -d "$tmp_dir"

        # 先挪走用户数据，再整目录替换安装包
        kakake_preserve_user_dirs "$keep_dir"

        # 统一落到 ~/kakake：兼容 kakake / kakake-linux-x64 / 根目录即包 / 单层包裹
        if [[ -d "${tmp_dir}/kakake" ]]; then
            rm -rf "$KAKAKE_HOME"
            mv "${tmp_dir}/kakake" "$KAKAKE_HOME"
        elif [[ -d "${tmp_dir}/kakake-linux-x64" ]]; then
            rm -rf "$KAKAKE_HOME"
            mv "${tmp_dir}/kakake-linux-x64" "$KAKAKE_HOME"
        elif [[ -f "${tmp_dir}/scripts/bootstrap.mjs" || -f "${tmp_dir}/packages/server/main.mjs" ]]; then
            rm -rf "$KAKAKE_HOME"
            mv "$tmp_dir" "$KAKAKE_HOME"
            tmp_dir=""
        else
            nested=""
            count=0
            for nested in "$tmp_dir"/*; do
                [[ -d "$nested" ]] || continue
                count=$((count + 1))
            done
            if [[ "$count" -eq 1 ]]; then
                for nested in "$tmp_dir"/*; do
                    [[ -d "$nested" ]] || continue
                    rm -rf "$KAKAKE_HOME"
                    mv "$nested" "$KAKAKE_HOME"
                    break
                done
            else
                rm -rf "$KAKAKE_HOME"
                mv "$tmp_dir" "$KAKAKE_HOME"
                tmp_dir=""
            fi
        fi

        # 便携包可执行位（从 Windows 打包拷来时常丢失）
        if [[ -f "${KAKAKE_HOME}/runtime/bin/node" ]]; then
            chmod +x "${KAKAKE_HOME}/runtime/bin/node" 2>/dev/null || true
        fi
        if [[ -f "${KAKAKE_HOME}/启动.sh" ]]; then
            chmod +x "${KAKAKE_HOME}/启动.sh" 2>/dev/null || true
        fi

        kakake_restore_user_dirs "$keep_dir"

        rm -f "$tmp_zip"
        [[ -n "$tmp_dir" && -d "$tmp_dir" ]] && rm -rf "$tmp_dir"
        echo "[MK-KAKAKE] install done: $(date '+%Y-%m-%d %H:%M:%S')"
    } 2>&1 | tee -a "$KAKAKE_INSTALL_LOG"

    if ! kakake_is_installed; then
        error "呜哇！ 装不上了喵，看看: ${KAKAKE_INSTALL_LOG} 呢喵 (；´д｀)"
        if [[ -d "$keep_dir" && -d "$KAKAKE_HOME" ]]; then
            kakake_restore_user_dirs "$keep_dir" >/dev/null 2>&1 || true
        elif [[ -d "$keep_dir" ]]; then
            mkdir -p "$KAKAKE_HOME"
            kakake_restore_user_dirs "$keep_dir" >/dev/null 2>&1 || true
        fi
        return 1
    fi

    # 所选版本与实际落地形态不一致时提示（例如下错包）
    if [[ "$want_edition" == "portable" ]] && ! kakake_is_portable; then
        warn "呜喵… 已下载便携包，但目录未识别为便携版，帮忙检查一下 zip 内容是否含 runtime/bin/node 呢～ (｡•́︿•̀｡)"
    elif [[ "$want_edition" == "source" ]] && ! kakake_is_source; then
        warn "小MK喵小声说：已下载源码包，但目录未识别为源码版，帮忙检查一下是否含 scripts/bootstrap.mjs 哇～ (。•́︿•̀。)"
    fi

    mkdir -p "$KAKAKE_DATA"
    kakake_open_admin_port
    info "诶嘿～ 咔咔珂装好啦: ${KAKAKE_HOME} ($(kakake_edition_label)) 哦喵 (๑ᵕᴗᵕ๑)"
    if [[ "$preserved" -eq 1 ]]; then
        info "喵～ 已保留原 data/ 与 plugins/ 啦～ (๑>◡<๑)"
    fi
    if mk_is_termux; then
        info "呐呐，安卓不需要放行端口，同一 Wi-Fi 下别的设备可直接访问，未自动启动 喵～ ₍˄·͈༝·͈˄₎"
        info "喵～ 请先「安装 Node.js」（pkg 版），再「启动咔咔珂」 咯～ (๑ᵕᴗᵕ๑)"
        info "小MK喵：首次启动要装依赖 + 构建前端，手机上约 5-15 分钟，请保持 Termux 前台 哇～ (｡•̀ᴗ-)✧"
        return 0
    fi
    info "喵～ 已开放 ${KAKAKE_ADMIN_PORT} 端口，未自动启动 呀～ ✧٩(ˊωˋ*)و✧"
    if kakake_is_portable; then
        info "诶嘿～ 当前为便携版（内置 Node），可直接「启动咔咔珂」，无需再装系统 Node 喵～ (๑ᵕᴗᵕ๑)"
    else
        info "喵～ 请先「安装 Node.js」（若本机尚无），再「启动咔咔珂」 啦～ (๑>◡<๑)"
    fi
}

kakake_start_panel_cursor_up() {
    local i=0
    for ((i=0; i<KAKAKE_START_PANEL_LINES; i++)); do
        printf '%s' $'\033[1A\033[2K'
    done
}

kakake_draw_start_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  咔咔珂 启动进度 喵♪ (๑>◡<๑)"
    echo "--------------------------------------"
    echo "  当前步骤: ${stage} 啦喵 ✧٩(ˊωˋ*)و✧"
    printf '  进度: '
    baota_make_bar "$percent"
    echo
    echo "  已用时间: ${elapsed} 秒    状态: ${spin} 运行中 咯喵 (๑>◡<๑)"
    echo "--------------------------------------"
}

kakake_start() {
    local node_bin="" node_path="" port="" i=0 entry=""
    local start_ts="" now_ts="" elapsed=0 panel_active=0
    local spinner=('|' '/' '-' '+') spin_idx=0
    local percent=15 stage="准备启动"

    if ! kakake_is_installed; then
        error "小MK喵吓一跳！ 咔咔珂还没装呢，请先安装咔咔珂 哇～ (,,>﹏<,,)"
        return 1
    fi

    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        if kakake_is_portable; then
            error "呜哇！ 便携版少了 runtime/bin/node，帮忙检查一下目录是否完整 哦喵 (；´д｀)"
        else
            error "小MK喵吓一跳！ 没找到 Node.js，请先安装 Node.js 呀～ (｡•́︿•̀｡)"
        fi
        return 1
    fi

    if ! kakake_ensure_node_tools "$node_bin"; then
        return 1
    fi

    port="$(kakake_get_admin_port)"
    entry="$(kakake_server_entry)"

    if kakake_http_alive "$port"; then
        if kakake_web_built; then
            warn "诶…… 咔咔珂已在正常运行 ($(kakake_edition_label)) 呢喵 (´･ω･)"
            kakake_show_login_info
            return 0
        fi
        warn "小MK喵小声说：服务在响应但 Web UI 未构建，将重启并先构建前端 呀～ (；´д｀)"
        kakake_stop || true
        sleep 1
    elif kakake_has_process || kakake_port_listening "$port"; then
        warn "呜喵… 小MK发现残留进程或端口占用但 HTTP 无响应，先清理 啦～ (。•́︿•̀。)"
        kakake_stop || true
        # 仍占用则强杀监听进程
        if kakake_port_listening "$port"; then
            if command -v fuser >/dev/null 2>&1; then
                fuser -k "${port}/tcp" >/dev/null 2>&1 || true
            elif command -v lsof >/dev/null 2>&1; then
                lsof -ti ":${port}" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
            fi
            sleep 1
        fi
    fi

    # 源码版必须先构建；便携版校验随包 Web（构建过程自带进度面板）
    if ! kakake_ensure_web_build "$node_bin"; then
        return 1
    fi

    node_path="$(dirname "$node_bin")"
    mkdir -p "$LOG_DIR" "$KAKAKE_DATA"
    # 便携包从 Windows 拷来时可能丢可执行位
    if [[ -f "${KAKAKE_HOME}/runtime/bin/node" ]]; then
        chmod +x "${KAKAKE_HOME}/runtime/bin/node" 2>/dev/null || true
    fi
    if [[ -f "${KAKAKE_HOME}/启动.sh" ]]; then
        chmod +x "${KAKAKE_HOME}/启动.sh" 2>/dev/null || true
    fi

    echo "===== Kakake start $(date '+%Y-%m-%d %H:%M:%S') edition=$(kakake_edition) entry=${entry} node=$("$node_bin" -v 2>/dev/null || echo unknown) =====" >> "$KAKAKE_LOG"

    # Termux：不拿唤醒锁的话，锁屏几分钟后安卓会冻结整个 Termux 进程组，
    # 表现就是「机器人突然不回消息，回到 Termux 又活了」。
    if mk_is_termux; then
        if command -v termux-wake-lock >/dev/null 2>&1; then
            termux-wake-lock >/dev/null 2>&1 || true
            info "小MK喵：已获取 Termux 唤醒锁（锁屏后仍保持运行） 哇～ (｡•̀ᴗ-)✧"
        else
            warn "诶…… 还没装 Termux:API 呢，锁屏后可能被系统冻结 喵～ (´･ω･)"
            warn "小MK喵小声说：建议执行: pkg install termux-api，并安装 Termux:API 应用 呀～ (｡•́︿•̀｡)"
        fi
    fi

    info "喵～ 正在后台启动咔咔珂（$(kakake_edition_label) · ${entry}） 啦～ (๑>◡<๑)"
    (
        cd "$KAKAKE_HOME" || exit 1
        export PATH="${node_path}:${PATH}"
        nohup env PATH="${node_path}:${PATH}" "$node_bin" "$entry" >> "$KAKAKE_LOG" 2>&1 &
        echo $! > "$KAKAKE_PID_FILE"
    )

    start_ts=$(date +%s)
    echo
    kakake_draw_start_progress_panel 20 "进程已拉起，等待控制台 :${port}" 0 "${spinner[0]}"
    panel_active=1

    while (( i < 90 )); do
        now_ts=$(date +%s)
        elapsed=$(( now_ts - start_ts ))

        if kakake_http_alive "$port"; then
            percent=100
            stage="控制台已就绪"
            (( panel_active == 1 )) && kakake_start_panel_cursor_up
            kakake_draw_start_progress_panel 100 "$stage" "$elapsed" "OK"
            echo
            break
        fi

        if ! kakake_has_process && ! kakake_port_listening "$port"; then
            sleep 2
            if ! kakake_has_process && ! kakake_port_listening "$port"; then
                (( panel_active == 1 )) && kakake_start_panel_cursor_up
                panel_active=0
                error "诶诶！ 启动失败了喵，看看日志: ${KAKAKE_LOG} 啦喵 (｡•́︿•̀｡)"
                tail -30 "$KAKAKE_LOG" 2>/dev/null || true
                return 1
            fi
        fi

        # 按等待时间推进进度（上限 95，真正就绪才到 100）
        if (( elapsed >= 60 )); then
            percent=92
        elif (( elapsed >= 30 )); then
            percent=75
        elif (( elapsed >= 10 )); then
            percent=55
        elif (( elapsed >= 3 )); then
            percent=35
        else
            percent=22
        fi
        stage="等待控制台就绪 (:${port})"
        spin_idx=$(( (spin_idx + 1) % 4 ))
        (( panel_active == 1 )) && kakake_start_panel_cursor_up
        kakake_draw_start_progress_panel "$percent" "$stage" "$elapsed" "${spinner[$spin_idx]}"
        panel_active=1

        sleep 2
        ((i++)) || true
    done

    if ! kakake_http_alive "$port"; then
        (( panel_active == 1 )) && kakake_start_panel_cursor_up
        error "诶诶！ 等待超时（HTTP :${port} 无响应），看看: ${KAKAKE_LOG} 呀喵 (｡•́︿•̀｡)"
        tail -40 "$KAKAKE_LOG" 2>/dev/null || true
        return 1
    fi

    sleep 1

    kakake_open_admin_port
    info "小MK喵：咔咔珂启动好啦 (后台运行 · $(kakake_edition_label)) 呢～ ₍˄·͈༝·͈˄₎"
    kakake_show_login_info
    if mk_is_termux; then
        info "喵～ 退出 mk 菜单不会停止咔咔珂，请使用「停止咔咔珂」关闭 啦～ (๑>◡<๑)"
        warn "诶…… 别在最近任务里划掉 Termux，那等于直接杀进程 啦喵 (。•́︿•̀。)"
        warn "小MK喵小声说：请到系统设置里给 Termux 关闭电池优化（允许后台活动） 呀～ (；´д｀)"
    else
        info "喵～ 退出 mk 菜单不会停止咔咔珂，请使用「停止咔咔珂」关闭 咯～ (๑ᵕᴗᵕ๑)"
    fi
}

kakake_stop() {
    local pid="" port="" p=""

    port="$(kakake_get_admin_port)"

    # 先停 systemd 自启，否则 Restart=on-failure 会把进程立刻拉回来（杀不掉的假象）
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl list-unit-files "${AUTOSTART_KAKAKE_UNIT}" >/dev/null 2>&1 \
            || [[ -f "/etc/systemd/system/${AUTOSTART_KAKAKE_UNIT}" ]]; then
            systemctl stop "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
            systemctl reset-failed "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
            info "呐呐，已停止 systemd 服务 ${AUTOSTART_KAKAKE_UNIT}（避免自动拉起） 咯喵 (๑•̀ㅂ•́)و✧"
        fi
    fi

    if [[ -f "$KAKAKE_PID_FILE" ]]; then
        pid="$(tr -d '[:space:]' < "$KAKAKE_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$KAKAKE_PID_FILE"
    fi

    pkill -f "${KAKAKE_HOME}/scripts/bootstrap.mjs" 2>/dev/null || true
    pkill -f "${KAKAKE_HOME}/packages/server/main.mjs" 2>/dev/null || true
    pkill -f "${KAKAKE_HOME}/runtime/bin/node" 2>/dev/null || true
    pkill -f "${KAKAKE_HOME}.*tsx src/main.ts" 2>/dev/null || true
    pkill -f "${KAKAKE_HOME}.*src/main.ts" 2>/dev/null || true
    # 兼容相对路径启动：node packages/server/main.mjs 且 cwd=KAKAKE_HOME
    for p in $(pgrep -f 'packages/server/main.mjs' 2>/dev/null); do
        if [[ "$(readlink -f "/proc/${p}/cwd" 2>/dev/null || true)" == "$KAKAKE_HOME" ]]; then
            kill "$p" 2>/dev/null || true
        fi
    done
    for p in $(pgrep -f 'scripts/bootstrap.mjs' 2>/dev/null); do
        if [[ "$(readlink -f "/proc/${p}/cwd" 2>/dev/null || true)" == "$KAKAKE_HOME" ]]; then
            kill "$p" 2>/dev/null || true
        fi
    done
    sleep 1

    if kakake_has_process; then
        pkill -9 -f "${KAKAKE_HOME}/scripts/bootstrap.mjs" 2>/dev/null || true
        pkill -9 -f "${KAKAKE_HOME}/packages/server/main.mjs" 2>/dev/null || true
        pkill -9 -f "${KAKAKE_HOME}/runtime/bin/node" 2>/dev/null || true
        pkill -9 -f "${KAKAKE_HOME}.*tsx src/main.ts" 2>/dev/null || true
        pkill -9 -f "${KAKAKE_HOME}.*src/main.ts" 2>/dev/null || true
        for p in $(pgrep -f 'packages/server/main.mjs' 2>/dev/null); do
            if [[ "$(readlink -f "/proc/${p}/cwd" 2>/dev/null || true)" == "$KAKAKE_HOME" ]]; then
                kill -9 "$p" 2>/dev/null || true
            fi
        done
        for p in $(pgrep -f 'scripts/bootstrap.mjs' 2>/dev/null); do
            if [[ "$(readlink -f "/proc/${p}/cwd" 2>/dev/null || true)" == "$KAKAKE_HOME" ]]; then
                kill -9 "$p" 2>/dev/null || true
            fi
        done
    fi

    if kakake_port_listening "$port"; then
        warn "诶…… 端口 ${port} 仍被占用，尝试释放 喵～ (,,>﹏<,,)"
        if command -v fuser >/dev/null 2>&1; then
            fuser -k "${port}/tcp" >/dev/null 2>&1 || true
        elif command -v lsof >/dev/null 2>&1; then
            lsof -ti ":${port}" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
        else
            # 兜底：按端口找 PID
            for p in $(ss -lptn "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
                kill -9 "$p" 2>/dev/null || true
            done
        fi
        sleep 1
    fi

    if kakake_has_process || kakake_port_listening "$port" || kakake_http_alive "$port"; then
        warn "诶…… 部分进程/端口可能仍在占用 啦喵 (,,>﹏<,,)"
        if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1; then
            warn "呜喵… 小MK发现 ${AUTOSTART_KAKAKE_UNIT} 仍启用；若日志在刷 bootstrap 找不到，请到「开机自启」关闭后重装自启 呢～ (；´д｀)"
        fi
        if mk_is_termux; then
            warn "呜喵… 可手动: pkill -f kakake ；查看占用: ss -lptn 'sport = :${port}' 啦～ (,,>﹏<,,)"
        else
            warn "小MK喵小声说：可手动: systemctl stop ${AUTOSTART_KAKAKE_UNIT}; fuser -k ${port}/tcp 呀～ (；´д｀)"
        fi
        return 1
    fi

    # 进程确实停了再放唤醒锁，否则会白耗电
    if mk_is_termux && command -v termux-wake-unlock >/dev/null 2>&1; then
        termux-wake-unlock >/dev/null 2>&1 || true
    fi

    info "诶嘿～ 咔咔珂已经停下来啦 (๑>◡<๑)"
}

kakake_restart() {
    info "诶嘿～ 正在重启咔咔珂 啦喵 (๑ᵕᴗᵕ๑)"
    kakake_stop || true
    sleep 2
    kakake_start
}

kakake_get_server_ip() {
    napcat_get_server_ip
}

kakake_show_login_info() {
    local ip="" port="" key="" kind="" kind_label="" key_q=""
    local lan_if="" cand_ip="" cand_if=""
    # Termux 下顺带取出网卡名，好让用户一眼看出这是 Wi-Fi 地址还是蜂窝/VPN 地址
    if mk_is_termux; then
        IFS=$'\t' read -r ip lan_if < <(mk_lan_ipv4_best) || true
    fi
    [[ -z "$ip" ]] && ip="$(kakake_get_server_ip)"
    port="$(kakake_get_admin_port)"
    IFS=$'\t' read -r key kind < <(kakake_get_auth_key) || true
    kind_label="$(kakake_auth_kind_label "$kind")"

    title "咔咔珂 控制台 哦喵 ✧٩(ˊωˋ*)و✧"
    if mk_is_termux; then
        # 手机上最常用的是本机浏览器直接开，公网地址反而没用
        echo "  手机浏览器: http://127.0.0.1:${port} 咯喵 (｡•̀ᴗ-)✧"
        if [[ -n "$lan_if" ]]; then
            echo "  同 Wi-Fi 其他设备: http://${ip}:${port}  ← ${lan_if}（$(mk_nic_kind_label "$lan_if")） 喵～ (๑•̀ㅂ•́)و✧"
        else
            echo "  同 Wi-Fi 其他设备: 小MK没找到局域网地址（手机是不是没连 Wi-Fi？） 哦喵 ₍˄·͈༝·͈˄₎"
        fi
    else
        echo "  后台地址: http://${ip}:${port} 咯喵 (๑>◡<๑)"
        echo "  本机地址: http://127.0.0.1:${port} 喵♪ (๑•̀ㅂ•́)و✧"
    fi
    if [[ -n "$key" ]]; then
        echo "  登录密钥: ${key} 哦喵 (๑ᵕᴗᵕ๑)"
        echo "  密钥类型: ${kind_label} 呀喵 (｡•̀ᴗ-)✧"
        if command -v python3 >/dev/null 2>&1; then
            key_q="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$key" 2>/dev/null || true)"
        fi
        # 地址没探到时（占位文字）就别拼快捷链接了，点了也打不开
        if [[ -n "$key_q" && "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
            echo "  快捷入口: http://${ip}:${port}/?key=${key_q} 哦喵 (｡•̀ᴗ-)✧"
        fi
    else
        echo "  登录密钥: 没拿到喵 ✧٩(ˊωˋ*)و✧"
        if [[ -f "$KAKAKE_AUTH_KEY_FILE" ]]; then
            warn "诶…… 已找到 ${KAKAKE_AUTH_KEY_FILE} 但解析失败 喵～ (｡•́︿•̀｡)"
        else
            warn "呜喵… 尚未生成 ${KAKAKE_AUTH_KEY_FILE}，请先成功启动一次框架 啦～ (。•́︿•̀。)"
        fi
    fi
    if kakake_node_installed; then
        echo "  Node 版本: $(kakake_get_node_version || echo 未知) ($(kakake_node_source_label))"
    fi
    if kakake_web_built; then
        echo "  Web 构建: 已就绪 ($(kakake_web_label)) 哦喵 (๑•̀ㅂ•́)و✧"
    else
        echo "  Web 构建: 未完成（启动时会自动 build:web） 呢喵 ₍˄·͈༝·͈˄₎"
    fi
    echo
    if mk_is_termux; then
        if [[ -n "$lan_if" ]] && ! mk_nic_is_lan "$lan_if"; then
            warn "小MK喵小声说：上面的地址来自 ${lan_if}（$(mk_nic_kind_label "$lan_if")），同一 Wi-Fi 的电脑访问不到它 呀～ (,,>﹏<,,)"
            echo "  请先让手机连上 Wi-Fi，并关掉 VPN / 加速器，然后重新查看本页 呀喵 ₍˄·͈༝·͈˄₎"
        fi
        # 手机上常常同时有多个网卡，把其余地址一并列出，方便逐个试
        while IFS=$'\t' read -r cand_ip cand_if; do
            [[ -z "$cand_ip" || -z "$cand_if" || "$cand_ip" == "$ip" ]] && continue
            echo "  备选地址: http://${cand_ip}:${port}  ← ${cand_if}（$(mk_nic_kind_label "$cand_if")） 啦喵 ✧٩(ˊωˋ*)و✧"
        done < <(mk_lan_ipv4_candidates)
        echo "  若仍打不开: 确认电脑连的是同一个 Wi-Fi（不是访客网络），并关闭路由器的「AP 隔离」 呀喵 (๑ᵕᴗᵕ๑)"
    else
        warn "呜喵… 若没法访问，请在安全组放行 ${port} 端口 啦～ (,,>﹏<,,)"
    fi
}

kakake_do_uninstall() {
    title "卸载咔咔珂 呀喵 (｡•̀ᴗ-)✧"
    echo "  将删除 ${KAKAKE_HOME} 及运行状态 呢喵 (๑>◡<๑)"
    echo

    local confirm="" admin_port=""
    read -r -p "确认彻底卸载咔咔珂? 啦喵 (,,>﹏<,,) [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "喵～ 那就不拆啦 (๑>◡<๑)"
        return 0
    }

    admin_port="$(kakake_get_admin_port)"
    kakake_stop || true
    rm -rf "$KAKAKE_HOME"
    rm -f "$KAKAKE_LOG" "$KAKAKE_PID_FILE" "$KAKAKE_INSTALL_LOG" 2>/dev/null || true

    if ! kakake_port_listening "$admin_port"; then
        napcat_firewall_close_port "$admin_port" || true
    fi

    info "小MK喵：咔咔珂已彻底卸载 哦～ (๑•̀ㅂ•́)و✧"
}

kakake_cfg_require_python() {
    napcat_cfg_require_python
}

kakake_cfg_tool() {
    KAKAKE_CONN_FILE="$KAKAKE_CONNECTIONS_FILE" python3 - "$@" << 'PYEOF'
import json, os, sys, uuid

CONN_FILE = os.environ.get("KAKAKE_CONN_FILE", "")

DEFAULT = {
    "connections": [
        {
            "id": "default",
            "name": "NapCat 默认接入",
            "type": "onebot",
            "mode": "reverse",
            "host": "127.0.0.1",
            "port": 6700,
            "accessToken": "",
            "enable": False,
        }
    ]
}

LABELS = {
    "onebot:reverse": "OneBot 反向 (咔咔珂=Server)",
    "onebot:forward": "OneBot 正向 (咔咔珂=Client)",
    "qq_official": "QQ 官方机器人",
}

def load(create=False):
    if not CONN_FILE:
        return None
    d = os.path.dirname(CONN_FILE)
    if create and d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    if not os.path.isfile(CONN_FILE):
        if not create:
            return DEFAULT.copy()
        with open(CONN_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT, f, ensure_ascii=False, indent=2)
    with open(CONN_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    if "connections" not in data:
        data["connections"] = []
    return data

def save(data):
    with open(CONN_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def label_for(c):
    t = c.get("type") or "onebot"
    if t == "qq_official":
        return LABELS["qq_official"]
    mode = c.get("mode") or "reverse"
    return LABELS.get(f"onebot:{mode}", "OneBot")

def addr_for(c):
    t = c.get("type") or "onebot"
    if t == "qq_official":
        aid = c.get("appId") or ""
        env = "沙箱" if c.get("sandbox") else "正式"
        return f"AppID {aid} ({env})" if aid else "未配置 AppID"
    host = c.get("host") or "127.0.0.1"
    port = c.get("port") or 0
    mode = c.get("mode") or "reverse"
    if mode == "forward":
        return f"ws://{host}:{port}"
    return f"{host}:{port}"

def cmd_list():
    data = load(create=False)
    for i, c in enumerate(data.get("connections", [])):
        enable = "true" if c.get("enable") else "false"
        cat = c.get("type") or "onebot"
        if cat == "onebot":
            cat = f"onebot:{c.get('mode') or 'reverse'}"
        print(f"{i}\t{label_for(c)}\t{c.get('name','')}\t{addr_for(c)}\t{enable}\t{cat}")

def cmd_get(idx):
    data = load(create=False)
    arr = data.get("connections", [])
    if idx < 0 or idx >= len(arr):
        sys.exit(1)
    c = arr[idx]
    print(f"TYPE\t{label_for(c)}")
    print(f"IDX\t{idx}")
    for k, v in c.items():
        print(f"{k}\t{v}")

def cmd_delete(idx):
    data = load(create=False)
    arr = data.get("connections", [])
    if idx < 0 or idx >= len(arr):
        sys.exit(1)
    port = arr[idx].get("port") if (arr[idx].get("type") or "onebot") == "onebot" and (arr[idx].get("mode") or "reverse") == "reverse" else 0
    del arr[idx]
    save(data)
    print(f"OK|{port}")

def port_used(data, port, skip_idx=-1):
    for i, c in enumerate(data.get("connections", [])):
        if i == skip_idx:
            continue
        if (c.get("type") or "onebot") != "onebot":
            continue
        if (c.get("mode") or "reverse") != "reverse":
            continue
        if c.get("port") == port:
            return True
    return False

def cmd_add(kind, name, a1, a2, a3, token, enable):
    data = load(create=True)
    item = {"name": name, "enable": enable == "y", "id": uuid.uuid4().hex[:12]}
    if kind == "onebot:reverse":
        item.update({
            "type": "onebot", "mode": "reverse",
            "host": a1 or "0.0.0.0", "port": int(a2 or 6700),
            "accessToken": token or "",
        })
    elif kind == "onebot:forward":
        item.update({
            "type": "onebot", "mode": "forward",
            "host": a1 or "127.0.0.1", "port": int(a2 or 3001),
            "accessToken": token or "",
            "reconnectIntervalMs": 5000,
        })
    else:
        item.update({
            "type": "qq_official",
            "host": "", "port": 0,
            "appId": a1 or "", "appSecret": a2 or "",
            "sandbox": a3 == "y",
        })
    data.setdefault("connections", []).append(item)
    save(data)
    print(f"OK|{len(data['connections']) - 1}|{item.get('port', 0)}")

def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(1)
    act = args[0]
    if act == "list":
        cmd_list()
    elif act == "get" and len(args) >= 2:
        cmd_get(int(args[1]))
    elif act == "delete" and len(args) >= 2:
        cmd_delete(int(args[1]))
    elif act == "add" and len(args) >= 8:
        cmd_add(args[1], args[2], args[3], args[4], args[5], args[6], args[7])
    elif act == "path":
        print(CONN_FILE or "")
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
PYEOF
}

kakake_conn_get_field() {
    local idx="$1" field="$2"
    kakake_cfg_tool get "$idx" 2>/dev/null | awk -F'\t' -v f="$field" '$1==f { print $2; exit }'
}

kakake_conn_is_enabled() {
    local v="$1"
    [[ "$v" == "true" || "$v" == "True" ]]
}

kakake_conn_check_conflicts() {
    local line="" name="" addr="" enable="" cat=""
    local has_rev=0 has_fwd=0 rev_port="" fwd_port="" fwd_name="" rev_name=""

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        IFS=$'\t' read -r _ _ name addr enable cat <<< "$line"
        [[ "$enable" != "true" ]] && continue
        case "$cat" in
            onebot:reverse)
                has_rev=1
                rev_port="${addr##*:}"
                rev_name="$name"
                ;;
            onebot:forward)
                has_fwd=1
                fwd_port="$(port_parse_addr_port "$addr")"
                fwd_name="$name"
                ;;
        esac
    done < <(kakake_cfg_tool list 2>/dev/null || true)

    if [[ "$has_rev" -eq 1 && "$has_fwd" -eq 1 ]]; then
        warn "呜喵… 同时启用了「${rev_name}」(咔咔珂 Server) 和「${fwd_name}」(咔咔珂 Client)，通常只需一种 呢～ (,,>﹏<,,)"
        echo "  Server=正向(监听)  Client=反向(连出) 喵～ (๑ᵕᴗᵕ๑)"
        echo "  A 反向: 咔咔珂 Server :${rev_port} ← NapCat WebSocket Client 啦喵 (｡•̀ᴗ-)✧"
        echo "  B 正向: 咔咔珂 Client → NapCat WebSocket Server :3001 哦喵 (๑>◡<๑)"
    fi

    if [[ "$has_fwd" -eq 1 && "$fwd_port" == "6700" ]]; then
        error "诶诶！ 「${fwd_name}」正向 WS 指向 6700 有误 喵♪ (；´д｀)"
        echo "  6700 是咔咔珂反向监听口；正向连 6700 会连到咔咔珂自己，不是 NapCat 喵～ (｡•̀ᴗ-)✧"
        echo "  日志里「连上啦」是假象，真正连 NapCat 的是「${rev_name:-反向连接}」 啦喵 (๑>◡<๑)"
    elif [[ "$has_fwd" -eq 1 && "$has_rev" -eq 1 && "$fwd_port" == "$rev_port" ]]; then
        error "小MK喵吓一跳！ 正向与反向使用了同一端口 ${rev_port}，正向会连到咔咔珂自身 呀～ (。•́︿•̀。)"
    fi
}

kakake_show_pairing_hint() {
    echo -e "${CYAN}  术语: WebSocket Server=正向(监听)  Client=反向(连出) 啦喵 (๑•̀ㅂ•́)و✧${NC}"
    echo "  A. NapCat Client(反向) → ws://127.0.0.1:6700  [咔咔珂=Server，反向] 哦喵 ✧٩(ˊωˋ*)و✧"
    echo "  B. NapCat Server(正向) ← ws://127.0.0.1:3001  [咔咔珂=Client，正向] 呀喵 ₍˄·͈༝·͈˄₎"
    echo
}

kakake_conn_diagnose() {
    local idx="$1"
    local mode="" host="" port="" enable="" name=""

    mode="$(kakake_conn_get_field "$idx" mode)"
    host="$(kakake_conn_get_field "$idx" host)"
    port="$(kakake_conn_get_field "$idx" port)"
    enable="$(kakake_conn_get_field "$idx" enable)"
    name="$(kakake_conn_get_field "$idx" name)"

    echo -e "${BOLD}【连接诊断】${NC} ${name:-连接} 呀喵 (｡•̀ᴗ-)✧"
    echo

    if ! kakake_conn_is_enabled "$enable"; then
        warn "呜喵… 此连接未启用 (enable=false) 呢～ (。•́︿•̀。)"
        return 0
    fi
    if ! kakake_is_running; then
        error "诶诶！ 咔咔珂没在跑呢，请先: 咔咔珂操作 → 启动咔咔珂 呢喵 (,,>﹏<,,)"
        return 0
    fi

    if [[ "$mode" == "reverse" ]]; then
        if kakake_reverse_ws_has_client "$port"; then
            info "呐呐，正常: NapCat 已连入咔咔珂 ${host}:${port} 呀喵 (๑•̀ㅂ•́)و✧"
        elif kakake_port_listening "$port"; then
            warn "呜喵… 咔咔珂正在 ${host}:${port} 监听，但 NapCat 尚未连入 呢～ (´･ω･)"
            echo "  NapCat 侧: 网络配置 → WebSocket Client (反向 WS) 喵♪ (๑ᵕᴗᵕ๑)"
            echo "  连接地址: ws://127.0.0.1:${port} 喵～ (｡•̀ᴗ-)✧"
            echo "  Token 需与咔咔珂连接配置中的 Access Token 一致 啦喵 (๑>◡<๑)"
        else
            error "小MK喵吓一跳！ 咔咔珂未在端口 ${port} 监听 呀～ (´･ω･)"
            echo "  请重启咔咔珂，或用「端口验证」检查 ${port} 是否被占用 呢喵 ₍˄·͈༝·͈˄₎"
        fi
        return 0
    fi

    if [[ "$mode" == "forward" ]]; then
        host="${host:-127.0.0.1}"
        if [[ "$port" == "6700" ]] && kakake_port_listening "6700"; then
            error "小MK喵吓一跳！ 「${name}」正向 WS 连 ws://${host}:6700 实际连的是咔咔珂自己的反向监听 哇～ (；´д｀)"
            echo "  这不是 NapCat！日志「连上啦」是连到本机 6700，数据未进 NapCat 喵♪ (๑>◡<๑)"
            echo "  NapCat 侧应配 WebSocket Client (反向) → ws://127.0.0.1:6700 喵～ (๑•̀ㅂ•́)و✧"
            echo "  由「NapCat 默认接入」等反向连接负责，请禁用或删除本正向连接 啦喵 ✧٩(ˊωˋ*)و✧"
            kakake_show_pairing_hint
            return 0
        fi
        if kakake_forward_ws_has_session "$host" "$port"; then
            info "呐呐，正常: 咔咔珂已连上 NapCat ws://${host}:${port} 喵♪ (๑•̀ㅂ•́)و✧"
            return 0
        fi

        if kakake_port_listening "$port"; then
            if [[ "$port" == "6700" ]]; then
                error "诶诶！ 6700 上有咔咔珂反向监听，正向 WS 不应连此端口 咯喵 (。•́︿•̀。)"
            else
                warn "呜喵… ws://${host}:${port} 有程序在监听，但 WebSocket 未握手成功 呢～ (´･ω･)"
            fi
            echo "  检查 Token 是否与 NapCat WebSocket Server (正向) 一致 哦喵 (｡•̀ᴗ-)✧"
            echo "  查看日志: tail -f ${KAKAKE_LOG} 呀喵 (๑>◡<๑)"
            return 0
        fi

        error "诶诶！ 连接被拒绝 (ECONNREFUSED): ws://${host}:${port} 没有任何服务在监听 喵～ (,,>﹏<,,)"
        echo
        echo "  正向 = 咔咔珂 Client 连 NapCat WebSocket Server (正向，NapCat 监听) 哦喵 (๑>◡<๑)"
        echo "  反向 = 咔咔珂 Server 监听，NapCat WebSocket Client (反向) 连入 呀喵 (๑•̀ㅂ•́)و✧"
        echo
        if [[ "$port" == "6700" ]]; then
            warn "诶…… 6700 是咔咔珂「反向 WS」的默认监听端口，不是 NapCat 的端口！ 喵♪ (。•́︿•̀。)"
            echo "  你当前配成了正向 WS 去连 6700，所以一定会 ECONNREFUSED 喵～ (｡•̀ᴗ-)✧"
            echo
            echo "  方案 A (推荐，常用): 改用反向 WS 哦喵 (๑•̀ㅂ•́)و✧"
            echo "    1. 删除连接「${name}」，重新添加 → OneBot 反向 WS，端口 6700 呀喵 ✧٩(ˊωˋ*)و✧"
            echo "    2. NapCat → WebSocket Client (反向) → ws://127.0.0.1:6700 呢喵 ₍˄·͈༝·͈˄₎"
            echo
            echo "  方案 B: 继续用正向 (咔咔珂 Client → NapCat Server) 喵♪ (｡•̀ᴗ-)✧"
            echo "    1. NapCat → WebSocket Server (正向)，端口 3001 喵～ (๑>◡<๑)"
            echo "    2. 咔咔珂 → OneBot 正向 (Client)，ws://127.0.0.1:3001 啦喵 (๑•̀ㅂ•́)و✧"
        else
            echo "  确认一下 呀喵:"
            echo "    1. NapCat 已经跑起来啦 (NapCat操作 → 启动框架) 呢喵 (๑ᵕᴗᵕ๑)"
            echo "    2. NapCat 已添加 WebSocket Server (正向)，端口 ${port} (常用 3001) 咯喵 (｡•̀ᴗ-)✧"
            echo "    3. 咔咔珂 OneBot 正向 (Client) 地址与 NapCat Server 端口一致 喵♪ (๑>◡<๑)"
        fi
        return 0
    fi

    info "呐呐，看看咔咔珂控制台日志获取更多信息 呢喵 (｡•̀ᴗ-)✧"
}

kakake_conn_status_text() {
    local enable="$1" category="$2" addr="$3"
    local host="" port="" parsed=""

    if [[ "$enable" != "true" ]]; then
        echo -e "${YELLOW}还没打开呢 (๑•̀ㅂ•́)و✧${NC}"
        return
    fi
    if ! kakake_is_running; then
        echo -e "${RED}没在跑呢 (｡•̀ᴗ-)✧${NC}"
        return
    fi
    case "$category" in
        onebot:reverse)
            port="${addr##*:}"
            if kakake_reverse_ws_has_client "$port"; then
                echo -e "${GREEN}连上啦 (๑>◡<๑)${NC}"
            elif kakake_port_listening "$port"; then
                echo -e "${YELLOW}等待接入 呢喵 ✧٩(ˊωˋ*)و✧${NC}"
            else
                echo -e "${RED}未监听 喵♪ (๑ᵕᴗᵕ๑)${NC}"
            fi
            ;;
        onebot:forward)
            parsed="$(kakake_parse_ws_target "$addr")"
            host="${parsed%% *}"
            port="${parsed##* }"
            if kakake_forward_ws_has_session "$host" "$port"; then
                echo -e "${GREEN}连上啦 (๑>◡<๑)${NC}"
            elif kakake_port_listening "$port"; then
                echo -e "${YELLOW}未握手 哦喵 ✧٩(ˊωˋ*)و✧${NC}"
            else
                echo -e "${RED}目标未监听 呢喵 (๑ᵕᴗᵕ๑)${NC}"
            fi
            ;;
        qq_official)
            if kakake_qq_official_has_session; then
                echo -e "${GREEN}连上啦 ₍˄·͈༝·͈˄₎${NC}"
            else
                echo -e "${RED}还没连上 呢喵 (｡•̀ᴗ-)✧${NC}"
            fi
            ;;
        *)
            echo -e "${YELLOW}未知 啦喵 ₍˄·͈༝·͈˄₎${NC}"
            ;;
    esac
}

kakake_cfg_port_used_by_others() {
    local port="$1" exclude_idx="${2:--1}"
    local line="" idx="" addr="" cat=""
    [[ -z "$port" ]] && return 1
    while IFS=$'\t' read -r idx _ _ addr _ cat; do
        [[ "$cat" != "onebot:reverse" ]] && continue
        [[ "$idx" == "$exclude_idx" ]] && continue
        [[ "${addr##*:}" == "$port" ]] && return 0
    done < <(kakake_cfg_tool list 2>/dev/null || true)
    return 1
}

kakake_cfg_delete_item() {
    local idx="$1"
    local del_port="" result=""

    del_port="$(kakake_cfg_tool get "$idx" 2>/dev/null | awk -F'\t' '$1=="port"{print $2; exit}')"
    result="$(kakake_cfg_tool delete "$idx" 2>&1 || true)"
    if [[ "$result" != OK* ]]; then
        error "呜哇！ 删除失败 呢喵 (,,>﹏<,,)"
        return 1
    fi
    if [[ -n "$del_port" && "$del_port" =~ ^[0-9]+$ && "$del_port" != "0" ]]; then
        if ! kakake_cfg_port_used_by_others "$del_port"; then
            napcat_firewall_close_port "$del_port"
        fi
    fi
    info "小MK喵：连接配置已删除，已立即保存 哇～ (｡•̀ᴗ-)✧"
}

kakake_cfg_check_ready() {
    if ! kakake_is_installed; then
        error "诶诶！ 咔咔珂还没装呢 (´･ω･)"
        return 1
    fi
    kakake_cfg_require_python || return 1
    return 0
}

menu_kakake_conn_add() {
    local choice="" kind="" name="" host="" port="" token="" enable="y"
    local app_id="" app_secret="" sandbox="y"

    while true; do
        title "新增连接 - 选择类型 啦喵 (๑ᵕᴗᵕ๑)"
        show_nav_hint
        echo "  [2] OneBot 反向 (咔咔珂=Server) ← NapCat WebSocket Client"
        echo "  [3] OneBot 正向 (咔咔珂=Client) → NapCat WebSocket Server"
        echo "  [4] QQ 官方机器人"
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) kind="onebot:reverse"; break ;;
            3) kind="onebot:forward"; break ;;
            4) kind="qq_official"; break ;;
            *) warn "呜喵… 看不懂选项，请重新输入 啦～ (｡•́︿•̀｡)" ;;
        esac
    done

    echo
    read -r -p "连接名称 喵♪:" name
    name="${name// /}"
    [[ -z "$name" ]] && name="连接_$(date +%s)"

    if [[ "$kind" == "qq_official" ]]; then
        read -r -p "AppID: " app_id
        read -r -p "AppSecret: " app_secret
        read -r -p "沙箱环境? 喵♪ (。•́︿•̀。) [Y/n]: " sandbox
        [[ "$sandbox" =~ ^[Nn]$ ]] && sandbox="n" || sandbox="y"
        read -r -p "是否启用? 啦喵 (´･ω･) [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        kakake_cfg_tool add "$kind" "$name" "$app_id" "$app_secret" "$sandbox" "" "$enable" || {
            error "小MK喵吓一跳！ 添加失败 哇～ (。•́︿•̀。)"
            return 1
        }
    elif [[ "$kind" == "onebot:reverse" ]]; then
        read -r -p "监听地址 啦喵 (,,>﹏<,,) [0.0.0.0]: " host
        host="${host:-0.0.0.0}"
        read -r -p "监听端口 呀喵 (；´д｀) [6700]: " port
        port="${port:-6700}"
        read -r -p "Access Token (留空跳过) 咯喵:" token
        read -r -p "是否启用? 喵♪ (,,>﹏<,,) [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        kakake_cfg_tool add "$kind" "$name" "$host" "$port" "" "$token" "$enable" || {
            error "小MK喵吓一跳！ 添加失败 哇～ (´･ω･)"
            return 1
        }
        if [[ "$enable" == "y" && -n "$port" ]]; then
            napcat_firewall_open_port "$port"
        fi
    else
        read -r -p "NapCat WS 地址 哦喵 (,,>﹏<,,) [127.0.0.1]: " host
        host="${host:-127.0.0.1}"
        read -r -p "NapCat WS 端口 呢喵 (；´д｀) [3001]: " port
        port="${port:-3001}"
        if [[ "$port" == "6700" ]]; then
            echo
            error "呜哇！ 6700 是咔咔珂「反向 WS」监听端口，不是 NapCat 服务端端口 啦喵 (。•́︿•̀。)"
            echo "  若 NapCat 配 WebSocket Server (正向)，咔咔珂应选 OneBot 正向 (Client)，端口 3001 哦喵 (๑•̀ㅂ•́)و✧"
            echo "  若要用 6700，咔咔珂选 OneBot 反向 (Server)，NapCat 配 WebSocket Client (反向) 呀喵 ✧٩(ˊωˋ*)و✧"
            read -r -p "是否改用 3001? 呢喵 (｡•́︿•̀｡) [Y/n]: " fix_port
            [[ ! "$fix_port" =~ ^[Nn]$ ]] && port="3001"
        fi
        read -r -p "Access Token (留空跳过) 喵～:" token
        read -r -p "是否启用? 啦喵 (´･ω･) [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        kakake_cfg_tool add "$kind" "$name" "$host" "$port" "" "$token" "$enable" || {
            error "诶诶！ 添加失败 呢喵 (。•́︿•̀。)"
            return 1
        }
    fi

    info "小MK喵：连接配置已保存: ${KAKAKE_CONNECTIONS_FILE} 呢～ ₍˄·͈༝·͈˄₎"
    info "诶嘿～ 配置已写入，重启咔咔珂后可确保连接完全生效 呀喵 (๑ᵕᴗᵕ๑)"
}

menu_kakake_conn_detail() {
    local idx="$1"
    local choice="" confirm=""

    while true; do
        title "连接配置详情 呢喵 (๑>◡<๑)"
        show_nav_hint
        echo "  [3] 删除本配置"
        echo "  [4] 连接诊断"
        echo

        kakake_cfg_tool get "$idx" 2>/dev/null | while IFS=$'\t' read -r key val; do
            case "$key" in
                TYPE) echo "  类型:     ${val}" ;;
                name) echo "  名称:     ${val}" ;;
                enable) echo "  启用:     ${val}" ;;
                host) echo "  地址:     ${val}" ;;
                port) echo "  端口:     ${val}" ;;
                accessToken) [[ -n "$val" ]] && echo "  Token:    ${val}" ;;
                appId) echo "  AppID:    ${val}" ;;
                appSecret) [[ -n "$val" ]] && echo "  Secret:   ${val}" ;;
                sandbox) echo "  沙箱:     ${val}" ;;
                mode)
                    if [[ "$val" == "forward" ]]; then
                        echo "  模式:     正向 (咔咔珂 Client → NapCat Server) 哦喵 (๑•̀ㅂ•́)و✧"
                    elif [[ "$val" == "reverse" ]]; then
                        echo "  模式:     反向 (咔咔珂 Server ← NapCat Client) 呢喵 ₍˄·͈༝·͈˄₎"
                    else
                        echo "  模式:     ${val} 喵♪ (｡•̀ᴗ-)✧"
                    fi
                    ;;
            esac
        done
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            4)
                kakake_conn_diagnose "$idx"
                press_enter
                ;;
            3)
                read -r -p "确认删除此连接? 啦喵 (｡•́︿•̀｡) [y/N]: " confirm
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    kakake_cfg_delete_item "$idx"
                    press_enter
                    mk_nav_back
                    return 0
                fi
                ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (；´д｀)" ;;
        esac
    done
}

menu_kakake_configure() {
    kakake_cfg_check_ready || {
        press_enter
        mk_nav_back
        return 0
    }

    declare -A KAKAKE_CONN_MAP=()

    while true; do
        local lines=() line="" choice=""
        local menu_idx=4 idx="" type_label="" name="" addr="" enable="" category="" status=""

        unset KAKAKE_CONN_MAP
        declare -A KAKAKE_CONN_MAP=()

        title "咔咔珂 - 连接管理 哦喵 ✧٩(ˊωˋ*)و✧"
        show_nav_hint
        kakake_show_pairing_hint
        kakake_conn_check_conflicts
        echo "  [3] 新增连接"
        echo
        echo "  状态: 已连接 | 等待接入 | 目标未监听 | 未握手"
        echo

        mapfile -t lines < <(kakake_cfg_tool list 2>/dev/null || true)
        if [[ ${#lines[@]} -eq 0 || -z "${lines[0]:-}" ]]; then
            echo "  (暂无连接配置) 喵♪ (๑•̀ㅂ•́)و✧"
        else
            for line in "${lines[@]}"; do
                IFS=$'\t' read -r idx type_label name addr enable category <<< "$line"
                status="$(kakake_conn_status_text "$enable" "$category" "$addr")"
                KAKAKE_CONN_MAP[$menu_idx]="$idx"
                echo -e "  [${menu_idx}] ${type_label} | ${name} | ${addr} | ${status}"
                ((menu_idx++)) || true
            done
        fi
        echo
        info "喵～ 配置文件: ${KAKAKE_CONNECTIONS_FILE} 啦～ (๑>◡<๑)"
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            3) menu_kakake_conn_add || true
               if mk_nav_bubble_up; then return 0; fi
               press_enter ;;
            *)
                if [[ -n "${KAKAKE_CONN_MAP[$choice]:-}" ]]; then
                    menu_kakake_conn_detail "${KAKAKE_CONN_MAP[$choice]}" || true
                    if mk_nav_bubble_up; then return 0; fi
                else
                    warn "呜喵… 看不懂选项，请重新输入 呢～ (,,>﹏<,,)"
                fi
                ;;
        esac
    done
}

menu_kakake() {
    while true; do
        title "咔咔珂配置 (mk ${MK_VERSION}) 喵♪ (๑>◡<๑)"
        show_nav_hint
        echo "  [2] 安装咔咔珂"
        echo "  [3] 安装 Node.js"
        echo "  [4] 卸载 Node.js"
        echo "  [5] 启动咔咔珂"
        echo "  [6] 停止咔咔珂"
        echo "  [7] 重启咔咔珂"
        echo "  [8] 配置咔咔珂"
        echo "  [9] 查看登录密钥"
        echo "  [10] 构建 Web UI"
        echo "  [11] 卸载咔咔珂"
        echo

        local choice="" kakake_node_ver="" port="" node_bin="" node_src=""

        if node_bin="$(kakake_resolve_node_bin 2>/dev/null)"; then
            kakake_node_ver="$("$node_bin" -v 2>/dev/null || echo 已安装)"
            node_src="$(kakake_node_source_label)"
        fi

        kakake_status_line
        if mk_is_termux; then
            echo -e "  ${CYAN}* 运行环境: $(mk_platform_label) 啦喵 (｡•̀ᴗ-)✧${NC}"
        fi
        if kakake_is_installed; then
            echo -e "  ${GREEN}* 安装方式: $(kakake_edition_label) 呢喵 ✧٩(ˊωˋ*)و✧${NC}"
        fi
        if [[ -n "$node_bin" ]]; then
            echo -e "  ${GREEN}* Node.js ${kakake_node_ver} (${node_src})${NC}"
        else
            echo -e "  ${YELLOW}* Node.js 还没装呢 (๑•̀ㅂ•́)و✧${NC}"
            if kakake_is_portable; then
                echo -e "  ${YELLOW}  → 便携版应自带 runtime/bin/node，帮忙检查一下目录完整性 呢喵 ₍˄·͈༝·͈˄₎${NC}"
            fi
        fi
        if kakake_is_installed; then
            port="$(kakake_get_admin_port)"
            if kakake_web_built; then
                echo -e "  ${GREEN}* Web UI 已构建 · 端口 ${port} 呀喵 ₍˄·͈༝·͈˄₎${NC}"
            else
                echo -e "  ${YELLOW}* Web UI 未构建 · 端口 ${port} 咯喵 (｡•̀ᴗ-)✧${NC}"
                if kakake_is_portable; then
                    echo -e "  ${YELLOW}  → 便携版缺 dist，请重新解压完整便携包 喵～ (๑•̀ㅂ•́)و✧${NC}"
                else
                    echo -e "  ${YELLOW}  → 选 [10] 构建，或 [5] 启动时会先构建 哦喵 ₍˄·͈༝·͈˄₎${NC}"
                fi
            fi
        fi
        echo

        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) kakake_do_install; press_enter ;;
            3) kakake_node_install || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            4) kakake_node_uninstall; press_enter ;;
            5) kakake_start; press_enter ;;
            6) kakake_stop; press_enter ;;
            7) kakake_restart; press_enter ;;
            8) menu_kakake_configure || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               ;;
            9) kakake_show_login_info; press_enter ;;
            10)
                if kakake_is_portable; then
                    warn "呜喵… 便携版 Web UI 已随包提供，无需/没法在此重建 呢～ (｡•́︿•̀｡)"
                    if kakake_web_built; then
                        info "小MK喵：当前 dist 正常: ${KAKAKE_WEB_DIST_INDEX} 哇～ (｡•̀ᴗ-)✧"
                    else
                        error "诶诶！ 少了 packages/web/dist，请重新解压便携包 啦喵 (´･ω･)"
                    fi
                else
                    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
                    if [[ -z "$node_bin" ]]; then
                        error "呜哇！ 没找到 Node.js，请先安装 Node.js 喵♪ (´･ω･)"
                    elif ! kakake_is_installed; then
                        error "小MK喵吓一跳！ 咔咔珂还没装呢 (,,>﹏<,,)"
                    else
                        kakake_ensure_node_tools "$node_bin" || true
                        # 强制重建：清旧 Next/.next + Vite dist，不吞掉失败
                        if ! KAKAKE_FORCE_WEB_BUILD=1 kakake_ensure_web_build "$node_bin"; then
                            error "诶诶！ 强制编译翻车了喵，看看: ${KAKAKE_LOG} 喵♪ (,,>﹏<,,)"
                        fi
                    fi
                fi
                press_enter
                ;;
            11) kakake_do_uninstall; press_enter ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 呀～ (；´д｀)" ;;
        esac
    done
}

# ==================== 检查脚本更新 ====================

readonly MK_UPDATE_URL="https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/mk"
readonly MK_UPDATE_BACKUP_DIR="${INSTALL_DIR}/backup"
readonly MK_UPDATE_BACKUP_KEEP=3
readonly MK_UPDATE_TIMEOUT=60

# 从任意一份 mk 脚本里抠出 MK_VERSION，本地与远程共用
mk_update_read_version() {
    local src="$1" out=""
    [[ -f "$src" ]] || return 1
    out="$(sed -n 's/^readonly MK_VERSION="\([^"]*\)".*$/\1/p' "$src" 2>/dev/null | head -1 || true)"
    printf '%s' "$out"
}

# 远程版本比本地新时返回 0（相等或更旧都返回非 0）
mk_update_remote_is_newer() {
    local remote="$1" local_ver="$2"
    [[ -n "$remote" ]] || return 1
    [[ -n "$local_ver" ]] || return 0
    [[ "$remote" == "$local_ver" ]] && return 1
    snowluma_ver_ge "$remote" "$local_ver"
}

# 下载远程脚本：先 curl，失败再回落 wget
mk_update_download() {
    local dest="$1" ok=1
    rm -f "$dest" 2>/dev/null || true

    if command -v curl >/dev/null 2>&1; then
        if curl -fL --retry 3 --connect-timeout 15 --max-time "$MK_UPDATE_TIMEOUT" \
            -A 'mk-tools' -o "$dest" "$MK_UPDATE_URL" 2>/dev/null; then
            ok=0
        fi
    fi
    if (( ok != 0 )) && command -v wget >/dev/null 2>&1; then
        if wget -q -U 'mk-tools' --tries=3 --timeout="$MK_UPDATE_TIMEOUT" \
            -O "$dest" "$MK_UPDATE_URL" 2>/dev/null; then
            ok=0
        fi
    fi

    if [[ ! -s "$dest" ]]; then
        rm -f "$dest" 2>/dev/null || true
        return 1
    fi
    return "$ok"
}

# 确认下载到的真的是一份 mk 脚本，而不是网关塞回来的拦截页
mk_update_verify() {
    local f="$1"
    [[ -s "$f" ]] || return 1
    head -1 "$f" 2>/dev/null | grep -q '^#!' || return 1
    grep -q '^readonly MK_VERSION=' "$f" 2>/dev/null || return 1
    grep -q '__MK_EMBEDDED_PATCHES__' "$f" 2>/dev/null || return 1
    syntax_check "$f"
}

# 备份现有脚本并只保留最近几份，回显备份路径
mk_update_backup() {
    local installed="$1" ver="$2" stamp="" bak="" old="" n=0
    local keep=$((MK_UPDATE_BACKUP_KEEP + 1))
    [[ -f "$installed" ]] || return 0
    mkdir -p "$MK_UPDATE_BACKUP_DIR" 2>/dev/null || return 0

    stamp="$(date '+%Y%m%d-%H%M%S')"
    bak="${MK_UPDATE_BACKUP_DIR}/mk-${ver:-unknown}-${stamp}"
    if cp -f "$installed" "$bak" 2>/dev/null; then
        printf '%s' "$bak"
    fi

    while IFS= read -r old; do
        n=$((n + 1))
        (( n >= keep )) || continue
        rm -f "$old" 2>/dev/null || true
    done < <(ls -1t "${MK_UPDATE_BACKUP_DIR}"/mk-* 2>/dev/null || true)
    return 0
}

# 检查 → 下载 → 校验 → 备份 → 覆盖安装，全自动一条龙
mk_self_update() {
    local installed="${INSTALL_DIR}/${SCRIPT_FILE}"
    local local_ver="" remote_ver="" tmp="" bak="" answer=""

    local_ver="$(mk_update_read_version "$SELF_PATH" 2>/dev/null || true)"
    [[ -n "$local_ver" ]] || local_ver="$MK_VERSION"

    mkdir -p "$MK_TMP" 2>/dev/null || true
    tmp="${MK_TMP}/mk-update.$$.new"

    info "小MK喵先去远程瞄一眼版本 ~(=^･ω･^=)"
    echo "  远程地址: ${MK_UPDATE_URL}"
    echo "  本地版本: v${local_ver}"
    echo

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        error "curl 和 wget 都不在，小MK没手没脚下载不动喵 (；´д｀)"
        return 1
    fi

    if ! mk_update_download "$tmp"; then
        rm -f "$tmp" 2>/dev/null || true
        error "下载失败了喵…… 网络不通或者地址访问不到，过会儿再试试哦 (´･ω･)"
        return 1
    fi

    if ! mk_update_verify "$tmp"; then
        rm -f "$tmp" 2>/dev/null || true
        error "下回来的东西不像一份 mk 脚本（可能被网关换成错误页了），小MK不敢往身上装喵！"
        return 1
    fi

    remote_ver="$(mk_update_read_version "$tmp" 2>/dev/null || true)"
    info "远程版本: v${remote_ver:-未知}"

    if ! mk_update_remote_is_newer "$remote_ver" "$local_ver"; then
        if [[ "$remote_ver" == "$local_ver" ]]; then
            info "已经是最新的啦，不用动它喵～ ✧"
        else
            warn "远程 v${remote_ver:-未知} 不比本地 v${local_ver} 新，小MK就先不折腾了喵～"
        fi
        rm -f "$tmp" 2>/dev/null || true
        return 0
    fi

    echo
    info "嗷！抓到新版本: v${local_ver} → v${remote_ver} (๑>◡<๑)"
    echo "  接下来会: 备份当前脚本 → 覆盖安装 → 重建全局命令与自启单元"
    echo
    read -r -p "现在就更新嘛? [y/N]: " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        info "好哒，那这次先不更新喵～"
        rm -f "$tmp" 2>/dev/null || true
        return 0
    fi

    if ! require_root; then
        rm -f "$tmp" 2>/dev/null || true
        return 1
    fi

    bak="$(mk_update_backup "$installed" "$local_ver" 2>/dev/null || true)"

    # 借官方安装流程部署新脚本：软链别名、自启单元、魔改资源都会一起刷新
    # 它的「版本」提示取自旧进程常量，会显示旧版本号，所以先收进日志，成功只报权威版本
    local deploy_log=""
    info "正在部署 v${remote_ver} ..."
    if ! deploy_log="$(SELF_PATH="$tmp" install_self 2>&1)"; then
        printf '%s\n' "$deploy_log" >&2
        rm -f "$tmp" 2>/dev/null || true
        error "更新途中翻车了喵…… 小MK先把旧版本还给你 (；´д｀)"
        if [[ -n "$bak" && -f "$bak" ]]; then
            cp -f "$bak" "$installed" 2>/dev/null || true
            warn "已经回滚回 v${local_ver} 啦，别怕喵～"
        else
            warn "没找到备份文件，请手动检查: ${installed}"
        fi
        return 1
    fi

    rm -f "$tmp" 2>/dev/null || true

    info "更新成功啦！v${local_ver} → v${remote_ver} 好耶 ✧٩(ˊωˋ*)و✧"
    echo "  备份文件: ${bak:-无}"
    echo "  马上重载新版本喵～ (๑>◡<๑)"
    # 用 exec 替换当前进程为已部署的新脚本，避免用户手动退出重进
    exec bash "$installed" ${MK_ORIG_ARGS[@]+"${MK_ORIG_ARGS[@]}"} || return 1
}

menu_self_update() {
    title "检查脚本更新"
    echo "  远程地址: ${MK_UPDATE_URL}"
    echo "  当前版本: v${MK_VERSION}"
    echo "  备份目录: ${MK_UPDATE_BACKUP_DIR}（保留最近 ${MK_UPDATE_BACKUP_KEEP} 份）"
    echo
    mk_self_update || true
    press_enter
}

# ==================== 字体包操作 ====================

readonly FONT_INSTALL_DIR="/usr/share/fonts/mk-cjk"
readonly FONT_LOG="${LOG_DIR}/font-install.log"

# GitHub 直链（配合国内代理前缀）；自定义 URL 时不使用这些
readonly FONT_URL_WQY="https://github.com/anthonyfok/fonts-wqy-microhei/raw/master/wqy-microhei.ttc"
readonly FONT_URL_NOTO="https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"

FONT_PROXY_INDEX="0"
FONT_CUSTOM_URL=""

font_mirror_labels=(
    "直连 GitHub (国外/可访问 GitHub 的服务器)"
    "ghfast.top"
    "git.yylx.win"
    "gh-proxy.com"
    "ghfile.geekertao.top"
    "gh-proxy.net"
    "j.1win.ggff.net"
    "ghm.078465.xyz"
    "gitproxy.127731.xyz"
    "jiashu.1win.eu.org"
    "github.tbedu.top"
)

font_mirror_urls=(
    ""
    "https://ghfast.top"
    "https://git.yylx.win/"
    "https://gh-proxy.com"
    "https://ghfile.geekertao.top"
    "https://gh-proxy.net"
    "https://j.1win.ggff.net"
    "https://ghm.078465.xyz"
    "https://gitproxy.127731.xyz"
    "https://jiashu.1win.eu.org"
    "https://github.tbedu.top"
)

font_build_download_url() {
    local raw_url="$1"
    local proxy_idx="${2:-0}"
    local proxy=""

    if [[ -n "${FONT_CUSTOM_URL:-}" ]]; then
        echo "$FONT_CUSTOM_URL"
        return 0
    fi
    if [[ "$proxy_idx" =~ ^[0-9]+$ ]] && (( proxy_idx > 0 && proxy_idx < ${#font_mirror_urls[@]} )); then
        proxy="${font_mirror_urls[$proxy_idx]}"
        proxy="${proxy%/}"
        echo "${proxy}/${raw_url}"
    else
        echo "$raw_url"
    fi
}

font_ensure_fc() {
    if command -v fc-list >/dev/null 2>&1 && command -v fc-cache >/dev/null 2>&1; then
        return 0
    fi
    warn "呜喵… 小MK没找到 fontconfig（fc-list），尝试安装 呢～ (｡•́︿•̀｡)"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq >/dev/null 2>&1 || true
        apt-get install -y fontconfig >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y fontconfig >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y fontconfig >/dev/null 2>&1 || true
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm fontconfig >/dev/null 2>&1 || true
    fi
    command -v fc-list >/dev/null 2>&1
}

font_zh_family_pattern() {
    echo 'Noto Sans CJK|NotoSansCJK|Noto Serif CJK|Source Han Sans|SourceHanSans|WenQuanYi|文泉驿|WQY|wqy-|Droid Sans Fallback|AR PL|AR PL UMing|AR PL UKai|FZSong|SimSun|SimHei|Microsoft YaHei|WenQuanYi Micro Hei|WenQuanYi Zen Hei'
}

font_scan_fc_zh() {
    local out=""
    command -v fc-list >/dev/null 2>&1 || return 1
    out="$(fc-list :lang=zh family 2>/dev/null | sort -u || true)"
    if [[ -z "$out" ]]; then
        out="$(fc-list 2>/dev/null | grep -iE "$(font_zh_family_pattern)" | sed 's/:.*//' | sort -u || true)"
    fi
    [[ -n "$out" ]] || return 1
    printf '%s\n' "$out"
}

font_scan_files() {
    local dirs=(
        /usr/share/fonts
        /usr/local/share/fonts
        /usr/share/fonts/truetype
        /usr/share/fonts/opentype
        "$FONT_INSTALL_DIR"
        "${HOME}/.fonts"
        "${HOME}/.local/share/fonts"
    )
    local d="" found=0
    for d in "${dirs[@]}"; do
        [[ -d "$d" ]] || continue
        while IFS= read -r -d '' f; do
            echo "  文件: $f 呢喵 (๑ᵕᴗᵕ๑)"
            found=1
        done < <(find "$d" -type f \( \
            -iname '*noto*cjk*' -o -iname '*sourcehan*' -o -iname '*wqy*' \
            -o -iname '*wenquanyi*' -o -iname '*microhei*' -o -iname '*zenhei*' \
            -o -iname '*droid*fallback*' -o -iname '*uming*' -o -iname '*ukai*' \
        \) -print0 2>/dev/null)
    done
    (( found == 1 ))
}

font_pkg_status_line() {
    local name="$1"
    if command -v dpkg >/dev/null 2>&1; then
        if dpkg -s "$name" 2>/dev/null | grep -qi '^Status:.*installed'; then
            echo -e "  ${GREEN}* 软件包 ${name}: 已经装好啦 (๑•̀ㅂ•́)و✧${NC}"
            return 0
        fi
        echo -e "  ${YELLOW}* 软件包 ${name}: 还没装呢 (๑ᵕᴗᵕ๑)${NC}"
        return 1
    fi
    if command -v rpm >/dev/null 2>&1; then
        if rpm -q "$name" >/dev/null 2>&1; then
            echo -e "  ${GREEN}* 软件包 ${name}: 已经装好啦 ₍˄·͈༝·͈˄₎${NC}"
            return 0
        fi
        echo -e "  ${YELLOW}* 软件包 ${name}: 还没装呢 (๑>◡<๑)${NC}"
        return 1
    fi
    if command -v pacman >/dev/null 2>&1; then
        if pacman -Qi "$name" >/dev/null 2>&1; then
            echo -e "  ${GREEN}* 软件包 ${name}: 已经装好啦 (｡•̀ᴗ-)✧${NC}"
            return 0
        fi
        echo -e "  ${YELLOW}* 软件包 ${name}: 还没装呢 ✧٩(ˊωˋ*)و✧${NC}"
        return 1
    fi
    return 1
}

font_has_cjk() {
    local families=""
    if families="$(font_scan_fc_zh 2>/dev/null)"; then
        return 0
    fi
    if font_scan_files >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

font_show_status() {
    local families="" count=0
    echo "  检测结果 啦喵:"
    if command -v fc-list >/dev/null 2>&1; then
        if families="$(font_scan_fc_zh 2>/dev/null)"; then
            count="$(printf '%s\n' "$families" | grep -c . || true)"
            echo -e "  ${GREEN}* 已小MK发现中文字体族 ${count} 个（fontconfig） 咯喵 (๑•̀ㅂ•́)و✧${NC}"
            printf '%s\n' "$families" | head -n 12 | while IFS= read -r line; do
                [[ -n "$line" ]] && echo "    - $line"
            done
            if (( count > 12 )); then
                echo "    ... 另有 $((count - 12)) 个未列出 呀喵 (๑>◡<๑)"
            fi
        else
            echo -e "  ${YELLOW}* fontconfig 未列出中文字体族 喵♪ ₍˄·͈༝·͈˄₎${NC}"
        fi
    else
        echo -e "  ${YELLOW}* 还没装呢 fontconfig（没法用 fc-list 精确检测） 哦喵 (๑>◡<๑)${NC}"
    fi

    echo
    echo "  常见软件包 喵♪:"
    if command -v dpkg >/dev/null 2>&1; then
        font_pkg_status_line "fonts-wqy-microhei" || true
        font_pkg_status_line "fonts-wqy-zenhei" || true
        font_pkg_status_line "fonts-noto-cjk" || true
        font_pkg_status_line "fonts-noto-cjk-extra" || true
    elif command -v rpm >/dev/null 2>&1; then
        font_pkg_status_line "wqy-microhei-fonts" || true
        font_pkg_status_line "wqy-zenhei-fonts" || true
        font_pkg_status_line "google-noto-sans-cjk-fonts" || true
        font_pkg_status_line "google-noto-sans-cjk-ttc-fonts" || true
    elif command -v pacman >/dev/null 2>&1; then
        font_pkg_status_line "wqy-microhei" || true
        font_pkg_status_line "noto-fonts-cjk" || true
    else
        echo "  （未识别到 apt/rpm/pacman，跳过软件包检测） 喵～ (๑•̀ㅂ•́)و✧"
    fi

    echo
    echo "  mk 手动安装目录: ${FONT_INSTALL_DIR} 呢喵 (｡•̀ᴗ-)✧"
    if [[ -d "$FONT_INSTALL_DIR" ]] && find "$FONT_INSTALL_DIR" -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' \) 2>/dev/null | grep -q .; then
        echo -e "  ${GREEN}* 目录内已有字体文件 喵♪:${NC}"
        find "$FONT_INSTALL_DIR" -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' \) 2>/dev/null | while IFS= read -r f; do
            echo "    - $f"
        done
    else
        echo -e "  ${YELLOW}* 目录为空或未创建 呢喵 (๑>◡<๑)${NC}"
    fi

    echo
    if font_has_cjk; then
        echo -e "  ${GREEN}结论: 系统已具备可用中文字体 哦喵 (｡•̀ᴗ-)✧${NC}"
    else
        echo -e "  ${RED}结论: 未发现中文字体，建议安装（截图/渲染中文可能方块） 呢喵 (๑•̀ㅂ•́)و✧${NC}"
    fi
}

font_refresh_cache() {
    mkdir -p "$FONT_INSTALL_DIR" 2>/dev/null || true
    if command -v fc-cache >/dev/null 2>&1; then
        info "喵～ 正在刷新字体缓存 呀～ ✧٩(ˊωˋ*)و✧"
        fc-cache -fv "$FONT_INSTALL_DIR" >/dev/null 2>&1 || fc-cache -fv || true
        info "诶嘿～ 字体缓存已刷新 喵♪ (๑ᵕᴗᵕ๑)"
    else
        warn "呜喵… 无 fc-cache，跳过刷新；新字体可能需重启相关进程后生效 啦～ (´･ω･)"
    fi
}

font_download_to() {
    local url="$1"
    local dest="$2"
    mkdir -p "$(dirname "$dest")" "$LOG_DIR"
    info "喵～ 下载: $url 呀～ ✧٩(ˊωˋ*)و✧"
    info "小MK喵：保存: $dest 呢～ ₍˄·͈༝·͈˄₎"
    if command -v curl >/dev/null 2>&1; then
        if curl -fL --retry 3 --connect-timeout 30 -A 'mk-tools' -o "$dest" "$url" >>"$FONT_LOG" 2>&1; then
            return 0
        fi
    fi
    if command -v wget >/dev/null 2>&1; then
        if wget -O "$dest" "$url" >>"$FONT_LOG" 2>&1; then
            return 0
        fi
    fi
    error "小MK喵吓一跳！ 下载失败，详见: $FONT_LOG 呀～ (´･ω･)"
    return 1
}

font_install_file() {
    local src="$1"
    local name=""
    [[ -f "$src" ]] || { error "呜哇！ 文件不存在: $src 喵～ (,,>﹏<,,)"; return 1; }
    name="$(basename "$src")"
    mkdir -p "$FONT_INSTALL_DIR"
    cp -f "$src" "${FONT_INSTALL_DIR}/${name}"
    chmod 644 "${FONT_INSTALL_DIR}/${name}" || true
    info "喵～ 已安装到: ${FONT_INSTALL_DIR}/${name} 呀～ ✧٩(ˊωˋ*)و✧"
    font_refresh_cache
}

menu_font_select_mirror() {
    local i=0 idx=0
    FONT_CUSTOM_URL=""
    FONT_PROXY_INDEX="0"

    while true; do
        title "选择字体下载镜像源 啦喵 (๑>◡<๑)"
        show_nav_hint
        echo "  无外网请返回后选「从本地文件安装」 呀喵 ✧٩(ˊωˋ*)و✧"
        echo "  国内服务器访问 GitHub 困难时，请选代理镜像 呢喵 ₍˄·͈༝·͈˄₎"
        echo
        for ((i=0; i<${#font_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            echo "  [${idx}] ${font_mirror_labels[$i]}"
        done
        echo "  [$(( ${#font_mirror_labels[@]} + 2 ))] 自定义完整下载 URL 呀喵 ₍˄·͈༝·͈˄₎"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            *)
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    local custom_idx=$(( ${#font_mirror_labels[@]} + 2 ))
                    if (( choice == custom_idx )); then
                        local url=""
                        read -r -p "请粘贴字体文件完整 URL 哦喵:" url </dev/tty 2>/dev/null || read -r -p "请粘贴字体文件完整 URL: " url
                        url="${url#"${url%%[![:space:]]*}"}"
                        url="${url%"${url##*[![:space:]]}"}"
                        if [[ -z "$url" ]]; then
                            warn "小MK喵小声说：URL 为空 呀～ (。•́︿•̀。)"
                            continue
                        fi
                        FONT_CUSTOM_URL="$url"
                        FONT_PROXY_INDEX="0"
                        info "小MK喵：已使用自定义 URL 哦～ (๑•̀ㅂ•́)و✧"
                        return 0
                    fi
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#font_mirror_labels[@]} )); then
                        FONT_PROXY_INDEX="$idx"
                        FONT_CUSTOM_URL=""
                        info "喵～ 已选择: ${font_mirror_labels[$idx]} 呀～ ✧٩(ˊωˋ*)و✧"
                        return 0
                    fi
                fi
                warn "呜喵… 看不懂选项，请重新输入 啦～ (；´д｀)"
                ;;
        esac
    done
}

font_install_via_download() {
    local kind="$1"
    local raw_url="" dest="" dl_url=""
    require_root || return 1

    case "$kind" in
        wqy)
            raw_url="$FONT_URL_WQY"
            dest="${FONT_INSTALL_DIR}/wqy-microhei.ttc"
            ;;
        noto)
            raw_url="$FONT_URL_NOTO"
            dest="${FONT_INSTALL_DIR}/NotoSansCJKsc-Regular.otf"
            ;;
        *)
            error "呜哇！ 未知字体类型: $kind 啦喵 (´･ω･)"
            return 1
            ;;
    esac

    menu_font_select_mirror || return 0
    if mk_nav_bubble_up; then
        return 0
    fi

    if [[ -n "$FONT_CUSTOM_URL" ]]; then
        dl_url="$FONT_CUSTOM_URL"
        # 自定义 URL 时按后缀猜文件名
        local base=""
        base="$(basename "${dl_url%%\?*}")"
        if [[ "$base" =~ \.(ttf|otf|ttc)$ ]]; then
            dest="${FONT_INSTALL_DIR}/${base}"
        fi
    else
        dl_url="$(font_build_download_url "$raw_url" "$FONT_PROXY_INDEX")"
    fi

    local tmp=""
    tmp="$(mktemp "/tmp/mk-font.XXXXXX")"
    if ! font_download_to "$dl_url" "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    # 简单校验：文件非空且不太像 HTML 错误页
    if [[ ! -s "$tmp" ]]; then
        error "呜哇！ 下载文件为空 呀喵 (´･ω･)"
        rm -f "$tmp"
        return 1
    fi
    if head -c 200 "$tmp" 2>/dev/null | grep -qiE '<html|<!DOCTYPE'; then
        error "小MK喵吓一跳！ 下载内容像网页而非字体文件，请换镜像或自定义 URL 呀～ (´･ω･)"
        rm -f "$tmp"
        return 1
    fi
    mkdir -p "$FONT_INSTALL_DIR"
    mv -f "$tmp" "$dest"
    chmod 644 "$dest" || true
    info "呐呐，字体文件已经准备好啦: $dest 啦喵 ₍˄·͈༝·͈˄₎"
    font_refresh_cache
    echo
    font_show_status
}

font_install_via_packages() {
    require_root || return 1
    info "呐呐，通过系统软件源安装中文字体（走本机 apt/yum 镜像，适合已配国内源的机器） 哦喵 (｡•̀ᴗ-)✧"
    echo
    local ok=0
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq || true
        if apt-get install -y fonts-wqy-microhei fonts-noto-cjk; then
            ok=1
        else
            warn "诶…… 完整套装失败，尝试仅安装文泉驿 呀喵 (。•́︿•̀。)"
            apt-get install -y fonts-wqy-microhei && ok=1 || true
            apt-get install -y fonts-noto-cjk || true
        fi
    elif command -v dnf >/dev/null 2>&1; then
        if dnf install -y wqy-microhei-fonts google-noto-sans-cjk-fonts \
            || dnf install -y wqy-microhei-fonts google-noto-sans-cjk-ttc-fonts \
            || dnf install -y wqy-microhei-fonts; then
            ok=1
        fi
    elif command -v yum >/dev/null 2>&1; then
        if yum install -y wqy-microhei-fonts google-noto-sans-cjk-fonts \
            || yum install -y wqy-microhei-fonts google-noto-sans-cjk-ttc-fonts \
            || yum install -y wqy-microhei-fonts; then
            ok=1
        fi
    elif command -v pacman >/dev/null 2>&1; then
        if pacman -Sy --noconfirm wqy-microhei noto-fonts-cjk; then
            ok=1
        fi
    else
        error "诶诶！ 未识别到 apt / dnf / yum / pacman，请改用下载安装或本地文件 呀喵 (；´д｀)"
        return 1
    fi

    font_ensure_fc || true
    font_refresh_cache
    echo
    font_show_status
    if (( ok == 1 )) || font_has_cjk; then
        info "小MK喵：软件源安装流程结束 哦～ (๑•̀ㅂ•́)و✧"
        return 0
    fi
    error "诶诶！ 软件源安装可能失败（仓库无包或无外网）。可改用镜像下载，或把字体文件拷到服务器后「从本地文件安装」 啦喵 (｡•́︿•̀｡)"
    return 1
}

font_install_from_local() {
    require_root || return 1
    local path=""
    echo "  支持 .ttf / .otf / .ttc；可先 scp 到服务器再填写路径 啦喵 (｡•̀ᴗ-)✧"
    echo "  例: /root/wqy-microhei.ttc 哦喵 (๑>◡<๑)"
    echo
    read -r -p "本地字体文件路径 呢喵:" path </dev/tty 2>/dev/null || read -r -p "本地字体文件路径: " path
    path="${path#"${path%%[![:space:]]*}"}"
    path="${path%"${path##*[![:space:]]}"}"
    path="${path%\"}"
    path="${path#\"}"
    if [[ "$path" == "~/"* ]]; then
        path="${HOME}/${path:2}"
    fi
    if [[ -z "$path" || ! -f "$path" ]]; then
        error "小MK喵吓一跳！ 看不懂路径: ${path:-"(空)"} 哇～ (´･ω･)"
        return 1
    fi
    if [[ ! "$path" =~ \.(ttf|otf|ttc|TTF|OTF|TTC)$ ]]; then
        warn "呜喵… 扩展名不像字体文件，仍将尝试安装 呢～ (；´д｀)"
    fi
    font_install_file "$path"
    echo
    font_show_status
}

menu_fonts() {
    while true; do
        title "字体包操作 咯喵 (๑>◡<๑)"
        show_nav_hint
        if font_has_cjk; then
            echo -e "  ${GREEN}* 状态: 已小MK发现中文字体 啦喵 ₍˄·͈༝·͈˄₎${NC}"
        else
            echo -e "  ${YELLOW}* 状态: 小MK没找到中文字体（截图/中文渲染可能异常） 呀喵 (｡•̀ᴗ-)✧${NC}"
        fi
        echo
        echo "  [2] 扫描检测中文字体嘛"
        echo "  [3] 软件源一键安装（apt/yum，走系统镜像）嘛"
        echo "  [4] 下载安装 文泉驿微米黑（体积较小）嘛"
        echo "  [5] 下载安装 Noto Sans CJK SC（覆盖更好）嘛"
        echo "  [6] 从本地文件安装（无外网 / 自备字体）嘛"
        echo "  [7] 刷新字体缓存（fc-cache）嘛"
        echo
        echo "  说明: [4]/[5] 可选国内代理或自定义 URL；完全断网请用 [6] 喵♪ ₍˄·͈༝·͈˄₎"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                font_ensure_fc || true
                font_show_status
                press_enter
                ;;
            3)
                font_install_via_packages || true
                press_enter
                ;;
            4)
                font_install_via_download "wqy" || true
                press_enter
                ;;
            5)
                font_install_via_download "noto" || true
                press_enter
                ;;
            6)
                font_install_from_local || true
                press_enter
                ;;
            7)
                require_root || true
                font_ensure_fc || true
                font_refresh_cache
                press_enter
                ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 呀～ (。•́︿•̀。)" ;;
        esac
        if mk_nav_bubble_up; then
            return 0
        fi
    done
}

# ==================== 端口验证 ====================

port_is_valid() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 ))
}

port_translate_state() {
    case "$1" in
        LISTEN)     echo "监听中" ;;
        ESTAB|ESTABLISHED) echo "已建立连接" ;;
        TIME-WAIT|TIME_WAIT) echo "等待关闭" ;;
        CLOSE-WAIT|CLOSE_WAIT) echo "等待本地关闭" ;;
        SYN-SENT|SYN_SENT) echo "正在连接" ;;
        SYN-RECV|SYN_RECV) echo "等待握手" ;;
        FIN-WAIT-1|FIN_WAIT1) echo "正在关闭(1)" ;;
        FIN-WAIT-2|FIN_WAIT2) echo "正在关闭(2)" ;;
        CLOSED)     echo "已关闭" ;;
        UNCONN)     echo "未连接" ;;
        *)          echo "$1" ;;
    esac
}

port_translate_proto() {
    case "${1,,}" in
        tcp) echo "TCP" ;;
        udp) echo "UDP" ;;
        tcp6) echo "TCP (IPv6)" ;;
        udp6) echo "UDP (IPv6)" ;;
        *) echo "$1" ;;
    esac
}

port_translate_addr() {
    local addr="$1"
    case "$addr" in
        0.0.0.0|"[::]"|\*|"") echo "所有网卡" ;;
        127.0.0.1|"[::1]") echo "仅本机" ;;
        *) echo "$addr" ;;
    esac
}

port_translate_process() {
    local name="$1"
    local lower="${name,,}"
    case "$lower" in
        node)           echo "Node.js" ;;
        nginx)          echo "Nginx 网页服务" ;;
        python|python3) echo "Python 程序" ;;
        java)           echo "Java 程序" ;;
        docker-proxy)   echo "Docker 端口转发" ;;
        bt|panel*)      echo "宝塔面板" ;;
        redis-server)   echo "Redis 数据库" ;;
        mysqld|mariadbd) echo "MySQL/MariaDB 数据库" ;;
        postgres)       echo "PostgreSQL 数据库" ;;
        sshd)           echo "SSH 远程登录" ;;
        napcat*|qq)     echo "NapCat / QQ 相关" ;;
        *)              echo "$name" ;;
    esac
}

port_guess_service_hint() {
    local port="$1"
    case "$port" in
        22)    echo "常见用途: SSH 远程登录" ;;
        80)    echo "常见用途: HTTP 网站" ;;
        443)   echo "常见用途: HTTPS 加密网站" ;;
        3000)  echo "常见用途: HTTP 服务 / NapCat" ;;
        3001)  echo "常见用途: WebSocket 服务 / NapCat" ;;
        6099)  echo "常见用途: NapCat WebUI 面板" ;;
        6700)  echo "常见用途: 咔咔珂 OneBot 反向 WS" ;;
        8787)  echo "常见用途: 咔咔珂控制台" ;;
        8888)  echo "常见用途: 宝塔面板" ;;
        8080)  echo "常见用途: 备用 Web 服务" ;;
        *)     return 1 ;;
    esac
}

port_to_proc_hex() {
    local port="$1"
    local hex=""
    hex="$(printf '%04X' "$port")"
    echo "${hex:2:2}${hex:0:2}"
}

port_ss_has_listener() {
    local port="$1"
    command -v ss >/dev/null 2>&1 || return 1
    ss -H -tulnp "( sport = :${port} )" 2>/dev/null | grep -q . && return 0
    ss -H -tulnp 2>/dev/null | awk -v p=":${port}" '
        $2 ~ /^(LISTEN|UNCONN)$/ && ($4 ~ p "([^0-9]|$)" || $4 ~ "\\*" p "([^0-9]|$)") { found=1 }
        END { exit !found }' && return 0
    return 1
}

port_proc_has_listener() {
    local port="$1" hex="" f=""
    hex="$(port_to_proc_hex "$port")"
    for f in /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6; do
        [[ -r "$f" ]] || continue
        awk -v h=":${hex}" 'NR > 1 && $2 ~ h "$" { found=1 } END { exit !found }' "$f" 2>/dev/null && return 0
    done
    return 1
}

port_lsof_has_socket() {
    local port="$1"
    command -v lsof >/dev/null 2>&1 || return 1
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { found=1 } END { exit !found }' && return 0
    lsof -nP -iUDP:"${port}" 2>/dev/null | awk 'NR > 1 { found=1 } END { exit !found }' && return 0
    lsof -nP -i:"${port}" 2>/dev/null | awk 'NR > 1 { found=1 } END { exit !found }' && return 0
    return 1
}

port_is_listening() {
    local port="$1"
    port_ss_has_listener "$port" && return 0
    port_proc_has_listener "$port" && return 0
    port_lsof_has_socket "$port" && return 0
    if command -v netstat >/dev/null 2>&1; then
        netstat -tulnp 2>/dev/null | awk -v p=":${port}" '
            $6 ~ /^(LISTEN|UNCONN)$/ && ($4 ~ p "([^0-9]|$)" || $4 ~ p"$") { found=1 }
            END { exit !found }' && return 0
    fi
    return 1
}

port_has_established() {
    local port="$1"
    command -v ss >/dev/null 2>&1 || return 1
    ss -H -tan "( sport = :${port} or dport = :${port} )" state established 2>/dev/null | grep -q . && return 0
    ss -H -tan state established 2>/dev/null | awk -v p=":${port}" '
        $4 ~ p "([^0-9]|$)" || $5 ~ p "([^0-9]|$)" { found=1 }
        END { exit !found }' && return 0
    return 1
}

port_parse_addr_port() {
    local addr="$1" p=""
    addr="${addr#http://}"
    addr="${addr#https://}"
    addr="${addr#ws://}"
    addr="${addr#wss://}"
    addr="${addr%%/*}"
    if [[ "$addr" == *:* ]]; then
        p="${addr##*:}"
        p="${p%%[^0-9]*}"
    elif [[ "$addr" =~ ^[0-9]+$ ]]; then
        p="$addr"
    fi
    if [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 65535 )); then
        echo "$p"
    fi
}

port_mk_config_hit() {
    local port="$1"
    local addr="" p=""

    if [[ -f "${KAKAKE_CONNECTIONS_FILE:-}" ]] \
        && grep -qE "\"port\"[[:space:]]*:[[:space:]]*${port}([,}]|[[:space:]]*[,}])" "${KAKAKE_CONNECTIONS_FILE}" 2>/dev/null; then
        return 0
    fi
    if [[ "$port" == "$KAKAKE_ADMIN_PORT" || "$port" == "6099" ]]; then
        return 0
    fi
    if declare -f napcat_cfg_tool >/dev/null 2>&1; then
        while IFS=$'\t' read -r _ _ _ addr _ _; do
            p="$(port_parse_addr_port "$addr")"
            [[ "$p" == "$port" ]] && return 0
        done < <(napcat_cfg_tool list 2>/dev/null || true)
    fi
    return 1
}

port_collect_mk_ports() {
    local -a ports=()
    local addr="" p=""

    ports+=(6099 "$KAKAKE_ADMIN_PORT" 8888)

    if [[ -f "${KAKAKE_CONNECTIONS_FILE:-}" ]]; then
        while IFS= read -r p; do
            [[ -n "$p" ]] && ports+=("$p")
        done < <(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "${KAKAKE_CONNECTIONS_FILE}" 2>/dev/null \
            | grep -oE '[0-9]+' || true)
    fi

    if declare -f napcat_cfg_tool >/dev/null 2>&1; then
        while IFS=$'\t' read -r _ _ _ addr _ _; do
            p="$(port_parse_addr_port "$addr")"
            [[ -n "$p" ]] && ports+=("$p")
        done < <(napcat_cfg_tool list 2>/dev/null || true)
    fi

    printf '%s\n' "${ports[@]}" | sort -nu
}

port_firewall_is_open() {
    local port="$1"
    local ufw_status=""

    if command -v ufw >/dev/null 2>&1; then
        ufw_status="$(ufw status 2>/dev/null || true)"
        if ! echo "$ufw_status" | grep -qi inactive; then
            echo "$ufw_status" | grep -qE "(^|[[:space:]])${port}/tcp([[:space:]]|$)" && return 0
            iptables -L ufw-user-input -n 2>/dev/null | grep -qE "dpt:${port}([[:space:]]|$)" && return 0
        fi
    fi
    if command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --list-ports 2>/dev/null | grep -qE "(^|[[:space:]])${port}/tcp([[:space:]]|$)" && return 0
    fi
    if command -v iptables >/dev/null 2>&1; then
        iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 && return 0
        iptables -L INPUT -n 2>/dev/null | grep -qE "dpt:${port}([[:space:]]|$)" && return 0
    fi
    return 1
}

port_show_verify_summary() {
    local port="$1"
    local listen_text="" conn_text="" fw_text="" cfg_text=""

    if port_is_listening "$port"; then
        listen_text="${GREEN}监听中${NC}"
    else
        listen_text="${YELLOW}未监听${NC}"
    fi
    if port_has_established "$port"; then
        conn_text="${GREEN}有连接${NC}"
    else
        conn_text="无连接"
    fi
    if port_firewall_is_open "$port"; then
        fw_text="${GREEN}已放行${NC}"
    else
        fw_text="${YELLOW}未放行${NC}"
    fi
    if port_mk_config_hit "$port"; then
        cfg_text="${CYAN}已配置${NC}"
    else
        cfg_text="-"
    fi
    echo -e "  $(printf '%-6s' "$port")  占用:${listen_text}  连接:${conn_text}  防火墙:${fw_text}  mk:${cfg_text} 咯喵 (๑•̀ㅂ•́)و✧"
}

port_scan_mk_ports() {
    local -a ports=()
    local p="" choice=""

    mapfile -t ports < <(port_collect_mk_ports)
    if [[ ${#ports[@]} -eq 0 ]]; then
        warn "诶…… 没找到 mk 相关端口 喵～ (。•́︿•̀。)"
        return 0
    fi

    title "mk 相关端口扫描 (共 ${#ports[@]} 个) 呢喵 ✧٩(ˊωˋ*)و✧"
    echo "  端口    占用        连接      防火墙      mk配置 咯喵 ₍˄·͈༝·͈˄₎"
    echo "  --------------------------------------------------------------"
    for p in "${ports[@]}"; do
        port_show_verify_summary "$p"
    done
    echo
    info "小MK喵：端口列表: ${ports[*]} 呢～ ₍˄·͈༝·͈˄₎"
    echo
    read -r -p "输入端口号查看详情 (直接回车返回) 喵♪:" choice
    choice="${choice//$'\r'/}"
    if [[ -n "$choice" ]] && port_is_valid "$choice"; then
        echo
        port_show_verify_report "$choice"
    fi
}

port_list_all_listeners() {
    local line="" proto="" state="" local_addr="" port="" host="" proc="" pid=""

    title "本机全部监听端口 呀喵 (๑ᵕᴗᵕ๑)"
    if ! command -v ss >/dev/null 2>&1; then
        error "呜哇！ 需要 ss 命令，没法列出端口 咯喵 (；´д｀)"
        return 1
    fi

    echo -e "  ${BOLD}端口    协议        状态      监听地址              进程 哦喵 (๑ᵕᴗᵕ๑)${NC}"
    echo "  ----------------------------------------------------------------------"

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        proto="$(echo "$line" | awk '{print $1}')"
        state="$(echo "$line" | awk '{print $2}')"
        local_addr="$(echo "$line" | awk '{print $4}')"
        port="${local_addr##*:}"
        port="${port%%[^0-9]*}"
        [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && continue
        host="${local_addr%:*}"
        host="${host#[}"
        host="${host%]}"
        proc="$(echo "$line" | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p')"
        pid="$(echo "$line" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
        [[ -z "$proc" && -n "$pid" ]] && proc="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
        proc="${proc:-?}"
        echo -e "  $(printf '%-6s' "$port")  $(printf '%-10s' "$(port_translate_proto "$proto")")  $(printf '%-8s' "$(port_translate_state "$state")")  $(printf '%-20s' "${local_addr}")  $(port_translate_process "$proc")"
    done < <(
        ss -H -tulnp 2>/dev/null | awk '$2 ~ /^(LISTEN|UNCONN)$/' | while IFS= read -r ln; do
            p="${ln##*:}"
            p="${p%%[^0-9]*}"
            echo "${p}|${ln}"
        done | sort -t'|' -k1,1n | cut -d'|' -f2-
    )

    echo
    info "喵～ 共上表为当前监听/还没连上 UDP 端口；输入具体端口号可查看详情 呀～ ✧٩(ˊωˋ*)و✧"
}

port_verify_ports_input() {
    local raw="$1" p="" first=1
    raw="${raw//,/ }"
    raw="${raw//;/ }"
    raw="${raw//|/ }"

    for p in $raw; do
        if ! port_is_valid "$p"; then
            warn "诶…… 跳过看不懂端口: ${p} 喵♪ (,,>﹏<,,)"
            continue
        fi
        if [[ "$first" -eq 0 ]]; then
            echo
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo
        fi
        first=0
        port_show_verify_report "$p"
    done
    [[ "$first" -eq 1 ]] && warn "呜喵… 没有管用的端口号 啦～ (。•́︿•̀。)"
}

port_show_config_refs() {
    local port="$1"
    local found=0 addr="" cat="" name=""

    if [[ -f "${KAKAKE_CONNECTIONS_FILE:-}" ]] \
        && grep -qE "\"port\"[[:space:]]*:[[:space:]]*${port}([,}]|[[:space:]]*[,}])" "${KAKAKE_CONNECTIONS_FILE}" 2>/dev/null; then
        name="$(grep -E "\"port\"[[:space:]]*:[[:space:]]*${port}" "${KAKAKE_CONNECTIONS_FILE}" 2>/dev/null | head -1 | sed -n 's/.*\"name\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p')"
        echo "  咔咔珂连接配置: ${name:-未命名} (端口 ${port}) 喵♪ (๑ᵕᴗᵕ๑)"
        found=1
    fi

    if declare -f napcat_cfg_tool >/dev/null 2>&1; then
        while IFS=$'\t' read -r _ _ name addr _ cat; do
            [[ -z "$addr" ]] && continue
            if [[ "$(port_parse_addr_port "$addr")" == "$port" ]]; then
                echo "  NapCat 网络配置: ${name} (${cat}) -> ${addr} 喵～ (๑>◡<๑)"
                found=1
            fi
        done < <(napcat_cfg_tool list 2>/dev/null || true)
    fi

    if [[ "$port" == "$KAKAKE_ADMIN_PORT" ]]; then
        echo "  咔咔珂控制台默认端口 ${KAKAKE_ADMIN_PORT} 喵～ (๑•̀ㅂ•́)و✧"
        found=1
    fi

    if [[ "$found" -eq 0 ]]; then
        echo "  mk 管理的配置中未发现此端口 咯喵 (๑>◡<๑)"
    fi
}

port_firewall_check() {
    local port="$1"
    local found=0 ufw_status="" ufw_active=0

    if command -v ufw >/dev/null 2>&1; then
        ufw_status="$(ufw status 2>/dev/null || true)"
        if echo "$ufw_status" | grep -qi inactive; then
            echo "  ufw: 已安装但未启用 (通常不拦截入站) 哦喵 (｡•̀ᴗ-)✧"
        else
            ufw_active=1
            if echo "$ufw_status" | grep -qE "(^|[[:space:]])${port}/tcp([[:space:]]|$)"; then
                echo -e "  ufw: ${GREEN}已放行 TCP ${port} 喵♪ ₍˄·͈༝·͈˄₎${NC}"
                found=1
            elif echo "$ufw_status" | grep -qE "(^|[[:space:]])${port}([[:space:]]|$)"; then
                echo -e "  ufw: ${GREEN}已放行 ${port} 哦喵 (๑>◡<๑)${NC}"
                found=1
            else
                echo -e "  ufw: ${YELLOW}未放行 TCP ${port} 咯喵 ₍˄·͈༝·͈˄₎${NC}"
            fi
            if iptables -L ufw-user-input -n 2>/dev/null | grep -qE "dpt:${port}[[:space:]]"; then
                echo -e "  ufw 规则链: ${GREEN}存在 ${port} 入站规则 啦喵 (๑>◡<๑)${NC}"
                found=1
            fi
        fi
    fi

    if command -v firewall-cmd >/dev/null 2>&1; then
        local fw_ports=""
        fw_ports="$(firewall-cmd --list-ports 2>/dev/null || true)"
        if echo " $fw_ports " | grep -qE " ${port}/tcp "; then
            echo -e "  firewalld: ${GREEN}已放行 TCP ${port} 呢喵 (๑ᵕᴗᵕ๑)${NC}"
            found=1
        elif echo " $fw_ports " | grep -qE " ${port}/udp "; then
            echo -e "  firewalld: ${GREEN}已放行 UDP ${port} 喵～ (๑•̀ㅂ•́)و✧${NC}"
            found=1
        else
            echo -e "  firewalld: ${YELLOW}未放行 ${port} 呀喵 (๑ᵕᴗᵕ๑)${NC}"
        fi
    fi

    if command -v iptables >/dev/null 2>&1; then
        if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
            echo -e "  iptables INPUT: ${GREEN}已放行 TCP ${port} 哦喵 (๑ᵕᴗᵕ๑)${NC}"
            found=1
        elif iptables -L INPUT -n 2>/dev/null | grep -qE "dpt:${port}([[:space:]]|$)"; then
            echo -e "  iptables INPUT: ${GREEN}存在 ${port} 相关规则 咯喵 (๑•̀ㅂ•́)و✧${NC}"
            found=1
        elif [[ "$ufw_active" -eq 0 ]]; then
            echo -e "  iptables: ${YELLOW}没找到 ${port} 放行规则 啦喵 (๑ᵕᴗᵕ๑)${NC}"
        fi
    fi

    if command -v nft >/dev/null 2>&1; then
        local port_hex=""
        port_hex="$(port_to_proc_hex "$port")"
        if nft list ruleset 2>/dev/null | grep -qE "dport[[:space:]]*(${port}|0x${port_hex}|${port_hex})"; then
            echo -e "  nftables: ${GREEN}存在 ${port} 相关规则 哦喵 (๑>◡<๑)${NC}"
            found=1
        fi
    fi

    if [[ "$found" -eq 0 ]] \
        && ! command -v ufw >/dev/null 2>&1 \
        && ! command -v firewall-cmd >/dev/null 2>&1 \
        && ! command -v iptables >/dev/null 2>&1 \
        && ! command -v nft >/dev/null 2>&1; then
        echo "  小MK没找到 ufw / firewalld / iptables / nftables 咯喵 (๑ᵕᴗᵕ๑)"
    fi
}

port_show_listeners() {
    local port="$1"
    local line="" proto="" state="" local_addr="" host="" proc="" pid="" has_listener=0

    if command -v ss >/dev/null 2>&1; then
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            has_listener=1
            proto="$(echo "$line" | awk '{print $1}')"
            state="$(echo "$line" | awk '{print $2}')"
            local_addr="$(echo "$line" | awk '{print $4}')"
            host="${local_addr%:*}"
            host="${host#[}"
            host="${host%]}"
            proc="$(echo "$line" | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p')"
            pid="$(echo "$line" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
            if [[ -z "$proc" && -n "$pid" ]]; then
                proc="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
            fi
            proc="${proc:-未知}"
            echo "  协议:     $(port_translate_proto "$proto") 啦喵 (๑ᵕᴗᵕ๑)"
            echo "  状态:     $(port_translate_state "$state") 哦喵 (｡•̀ᴗ-)✧"
            echo "  监听地址: $(port_translate_addr "$host") (${local_addr}) 呀喵 (๑>◡<๑)"
            echo "  进程:     $(port_translate_process "$proc") 呢喵 (๑•̀ㅂ•́)و✧"
            [[ -n "$pid" ]] && echo "  进程 ID:  ${pid}"
            if [[ "$proc" == "未知" && $EUID -ne 0 ]]; then
                if mk_is_termux; then
                    echo "  提示:     安卓限制，只能看到 Termux 自己的进程（sudo 也看不懂） 啦喵 (｡•̀ᴗ-)✧"
                else
                    echo "  提示:     使用 sudo mk 可查看其他用户进程 呀喵 (๑•̀ㅂ•́)و✧"
                fi
            fi
            echo "  ---"
        done < <({
            ss -H -tulnp "( sport = :${port} )" 2>/dev/null || true
            if ! ss -H -tulnp "( sport = :${port} )" 2>/dev/null | grep -q .; then
                ss -H -tulnp 2>/dev/null | awk -v p=":${port}" \
                    '$2 ~ /^(LISTEN|UNCONN)$/ && ($4 ~ p "([^0-9]|$)" || $4 ~ "\\*" p "([^0-9]|$)") { print }' || true
            fi
        } | sort -u)
    fi

    if [[ "$has_listener" -eq 0 ]] && command -v lsof >/dev/null 2>&1; then
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            has_listener=1
            proc="$(echo "$line" | awk '{print $1}')"
            pid="$(echo "$line" | awk '{print $2}')"
            proto="$(echo "$line" | awk '{print $8}')"
            local_addr="$(echo "$line" | awk '{print $9}')"
            echo "  协议:     ${proto^^} 呀喵 (๑ᵕᴗᵕ๑)"
            echo "  状态:     监听中 呢喵 (｡•̀ᴗ-)✧"
            echo "  监听地址: ${local_addr} 咯喵 (๑>◡<๑)"
            echo "  进程:     $(port_translate_process "$proc") 喵♪ (๑•̀ㅂ•́)و✧"
            echo "  进程 ID:  ${pid} 喵～ ✧٩(ˊωˋ*)و✧"
            echo "  ---"
        done < <(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1'; lsof -nP -iUDP:"${port}" 2>/dev/null | awk 'NR>1'; lsof -nP -i:"${port}" 2>/dev/null | awk 'NR>1' || true)
    fi

    if [[ "$has_listener" -eq 0 ]] && port_proc_has_listener "$port"; then
        has_listener=1
        echo -e "  ${GREEN}内核显示端口 ${port} 已被占用 喵～ ₍˄·͈༝·͈˄₎${NC}"
        echo "  说明: 小MK发现 /proc/net 中有此端口，但未能解析进程名 啦喵 (๑ᵕᴗᵕ๑)"
        if mk_is_termux; then
            echo "  说明: 安卓不开放其他应用的进程信息，看不到进程名是正常的 呀喵 (๑>◡<๑)"
        elif [[ $EUID -ne 0 ]]; then
            echo "  建议: 使用 sudo mk 或 sudo ss -tulnp | grep :${port}"
        fi
    fi

    if [[ "$has_listener" -eq 0 ]]; then
        echo -e "  ${YELLOW}当前没有进程监听此端口 呀喵 (๑•̀ㅂ•́)و✧${NC}"
        if port_has_established "$port"; then
            echo "  说明: 无监听，但存在指向此端口的已建立连接 咯喵 ₍˄·͈༝·͈˄₎"
        else
            echo "  说明: 端口可能空闲，或服务尚还没跑起来呢 (｡•̀ᴗ-)✧"
        fi
    fi
}

port_show_connections() {
    local port="$1"
    local line="" state="" count=0
    declare -A state_map=()

    if ! command -v ss >/dev/null 2>&1; then
        echo "  没法统计 (少了 ss 命令) 呢喵 (๑ᵕᴗᵕ๑)"
        return 0
    fi

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        state="$(echo "$line" | awk '{print $1}')"
        state_map["$state"]=$(( ${state_map["$state"]:-0} + 1 ))
        ((count++)) || true
    done < <({
        ss -H -tan "( sport = :${port} or dport = :${port} )" 2>/dev/null || true
        if ! ss -H -tan "( sport = :${port} or dport = :${port} )" 2>/dev/null | grep -q .; then
            ss -H -tan 2>/dev/null | awk -v p=":${port}" \
                '$4 ~ p "([^0-9]|$)" || $5 ~ p "([^0-9]|$)" { print }' || true
        fi
    } | sort -u)

    if [[ "$count" -eq 0 ]]; then
        echo "  当前无 TCP 连接记录 啦喵 (๑ᵕᴗᵕ๑)"
        return 0
    fi

    echo "  TCP 连接总数: ${count} 咯喵 ✧٩(ˊωˋ*)و✧"
    for state in "${!state_map[@]}"; do
        echo "    $(port_translate_state "$state"): ${state_map[$state]} 条 喵～ (๑ᵕᴗᵕ๑)"
    done
}

port_show_verify_report() {
    local port="$1"
    local hint="" listening=0 established=0

    title "端口 ${port} 验证结果 啦喵 (๑>◡<๑)"

    listening=0
    established=0
    port_is_listening "$port" && listening=1
    port_has_established "$port" && established=1

    echo -e "${BOLD}【端口概览】 啦喵 (๑•̀ㅂ•́)و✧${NC}"
    if [[ "$listening" -eq 1 ]]; then
        echo -e "  占用状态: ${GREEN}使用中 (有程序正盯着) 呀喵 ₍˄·͈༝·͈˄₎${NC}"
    elif [[ "$established" -eq 1 ]]; then
        echo -e "  占用状态: ${YELLOW}有连接活动 (无监听，可能是出站连接) 咯喵 (｡•̀ᴗ-)✧${NC}"
    else
        echo -e "  占用状态: ${YELLOW}未发现监听或连接 喵～ (๑•̀ㅂ•́)و✧${NC}"
    fi
    if hint="$(port_guess_service_hint "$port" 2>/dev/null)"; then
        echo "  ${hint}"
    fi
    echo

    echo -e "${BOLD}【mk 配置关联】 喵～ ✧٩(ˊωˋ*)و✧${NC}"
    port_show_config_refs "$port"
    echo

    echo -e "${BOLD}【监听详情】 呢喵 (๑>◡<๑)${NC}"
    port_show_listeners "$port"
    echo

    echo -e "${BOLD}【连接统计】 啦喵 (๑ᵕᴗᵕ๑)${NC}"
    port_show_connections "$port"
    echo

    echo -e "${BOLD}【本机防火墙】 咯喵 ✧٩(ˊωˋ*)و✧${NC}"
    port_firewall_check "$port"
    echo

    warn "呜喵… 云服务商「安全组」没法在此检测，外网访问失败时请去控制台放行 啦～ (｡•́︿•̀｡)"
    if mk_is_termux; then
        info "诶嘿～ 手动验证: ss -tulnp '( sport = :${port} )'  或  cat /proc/net/tcp 呢喵 ✧٩(ˊωˋ*)و✧"
    else
        info "喵～ 手动验证: ss -tulnp '( sport = :${port} )'  或  sudo lsof -i :${port} 咯～ (๑ᵕᴗᵕ๑)"
    fi
}

# 收集占用某端口的进程，输出: pid|proto|state|addr|proc
port_collect_port_procs() {
    local port="$1"
    local line="" proto="" state="" local_addr="" proc="" pid=""
    local -A seen=()

    if command -v ss >/dev/null 2>&1; then
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            proto="$(echo "$line" | awk '{print $1}')"
            state="$(echo "$line" | awk '{print $2}')"
            local_addr="$(echo "$line" | awk '{print $4}')"
            proc="$(echo "$line" | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p')"
            pid="$(echo "$line" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
            [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]] && continue
            [[ -n "${seen[$pid]:-}" ]] && continue
            seen[$pid]=1
            if [[ -z "$proc" ]]; then
                proc="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
            fi
            proc="${proc:-未知}"
            printf '%s|%s|%s|%s|%s\n' "$pid" "$proto" "$state" "$local_addr" "$proc"
        done < <({
            ss -H -tulnp "( sport = :${port} )" 2>/dev/null || true
            if ! ss -H -tulnp "( sport = :${port} )" 2>/dev/null | grep -q .; then
                ss -H -tulnp 2>/dev/null | awk -v p=":${port}" \
                    '$2 ~ /^(LISTEN|UNCONN)$/ && ($4 ~ p "([^0-9]|$)" || $4 ~ "\\*" p "([^0-9]|$)") { print }' || true
            fi
            ss -H -tanp "( sport = :${port} or dport = :${port} )" 2>/dev/null || true
        } | sort -u)
    fi

    if command -v lsof >/dev/null 2>&1; then
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            proc="$(echo "$line" | awk '{print $1}')"
            pid="$(echo "$line" | awk '{print $2}')"
            proto="$(echo "$line" | awk '{print $8}')"
            local_addr="$(echo "$line" | awk '{print $9}')"
            state="LISTEN"
            [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]] && continue
            [[ -n "${seen[$pid]:-}" ]] && continue
            seen[$pid]=1
            proc="${proc:-未知}"
            printf '%s|%s|%s|%s|%s\n' "$pid" "$proto" "$state" "$local_addr" "$proc"
        done < <(
            lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1'
            lsof -nP -iUDP:"${port}" 2>/dev/null | awk 'NR>1'
            lsof -nP -i:"${port}" 2>/dev/null | awk 'NR>1'
            true
        )
    fi

    if [[ ${#seen[@]} -eq 0 ]] && command -v fuser >/dev/null 2>&1; then
        while IFS= read -r pid; do
            [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]] && continue
            [[ -n "${seen[$pid]:-}" ]] && continue
            seen[$pid]=1
            proc="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
            proc="${proc:-未知}"
            printf '%s|tcp|LISTEN|:%s|%s\n' "$pid" "$port" "$proc"
        done < <(fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true)
    fi
}

port_kill_one_pid() {
    local pid="$1"
    local name="${2:-}"

    if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
        error "呜哇！ 看不懂进程 ID: ${pid} 呀喵 (；´д｀)"
        return 1
    fi
    if [[ "$pid" -eq 1 ]]; then
        error "诶诶！ 拒绝杀掉 PID 1 (init/systemd) 喵～ (。•́︿•̀。)"
        return 1
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
        warn "小MK喵小声说：进程 ${pid} 已不存在 呀～ (,,>﹏<,,)"
        return 0
    fi

    info "诶嘿～ 正在结束进程 ${pid}${name:+ (${name})} 啦喵 (๑>◡<๑)"
    kill "$pid" 2>/dev/null || true
    sleep 0.4
    if kill -0 "$pid" 2>/dev/null; then
        warn "诶…… 进程未退出，发送 SIGKILL 咯喵 (´･ω･)"
        kill -9 "$pid" 2>/dev/null || true
        sleep 0.2
    fi
    if kill -0 "$pid" 2>/dev/null; then
        if mk_is_termux; then
            error "诶诶！ 没法结束进程 ${pid}：安卓只允许结束 Termux 自己的进程 呢喵 (｡•́︿•̀｡)"
        else
            error "呜哇！ 没法结束进程 ${pid}，可能需要 sudo mk 喵♪ (。•́︿•̀。)"
        fi
        return 1
    fi
    info "诶嘿～ 已结束进程 ${pid} 呀喵 (๑ᵕᴗᵕ๑)"
    return 0
}

# 序列号映射: 显示 1,3,4,5...（跳过 2）；2 固定表示全部杀掉
port_kill_seq_to_index() {
    local seq="$1"
    if [[ "$seq" == "1" ]]; then
        echo 0
        return 0
    fi
    if [[ "$seq" =~ ^[0-9]+$ ]] && (( seq >= 3 )); then
        echo $((seq - 2))
        return 0
    fi
    return 1
}

port_kill_index_to_seq() {
    local idx="$1"
    local seq=$((idx + 1))
    (( seq >= 2 )) && seq=$((seq + 1))
    echo "$seq"
}

port_kill_process_flow() {
    local port="" choice="" line="" i=0 seq="" idx=""
    local pid="" proto="" state="" addr="" proc=""
    local -a pids=() protos=() states=() addrs=() procs=()

    title "杀掉进程 咯喵 (๑ᵕᴗᵕ๑)"
    if mk_is_termux; then
        warn "呜喵… 安卓限制：只能结束 Termux 自己启动的进程，其他 App 的进程动不了 啦～ (；´д｀)"
    elif [[ $EUID -ne 0 ]]; then
        warn "小MK喵小声说：当前非 root，可能没法结束其他用户的进程（建议 sudo mk） 呀～ (｡•́︿•̀｡)"
    fi
    echo
    read -r -p "请输入嘛要清理的端口号 咯喵:" port
    port="${port//$'\r'/}"
    port="${port#"${port%%[![:space:]]*}"}"
    port="${port%"${port##*[![:space:]]}"}"

    if [[ -z "$port" ]]; then
        warn "小MK喵小声说：未输入端口 哇～ (´･ω･)"
        return 0
    fi
    if ! port_is_valid "$port"; then
        error "呜哇！ 看不懂端口: ${port} 啦喵 (；´д｀)"
        return 1
    fi

    while true; do
        pids=(); protos=(); states=(); addrs=(); procs=()
        while IFS='|' read -r pid proto state addr proc; do
            [[ -z "$pid" ]] && continue
            pids+=("$pid")
            protos+=("$proto")
            states+=("$state")
            addrs+=("$addr")
            procs+=("$proc")
        done < <(port_collect_port_procs "$port")

        title "端口 ${port} 占用进程 哦喵 (๑>◡<๑)"
        if [[ ${#pids[@]} -eq 0 ]]; then
            info "诶嘿～ 端口 ${port} 当前没有可识别的占用进程 呢喵 ✧٩(ˊωˋ*)و✧"
            if mk_is_termux; then
                echo "  提示: 安卓看不到其他 App 的进程，这里只统计 Termux 内的进程 喵♪ (๑ᵕᴗᵕ๑)"
            elif [[ $EUID -ne 0 ]]; then
                echo "  提示: 使用 sudo mk 可查看更多进程信息 啦喵 (๑>◡<๑)"
            fi
            return 0
        fi

        echo -e "  ${BOLD}序号  PID       协议        状态          地址                    进程 喵♪ (｡•̀ᴗ-)✧${NC}"
        echo "  --------------------------------------------------------------------------------"
        for i in "${!pids[@]}"; do
            seq="$(port_kill_index_to_seq "$i")"
            echo -e "  $(printf '%-4s' "[${seq}]")  $(printf '%-8s' "${pids[$i]}")  $(printf '%-10s' "$(port_translate_proto "${protos[$i]}")")  $(printf '%-12s' "$(port_translate_state "${states[$i]}")")  $(printf '%-22s' "${addrs[$i]}")  $(port_translate_process "${procs[$i]}")"
        done
        echo
        echo -e "  ${YELLOW}[2] 全部杀掉 喵♪ (๑>◡<๑)${NC}"
        echo "  输入上方序列号杀掉对应进程；输入 2 全部杀掉；输入 q 返回 喵～ (๑•̀ㅂ•́)و✧"
        echo

        read -r -p "请选择嘛 呀喵:" choice
        choice="$(normalize_choice "${choice:-}")"

        if [[ -z "$choice" || "$choice" == "q" || "$choice" == "Q" ]]; then
            return 0
        fi

        if [[ "$choice" == "2" ]]; then
            echo
            warn "诶…… 即将结束端口 ${port} 上的全部 ${#pids[@]} 个进程 咯喵 (´･ω･)"
            read -r -p "确认全部杀掉? 喵♪ (｡•́︿•̀｡) [y/N]: " choice
            choice="$(normalize_choice "${choice:-}")"
            if [[ "${choice,,}" != "y" && "${choice,,}" != "yes" ]]; then
                info "呐呐，已经取消啦 (｡•̀ᴗ-)✧"
                continue
            fi
            for i in "${!pids[@]}"; do
                port_kill_one_pid "${pids[$i]}" "${procs[$i]}" || true
            done
            echo
            info "诶嘿～ 已尝试结束全部进程，重新检测占用 哦喵 (๑>◡<๑)"
            sleep 0.3
            continue
        fi

        if idx="$(port_kill_seq_to_index "$choice")"; then
            if (( idx < 0 || idx >= ${#pids[@]} )); then
                warn "诶…… 序号不存在: ${choice} 哦喵 (。•́︿•̀。)"
                continue
            fi
            echo
            port_kill_one_pid "${pids[$idx]}" "${procs[$idx]}" || true
            echo
            info "呐呐，重新检测端口 ${port} 占用 啦喵 (๑•̀ㅂ•́)و✧"
            sleep 0.3
            continue
        fi

        warn "呜喵… 看不懂输入，请输入嘛列表中的序列号，或输入 2 全部杀掉 啦～ (；´д｀)"
    done
}

menu_port_verify() {
    while true; do
        title "端口验证 咯喵 (๑>◡<๑)"
        show_nav_hint
        echo "  [2] 扫描 mk 相关端口 (NapCat/咔咔珂/宝塔等，自动)"
        echo "  [3] 列出本机全部监听端口"
        echo "  [4] 杀掉进程 (按端口列出并可结束)"
        echo
        echo "  也可直接输入端口号 (任意 1-65535，支持多个) 呢喵:"
        echo "  示例: 8700  或  3001,8787,6099  或  8080 9000 咯喵 (๑•̀ㅂ•́)و✧"
        echo "  输入 q 返回上一步，0 返回首页 喵♪ ✧٩(ˊωˋ*)و✧"
        echo

        local port_input=""
        read -r -p "选项或端口号 呀喵:" port_input
        port_input="${port_input//$'\r'/}"
        port_input="${port_input#"${port_input%%[![:space:]]*}"}"
        port_input="${port_input%"${port_input##*[![:space:]]}"}"

        case "$port_input" in
            0) mk_nav_home; return 0 ;;
            q|Q) return 0 ;;
            "") warn "小MK喵小声说：请输入嘛选项或端口号 呀～ (´･ω･)"; continue ;;
            2) port_scan_mk_ports; press_enter ;;
            3) port_list_all_listeners; press_enter ;;
            4) port_kill_process_flow; press_enter ;;
            *)
                if [[ "$port_input" =~ ^[0-9]+$ ]] && port_is_valid "$port_input"; then
                    port_show_verify_report "$port_input"
                elif [[ "$port_input" =~ [0-9] ]]; then
                    port_verify_ports_input "$port_input"
                else
                    warn "呜喵… 看不懂输入，请输入嘛 [2]/[3]/[4]、端口号或多个端口 啦～ (´･ω･)"
                    continue
                fi
                press_enter
                ;;
        esac
    done
}

# ==================== 构建 MK 源码 (MKbot) ====================

readonly MKBOT_BUILD_LOG="${LOG_DIR}/mkbot-build.log"
readonly MKBOT_BUILD_PID="${LOG_DIR}/mkbot-build.pid"
readonly MKBOT_BUILD_START="${LOG_DIR}/mkbot-build.start"
readonly MKBOT_BUILD_SRC="${LOG_DIR}/mkbot-build.src"
readonly MKBOT_OUT_SUBDIR="napcat-plugin-mkbot"
readonly MKBOT_PANEL_LINES=9

mkbot_normalize_path() {
    local p="$1"
    p="${p//$'\r'/}"
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    if [[ "$p" == "~/"* ]]; then
        p="${HOME}/${p:2}"
    elif [[ "$p" == "~" ]]; then
        p="${HOME}"
    fi
    printf '%s' "$p"
}

mkbot_find_project_root() {
    local p="$1"
    p="${p%/}"
    [[ -n "$p" && -e "$p" ]] || return 1
    if [[ -f "${p}/package.json" && ( -f "${p}/vite.config.ts" || -f "${p}/vite.config.js" ) ]]; then
        echo "$p"
        return 0
    fi
    if [[ -f "${p}/MK/package.json" ]]; then
        echo "${p}/MK"
        return 0
    fi
    return 1
}

mkbot_resolve_node_bin() {
    kakake_resolve_node_bin
}

mkbot_node_version_ok() {
    local bin="$1" major=""
    [[ -n "$bin" && -x "$bin" ]] || return 1
    major="$("$bin" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 ))
}

mkbot_show_node_status() {
    local bin="" ver=""
    if bin="$(mkbot_resolve_node_bin 2>/dev/null)"; then
        ver="$("$bin" -v 2>/dev/null || echo unknown)"
        if mkbot_node_version_ok "$bin"; then
            echo -e "  ${GREEN}* Node.js ${ver} (满足构建要求 20+) 喵♪ ✧٩(ˊωˋ*)و✧${NC}"
        else
            echo -e "  ${YELLOW}* Node.js ${ver} (版本过低，需要 20+) 啦喵 (๑ᵕᴗᵕ๑)${NC}"
        fi
    else
        echo -e "  ${YELLOW}* Node.js 还没装呢 (构建需要 Node 20+) 呢喵 (๑•̀ㅂ•́)و✧${NC}"
    fi
}

mkbot_build_running() {
    if [[ ! -f "$MKBOT_BUILD_PID" ]]; then
        return 1
    fi
    local pid=""
    pid="$(tr -d '[:space:]' < "$MKBOT_BUILD_PID" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

mkbot_get_build_start_time() {
    local ts=""
    if [[ -f "$MKBOT_BUILD_START" ]]; then
        ts="$(tr -d '[:space:]' < "$MKBOT_BUILD_START" 2>/dev/null || true)"
        [[ "$ts" =~ ^[0-9]+$ ]] && echo "$ts" && return 0
    fi
    echo "$(date +%s)"
}

mkbot_collect_build_log() {
    [[ -f "$MKBOT_BUILD_LOG" ]] && cat "$MKBOT_BUILD_LOG" 2>/dev/null || true
}

mkbot_detect_build_progress() {
    local content="$1"
    local stage="准备中" percent=5 state="running"

    if echo "$content" | grep -q '\[MK-MKBOT-ERROR\]'; then
        stage="$(echo "$content" | grep '\[MK-MKBOT-ERROR\]' | tail -1 | sed 's/.*\[MK-MKBOT-ERROR\] //')"
        echo "failed|${stage}|0"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-MKBOT-DONE\]'; then
        echo "100|构建完成|100"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-MKBOT-STEP\] 4/4'; then
        echo "running|收尾|92"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-MKBOT-STEP\] 3/4'; then
        echo "running|编译构建 (vite)|65"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-MKBOT-STEP\] 2/4'; then
        echo "running|安装依赖|35"
        return 0
    fi
    if echo "$content" | grep -q '\[MK-MKBOT-STEP\] 1/4'; then
        echo "running|检查源码|12"
        return 0
    fi
    echo "running|${stage}|${percent}"
}

mkbot_panel_cursor_up() {
    local i=0
    for ((i=0; i<MKBOT_PANEL_LINES; i++)); do
        printf '%s' $'\033[1A\033[2K'
    done
}

mkbot_draw_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"
    local src="" out=""

    src="$(cat "$MKBOT_BUILD_SRC" 2>/dev/null || echo 未知)"
    out="${src%/}/${MKBOT_OUT_SUBDIR}"

    echo "--------------------------------------"
    echo "  MKbot 源码构建 呀喵 (｡•̀ᴗ-)✧"
    echo "--------------------------------------"
    echo "  源码目录: ${src}"
    echo "  当前步骤: ${stage}"
    printf '  进度: '
    baota_make_bar "$percent"
    echo
    echo "  已用时间: ${elapsed} 秒    状态: ${spin} 运行中"
    echo "  成品目录: ${out}"
    echo "--------------------------------------"
}

mkbot_show_build_errors() {
    local content=""
    content="$(mkbot_collect_build_log)"
    echo
    error "呜哇！ 编译翻车了喵，关键出错信息 咯喵:"
    echo "$content" | grep -E '\[MK-MKBOT-ERROR\]|npm ERR!| ELIFECYCLE |Error:|error TS|command not found' | tail -20 || true
    echo
    info "诶嘿～ 完整日志: ${MKBOT_BUILD_LOG} 啦喵 (๑>◡<๑)"
}

mkbot_watch_build() {
    local last_percent=-1 spinner=('|' '/' '-' '+') spin_idx=0
    local result="" stage="" percent=0 state=""
    local start_ts="" now_ts="" elapsed=0 panel_active=0

    if ! mkbot_build_running; then
        warn "呜喵… 当前没有进行中的构建任务 呢～ (｡•́︿•̀｡)"
        return 1
    fi

    start_ts="$(mkbot_get_build_start_time)"
    echo
    info "正在构建 MK 插件源码 (后台进程 $(cat "$MKBOT_BUILD_PID" 2>/dev/null || echo ?))"
    info "诶嘿～ 日志: ${MKBOT_BUILD_LOG} 呀喵 (๑ᵕᴗᵕ๑)"
    echo

    trap 'echo; info "小MK喵：已退出进度显示，构建仍在后台继续 哦～ (๑•̀ㅂ•́)و✧"; trap - INT; return 0' INT

    while mkbot_build_running; do
        local content=""
        content="$(mkbot_collect_build_log)"
        result="$(mkbot_detect_build_progress "$content")"
        IFS='|' read -r state stage percent <<< "$result"

        if [[ "$state" == "failed" ]]; then
            trap - INT
            if (( panel_active == 1 )); then mkbot_panel_cursor_up; fi
            mkbot_show_build_errors
            return 1
        fi

        (( percent < last_percent )) && percent=$last_percent || last_percent=$percent
        now_ts=$(date +%s)
        elapsed=$(( now_ts - start_ts ))
        spin_idx=$(( (spin_idx + 1) % 4 ))
        (( panel_active == 1 )) && mkbot_panel_cursor_up
        mkbot_draw_progress_panel "$percent" "$stage" "$elapsed" "${spinner[$spin_idx]}"
        panel_active=1

        [[ "$state" == "100" || "$percent" -ge 100 ]] && break
        sleep 1
    done

    trap - INT

    local final="" src="" out=""
    final="$(mkbot_collect_build_log)"
    result="$(mkbot_detect_build_progress "$final")"
    IFS='|' read -r state stage percent <<< "$result"

    if [[ "$state" != "100" && "$state" != "failed" ]]; then
        if echo "$final" | grep -q '\[MK-MKBOT-DONE\]'; then
            state="100"
            stage="构建完成"
            percent=100
        else
            state="failed"
            stage="构建异常结束"
        fi
    fi

    if [[ "$state" == "failed" ]]; then
        (( panel_active == 1 )) && mkbot_panel_cursor_up
        mkbot_show_build_errors
        return 1
    fi

    if (( panel_active == 1 )); then mkbot_panel_cursor_up; fi
    mkbot_draw_progress_panel 100 "构建完成" "$elapsed" "OK"
    echo

    src="$(cat "$MKBOT_BUILD_SRC" 2>/dev/null || true)"
    out="${src%/}/${MKBOT_OUT_SUBDIR}"
    if [[ -d "$out" && -f "${out}/index.mjs" ]]; then
        info "呐呐，构建成功 啦喵 (｡•̀ᴗ-)✧"
        echo "  成品目录: ${out} 哦喵 (๑>◡<๑)"
        echo "  入口文件: ${out}/index.mjs 呀喵 (๑•̀ㅂ•́)و✧"
        echo "  插件清单: ${out}/plugin.json 呢喵 ✧٩(ˊωˋ*)و✧"
        echo
        info "喵～ 可将 ${MKBOT_OUT_SUBDIR} 目录部署到 NapCat/咔咔珂 插件目录 咯～ (๑ᵕᴗᵕ๑)"
    else
        warn "呜喵… 构建进程已结束，但没找到预期成品目录 啦～ (｡•́︿•̀｡)"
        info "呐呐，帮忙检查一下: ${MKBOT_BUILD_LOG} 哦喵 (๑•̀ㅂ•́)و✧"
        return 1
    fi
    return 0
}

mkbot_start_build() {
    local src_root="$1"
    local node_bin="" node_path=""

    if mkbot_build_running; then
        warn "呜喵… 已有构建任务进行中 啦～ (。•́︿•̀。)"
        mkbot_watch_build
        return $?
    fi

    node_bin="$(mkbot_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        error "诶诶！ 没找到 Node.js，请先「安装 Node.js」(需要 20+) 喵♪ (´･ω･)"
        return 1
    fi
    if ! mkbot_node_version_ok "$node_bin"; then
        error "Node.js 版本过低: $("$node_bin" -v 2>/dev/null || echo 未知)，构建需要 20+"
        return 1
    fi

    node_path="$(dirname "$node_bin")"
    mkdir -p "$LOG_DIR"
    : > "$MKBOT_BUILD_LOG"
    date +%s > "$MKBOT_BUILD_START"
    echo "$src_root" > "$MKBOT_BUILD_SRC"

    info "呐呐，开始构建: ${src_root} 喵♪ ₍˄·͈༝·͈˄₎"

    nohup env MKBOT_SRC="$src_root" MKBOT_NODE_BIN="$node_bin" MKBOT_LOG="$MKBOT_BUILD_LOG" \
        MKBOT_OUT="$MKBOT_OUT_SUBDIR" bash -s >> "$MKBOT_BUILD_LOG" 2>&1 << 'MKBUILDEOF' &
set -u
log_step() { echo "[MK-MKBOT-STEP] $1"; }
log_err()  { echo "[MK-MKBOT-ERROR] $1"; }

SRC="${MKBOT_SRC:?}"
NODE_BIN="${MKBOT_NODE_BIN:?}"
LOG="${MKBOT_LOG:?}"
OUT_NAME="${MKBOT_OUT:-napcat-plugin-mkbot}"
export PATH="$(dirname "$NODE_BIN"):${PATH}"

log_step "1/4 检查源码"
cd "$SRC" || { log_err "无法进入目录: ${SRC}"; exit 1; }
if [[ ! -f package.json ]]; then
    log_err "缺少 package.json，请确认 MK 插件源码路径"
    exit 1
fi

log_step "2/4 安装依赖"
if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    if [[ -f pnpm-lock.yaml ]]; then
        corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
    fi
fi
if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1 || { log_err "pnpm install 失败"; exit 1; }
else
    npm install 2>&1 || { log_err "npm install 失败"; exit 1; }
    if ! command -v pnpm >/dev/null 2>&1; then
        npm install -g pnpm 2>&1 || npm install pnpm 2>&1 || true
    fi
fi

log_step "3/4 编译构建"
if command -v pnpm >/dev/null 2>&1; then
    pnpm run build 2>&1 || { log_err "pnpm run build 失败"; exit 1; }
else
    npm run build 2>&1 || { log_err "npm run build 失败"; exit 1; }
fi

log_step "4/4 完成"
if [[ ! -f "${SRC}/${OUT_NAME}/index.mjs" ]]; then
    log_err "未找到成品 ${OUT_NAME}/index.mjs"
    exit 1
fi
echo "[MK-MKBOT-DONE] ${SRC}/${OUT_NAME}"
MKBUILDEOF
    echo $! > "$MKBOT_BUILD_PID"
    sleep 1
    mkbot_watch_build
}

mkbot_prompt_and_build() {
    local raw="" src_root=""

    echo
    read -r -p "MK 插件源码路径 (含 package.json 的目录) 呀喵:" raw
    raw="$(mkbot_normalize_path "$raw")"
    [[ -n "$raw" ]] || {
        warn "呜喵… 路径不能为空 啦～ (,,>﹏<,,)"
        return 0
    }

    if ! src_root="$(mkbot_find_project_root "$raw")"; then
        error "小MK喵吓一跳！ 未识别为 MKbot 源码目录: ${raw} 哇～ (,,>﹏<,,)"
        echo "  请指向解压后的 MK 目录 (含 package.json 与 vite.config.ts) 咯喵 (๑>◡<๑)"
        echo "  若解压为 MKbot.zip/MK/ 则路径可填上级或 MK 子目录 喵♪ (๑•̀ㅂ•́)و✧"
        return 1
    fi

    if [[ "$src_root" != "$raw" ]]; then
        info "诶嘿～ 已识别源码根目录: ${src_root} 呢喵 (๑>◡<๑)"
    fi

    mkbot_start_build "$src_root"
}

menu_mkbot_build() {
    while true; do
        title "构建 MK 源码 咯喵 ✧٩(ˊωˋ*)و✧"
        show_nav_hint
        echo "  [2] 安装 Node.js (构建需要 20+，与咔咔珂共用)"
        echo "  [3] 卸载 Node.js"
        echo "  [4] 输入源码路径并开始构建"
        if mkbot_build_running; then
            echo "  [5] 查看构建进度"
        fi
        echo
        mkbot_show_node_status
        if mkbot_build_running; then
            echo -e "  ${YELLOW}* 正在后台努力编译 哦喵 (๑•̀ㅂ•́)و✧${NC}"
        fi
        echo

        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) kakake_node_install || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            3) kakake_node_uninstall; press_enter ;;
            4) mkbot_prompt_and_build; press_enter ;;
            5)
                if mkbot_build_running; then
                    mkbot_watch_build
                    press_enter
                else
                    warn "诶…… 当前没有构建任务 哦喵 (；´д｀)"
                fi
                ;;
            *) warn "诶…… 看不懂选项，请重新输入 咯喵 (,,>﹏<,,)" ;;
        esac
    done
}

kakake_conn_is_connected() {
    local enable="$1" category="$2" addr="$3"
    local host="" port="" parsed=""

    [[ "$enable" == "true" ]] || return 1
    kakake_is_running || return 1
    case "$category" in
        onebot:reverse)
            port="${addr##*:}"
            kakake_reverse_ws_has_client "$port"
            ;;
        onebot:forward)
            parsed="$(kakake_parse_ws_target "$addr")"
            host="${parsed%% *}"
            port="${parsed##* }"
            kakake_forward_ws_has_session "$host" "$port"
            ;;
        qq_official)
            kakake_qq_official_has_session
            ;;
        *)
            return 1
            ;;
    esac
}

kakake_has_any_connected() {
    local idx="" enable="" addr="" cat="" _label="" _name=""

    kakake_is_running || return 1
    while IFS=$'\t' read -r idx _label _name addr enable cat; do
        if kakake_conn_is_connected "$enable" "$cat" "$addr"; then
            return 0
        fi
    done < <(kakake_cfg_tool list 2>/dev/null || true)
    return 1
}

autostart_unit_enabled() {
    local unit="$1"
    systemctl is-enabled --quiet "$unit" 2>/dev/null
}

autostart_unit_failed() {
    local unit="$1" state=""
    # Termux 没有 systemd，也就没有 failed 状态
    mk_is_termux && return 1
    state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
    [[ "$state" == "failed" ]]
}

# Termux:Boot 开机脚本路径（~/.termux/boot/20-kakake.sh）
termux_boot_script_path() {
    printf '%s/%s' "$TERMUX_BOOT_DIR" "$TERMUX_BOOT_KAKAKE"
}

termux_boot_installed() {
    [[ -f "$(termux_boot_script_path)" ]]
}

autostart_napcat_enabled() {
    # NapCat 需要 X11 + root，手机上装不了，自启也就无从谈起
    mk_is_termux && return 1
    autostart_unit_enabled "$AUTOSTART_NAPCAT_UNIT"
}

autostart_kakake_enabled() {
    if mk_is_termux; then
        termux_boot_installed
        return $?
    fi
    autostart_unit_enabled "$AUTOSTART_KAKAKE_UNIT"
}

autostart_napcat_status_colored() {
    if ! napcat_is_installed; then
        echo -e "${NC}还没装呢 (๑ᵕᴗᵕ๑)${NC}"
        return
    fi
    if ! autostart_napcat_enabled; then
        echo -e "${NC}还没打开呢 ✧٩(ˊωˋ*)و✧${NC}"
        return
    fi
    if napcat_is_running; then
        echo -e "${GREEN}运行中 呀喵 (๑>◡<๑)${NC}"
        return
    fi
    if autostart_unit_failed "$AUTOSTART_NAPCAT_UNIT"; then
        echo -e "${RED}启动失败了喵 (๑ᵕᴗᵕ๑)${NC}"
        return
    fi
    echo -e "${RED}没在跑呢 (๑•̀ㅂ•́)و✧${NC}"
}

autostart_kakake_status_colored() {
    if ! kakake_is_installed; then
        echo -e "${NC}还没装呢 (๑>◡<๑)${NC}"
        return
    fi
    if ! autostart_kakake_enabled; then
        echo -e "${NC}还没打开呢 (๑ᵕᴗᵕ๑)${NC}"
        return
    fi
    if kakake_http_alive "$(kakake_get_admin_port)"; then
        if kakake_has_any_connected; then
            echo -e "${GREEN}运行中 呀喵 ₍˄·͈༝·͈˄₎${NC}"
        else
            echo -e "${YELLOW}没有连上的客户端 咯喵 (｡•̀ᴗ-)✧${NC}"
        fi
        return
    fi
    if kakake_has_process || kakake_port_listening "$(kakake_get_admin_port)"; then
        echo -e "${RED}被别的东西占着 呀喵 (๑ᵕᴗᵕ๑)${NC}"
        return
    fi
    if autostart_unit_failed "$AUTOSTART_KAKAKE_UNIT"; then
        echo -e "${RED}启动失败了喵 ✧٩(ˊωˋ*)و✧${NC}"
        return
    fi
    echo -e "${RED}没在跑呢 (｡•̀ᴗ-)✧${NC}"
}

autostart_napcat_disable() {
    mk_is_termux && return 0
    require_root || return 1
    systemctl stop "$AUTOSTART_NAPCAT_UNIT" >/dev/null 2>&1 || true
    systemctl disable "$AUTOSTART_NAPCAT_UNIT" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${AUTOSTART_NAPCAT_UNIT}"
    systemctl daemon-reload >/dev/null 2>&1 || true
}

autostart_kakake_disable() {
    # Termux：删掉 Termux:Boot 里的开机脚本即可，不需要 root
    if mk_is_termux; then
        rm -f "$(termux_boot_script_path)" 2>/dev/null || true
        return 0
    fi
    require_root || return 1
    systemctl stop "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
    systemctl disable "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${AUTOSTART_KAKAKE_UNIT}"
    systemctl daemon-reload >/dev/null 2>&1 || true
}

autostart_napcat_enable() {
    local run_user="" run_home=""

    mk_require_server "NapCat 需要 root + Xvfb 图形环境，手机上无法运行" || return 1
    require_root || return 1
    if ! napcat_is_installed; then
        error "呜哇！ NapCat 还没装呢，请先安装框架 喵♪ (,,>﹏<,,)"
        return 1
    fi
    napcat_detect_paths || return 1
    if ! napcat_ensure_xvfb; then
        error "小MK喵吓一跳！ 少了 xvfb-run，没法配置 NapCat 开机自启 哇～ (,,>﹏<,,)"
        return 1
    fi

    run_user="$(id -un)"
    run_home="$HOME"
    mkdir -p "$LOG_DIR"

    cat > "/etc/systemd/system/${AUTOSTART_NAPCAT_UNIT}" <<EOF
[Unit]
Description=NapCat autostart (mk)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
Environment=HOME=${run_home}
WorkingDirectory=${run_home}
ExecStartPre=/bin/mkdir -p ${LOG_DIR}
ExecStart=/usr/bin/xvfb-run -a ${NAPCAT_QQ_BIN} --no-sandbox
ExecStop=/bin/bash -c 'pkill -f "Napcat/opt/QQ/qq" 2>/dev/null || true; pkill -f "/opt/QQ/qq" 2>/dev/null || true; rm -f ${NAPCAT_PID_FILE} 2>/dev/null || true'
StandardOutput=append:${NAPCAT_LOG}
StandardError=append:${NAPCAT_LOG}
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "$AUTOSTART_NAPCAT_UNIT" >/dev/null
    systemctl reset-failed "$AUTOSTART_NAPCAT_UNIT" >/dev/null 2>&1 || true
    systemctl restart "$AUTOSTART_NAPCAT_UNIT"
    sleep 2

    if napcat_is_running; then
        systemctl reset-failed "$AUTOSTART_NAPCAT_UNIT" >/dev/null 2>&1 || true
        info "喵～ NapCat 开机自启已经打开啦，当前运行中 呀～ ✧٩(ˊωˋ*)و✧"
        napcat_open_port_6099
        return 0
    fi
    if autostart_unit_failed "$AUTOSTART_NAPCAT_UNIT"; then
        error "诶诶！ NapCat 开机自启已写入，但启动失败了喵，看看: ${NAPCAT_LOG} 喵♪ (｡•́︿•̀｡)"
        journalctl -u "$AUTOSTART_NAPCAT_UNIT" -n 10 --no-pager 2>/dev/null || true
        return 1
    fi
    warn "小MK喵小声说：NapCat 开机自启已经打开啦，服务正在拉起中 哇～ (´･ω･)"
}

# Termux 版「开机自启」：安卓没有 systemd，靠 Termux:Boot 应用在开机时
# 执行 ~/.termux/boot/ 下的脚本，效果等价于一个极简的 service。
autostart_kakake_enable_termux() {
    local node_bin="" node_path="" entry="" boot_script=""

    if ! kakake_is_installed; then
        error "小MK喵吓一跳！ 咔咔珂还没装呢，请先安装咔咔珂 呀～ (；´д｀)"
        return 1
    fi
    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
        error "诶诶！ 没找到 Node.js，请先「安装 Node.js」 呀喵 (；´д｀)"
        return 1
    fi

    node_path="$(dirname "$node_bin")"
    entry="$(kakake_server_entry)"
    boot_script="$(termux_boot_script_path)"
    mkdir -p "$TERMUX_BOOT_DIR" "$LOG_DIR"

    # 开机时没有登录 shell，PATH 必须自己写全，node 也用绝对路径
    cat > "$boot_script" <<EOF
#!${TERMUX_PREFIX}/bin/sh
# 由 mk v${MK_VERSION} 生成：咔咔珂开机自启（Termux:Boot）
# 删除本文件即可关闭自启，或在 mk 菜单「开机自启」里再点一次

# 拿唤醒锁，否则安卓会在锁屏后冻结进程
termux-wake-lock 2>/dev/null || true

export PATH="${node_path}:${TERMUX_PREFIX}/bin:\$PATH"
export HOME="${HOME}"
export TMPDIR="${MK_TMP}"

mkdir -p "${LOG_DIR}"
cd "${KAKAKE_HOME}" || exit 1

echo "===== Kakake boot \$(date '+%Y-%m-%d %H:%M:%S') (Termux:Boot) =====" >> "${KAKAKE_LOG}"
nohup "${node_bin}" "${entry}" >> "${KAKAKE_LOG}" 2>&1 &
echo \$! > "${KAKAKE_PID_FILE}"
EOF

    chmod 700 "$boot_script"

    info "呐呐，咔咔珂开机自启已经打开啦（Termux:Boot） 喵～ ₍˄·͈༝·͈˄₎"
    echo
    echo "  自启脚本: ${boot_script} 哦喵 (｡•̀ᴗ-)✧"
    echo "  运行日志: ${KAKAKE_LOG} 呀喵 (๑>◡<๑)"
    echo
    warn "小MK喵小声说：开机自启还需要满足下面 3 个条件，缺一个就不会生效 呀～："
    echo "  1) 已安装 Termux:Boot 应用（与 Termux 同一来源，F-Droid 或 GitHub） 喵♪ ₍˄·͈༝·͈˄₎"
    echo "  2) 装好后手动打开过一次 Termux:Boot（不打开不会注册开机广播） 喵～ (๑ᵕᴗᵕ๑)"
    echo "  3) 系统设置里给 Termux / Termux:Boot 关闭电池优化、允许自启动 啦喵 (｡•̀ᴗ-)✧"
    echo
    if ! kakake_http_alive "$(kakake_get_admin_port)"; then
        info "诶嘿～ 当前咔咔珂没在跑呢，是否立即启动一次？ 呢喵 ✧٩(ˊωˋ*)و✧"
        local now=""
        read -r -p "现在启动? 喵♪ (；´д｀) [Y/n]: " now
        if [[ ! "$now" =~ ^[Nn]$ ]]; then
            kakake_start || return 1
        fi
    else
        info "小MK喵：咔咔珂当前已在运行 呢～ ₍˄·͈༝·͈˄₎"
    fi
    return 0
}

autostart_kakake_enable() {
    local run_user="" run_home="" node_bin="" node_path="" entry=""

    if mk_is_termux; then
        autostart_kakake_enable_termux
        return $?
    fi

    require_root || return 1
    if ! kakake_is_installed; then
        error "呜哇！ 咔咔珂还没装呢，请先安装咔咔珂 咯喵 (；´д｀)"
        return 1
    fi
    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
        if kakake_is_portable; then
            error "呜哇！ 便携版少了 runtime/bin/node 呢喵 (´･ω･)"
        else
            error "小MK喵吓一跳！ 没找到 Node.js，请先安装 Node.js 呀～ (,,>﹏<,,)"
        fi
        return 1
    fi

    run_user="$(id -un)"
    run_home="$HOME"
    node_path="$(dirname "$node_bin")"
    entry="$(kakake_server_entry)"
    mkdir -p "$LOG_DIR"
    if [[ -f "${KAKAKE_HOME}/runtime/bin/node" ]]; then
        chmod +x "${KAKAKE_HOME}/runtime/bin/node" 2>/dev/null || true
    fi

    cat > "/etc/systemd/system/${AUTOSTART_KAKAKE_UNIT}" <<EOF
[Unit]
Description=Kakake autostart (mk)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
Environment=HOME=${run_home}
Environment=PATH=${node_path}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=${KAKAKE_HOME}
ExecStartPre=/bin/mkdir -p ${LOG_DIR}
ExecStart=${node_bin} ${entry}
ExecStop=/bin/bash -c 'pkill -f "${KAKAKE_HOME}/scripts/bootstrap.mjs" 2>/dev/null || true; pkill -f "${KAKAKE_HOME}/packages/server/main.mjs" 2>/dev/null || true; pkill -f "${KAKAKE_HOME}.*src/main.ts" 2>/dev/null || true; rm -f ${KAKAKE_PID_FILE} 2>/dev/null || true'
StandardOutput=append:${KAKAKE_LOG}
StandardError=append:${KAKAKE_LOG}
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "$AUTOSTART_KAKAKE_UNIT" >/dev/null
    systemctl reset-failed "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
    if kakake_http_alive "$(kakake_get_admin_port)" || kakake_has_process; then
        kakake_stop || true
        sleep 1
    fi
    systemctl restart "$AUTOSTART_KAKAKE_UNIT"
    sleep 3

    if kakake_http_alive "$(kakake_get_admin_port)"; then
        systemctl reset-failed "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
        info "诶嘿～ 咔咔珂开机自启已经打开啦，当前运行中 ($(kakake_edition_label)) 喵～ (๑ᵕᴗᵕ๑)"
        kakake_open_admin_port
        kakake_show_login_info
        return 0
    fi
    if kakake_has_process; then
        warn "诶…… 咔咔珂开机自启已经打开啦，进程在拉起中（可能正在编译），等小MK一下下查看日志: ${KAKAKE_LOG} 喵♪ (。•́︿•̀。)"
        return 0
    fi
    if autostart_unit_failed "$AUTOSTART_KAKAKE_UNIT"; then
        error "小MK喵吓一跳！ 咔咔珂开机自启已写入，但启动失败了喵，看看: ${KAKAKE_LOG} 呀～ (,,>﹏<,,)"
        journalctl -u "$AUTOSTART_KAKAKE_UNIT" -n 10 --no-pager 2>/dev/null || true
        return 1
    fi
    warn "呜喵… 咔咔珂开机自启已经打开啦，服务正在拉起中 啦～ (｡•́︿•̀｡)"
}

autostart_toggle_napcat() {
    if autostart_napcat_enabled; then
        autostart_napcat_disable
        info "诶嘿～ NapCat 开机自启已关闭 喵♪ (๑>◡<๑)"
        return 0
    fi
    autostart_napcat_enable
}

autostart_toggle_kakake() {
    if autostart_kakake_enabled; then
        autostart_kakake_disable
        info "呐呐，咔咔珂开机自启已关闭 啦喵 ₍˄·͈༝·͈˄₎"
        return 0
    fi
    autostart_kakake_enable
}

menu_autostart() {
    while true; do
        title "开机自启 哦喵 (｡•̀ᴗ-)✧"
        show_nav_hint
        if mk_is_termux; then
            echo -e "  [2] kakake开机自启   $(autostart_kakake_status_colored)"
            echo
            echo "  当前环境: $(mk_platform_label) · 无 systemd，自启由 Termux:Boot 承担 喵～ (๑ᵕᴗᵕ๑)"
            echo "  选择 [2] 开启/关闭（已开启时再次选择则关闭） 啦喵 (｡•̀ᴗ-)✧"
            echo "  NapCat 自启仅限 Linux 服务器，手机上不提供 哦喵 (๑>◡<๑)"
        else
            echo -e "  [1] NapCat开机自启  $(autostart_napcat_status_colored)"
            echo -e "  [2] kakake开机自启   $(autostart_kakake_status_colored)"
            echo
            echo "  选择序号开启/关闭自启（已开启时再次选择则关闭） 喵～ (｡•̀ᴗ-)✧"
        fi
        echo "  颜色: 白=未开启  绿=运行中  红=失败  黄=咔咔珂没有连上的客户端 哦喵 (๑•̀ㅂ•́)و✧"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1)
                if mk_is_termux; then
                    warn "诶…… 手机上没有 NapCat 自启，请选 [2] 呢喵 (,,>﹏<,,)"
                else
                    autostart_toggle_napcat || true
                    press_enter
                fi
                ;;
            2) autostart_toggle_kakake || true; press_enter ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (；´д｀)" ;;
        esac
    done
}

menu_uninstall() {
    title "卸载 mk 工具 呀喵 (｡•̀ᴗ-)✧"
    echo "  此操作将移除 mk 全局命令及安装文件 呢喵 (๑>◡<๑)"
    echo "  宝塔面板本身不会被卸载 咯喵 (๑•̀ㅂ•́)و✧"
    echo
    uninstall_self
    press_enter
    exit 0
}

menu_main() {
    while true; do
        title "MK 工具 - 主菜单 v${MK_VERSION}"
        if mk_is_termux; then
            # 手机上把仅限服务器的项标灰，点进去会给出原因而不是直接报错
            echo "  [1] 宝塔操作        (仅服务器)"
            echo "  [2] NapCat操作      (仅服务器)"
            echo "  [3] snowLuma操作    (仅服务器)"
            echo "  [4] 咔咔珂操作"
            echo "  [5] 端口验证"
            echo "  [6] 构建 MK 源码"
            echo "  [7] 实验功能        (仅服务器)"
            echo "  [8] 卸载 mk 工具"
            echo "  [9] 开机自启        (Termux:Boot)"
            echo "  [10] 字体包操作     (仅服务器)"
            echo "  [11] 检查脚本更新"
            echo "  [0] 退出"
            echo
            echo "  运行环境: $(mk_platform_label)"
        else
            echo "  [1] 宝塔操作"
            echo "  [2] NapCat操作"
            echo "  [3] snowLuma操作"
            echo "  [4] 咔咔珂操作"
            echo "  [5] 端口验证"
            echo "  [6] 构建 MK 源码"
            echo "  [7] 实验功能"
            echo "  [8] 卸载 mk 工具"
            echo "  [9] 开机自启"
            echo "  [10] 字体包操作"
            echo "  [11] 检查脚本更新"
            echo "  [0] 退出"
        fi
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            1) mk_require_server "宝塔面板需要 root 与系统级服务，安卓上无法安装" || continue
               menu_baota ;;
            2) mk_require_server "NapCat 依赖 root + Xvfb 图形环境，安卓上无法安装" || continue
               menu_napcat ;;
            3) mk_require_server "snowLuma 依赖 VNC/X11 桌面环境，安卓上无法安装" || continue
               menu_snowluma || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            4) menu_kakake || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            5) menu_port_verify || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            6) menu_mkbot_build || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            7) mk_require_server "实验魔改改的是 NapCat 安装目录，手机上没有 NapCat" || continue
               menu_experimental || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            8) menu_uninstall ;;
            9) menu_autostart || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            10) mk_require_server "字体包要写入系统字体目录并刷新 fontconfig，需要 root" || continue
               menu_fonts || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            11) menu_self_update || true ;;
            0) info "诶嘿～ 再见 喵～ (๑ᵕᴗᵕ๑)"; exit 0 ;;
            *) warn "小MK喵小声说：看不懂选项，请重新输入 哇～ (｡•́︿•̀｡)" ;;
        esac
    done
}

main() {
    case "${1:-}" in
        --install|-i)
            title "MK 工具 - 强制安装/更新 哦喵 (๑•̀ㅂ•́)و✧"
            install_self
            ;;
        --uninstall|-u)
            title "MK 工具 - 卸载 喵♪ (｡•̀ᴗ-)✧"
            uninstall_self
            ;;
        --check|-c)
            syntax_check "$SELF_PATH"
            info "喵～ 语法检查通过 咯～ (๑ᵕᴗᵕ๑)"
            ;;
        --version|-v)
            echo "mk 版本: ${MK_VERSION} 喵～ (๑•̀ㅂ•́)و✧"
            echo "运行平台: $(mk_platform_label) 啦喵 ✧٩(ˊωˋ*)و✧"
            echo "安装目录: ${INSTALL_DIR} 哦喵 ₍˄·͈༝·͈˄₎"
            ;;
        --help|-h)
            echo "用法 咯喵:"
            echo "  mk / MK / Mk / mK  打开交互菜单（字母大小写均可） 喵♪ (๑•̀ㅂ•́)و✧"
            if mk_is_termux; then
                echo "  bash mk           首次安装/更新（Termux 免 sudo） 啦喵 ₍˄·͈༝·͈˄₎"
            else
                echo "  sudo bash mk      首次安装/更新 呀喵 (｡•̀ᴗ-)✧"
            fi
            echo "  mk --install      强制重装/更新 咯喵 (๑•̀ㅂ•́)و✧"
            echo "  mk --uninstall    卸载 mk 工具 喵♪ ✧٩(ˊωˋ*)و✧"
            echo "  mk --check        语法检查 喵～ ₍˄·͈༝·͈˄₎"
            echo "  mk --version      查看版本 啦喵 (๑ᵕᴗᵕ๑)"
            echo "  mk --patch-all            应用全部实验魔改 哦喵 (｡•̀ᴗ-)✧"
            echo
            echo "当前平台: $(mk_platform_label) 呢喵 (๑•̀ㅂ•́)و✧"
            if mk_is_termux; then
                echo "手机可用: 咔咔珂操作 / 端口验证 / 构建 MK 源码 / 开机自启(Termux:Boot) 喵♪ ₍˄·͈༝·͈˄₎"
                echo "手机不可用: 宝塔 / NapCat / snowLuma / 实验魔改 / 字体包（需 root 或图形环境） 喵～ (๑ᵕᴗᵕ๑)"
            fi
            ;;
        --patch-all)
            if mk_is_termux; then
                error "呜哇！ 实验魔改改的是 NapCat 安装目录，Termux 上没有 NapCat 咯喵 (,,>﹏<,,)"
                exit 1
            fi
            if [[ "$SELF_PATH" != "${INSTALL_DIR}/${SCRIPT_FILE}" ]]; then
                auto_install_if_needed
            fi
            napcat_mod_apply_all
            ;;
        "")
            if [[ "$SELF_PATH" != "${INSTALL_DIR}/${SCRIPT_FILE}" ]]; then
                auto_install_if_needed
            fi
            menu_main
            ;;
        *)
            error "呜哇！ 未知参数: $1 喵♪ (,,>﹏<,,)"
            echo "使用 mk --help 查看帮助 喵～ (๑•̀ㅂ•́)و✧"
            exit 1
            ;;
    esac
}

main "$@"
: <<'__MK_EMBEDDED_PATCHES__'
__MK_EMBED_FILE__:import_reload.snippet.js__
Y29uc3QgX25hcFBsZ0ltcG9ydERpc2tTdG9yYWdlID0gZHMuZGlza1N0b3JhZ2UoewogIGRlc3Rp
bmF0aW9uOiAodCwgZSwgbikgPT4gewogICAgbihudWxsLCBwRik7CiAgfSwKICBmaWxlbmFtZTog
KHQsIGUsIG4pID0+IHsKICAgIG4obnVsbCwgRGF0ZS5ub3coKSArICItIiArIGUub3JpZ2luYWxu
YW1lKTsKICB9Cn0pLCBfbmFwUGxnSW1wb3J0VXBsb2FkID0gZHMoewogIHN0b3JhZ2U6IF9uYXBQ
bGdJbXBvcnREaXNrU3RvcmFnZSwKICBsaW1pdHM6IHsKICAgIGZpbGVTaXplOiA1MCAqIDEwMjQg
KiAxMDI0CiAgfSwKICBmaWxlRmlsdGVyOiAodCwgZSwgbikgPT4gewogICAgZS5taW1ldHlwZSA9
PT0gImFwcGxpY2F0aW9uL3ppcCIgfHwgZS5taW1ldHlwZSA9PT0gImFwcGxpY2F0aW9uL3gtemlw
LWNvbXByZXNzZWQiIHx8IGUub3JpZ2luYWxuYW1lLmVuZHNXaXRoKCIuemlwIikgPyBuKG51bGws
ICEwKSA6IG4obmV3IEVycm9yKCJPbmx5IC56aXAgZmlsZXMgYXJlIGFsbG93ZWQiKSk7CiAgfQp9
KS5zaW5nbGUoInBsdWdpbiIpLCBfbmFwUGxnSW1wb3J0SGFuZGxlciA9IGFzeW5jICh0LCBlKSA9
PiB7CiAgY29uc3QgbiA9IEFhKCk7CiAgaWYgKCFuKQogICAgcmV0dXJuIG5lKGUsICJQbHVnaW4g
TWFuYWdlciBub3QgZm91bmQiKTsKICBjb25zdCByID0gdC5maWxlOwogIGlmICghcikKICAgIHJl
dHVybiBuZShlLCAiTm8gZmlsZSB1cGxvYWRlZCIpOwogIGNvbnN0IGkgPSBhdC5wbHVnaW5QYXRo
OwogIGRlLmV4aXN0c1N5bmMoaSkgfHwgZGUubWtkaXJTeW5jKGksIHsgcmVjdXJzaXZlOiAhMCB9
KTsKICBjb25zdCBvID0gci5wYXRoOwogIHRyeSB7CiAgICBjb25zdCBzID0gYmUuam9pbihpLCBg
X3RlbXBfZXh0cmFjdF8ke0RhdGUubm93KCl9YCk7CiAgICBkZS5ta2RpclN5bmMocywgeyByZWN1
cnNpdmU6ICEwIH0pLCBhd2FpdCB6dS56aXAudW5jb21wcmVzcyhvLCBzKTsKICAgIGNvbnN0IGEg
PSBkZS5yZWFkZGlyU3luYyhzKSwgYyA9IGEuaW5jbHVkZXMoInBhY2thZ2UuanNvbiIpLCB1ID0g
YS5zb21lKChkKSA9PiBbImluZGV4LmpzIiwgImluZGV4Lm1qcyIsICJtYWluLmpzIiwgIm1haW4u
bWpzIl0uaW5jbHVkZXMoZCkpOwogICAgbGV0IGwsIGQ7CiAgICBpZiAoYyB8fCB1KSB7CiAgICAg
IGwgPSBzOwogICAgICBjb25zdCBmID0gYmUuam9pbihzLCAicGFja2FnZS5qc29uIik7CiAgICAg
IGlmIChkZS5leGlzdHNTeW5jKGYpKQogICAgICAgIHRyeSB7CiAgICAgICAgICBkID0gSlNPTi5w
YXJzZShkZS5yZWFkRmlsZVN5bmMoZiwgInV0Zi04IikpLm5hbWUgfHwgYmUuYmFzZW5hbWUoci5v
cmlnaW5hbG5hbWUsICIuemlwIik7CiAgICAgICAgfSBjYXRjaCB7CiAgICAgICAgICBkID0gYmUu
YmFzZW5hbWUoci5vcmlnaW5hbG5hbWUsICIuemlwIik7CiAgICAgICAgfQogICAgICBlbHNlCiAg
ICAgICAgZCA9IGJlLmJhc2VuYW1lKHIub3JpZ2luYWxuYW1lLCAiLnppcCIpOwogICAgfSBlbHNl
IGlmIChhLmxlbmd0aCA9PT0gMSAmJiBkZS5zdGF0U3luYyhiZS5qb2luKHMsIGFbMF0pKS5pc0Rp
cmVjdG9yeSgpKSB7CiAgICAgIGNvbnN0IGYgPSBhWzBdOwogICAgICBsID0gYmUuam9pbihzLCBm
KTsKICAgICAgY29uc3QgbSA9IGJlLmpvaW4obCwgInBhY2thZ2UuanNvbiIpOwogICAgICBpZiAo
ZGUuZXhpc3RzU3luYyhtKSkKICAgICAgICB0cnkgewogICAgICAgICAgZCA9IEpTT04ucGFyc2Uo
ZGUucmVhZEZpbGVTeW5jKG0sICJ1dGYtOCIpKS5uYW1lIHx8IGY7CiAgICAgICAgfSBjYXRjaCB7
CiAgICAgICAgICBkID0gZjsKICAgICAgICB9CiAgICAgIGVsc2UKICAgICAgICBkID0gZjsKICAg
IH0gZWxzZQogICAgICByZXR1cm4gZGUucm1TeW5jKHMsIHsgcmVjdXJzaXZlOiAhMCwgZm9yY2U6
ICEwIH0pLCBkZS5leGlzdHNTeW5jKG8pICYmIGRlLnVubGlua1N5bmMobyksIG5lKGUsICJJbnZh
bGlkIHBsdWdpbiBwYWNrYWdlIHN0cnVjdHVyZSIpOwogICAgY29uc3QgZiA9IGJlLmpvaW4oaSwg
ZCk7CiAgICBpZiAoZGUuZXhpc3RzU3luYyhmKSkgewogICAgICBjb25zdCBtID0gbi5nZXRQbHVn
aW5JbmZvKGQpOwogICAgICBtICYmIG0ubG9hZGVkICYmIGF3YWl0IG4udW5yZWdpc3RlclBsdWdp
bihkKSwgZGUucm1TeW5jKGYsIHsgcmVjdXJzaXZlOiAhMCwgZm9yY2U6ICEwIH0pOwogICAgfQog
ICAgbCA9PT0gcyA/IGRlLnJlbmFtZVN5bmMocywgZikgOiAoZGUucmVuYW1lU3luYyhsLCBmKSwg
ZGUucm1TeW5jKHMsIHsgcmVjdXJzaXZlOiAhMCwgZm9yY2U6ICEwIH0pKSwgZGUuZXhpc3RzU3lu
YyhvKSAmJiBkZS51bmxpbmtTeW5jKG8pOwogICAgY29uc3QgbSA9IGF3YWl0IG4ubG9hZFBsdWdp
bkJ5SWQoZCk7CiAgICByZXR1cm4gbWUoZSwgewogICAgICBtZXNzYWdlOiBtID8gIlBsdWdpbiBp
bXBvcnRlZCBhbmQgbG9hZGVkIHN1Y2Nlc3NmdWxseSIgOiAiUGx1Z2luIGltcG9ydGVkIGJ1dCBm
YWlsZWQgdG8gbG9hZCAoY2hlY2sgcGx1Z2luIHN0cnVjdHVyZSkiLAogICAgICBwbHVnaW5JZDog
ZCwKICAgICAgaW5zdGFsbFBhdGg6IGYKICAgIH0pOwogIH0gY2F0Y2ggKHMpIHsKICAgIHJldHVy
biBkZS5leGlzdHNTeW5jKG8pICYmIGRlLnVubGlua1N5bmMobyksIG5lKGUsICJGYWlsZWQgdG8g
aW1wb3J0IHBsdWdpbjogIiArIHMubWVzc2FnZSk7CiAgfQp9LCBfbmFwUGxnUmVsb2FkSGFuZGxl
ciA9IGFzeW5jICh0LCBlKSA9PiB7CiAgY29uc3QgbiA9IEFhKCk7CiAgaWYgKCFuKQogICAgcmV0
dXJuIG5lKGUsICJQbHVnaW4gTWFuYWdlciBub3QgZm91bmQiKTsKICB0cnkgewogICAgbi5pc0Vu
YWJsZSAmJiBhd2FpdCBuLmNsb3NlKCk7CiAgICBhd2FpdCBuLm9wZW4oKTsKICAgIGNvbnN0IHIg
PSBuLmdldEFsbFBsdWdpbnMoKS5tYXAoKGkpID0+IHsKICAgICAgbGV0IG87CiAgICAgIGkuZW5h
YmxlID8gaS5sb2FkZWQgPyBvID0gImFjdGl2ZSIgOiBvID0gInN0b3BwZWQiIDogbyA9ICJkaXNh
YmxlZCI7CiAgICAgIGNvbnN0IHMgPSBuLmdldFBsdWdpblJvdXRlcihpLmlkKSwgYSA9IHM/Lmhh
c1BhZ2VzKCkgPz8gITE7CiAgICAgIHJldHVybiB7CiAgICAgICAgbmFtZTogaS5wYWNrYWdlSnNv
bj8ucGx1Z2luIHx8IGkubmFtZSB8fCAiIiwKICAgICAgICBpZDogaS5pZCwKICAgICAgICB2ZXJz
aW9uOiBpLnZlcnNpb24gfHwgIjAuMC4wIiwKICAgICAgICBkZXNjcmlwdGlvbjogaS5wYWNrYWdl
SnNvbj8uZGVzY3JpcHRpb24gfHwgIiIsCiAgICAgICAgYXV0aG9yOiBpLnBhY2thZ2VKc29uPy5h
dXRob3IgfHwgIiIsCiAgICAgICAgc3RhdHVzOiBvLAogICAgICAgIGhhc0NvbmZpZzogISEoaS5y
dW50aW1lLm1vZHVsZT8ucGx1Z2luX2NvbmZpZ19zY2hlbWEgfHwgaS5ydW50aW1lLm1vZHVsZT8u
cGx1Z2luX2NvbmZpZ191aSksCiAgICAgICAgaGFzUGFnZXM6IGEsCiAgICAgICAgaG9tZXBhZ2U6
IGkucGFja2FnZUpzb24/LmhvbWVwYWdlLAogICAgICAgIHJlcG9zaXRvcnk6IHR5cGVvZiBpLnBh
Y2thZ2VKc29uPy5yZXBvc2l0b3J5ID09ICJzdHJpbmciID8gaS5wYWNrYWdlSnNvbi5yZXBvc2l0
b3J5IDogaS5wYWNrYWdlSnNvbj8ucmVwb3NpdG9yeT8udXJsLAogICAgICAgIGljb246IGRtZShp
LmlkLCBpLnBsdWdpblBhdGgsIGkucGFja2FnZUpzb24/Lmljb24pCiAgICAgIH07CiAgICB9KTsK
ICAgIHJldHVybiBtZShlLCB7CiAgICAgIG1lc3NhZ2U6ICJQbHVnaW5zIHJlbG9hZGVkIGZyb20g
bG9jYWwgZGlyZWN0b3J5IiwKICAgICAgY291bnQ6IHIubGVuZ3RoLAogICAgICBwbHVnaW5zOiBy
CiAgICB9KTsKICB9IGNhdGNoIChyKSB7CiAgICByZXR1cm4gbmUoZSwgIkZhaWxlZCB0byByZWxv
YWQgcGx1Z2luczogIiArIHIubWVzc2FnZSk7CiAgfQp9Owo=
__MK_EMBED_END__
__MK_EMBED_FILE__:plugin-NCp3.js__
aW1wb3J0e2ggYXMgaSxqIGFzIGV9ZnJvbSIuL2NvZGVtaXJyb3ItY29yZS12a2NuWEpnRC5qcyI7
aW1wb3J0e2sgYXMgJCxiIGFzIE0sVSBhcyBHLHggYXMgUSx5IGFzIFgseiBhcyBZLEEgYXMgZWUs
QiBhcyBzZSxEIGFzIGFlLFAgYXMgdGV9ZnJvbSIuL2luZGV4LUJmTW00UFJ2LmpzIjtpbXBvcnR7
dSBhcyBsZSxjIGFzIEEsSiBhcyBwfWZyb20iLi9yZWFjdC1kb20tQ3dhSEZndDYuanMiO2ltcG9y
dHthIGFzIG5lfWZyb20iLi9pbmRleC1qM2NuZGVuNS5qcyI7aW1wb3J0e2EgYXMgcmV9ZnJvbSIu
L2NodW5rLVNYTUxTQk9ZLURjMlRmNkgyLmpzIjtpbXBvcnR7YSBhcyBjZSxjIGFzIG9lfWZyb20i
Li9jaHVuay01UElMT1VCUy1EMXR0bU9BSC5qcyI7aW1wb3J0e2MgYXMgaWV9ZnJvbSIuL2NodW5r
LVRFNlNaUzZXLTBJWVNlOVplLmpzIjtpbXBvcnR7YyBhcyBPfWZyb20iLi9jaHVuay1OQVYzWlhM
SS1DTk8tOEx6aS5qcyI7aW1wb3J0e3MgYXMgS31mcm9tIi4vY2h1bmstSjZKR0k2Uk0tSGtTM1hF
S2IuanMiO2ltcG9ydHt0IGFzIFR9ZnJvbSIuL2NodW5rLTZMSVg2TFZULUJLNmQxQnJQLmpzIjtp
bXBvcnR7ZSBhcyBkZSxyIGFzIHVlfWZyb20iLi9pbmRleC1CLTk1UVp5ay5qcyI7aW1wb3J0e1Ag
YXMgRX1mcm9tIi4vcGx1Z2luX21hbmFnZXItTkNwMy5qcyI7aW1wb3J0e3UgYXMgZmV9ZnJvbSIu
L3VzZS1kaWFsb2ctdnczTzRITXUuanMiO2ltcG9ydHtpIGFzIEx9ZnJvbSIuL2NodW5rLTJRQU4y
VjJSLXByUFh5UFFfLmpzIjtpbXBvcnR7cyBhcyBWLGwgYXMgSn1mcm9tIi4vY2h1bmstS1ZEVzYy
WlQtQmtQTGRBcnYuanMiO2ltcG9ydCIuL2ljb25CYXNlLURxUU1yY3hVLmpzIjtpbXBvcnQiLi9p
bmRleC1ja3F2TVdBRi5qcyI7aW1wb3J0Ii4vY2h1bmstU0xBQlVTR1MtRGNtam9ZeWMuanMiO2lt
cG9ydCIuL2NodW5rLUVONEI1N1JRLURGNWZlWXJ1LmpzIjtpbXBvcnQiLi9jaHVuay1VWDdVTVpM
NS1Ea205b1hoSS5qcyI7aW1wb3J0Ii4vY2h1bmstV1FWUTdQMkktQ2h3aHNwQzEuanMiO2ltcG9y
dCIuL0l0ZW0tQ2RackdFYmUuanMiO2Z1bmN0aW9uIHhlKGEpe2lmKGEpdHJ5e2NvbnN0IGM9bG9j
YWxTdG9yYWdlLmdldEl0ZW0oJC50b2tlbik7aWYoIWMpcmV0dXJuIGE7Y29uc3Qgbz1KU09OLnBh
cnNlKGMpLHg9bmV3IFVSTChhLHdpbmRvdy5sb2NhdGlvbi5vcmlnaW4pO3JldHVybiB4LnNlYXJj
aFBhcmFtcy5zZXQoIndlYnVpX3Rva2VuIixvKSx4LnBhdGhuYW1lK3guc2VhcmNofWNhdGNoe3Jl
dHVybiBhfX1jb25zdCBoZT0oe2RhdGE6YSxvblRvZ2dsZVN0YXR1czpjLG9uVW5pbnN0YWxsOm8s
b25Db25maWc6eCxoYXNDb25maWc6aD0hMX0pPT57Y29uc3R7bmFtZTptLHZlcnNpb246dSxhdXRo
b3I6ZixkZXNjcmlwdGlvbjp5LHN0YXR1czp3LGljb246Un09YSx6PXc9PT0iYWN0aXZlIixbTixr
XT1pLnVzZVN0YXRlKCExKSxbQyxQXT1pLnVzZVN0YXRlKCExKSxbcl09bGUoJC5iYWNrZ3JvdW5k
SW1hZ2UsIiIpLGc9ISFyLF89eGUoUil8fGBodHRwczovL2F2YXRhci52ZXJjZWwuc2gvJHtlbmNv
ZGVVUklDb21wb25lbnQobSl9YCx2PSgpPT57ayghMCksYygpLmZpbmFsbHkoKCk9PmsoITEpKX0s
Uz0oKT0+e2soITApLG8oKS5maW5hbGx5KCgpPT5rKCExKSl9O3JldHVybiBlLmpzeHMoY2Use2Ns
YXNzTmFtZTpBKCJncm91cCB3LWZ1bGwgYmFja2Ryb3AtYmx1ci1tZCByb3VuZGVkLTJ4bCBvdmVy
Zmxvdy1oaWRkZW4gdHJhbnNpdGlvbi1hbGwgZHVyYXRpb24tMzAwIiwiaG92ZXI6c2hhZG93LXhs
IGhvdmVyOi10cmFuc2xhdGUteS0xIiwiYm9yZGVyIGJvcmRlci13aGl0ZS81MCBkYXJrOmJvcmRl
ci13aGl0ZS8xMCBob3Zlcjpib3JkZXItcHJpbWFyeS81MCBkYXJrOmhvdmVyOmJvcmRlci1wcmlt
YXJ5LzUwIixnPyJiZy13aGl0ZS8yMCBkYXJrOmJnLWJsYWNrLzEwIjoiYmctd2hpdGUvNjAgZGFy
azpiZy1ibGFjay8zMCIpLHNoYWRvdzoic20iLGNoaWxkcmVuOltlLmpzeHMob2Use2NsYXNzTmFt
ZToicC00IGZsZXggZmxleC1jb2wgZ2FwLTMiLGNoaWxkcmVuOltlLmpzeHMoImRpdiIse2NsYXNz
TmFtZToiZmxleCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTMiLGNoaWxkcmVuOltl
LmpzeHMoImRpdiIse2NsYXNzTmFtZToiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTMgbWluLXctMCIs
Y2hpbGRyZW46W2UuanN4KHJlLHtzcmM6XyxuYW1lOmZ8fCI/IixjbGFzc05hbWU6ImZsZXgtc2hy
aW5rLTAiLHNpemU6Im1kIixpc0JvcmRlcmVkOiEwLHJhZGl1czoiZnVsbCIsY29sb3I6ImRlZmF1
bHQifSksZS5qc3hzKCJkaXYiLHtjbGFzc05hbWU6Im1pbi13LTAiLGNoaWxkcmVuOltlLmpzeCgi
aDMiLHtjbGFzc05hbWU6InRleHQtYmFzZSBmb250LWJvbGQgdGV4dC1kZWZhdWx0LTkwMCB0cnVu
Y2F0ZSIsdGl0bGU6bSxjaGlsZHJlbjptfSksZS5qc3hzKCJwIix7Y2xhc3NOYW1lOiJ0ZXh0LXhz
IHRleHQtZGVmYXVsdC01MDAgbXQtMC41IHRydW5jYXRlIixjaGlsZHJlbjpbImJ5ICIsZS5qc3go
InNwYW4iLHtjbGFzc05hbWU6ImZvbnQtbWVkaXVtIixjaGlsZHJlbjpmfHwi5pyq55+lIn0pXX0p
XX0pXX0pLGUuanN4KE8se3NpemU6InNtIix2YXJpYW50OiJmbGF0Iixjb2xvcjp3PT09ImFjdGl2
ZSI/InN1Y2Nlc3MiOnc9PT0ic3RvcHBlZCI/Indhcm5pbmciOiJkZWZhdWx0IixjbGFzc05hbWU6
ImZsZXgtc2hyaW5rLTAgZm9udC1tZWRpdW0gaC02IHB4LTEiLGNoaWxkcmVuOnc9PT0iYWN0aXZl
Ij8i6L+Q6KGM5LitIjp3PT09InN0b3BwZWQiPyLlt7LlgZzmraIiOiLlt7LnpoHnlKgifSldfSks
ZS5qc3goImRpdiIse2NsYXNzTmFtZToicmVsYXRpdmUgbWluLWgtWzIuNXJlbV0gY3Vyc29yLXBv
aW50ZXIgZ3JvdXAvZGVzYyIsb25DbGljazooKT0+UCghQyksY2hpbGRyZW46ZS5qc3goVCx7Y29u
dGVudDp5LGlzRGlzYWJsZWQ6IXl8fHkubGVuZ3RoPDUwfHxDLHBsYWNlbWVudDoiYm90dG9tIixj
bGFzc05hbWU6Im1heC13LVsyODBweF0iLGRlbGF5OjUwMCxjaGlsZHJlbjplLmpzeCgicCIse2Ns
YXNzTmFtZTpBKCJ0ZXh0LXNtIHRleHQtZGVmYXVsdC02MDAgZGFyazp0ZXh0LWRlZmF1bHQtNDAw
IGxlYWRpbmctcmVsYXhlZCB0cmFuc2l0aW9uLWFsbCBkdXJhdGlvbi0zMDAiLEM/ImxpbmUtY2xh
bXAtbm9uZSI6ImxpbmUtY2xhbXAtMiIpLGNoaWxkcmVuOnl8fCLmmoLml6Dmj4/ov7AifSl9KX0p
LGUuanN4KCJkaXYiLHtjaGlsZHJlbjplLmpzeHMoTyx7c2l6ZToic20iLHZhcmlhbnQ6ImZsYXQi
LGNvbG9yOiJwcmltYXJ5IixjbGFzc05hbWU6ImgtNSB0ZXh0LXhzIGZvbnQtc2VtaWJvbGQgcHgt
MC41IixjbGFzc05hbWVzOntjb250ZW50OiJweC0xIn0sY2hpbGRyZW46WyJ2Iix1XX0pfSldfSks
ZS5qc3hzKGllLHtjbGFzc05hbWU6InB4LTQgcGItNCBwdC0wIGdhcC0zIixjaGlsZHJlbjpbZS5q
c3goSyx7aXNEaXNhYmxlZDpOLGlzU2VsZWN0ZWQ6eixvblZhbHVlQ2hhbmdlOnYsc2l6ZToic20i
LGNvbG9yOiJzdWNjZXNzIixjbGFzc05hbWVzOnt3cmFwcGVyOiJncm91cC1kYXRhLVtzZWxlY3Rl
ZD10cnVlXTpiZy1zdWNjZXNzIn0sY2hpbGRyZW46ZS5qc3goInNwYW4iLHtjbGFzc05hbWU6InRl
eHQteHMgZm9udC1tZWRpdW0gdGV4dC1kZWZhdWx0LTYwMCIsY2hpbGRyZW46ej8i5bey5ZCv55So
Ijoi5bey56aB55SoIn0pfSksZS5qc3goImRpdiIse2NsYXNzTmFtZToiZmxleC0xIn0pLGgmJmUu
anN4KFQse2NvbnRlbnQ6IuaPkuS7tumFjee9riIsY2hpbGRyZW46ZS5qc3goTSx7aXNJY29uT25s
eTohMCxyYWRpdXM6ImZ1bGwiLHNpemU6InNtIix2YXJpYW50OiJsaWdodCIsY29sb3I6InByaW1h
cnkiLG9uUHJlc3M6eCxjaGlsZHJlbjplLmpzeChkZSx7c2l6ZToyMH0pfSl9KSxlLmpzeChULHtj
b250ZW50OiLljbjovb3mj5Lku7YiLGNvbG9yOiJkYW5nZXIiLGNoaWxkcmVuOmUuanN4KE0se2lz
SWNvbk9ubHk6ITAscmFkaXVzOiJmdWxsIixzaXplOiJzbSIsdmFyaWFudDoibGlnaHQiLGNvbG9y
OiJkYW5nZXIiLG9uUHJlc3M6Uyxpc0Rpc2FibGVkOk4sY2hpbGRyZW46ZS5qc3godWUse3NpemU6
MjB9KX0pfSldfSldfSl9O2Z1bmN0aW9uIEIoYSxjPTYwKXtpZihhLmxlbmd0aDw9YylyZXR1cm4g
YTtjb25zdCBvPWEuaW5jbHVkZXMoIlxcIik/IlxcIjoiLyIseD1hLnNwbGl0KG8pO2lmKHgubGVu
Z3RoPD0zKXJldHVybiBhLnN1YnN0cmluZygwLGMtMykrIi4uLiI7Y29uc3QgaD14WzBdLG09eC5z
bGljZSgtMikuam9pbihvKSx1PWAke2h9JHtvfS4uLiR7b30ke219YDtyZXR1cm4gdS5sZW5ndGg+
Yz9hLnN1YnN0cmluZygwLGMtMykrIi4uLiI6dX1mdW5jdGlvbiBtZShhLGM9MTAwKXtpZihhLmxl
bmd0aDw9YylyZXR1cm4gYTtjb25zdCBvPS9bQS1aYS16XTpcXFteXHMnIl0rL2cseD0vXC9bXlxz
JyJdKyg/OlwvW15ccyciXSspKy9nO2xldCBoPWE7Y29uc3QgbT1hLm1hdGNoKG8pO2lmKG0pZm9y
KGNvbnN0IGYgb2YgbSlmLmxlbmd0aD40MCYmKGg9aC5yZXBsYWNlKGYsQihmLDQwKSkpO2NvbnN0
IHU9YS5tYXRjaCh4KTtpZih1KWZvcihjb25zdCBmIG9mIHUpZi5sZW5ndGg+NDAmJihoPWgucmVw
bGFjZShmLEIoZiw0MCkpKTtyZXR1cm4gaC5sZW5ndGg+Yz9oLnN1YnN0cmluZygwLGMtMykrIi4u
LiI6aH1jb25zdCBEPXtlcnJvcjooYSxjKT0+e2NvbnN0IG89dHlwZW9mIGE9PSJzdHJpbmciP21l
KGEpOmE7cmV0dXJuIHAuZXJyb3IobyxjKX0sc3VjY2VzczooYSxjKT0+cC5zdWNjZXNzKGEsYyks
bG9hZGluZzooYSxjKT0+cC5sb2FkaW5nKGEsYyksY3VzdG9tOnAuY3VzdG9tLGRpc21pc3M6cC5k
aXNtaXNzLHJlbW92ZTpwLnJlbW92ZSxwcm9taXNlOnAucHJvbWlzZX07ZnVuY3Rpb24gcGUoe2lz
T3BlbjphLG9uT3BlbkNoYW5nZTpjLHBsdWdpbklkOm99KXtjb25zdFt4LGhdPWkudXNlU3RhdGUo
ITEpLFttLHVdPWkudXNlU3RhdGUoW10pLFtmLHldPWkudXNlU3RhdGUoe30pLFt3LFJdPWkudXNl
U3RhdGUoITEpLFt6LE5dPWkudXNlU3RhdGUoITEpLFtrLENdPWkudXNlU3RhdGUobnVsbCksW1As
cl09aS51c2VTdGF0ZSghMSksZz1pLnVzZVJlZihudWxsKSxfPWkudXNlUmVmKHt9KTtpLnVzZUVm
ZmVjdCgoKT0+e18uY3VycmVudD1mfSxbZl0pO2NvbnN0IHY9aS51c2VDYWxsYmFjayhzPT57c3dp
dGNoKHMudHlwZSl7Y2FzZSJmdWxsIjpzLnNjaGVtYSYmdShzLnNjaGVtYSk7YnJlYWs7Y2FzZSJ1
cGRhdGVGaWVsZCI6cy5rZXkmJnMuZmllbGQmJnUobj0+bi5tYXAodD0+dC5rZXk9PT1zLmtleT97
Li4udCwuLi5zLmZpZWxkfTp0KSk7YnJlYWs7Y2FzZSJyZW1vdmVGaWVsZCI6cy5rZXkmJnUobj0+
bi5maWx0ZXIodD0+dC5rZXkhPT1zLmtleSkpO2JyZWFrO2Nhc2UiYWRkRmllbGQiOnMuZmllbGQm
JnUobj0+e2NvbnN0IHQ9cy5maWVsZCxiPW4uZmluZEluZGV4KGw9Pmwua2V5PT09dC5rZXkpO2lm
KGIhPT0tMSl7Y29uc3QgbD1bLi4ubl07cmV0dXJuIGxbYl09ey4uLmxbYl0sLi4udH0sbH1pZihz
LmFmdGVyS2V5KXtjb25zdCBsPW4uZmluZEluZGV4KGQ9PmQua2V5PT09cy5hZnRlcktleSk7aWYo
bCE9PS0xKXtjb25zdCBkPVsuLi5uXTtyZXR1cm4gZC5zcGxpY2UobCsxLDAsdCksZH19cmV0dXJu
Wy4uLm4sdF19KTticmVhaztjYXNlInNob3dGaWVsZCI6cy5rZXkmJnUobj0+bi5tYXAodD0+dC5r
ZXk9PT1zLmtleT97Li4udCxoaWRkZW46ITF9OnQpKTticmVhaztjYXNlImhpZGVGaWVsZCI6cy5r
ZXkmJnUobj0+bi5tYXAodD0+dC5rZXk9PT1zLmtleT97Li4udCxoaWRkZW46ITB9OnQpKTticmVh
a319LFtdKSxTPWkudXNlQ2FsbGJhY2socz0+e2cuY3VycmVudCYmZy5jdXJyZW50LmNsb3NlKCk7
Y29uc3Qgbj1sb2NhbFN0b3JhZ2UuZ2V0SXRlbSgkLnRva2VuKTtpZighbil7Y29uc29sZS53YXJu
KCLmnKrnmbvlvZXvvIzml6Dms5Xlu7rnq4sgU1NFIOi/nuaOpSIpO3JldHVybn1jb25zdCB0PUpT
T04ucGFyc2UobiksYj1FLmdldENvbmZpZ1NTRVVybChvLHMpLGw9bmV3IEcuRXZlbnRTb3VyY2VQ
b2x5ZmlsbChiLHtoZWFkZXJzOntBdXRob3JpemF0aW9uOmBCZWFyZXIgJHt0fWAsQWNjZXB0OiJ0
ZXh0L2V2ZW50LXN0cmVhbSJ9LHdpdGhDcmVkZW50aWFsczohMH0pO2cuY3VycmVudD1sLGwuYWRk
RXZlbnRMaXN0ZW5lcigiY29ubmVjdGVkIixkPT57Y29uc3Qgaj1KU09OLnBhcnNlKGQuZGF0YSk7
QyhqLnNlc3Npb25JZCkscighMCl9KSxsLmFkZEV2ZW50TGlzdGVuZXIoInNjaGVtYSIsZD0+e2Nv
bnN0IGo9SlNPTi5wYXJzZShkLmRhdGEpO3Yoail9KSxsLmFkZEV2ZW50TGlzdGVuZXIoImVycm9y
IixkPT57dHJ5e2NvbnN0IGo9SlNPTi5wYXJzZShkLmRhdGEpO0QuZXJyb3IoIuaPkuS7tumUmeiv
rzogIitqLm1lc3NhZ2UpfWNhdGNoe3IoITEpfX0pLGwub25lcnJvcj0oKT0+e3IoITEpfX0sW28s
dl0pLEk9aS51c2VDYWxsYmFjaygoKT0+e2cuY3VycmVudCYmKGcuY3VycmVudC5jbG9zZSgpLGcu
Y3VycmVudD1udWxsKSxDKG51bGwpLHIoITEpfSxbXSk7aS51c2VFZmZlY3QoKCk9PihhJiZvJiZI
KCksKCk9PntJKCl9KSxbYSxvLEldKTtjb25zdCBIPWFzeW5jKCk9PntoKCEwKSx1KFtdKSx5KHt9
KSxOKCExKSxJKCk7dHJ5e2NvbnN0IHM9YXdhaXQgRS5nZXRQbHVnaW5Db25maWcobyk7dShzLnNj
aGVtYXx8W10pLHkocy5jb25maWd8fHt9KSxOKCEhcy5zdXBwb3J0UmVhY3RpdmUpLHMuc3VwcG9y
dFJlYWN0aXZlJiZTKHMuY29uZmlnfHx7fSl9Y2F0Y2gocyl7RC5lcnJvcigi5Yqg6L296YWN572u
5aSx6LSlOiAiK3MubWVzc2FnZSl9ZmluYWxseXtoKCExKX19LFc9YXN5bmMoKT0+e1IoITApO3Ry
eXthd2FpdCBFLnNldFBsdWdpbkNvbmZpZyhvLGYpLEQuc3VjY2VzcygiQ29uZmlndXJhdGlvbiBz
YXZlZCIpLGMoKX1jYXRjaChzKXtELmVycm9yKCJTYXZlIGZhaWxlZDogIitzLm1lc3NhZ2UpfWZp
bmFsbHl7UighMSl9fSxGPWkudXNlQ2FsbGJhY2soKHMsbik9Pnt5KHQ9Pntjb25zdCBiPXsuLi50
LFtzXTpufSxsPW0uZmluZChkPT5kLmtleT09PXMpO3JldHVybiBsIT1udWxsJiZsLnJlYWN0aXZl
JiZrJiZQJiZFLm5vdGlmeUNvbmZpZ0NoYW5nZShvLGsscyxuLGIpLmNhdGNoKGQ9PmNvbnNvbGUu
ZXJyb3IoIumAmuefpemFjee9ruWPmOWMluWksei0pToiLGQpKSxifSl9LFttLGssUCxvXSksWj1z
PT57Y29uc3Qgbj1mW3Mua2V5XT8/cy5kZWZhdWx0O3N3aXRjaChzLnR5cGUpe2Nhc2Uic3RyaW5n
IjpyZXR1cm4gZS5qc3goTCx7bGFiZWw6cy5sYWJlbCxwbGFjZWhvbGRlcjpzLnBsYWNlaG9sZGVy
fHxzLmRlc2NyaXB0aW9uLHZhbHVlOm58fCIiLG9uVmFsdWVDaGFuZ2U6dD0+RihzLmtleSx0KSxk
ZXNjcmlwdGlvbjpzLmRlc2NyaXB0aW9uLGNsYXNzTmFtZToibWItNCJ9LHMua2V5KTtjYXNlIm51
bWJlciI6cmV0dXJuIGUuanN4KEwse3R5cGU6Im51bWJlciIsbGFiZWw6cy5sYWJlbCxwbGFjZWhv
bGRlcjpzLnBsYWNlaG9sZGVyfHxzLmRlc2NyaXB0aW9uLHZhbHVlOlN0cmluZyhuPz8wKSxvblZh
bHVlQ2hhbmdlOnQ9PkYocy5rZXksTnVtYmVyKHQpKSxkZXNjcmlwdGlvbjpzLmRlc2NyaXB0aW9u
LGNsYXNzTmFtZToibWItNCJ9LHMua2V5KTtjYXNlImJvb2xlYW4iOnJldHVybiBlLmpzeHMoImRp
diIse2NsYXNzTmFtZToiZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIG1iLTQgcC0y
IGJnLWRlZmF1bHQtMTAwIHJvdW5kZWQtbGciLGNoaWxkcmVuOltlLmpzeHMoImRpdiIse2NsYXNz
TmFtZToiZmxleCBmbGV4LWNvbCIsY2hpbGRyZW46W2UuanN4KCJzcGFuIix7Y2xhc3NOYW1lOiJ0
ZXh0LXNtYWxsIixjaGlsZHJlbjpzLmxhYmVsfSkscy5kZXNjcmlwdGlvbiYmZS5qc3goInNwYW4i
LHtjbGFzc05hbWU6InRleHQtdGlueSB0ZXh0LWRlZmF1bHQtNTAwIixjaGlsZHJlbjpzLmRlc2Ny
aXB0aW9ufSldfSksZS5qc3goSyx7aXNTZWxlY3RlZDohIW4sb25WYWx1ZUNoYW5nZTp0PT5GKHMu
a2V5LHQpfSldfSxzLmtleSk7Y2FzZSJzZWxlY3QiOntjb25zdCB0PW4hPT12b2lkIDA/U3RyaW5n
KG4pOnZvaWQgMCxiPXMub3B0aW9uc3x8W107cmV0dXJuIGUuanN4KFYse2xhYmVsOnMubGFiZWws
cGxhY2Vob2xkZXI6cy5wbGFjZWhvbGRlcnx8IlNlbGVjdCBhbiBvcHRpb24iLHNlbGVjdGVkS2V5
czp0P1t0XTpbXSxvblNlbGVjdGlvbkNoYW5nZTpsPT57Y29uc3QgZD1BcnJheS5mcm9tKGwpWzBd
LGo9Yi5maW5kKFU9PlN0cmluZyhVLnZhbHVlKT09PWQpO0Yocy5rZXksaj9qLnZhbHVlOmQpfSxk
ZXNjcmlwdGlvbjpzLmRlc2NyaXB0aW9uLGNsYXNzTmFtZToibWItNCIsY2hpbGRyZW46Yi5tYXAo
bD0+ZS5qc3goSix7dGV4dFZhbHVlOmwubGFiZWwsY2hpbGRyZW46bC5sYWJlbH0sU3RyaW5nKGwu
dmFsdWUpKSl9LHMua2V5KX1jYXNlIm11bHRpLXNlbGVjdCI6e2NvbnN0IHQ9QXJyYXkuaXNBcnJh
eShuKT9uLm1hcChTdHJpbmcpOltdLGI9cy5vcHRpb25zfHxbXTtyZXR1cm4gZS5qc3goVix7bGFi
ZWw6cy5sYWJlbCxwbGFjZWhvbGRlcjpzLnBsYWNlaG9sZGVyfHwiU2VsZWN0IG9wdGlvbnMiLHNl
bGVjdGlvbk1vZGU6Im11bHRpcGxlIixzZWxlY3RlZEtleXM6bmV3IFNldCh0KSxvblNlbGVjdGlv
bkNoYW5nZTpsPT57Y29uc3QgZD1BcnJheS5mcm9tKGwpLm1hcChqPT57Y29uc3QgVT1iLmZpbmQo
cT0+U3RyaW5nKHEudmFsdWUpPT09aik7cmV0dXJuIFU/VS52YWx1ZTpqfSk7RihzLmtleSxkKX0s
ZGVzY3JpcHRpb246cy5kZXNjcmlwdGlvbixjbGFzc05hbWU6Im1iLTQiLGNoaWxkcmVuOmIubWFw
KGw9PmUuanN4KEose3RleHRWYWx1ZTpsLmxhYmVsLGNoaWxkcmVuOmwubGFiZWx9LFN0cmluZyhs
LnZhbHVlKSkpfSxzLmtleSl9Y2FzZSJodG1sIjpyZXR1cm4gZS5qc3hzKCJkaXYiLHtjbGFzc05h
bWU6Im1iLTQiLGNoaWxkcmVuOltzLmxhYmVsJiZlLmpzeCgiaDQiLHtjbGFzc05hbWU6InRleHQt
c21hbGwgZm9udC1ib2xkIG1iLTEiLGNoaWxkcmVuOnMubGFiZWx9KSxlLmpzeCgiZGl2Iix7ZGFu
Z2Vyb3VzbHlTZXRJbm5lckhUTUw6e19faHRtbDpzLmRlZmF1bHR8fCIifSxjbGFzc05hbWU6InBy
b3NlIGRhcms6cHJvc2UtaW52ZXJ0IG1heC13LW5vbmUifSkscy5kZXNjcmlwdGlvbiYmZS5qc3go
InAiLHtjbGFzc05hbWU6InRleHQtdGlueSB0ZXh0LWRlZmF1bHQtNTAwIG10LTEiLGNoaWxkcmVu
OnMuZGVzY3JpcHRpb259KV19LHMua2V5KTtjYXNlInRleHQiOnJldHVybiBlLmpzeHMoImRpdiIs
e2NsYXNzTmFtZToibWItNCIsY2hpbGRyZW46W3MubGFiZWwmJmUuanN4KCJoNCIse2NsYXNzTmFt
ZToidGV4dC1zbWFsbCBmb250LWJvbGQgbWItMSIsY2hpbGRyZW46cy5sYWJlbH0pLGUuanN4KCJk
aXYiLHtjbGFzc05hbWU6IndoaXRlc3BhY2UtcHJlLXdyYXAgdGV4dC1kZWZhdWx0LTcwMCIsY2hp
bGRyZW46cy5kZWZhdWx0fHwiIn0pLHMuZGVzY3JpcHRpb24mJmUuanN4KCJwIix7Y2xhc3NOYW1l
OiJ0ZXh0LXRpbnkgdGV4dC1kZWZhdWx0LTUwMCBtdC0xIixjaGlsZHJlbjpzLmRlc2NyaXB0aW9u
fSldfSxzLmtleSk7ZGVmYXVsdDpyZXR1cm4gbnVsbH19O3JldHVybiBlLmpzeChRLHtpc09wZW46
YSxvbk9wZW5DaGFuZ2U6YyxzaXplOiIyeGwiLHNjcm9sbEJlaGF2aW9yOiJpbnNpZGUiLGNoaWxk
cmVuOmUuanN4KFgse2NoaWxkcmVuOnM9PmUuanN4cyhlLkZyYWdtZW50LHtjaGlsZHJlbjpbZS5q
c3goWSx7Y2xhc3NOYW1lOiJmbGV4IGZsZXgtY29sIGdhcC0xIixjaGlsZHJlbjplLmpzeHMoImRp
diIse2NsYXNzTmFtZToiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIiLGNoaWxkcmVuOlsi5o+S5Lu2
6YWN572uOiAiLG8seiYmZS5qc3goInNwYW4iLHtjbGFzc05hbWU6YHRleHQtdGlueSBweC0yIHB5
LTAuNSByb3VuZGVkICR7UD8iYmctc3VjY2Vzcy0xMDAgdGV4dC1zdWNjZXNzLTYwMCI6ImJnLXdh
cm5pbmctMTAwIHRleHQtd2FybmluZy02MDAifWAsY2hpbGRyZW46UD8i5bey6L+e5o6lIjoi5pyq
6L+e5o6lIn0pXX0pfSksZS5qc3goZWUse2NoaWxkcmVuOng/ZS5qc3goImRpdiIse2NsYXNzTmFt
ZToiZmxleCBqdXN0aWZ5LWNlbnRlciBwLTgiLGNoaWxkcmVuOiJMb2FkaW5nIGNvbmZpZ3VyYXRp
b24uLi4ifSk6ZS5qc3goImRpdiIse2NsYXNzTmFtZToiZmxleCBmbGV4LWNvbCBnYXAtMiIsY2hp
bGRyZW46bS5sZW5ndGg9PT0wP2UuanN4KCJkaXYiLHtjbGFzc05hbWU6InRleHQtY2VudGVyIHRl
eHQtZGVmYXVsdC01MDAiLGNoaWxkcmVuOiJObyBjb25maWd1cmF0aW9uIHNjaGVtYSBhdmFpbGFi
bGUuIn0pOm0uZmlsdGVyKG49PiFuLmhpZGRlbikubWFwKFopfSl9KSxlLmpzeHMoc2Use2NoaWxk
cmVuOltlLmpzeChNLHtjb2xvcjoiZGFuZ2VyIix2YXJpYW50OiJsaWdodCIsb25QcmVzczpzLGNo
aWxkcmVuOiLlhbPpl60ifSksZS5qc3goTSx7Y29sb3I6InByaW1hcnkiLG9uUHJlc3M6Vyxpc0xv
YWRpbmc6dyxjaGlsZHJlbjoi5L+d5a2YIn0pXX0pXX0pfSl9KX1mdW5jdGlvbiBBZSgpe2NvbnN0
W2EsY109aS51c2VTdGF0ZShbXSksW28seF09aS51c2VTdGF0ZSghMSksW2gsbV09aS51c2VTdGF0
ZSghMSksdT1mZSgpLHtpc09wZW46Zixvbk9wZW46eSxvbk9wZW5DaGFuZ2U6d309YWUoKSxbUix6
XT1pLnVzZVN0YXRlKCIiKSxVPWkudXNlUmVmKG51bGwpLFZ2PWkudXNlUmVmKCExKSxqPWFzeW5j
KCk9Pnt4KCEwKSxtKCExKTt0cnl7Y29uc3Qgcj1hd2FpdCBFLmdldFBsdWdpbkxpc3QoKTtyLnBs
dWdpbk1hbmFnZXJOb3RGb3VuZD8obSghMCksYyhbXSkpOmMoci5wbHVnaW5zKX1jYXRjaChyKXtw
LmVycm9yKHIubWVzc2FnZSl9ZmluYWxseXt4KCExKX19LE49YXN5bmMoKT0+e3goITApO3RyeXtj
b25zdCByPWF3YWl0IEUucmVsb2FkUGx1Z2lucygpO3I/LnBsdWdpbnM/KGMoci5wbHVnaW5zKSxt
KCExKSxwLnN1Y2Nlc3MoYOmHjei9veWujOaIkO+8jOWFsSAke3IuY291bnQ/P3IucGx1Z2lucy5s
ZW5ndGh9IOS4quaPkuS7tmApKTooYXdhaXQgaigpLHAuc3VjY2Vzcygi6YeN6L295a6M5oiQIikp
fWNhdGNoKHIpe3AuZXJyb3Ioci5tZXNzYWdlKX1maW5hbGx5e3goITEpfX0sTD0oKT0+e2g/dS5j
b25maXJtKHt0aXRsZToi5o+S5Lu2566h55CG5Zmo5pyq5Yqg6L29Iixjb250ZW50OmUuanN4cygi
ZGl2Iix7Y2xhc3NOYW1lOiJzcGFjZS15LTIiLGNoaWxkcmVuOltlLmpzeCgicCIse2NsYXNzTmFt
ZToidGV4dC1zbSB0ZXh0LWRlZmF1bHQtNjAwIixjaGlsZHJlbjoi5o+S5Lu2566h55CG5Zmo5bCa
5pyq5Yqg6L2977yM5peg5rOV5a+85YWl5o+S5Lu244CCIn0pLGUuanN4KCJwIix7Y2xhc3NOYW1l
OiJ0ZXh0LXNtIHRleHQtZGVmYXVsdC02MDAiLGNoaWxkcmVuOiLmmK/lkKbnq4vljbPms6jlhozm
j5Lku7bnrqHnkIblmajvvJ8ifSldfSksY29uZmlybVRleHQ6IuazqOWGjOaPkuS7tueuoeeQhuWZ
qCIsY2FuY2VsVGV4dDoi5Y+W5raIIixvbkNvbmZpcm06YXN5bmMoKT0+e3RyeXthd2FpdCBFLnJl
Z2lzdGVyUGx1Z2luTWFuYWdlcigpLHAuc3VjY2Vzcygi5o+S5Lu2566h55CG5Zmo5rOo5YaM5oiQ
5YqfIiksbSghMSksVS5jdXJyZW50Py5jbGljaygpfWNhdGNoKHIpe3AuZXJyb3IoIuazqOWGjOWk
sei0pTogIityLm1lc3NhZ2UpfX19KTpVLmN1cnJlbnQ/LmNsaWNrKCl9LHE9YXN5bmMgcj0+e2Nv
bnN0IGc9ci50YXJnZXQuZmlsZXM/LlswXTtpZihyLnRhcmdldC52YWx1ZT0iIiwhZylyZXR1cm47
aWYoIWcubmFtZS5lbmRzV2l0aCgiLnppcCIpKXtwLmVycm9yKCLor7fpgInmi6kgLnppcCDmoLzl
vI/nmoTmj5Lku7bljIUiKTtyZXR1cm59Y29uc3QgXz1wLmxvYWRpbmcoIuato+WcqOWvvOWFpeaP
kuS7ti4uLiIpO3RyeXtjb25zdCB2PWF3YWl0IEUuaW1wb3J0TG9jYWxQbHVnaW4oZyk7cC5zdWNj
ZXNzKHYubWVzc2FnZSx7aWQ6X30pLGooKX1jYXRjaCh2KXtwLmVycm9yKHYubWVzc2FnZXx8IuWv
vOWFpeWksei0pSIse2lkOl99KX19O2kudXNlRWZmZWN0KCgpPT57VnYuY3VycmVudHx8KFZ2LmN1
cnJlbnQ9ITAsaigpKX0sW10pO2NvbnN0IGs9YXN5bmMgcj0+e2NvbnN0IGc9ci5zdGF0dXMhPT0i
YWN0aXZlIixfPWc/IuWQr+eUqCI6IuemgeeUqCIsdj1wLmxvYWRpbmcoYCR7X33kuK0uLi5gKTt0
cnl7YXdhaXQgRS5zZXRQbHVnaW5TdGF0dXMoci5pZCxnKSxwLnN1Y2Nlc3MoYCR7X33miJDlip9g
LHtpZDp2fSksaigpfWNhdGNoKFMpe3AuZXJyb3IoUy5tZXNzYWdlLHtpZDp2fSl9fSxDPWFzeW5j
IHI9Pm5ldyBQcm9taXNlKChnLF8pPT57bGV0IHY9ITE7dS5jb25maXJtKHt0aXRsZToi5Y246L29
5o+S5Lu2Iixjb250ZW50OmUuanN4cygiZGl2Iix7Y2xhc3NOYW1lOiJmbGV4IGZsZXgtY29sIGdh
cC0yIixjaGlsZHJlbjpbZS5qc3hzKCJwIix7Y2xhc3NOYW1lOiJ0ZXh0LWJhc2UgdGV4dC1kZWZh
dWx0LTgwMCIsY2hpbGRyZW46WyLnoa7lrpropoHljbjovb3mj5Lku7bjgIwiLGUuanN4KCJzcGFu
Iix7Y2xhc3NOYW1lOiJmb250LXNlbWlib2xkIHRleHQtZGFuZ2VyIixjaGlsZHJlbjpyLm5hbWV9
KSwi44CN5ZCXPyDmraTmk43kvZzkuI3lj6/mgaLlpI3jgIIiXX0pLGUuanN4cygiZGl2Iix7Y2xh
c3NOYW1lOiJtdC0yIGJnLWRlZmF1bHQtMTAwIGRhcms6YmctZGVmYXVsdC01MC8xMCBwLTMgcm91
bmRlZC1sZyBmbGV4IGZsZXgtY29sIGdhcC0xIixjaGlsZHJlbjpbZS5qc3hzKCJsYWJlbCIse2Ns
YXNzTmFtZToiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIgY3Vyc29yLXBvaW50ZXIgdy1maXQiLGNo
aWxkcmVuOltlLmpzeCgiaW5wdXQiLHt0eXBlOiJjaGVja2JveCIsb25DaGFuZ2U6Uz0+e3Y9Uy50
YXJnZXQuY2hlY2tlZH0sY2xhc3NOYW1lOiJ3LTQgaC00IGN1cnNvci1wb2ludGVyIGFjY2VudC1k
YW5nZXIifSksZS5qc3goInNwYW4iLHtjbGFzc05hbWU6InRleHQtc21hbGwgZm9udC1tZWRpdW0g
dGV4dC1kZWZhdWx0LTcwMCIsY2hpbGRyZW46IuWQjOaXtuWIoOmZpOWFtumFjee9ruaWh+S7tiJ9
KV19KSxlLmpzeHMoInAiLHtjbGFzc05hbWU6InRleHQteHMgdGV4dC1kZWZhdWx0LTUwMCBwbC02
IGJyZWFrLWFsbCB3LWZ1bGwiLGNoaWxkcmVuOlsi6YWN572u55uu5b2VOiBjb25maWcvcGx1Z2lu
cy8iLHIuaWRdfSldfSldfSksY29uZmlybVRleHQ6IuehruWumuWNuOi9vSIsY2FuY2VsVGV4dDoi
5Y+W5raIIixvbkNvbmZpcm06YXN5bmMoKT0+e2NvbnN0IFM9cC5sb2FkaW5nKCLljbjovb3kuK0u
Li4iKTt0cnl7YXdhaXQgRS51bmluc3RhbGxQbHVnaW4oci5pZCx2KSxwLnN1Y2Nlc3MoIuWNuOi9
veaIkOWKnyIse2lkOlN9KSxqKCksZygpfWNhdGNoKEkpe3AuZXJyb3IoSS5tZXNzYWdlLHtpZDpT
fSksXyhJKX19LG9uQ2FuY2VsOigpPT57ZygpfX0pfSksUD1yPT57eihyLmlkKSx5KCl9O3JldHVy
biBlLmpzeHMoZS5GcmFnbWVudCx7Y2hpbGRyZW46W2UuanN4KCJ0aXRsZSIse2NoaWxkcmVuOiLm
j5Lku7bnrqHnkIYgLSBOYXBDYXQgV2ViVUkifSksZS5qc3hzKCJkaXYiLHtjbGFzc05hbWU6InAt
MiBtZDpwLTQgcmVsYXRpdmUiLGNoaWxkcmVuOltlLmpzeCh0ZSx7bG9hZGluZzpvfSksZS5qc3go
cGUse2lzT3BlbjpmLG9uT3BlbkNoYW5nZTp3LHBsdWdpbklkOlJ9KSxlLmpzeHMoImRpdiIse2Ns
YXNzTmFtZToiZmxleCBtYi02IGl0ZW1zLWNlbnRlciBnYXAtNCIsY2hpbGRyZW46W2UuanN4KCJo
MSIse2NsYXNzTmFtZToidGV4dC0yeGwgZm9udC1ib2xkIixjaGlsZHJlbjoi5o+S5Lu2566h55CG
In0pLGUuanN4KE0se2lzSWNvbk9ubHk6ITAsY2xhc3NOYW1lOiJiZy1kZWZhdWx0LTEwMC81MCBo
b3ZlcjpiZy1kZWZhdWx0LTIwMC81MCB0ZXh0LWRlZmF1bHQtNzAwIGJhY2tkcm9wLWJsdXItbWQi
LHJhZGl1czoiZnVsbCIsb25QcmVzczpOLHRpdGxlOiLph43ovb3mnKzlnLDmj5Lku7bnm67lvZUi
LGNoaWxkcmVuOmUuanN4KG5lLHtzaXplOjI0fSl9KSxlLmpzeChNLHtjb2xvcjoicHJpbWFyeSIs
dmFyaWFudDoic29saWQiLHJhZGl1czoiZnVsbCIsb25QcmVzczpMLGNoaWxkcmVuOiLlr7zlhaXm
j5Lku7YifSksZS5qc3goImlucHV0Iix7cmVmOlUsdHlwZToiZmlsZSIsYWNjZXB0OiIuemlwIixj
bGFzc05hbWU6ImhpZGRlbiIsb25DaGFuZ2U6cX0pXX0pLGg/ZS5qc3hzKCJkaXYiLHtjbGFzc05h
bWU6ImZsZXggZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG1pbi1oLVs0MDBw
eF0gdGV4dC1jZW50ZXIiLGNoaWxkcmVuOltlLmpzeCgiZGl2Iix7Y2xhc3NOYW1lOiJ0ZXh0LTZ4
bCBtYi00IixjaGlsZHJlbjoi8J+TpiJ9KSxlLmpzeCgiaDIiLHtjbGFzc05hbWU6InRleHQteGwg
Zm9udC1zZW1pYm9sZCB0ZXh0LWRlZmF1bHQtNzAwIGRhcms6dGV4dC13aGl0ZS85MCBtYi0yIixj
aGlsZHJlbjoi5peg5o+S5Lu25Yqg6L29In0pLGUuanN4KCJwIix7Y2xhc3NOYW1lOiJ0ZXh0LWRl
ZmF1bHQtNTAwIGRhcms6dGV4dC13aGl0ZS82MCBtYXgtdy1tZCIsY2hpbGRyZW46IuaPkuS7tueu
oeeQhuWZqOacquWKoOi9ve+8jOivt+ajgOafpSBwbHVnaW5zIOebruW9leaYr+WQpuWtmOWcqCJ9
KV19KTphLmxlbmd0aD09PTA/ZS5qc3goImRpdiIse2NsYXNzTmFtZToidGV4dC1kZWZhdWx0LTQw
MCIsY2hpbGRyZW46IuaaguaXtuayoeacieWuieijheaPkuS7tiJ9KTplLmpzeCgiZGl2Iix7Y2xh
c3NOYW1lOiJncmlkIGdyaWQtY29scy0xIG1kOmdyaWQtY29scy0yIGxnOmdyaWQtY29scy0zIHhs
OmdyaWQtY29scy00IDJ4bDpncmlkLWNvbHMtNSBqdXN0aWZ5LXN0YXJ0IGl0ZW1zLXN0cmV0Y2gg
Z2FwLXgtMiBnYXAteS00IixjaGlsZHJlbjphLm1hcChyPT5lLmpzeChoZSx7ZGF0YTpyLG9uVG9n
Z2xlU3RhdHVzOigpPT5rKHIpLG9uVW5pbnN0YWxsOigpPT5DKHIpLG9uQ29uZmlnOigpPT57ci5z
dGF0dXMhPT0iYWN0aXZlIj9wLmVycm9yKCLmnKrlkK/nlKjmj5Lku7bvvIzml6Dms5XphY3nva7m
j5Lku7YiKTpyLmhhc0NvbmZpZz9QKHIpOnAuZXJyb3IoIuatpOaPkuS7tuayoeaciemFjee9ruWT
piIpfSxoYXNDb25maWc6ITB9LHIuaWQpKX0pXX0pXX0pfWV4cG9ydHtBZSBhcyBkZWZhdWx0fTsK
__MK_EMBED_END__
__MK_EMBED_FILE__:plugin_manager-NCp3.js__
aW1wb3J0e3EgYXMgbn1mcm9tIi4vaW5kZXgtQmZNbTRQUnYuanMiO2NsYXNzIG97c3RhdGljIGFz
eW5jIGdldFBsdWdpbkxpc3QoKXtjb25zdHtkYXRhOnR9PWF3YWl0IG4uZ2V0KCIvUGx1Z2luL0xp
c3QiKTtyZXR1cm4gdC5kYXRhfXN0YXRpYyBhc3luYyByZWdpc3RlclBsdWdpbk1hbmFnZXIoKXtj
b25zdHtkYXRhOnR9PWF3YWl0IG4ucG9zdCgiL1BsdWdpbi9SZWdpc3Rlck1hbmFnZXIiKTtyZXR1
cm4gdC5kYXRhfXN0YXRpYyBhc3luYyByZWxvYWRQbHVnaW5zKCl7Y29uc3R7ZGF0YTp0fT1hd2Fp
dCBuLnBvc3QoIi9QbHVnaW4vUmVsb2FkIik7cmV0dXJuIHQuZGF0YX1zdGF0aWMgYXN5bmMgc2V0
UGx1Z2luU3RhdHVzKHQsYSl7YXdhaXQgbi5wb3N0KCIvUGx1Z2luL1NldFN0YXR1cyIse2lkOnQs
ZW5hYmxlOmF9KX1zdGF0aWMgYXN5bmMgdW5pbnN0YWxsUGx1Z2luKHQsYSl7YXdhaXQgbi5wb3N0
KCIvUGx1Z2luL1VuaW5zdGFsbCIse2lkOnQsY2xlYW5EYXRhOmF9KX1zdGF0aWMgYXN5bmMgaW1w
b3J0TG9jYWxQbHVnaW4odCl7Y29uc3QgYT1uZXcgRm9ybURhdGE7YS5hcHBlbmQoInBsdWdpbiIs
dCk7Y29uc3R7ZGF0YTppfT1hd2FpdCBuLnBvc3QoIi9QbHVnaW4vSW1wb3J0IixhLHtoZWFkZXJz
OnsiQ29udGVudC1UeXBlIjoibXVsdGlwYXJ0L2Zvcm0tZGF0YSJ9LHRpbWVvdXQ6NmU0fSk7cmV0
dXJuIGkuZGF0YX1zdGF0aWMgYXN5bmMgZ2V0UGx1Z2luU3RvcmVMaXN0KHQ9ITEpe2NvbnN0IGE9
dD97Zm9yY2VSZWZyZXNoOiJ0cnVlIn06e30se2RhdGE6aX09YXdhaXQgbi5nZXQoIi9QbHVnaW4v
U3RvcmUvTGlzdCIse3BhcmFtczphfSk7cmV0dXJuIGkuZGF0YX1zdGF0aWMgYXN5bmMgZ2V0UGx1
Z2luU3RvcmVEZXRhaWwodCl7Y29uc3R7ZGF0YTphfT1hd2FpdCBuLmdldChgL1BsdWdpbi9TdG9y
ZS9EZXRhaWwvJHt0fWApO3JldHVybiBhLmRhdGF9c3RhdGljIGFzeW5jIGluc3RhbGxQbHVnaW5G
cm9tU3RvcmUodCxhKXthd2FpdCBuLnBvc3QoIi9QbHVnaW4vU3RvcmUvSW5zdGFsbCIse2lkOnQs
bWlycm9yOmF9LHt0aW1lb3V0OjNlNX0pfXN0YXRpYyBhc3luYyBnZXRQbHVnaW5Db25maWcodCl7
Y29uc3R7ZGF0YTphfT1hd2FpdCBuLmdldCgiL1BsdWdpbi9Db25maWciLHtwYXJhbXM6e2lkOnR9
fSk7cmV0dXJuIGEuZGF0YX1zdGF0aWMgYXN5bmMgc2V0UGx1Z2luQ29uZmlnKHQsYSl7YXdhaXQg
bi5wb3N0KCIvUGx1Z2luL0NvbmZpZyIse2lkOnQsY29uZmlnOmF9KX1zdGF0aWMgYXN5bmMgbm90
aWZ5Q29uZmlnQ2hhbmdlKHQsYSxpLHMsZSl7YXdhaXQgbi5wb3N0KCIvUGx1Z2luL0NvbmZpZy9D
aGFuZ2UiLHtpZDp0LHNlc3Npb25JZDphLGtleTppLHZhbHVlOnMsY3VycmVudENvbmZpZzplfSl9
c3RhdGljIGdldENvbmZpZ1NTRVVybCh0LGEpe2NvbnN0IGk9bmV3IFVSTFNlYXJjaFBhcmFtcyh7
aWQ6dH0pO3JldHVybiBhJiZpLnNldCgiY29uZmlnIixKU09OLnN0cmluZ2lmeShhKSksYC9hcGkv
UGx1Z2luL0NvbmZpZy9TU0U/JHtpLnRvU3RyaW5nKCl9YH19ZXhwb3J0e28gYXMgUH07Cg==
__MK_EMBED_END__
__MK_EMBEDDED_PATCHES__
