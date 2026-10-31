#!/bin/bash
# mk - Linux 服务器 / Termux（安卓手机）管理工具

set -euo pipefail

# 保存原始命令行参数，供自更新后重载时透传使用
MK_ORIG_ARGS=("$@")

readonly MK_VERSION="2.18.0"

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

# ==================== 着色 ====================
# 与 src/core/console-style.ts / start.sh 同一套规则：只在**屏幕**上带 ANSI 控制符。
# NO_COLOR 或 stdout 不是终端（重定向到文件 / 走管道 / systemd 捕获）时全部留空——
# 否则 \033[0;31m 会被写进 /var/log/mk-tools 下的日志，在控制台「日志」页里显示成乱码。
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    readonly RED=$'\033[0;31m'
    readonly GREEN=$'\033[0;32m'
    readonly YELLOW=$'\033[1;33m'
    readonly BLUE=$'\033[0;34m'
    readonly CYAN=$'\033[0;36m'
    readonly BOLD=$'\033[1m'
    readonly NC=$'\033[0m'
    # 进度条/面板用的「光标上移 + 清行」；非终端下留空，宁可多打几行也不要写脏控制符
    readonly MK_CLEAR_LINE=$'\033[1A\033[2K'
else
    readonly RED=''
    readonly GREEN=''
    readonly YELLOW=''
    readonly BLUE=''
    readonly CYAN=''
    readonly BOLD=''
    readonly NC=''
    readonly MK_CLEAR_LINE=''
fi

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

# ==================== 镜像源延迟测速 ====================
# 选镜像时逐个节点探活并把延迟显示在名字后面：低=绿、中=黄、高/失败=红。
# 探测目标是一个 13 字节的小文件，并带 --range 0-0 只取 1 字节，
# 所以耗时 ≈ 到该节点（含回源首字节）的网络往返，够用来比较快慢。
readonly MK_PROBE_TARGET="https://raw.githubusercontent.com/octocat/Hello-World/master/README"
readonly MK_PROBE_NODE_TARGET="index.json"
# 咔咔珂源码版走的是 api.github.com（releases/latest + tarball），单独用 API 根地址探活：
# 它固定返回 200，不依赖仓库有没有正式版，正好代表那条线路
readonly MK_PROBE_API_TARGET="https://api.github.com/"
readonly MK_PROBE_TIMEOUT=4
readonly MK_PROBE_FAST_MS=800
readonly MK_PROBE_MID_MS=2000

# 镜像前缀 + 目标 URL（前缀为空 = 直连；前缀末尾的 / 统一去掉再拼）
mk_mirror_join_url() {
    local prefix="${1:-}" target="$2"
    prefix="${prefix%/}"
    if [[ -z "$prefix" ]]; then
        printf '%s' "$target"
    else
        printf '%s/%s' "$prefix" "$target"
    fi
}

# 探测单个 URL：成功输出毫秒整数，失败输出空串（始终返回 0，方便 set -e 下取值）
mk_mirror_latency_ms() {
    local url="$1" out="" code="" t="" sec="" frac=""
    command -v curl >/dev/null 2>&1 || { printf ''; return 0; }
    out="$(curl -sS -L -o /dev/null \
        --connect-timeout "$MK_PROBE_TIMEOUT" --max-time "$MK_PROBE_TIMEOUT" \
        --range 0-0 -A 'mk-tools' \
        -w '%{http_code} %{time_total}' "$url" 2>/dev/null || true)"
    code="${out%% *}"
    t="${out##* }"
    [[ "$code" =~ ^[23] ]] || { printf ''; return 0; }
    [[ "$t" =~ ^[0-9]+\.[0-9]+$ ]] || { printf ''; return 0; }
    sec="${t%%.*}"
    frac="${t#*.}000"
    printf '%s' "$(( sec * 1000 + 10#${frac:0:3} ))"
    return 0
}

# 毫秒数 → 彩色文本（低绿 / 中黄 / 高或失败红）
mk_mirror_latency_text() {
    local ms="${1:-}"
    if [[ ! "$ms" =~ ^[0-9]+$ ]]; then
        printf '%s' "${RED}测速失败${NC}"
    elif (( ms <= MK_PROBE_FAST_MS )); then
        printf '%s' "${GREEN}${ms} ms${NC}"
    elif (( ms <= MK_PROBE_MID_MS )); then
        printf '%s' "${YELLOW}${ms} ms${NC}"
    else
        printf '%s' "${RED}${ms} ms${NC}"
    fi
}

# 测速说明（测速开始 / 结果已缓存两种口吻）
mk_mirror_probe_hint() {
    echo -e "  ${CYAN}正在逐个节点测速（每项最多等 ${MK_PROBE_TIMEOUT} 秒）… 绿 ≤ ${MK_PROBE_FAST_MS}ms · 黄 ≤ ${MK_PROBE_MID_MS}ms · 红 = 偏慢或不通${NC}"
}

mk_mirror_probe_done_hint() {
    echo -e "  ${CYAN}上面是本次测速结果（觉得不准就选「重新测速」再跑一遍，也可以直接按 r）${NC}"
}

# 所有节点都测不通时提醒一句（也可能只是本机访问不了 GitHub 家族域名）
mk_mirror_probe_warn_if_all_failed() {
    local ms="" any=0
    for ms in "$@"; do
        [[ "$ms" =~ ^[0-9]+$ ]] && any=1
    done
    if (( any == 0 )); then
        warn "全部节点都测速失败了？可能是本机访问不了 GitHub 家族域名，测速结果仅供参考 喵"
    fi
}

# 按前缀在「标签数组 / 前缀数组」里反查镜像名（$1=标签数组名 $2=前缀数组名 $3=前缀）
mk_mirror_label_of() {
    local labels_name="$1" urls_name="$2" prefix="${3:-}" i=0
    local -n _mk_labels="$labels_name"
    local -n _mk_urls="$urls_name"
    for ((i=0; i<${#_mk_urls[@]}; i++)); do
        if [[ "${_mk_urls[$i]}" == "$prefix" ]]; then
            printf '%s' "${_mk_labels[$i]}"
            return 0
        fi
    done
    printf '%s' "${prefix:-直连 GitHub}"
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
        error "此操作需要 root 权限，请使用: sudo mk"
        return 1
    fi
}

# 仅限 Linux 服务器的功能（宝塔 / NapCat / snowLuma / 字体等）在 Termux 上统一拦住，
# 并说清原因，免得用户在手机上反复试。
mk_require_server() {
    if mk_is_termux; then
        title "该功能仅限 Linux 服务器"
        warn "${1:-此功能依赖 root、systemd 或桌面图形环境} 喵"
        echo
        echo "  当前环境: $(mk_platform_label) · 无 root、无 systemd、无 X11 桌面"
        echo "  手机上可用: 「咔咔珂操作」「端口验证」「开机自启（Termux:Boot）」「字体检测（仅检测）」"
        echo
        press_enter
        return 1
    fi
    return 0
}

press_enter() {
    echo
    read -r -p "按 Enter 继续"
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
    local prompt="${2:-请选择}"
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
        error "脚本语法检查失败: $target"
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
            error "找不到 mk 脚本源文件: ${SELF_PATH}"
            return 1
        fi
    fi

    if ! tr -d '\r' < "$source_path" > "$tmp"; then
        rm -f "$tmp"
        error "无法读取脚本: ${source_path}"
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

    # systemd 服务只在服务器上用得到，Termux 直接跳过
    if ! mk_is_termux; then
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

    info "mk 工具已安装/更新完成 版本: ${MK_VERSION} 喵"
    info "运行平台: $(mk_platform_label) 喵"
    info "安装路径: ${INSTALL_DIR}/${SCRIPT_FILE} 喵"
    info "全局命令: mk / MK / Mk / mK（大小写均可） 喵"
    if mk_is_termux; then
        info "命令目录: ${INSTALL_BIN_DIR}（Termux 无 systemd，开机自启走 Termux:Boot） 喵"
    fi
}

uninstall_self() {
    require_root || return 1

    local confirm=""
    read -r -p "确认卸载 mk 工具? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        info "已取消卸载 喵"
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

    info "mk 工具已卸载 喵"
    info "日志目录保留在: ${LOG_DIR} 喵"
}

auto_install_if_needed() {
    local installed="${INSTALL_DIR}/${SCRIPT_FILE}"
    if [[ "$SELF_PATH" != "$installed" ]]; then
        if [[ ! -f "$SELF_PATH" ]]; then
            if [[ -f "$installed" ]]; then
                return 0
            fi
            error "找不到 mk 脚本: ${SELF_PATH}"
            exit 1
        fi
        if ! mk_is_termux && [[ $EUID -ne 0 ]]; then
            error "首次安装需要 root 权限"
            echo "请执行: sudo bash $(basename "$SELF_PATH")"
            exit 1
        fi
        title "MK 工具 - 安装/更新"
        install_self || exit 1
        info "现在可以直接输入 mk / MK 使用菜单 喵"
    fi
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
        printf '%s' "$MK_CLEAR_LINE"
    done
}

baota_draw_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  宝塔安装进度"
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
            info "宝塔已装好 喵"
            return 0
        fi
        warn "当前没有正在进行的宝塔安装任务 喵"
        return 1
    fi

    pid="$(cat "$BAOTA_PID")"
    start_ts="$(baota_get_start_time)"

    echo
    info "正在跟踪宝塔安装进度，进程号=${pid} 喵"
    info "日志文件: ${BAOTA_LOG} 喵"
    info "按 Ctrl+C 可退出监听，后台安装不会停止 喵"
    echo

    trap 'echo; info "已退出监听，安装仍在后台继续 喵"; trap - INT; return 0' INT

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
        info "宝塔已装好，可使用菜单查看登录密码 喵"
        baota_clear_install_state
        return 0
    fi

    if (( panel_active == 1 )); then
        baota_panel_cursor_up
    fi
    baota_draw_progress_panel "$last_percent" "$stage" "$elapsed" ".."
    echo
    warn "安装进程已结束，请查看日志确认结果 喵"
    info "日志: tail -f ${BAOTA_LOG} 喵"
    return 0
}

BAOTA_INSTALL_URL=""
BAOTA_INSTALL_LABEL=""

menu_baota_select_stable() {
    while true; do
        title "宝塔稳定版"
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
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_baota_select_version() {
    while true; do
        title "选择宝塔安装版本"
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
            *) warn "无法识别该选项，请重新输入 喵" ;;
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
        warn "小MK发现宝塔已装好 喵"
        read -r -p "是否重新安装? [y/N]: " reinstall
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

    info "正在后台启动宝塔安装: ${BAOTA_INSTALL_LABEL} 喵"

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
        error "宝塔还没装"
        if [[ -f "$BAOTA_LOG" ]]; then
            info "最近安装日志末尾 10 行 喵"
            tail -10 "$BAOTA_LOG" 2>/dev/null || true
        fi
        if baota_install_running; then
            warn "宝塔正在后台安装 喵"
            baota_watch_install
        fi
        return 1
    fi

    local raw="" line=""
    local panel_url="" panel_inner="" username="" password=""

    raw="$(baota_fetch_default_output)" || {
        error "找不到 bt 命令"
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

    title "宝塔面板登录信息"
    echo "  面板地址: ${panel_url:-未获取到}"
    if [[ -n "$panel_inner" && "$panel_inner" != "$panel_url" ]]; then
        echo "  内网地址: ${panel_inner}"
    fi
    echo "  用户名:   ${username:-未获取到}"
    echo "  密码:     ${password:-未获取到}"
    echo
    warn "若无法访问，请在安全组放行面板端口 喵"
}

show_nav_hint() {
    echo -e "${YELLOW}  [0] 返回首页    [1] 返回上一步${NC}"
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
        info "小MK发现宝塔正在后台安装，正在找回进度显示 喵"
        baota_watch_install
        echo
    fi

    while true; do
        title "宝塔操作"
        show_nav_hint
        echo "  [2] 安装宝塔-后台安装"
        echo "  [3] 查看宝塔登录密码"
        if baota_install_running; then
            echo "  [4] 查看安装进度"
            echo
            echo -e "  ${YELLOW}* 宝塔正在后台安装${NC}"
        elif is_baota_installed; then
            echo
            echo -e "  ${GREEN}* 宝塔已装好${NC}"
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
                    warn "当前没有安装任务 喵"
                fi
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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

# ==================== NapCat Docker 多开 ====================
# NapCat 官方 Shell 版不支持单框架多开（一个框架实例只能登一个 QQ），
# 要在一台机器上跑多个 QQ 机器人，只能每个账号起一个 Docker 容器 —— 这就是 Docker 版存在的意义。
readonly NAPCAT_DOCKER_IMAGE="mlikiowa/napcat-docker:latest"
readonly NAPCAT_DOCKER_NAME_PREFIX="napcat-"
# 容器清单：每行一个 QQ 号（容器名 = 前缀 + QQ 号），增删容器时同步维护
readonly NAPCAT_CONTAINERS_FILE="${LOG_DIR}/napcat-containers"
readonly NAPCAT_WEBUI_PORT_BASE=6099
readonly NAPCAT_WS_PORT_BASE=3001
readonly NAPCAT_HTTP_PORT_BASE=3000

# Docker Hub 镜像加速前缀（国内拉不动官方源时用；0 = 直连）
NAPCAT_DOCKER_MIRROR_INDEX="0"
napcat_docker_mirror_labels=(
    "直连 Docker Hub (国外/可访问 Docker Hub 的服务器)"
    "docker.1ms.run"
    "docker.xuanyuan.me"
    "docker.mybacc.com"
    "dytt.online"
    "lispy.org"
)
napcat_docker_mirror_prefixes=(
    ""
    "docker.1ms.run"
    "docker.xuanyuan.me"
    "docker.mybacc.com"
    "dytt.online"
    "lispy.org"
)

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
    if napcat_docker_has_any; then
        return 0
    fi
    napcat_detect_paths || return 1
    [[ -n "$NAPCAT_QQ_BIN" ]]
}

napcat_is_running() {
    if napcat_docker_has_any; then
        if napcat_docker_any_running; then
            return 0
        fi
    fi
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
    local has_docker=0 has_shell=0

    if napcat_docker_has_any; then
        has_docker=1
    fi
    if napcat_detect_paths && [[ -n "$NAPCAT_QQ_BIN" ]]; then
        has_shell=1
    fi

    if (( has_docker == 1 )); then
        if (( has_shell == 1 )); then
            echo "Docker + Shell"
        else
            echo "Docker"
        fi
        return 0
    fi

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
        info "已通过 ufw 放行 ${port} 端口 喵"
    elif command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        info "已通过 firewalld 放行 ${port} 端口 喵"
    elif command -v iptables >/dev/null 2>&1; then
        iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || \
            iptables -I INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || true
        info "已通过 iptables 放行 ${port} 端口 喵"
    else
        warn "小MK没找到常见防火墙，手动放行 ${port} 端口 喵"
    fi
    warn "请在云服务商安全组放行 ${port} 端口 喵"
}

napcat_firewall_close_port() {
    local port="$1"
    [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]] && return 1

    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi active; then
        ufw delete allow "${port}/tcp" >/dev/null 2>&1 || true
        info "已通过 ufw 关闭 ${port} 端口 喵"
    elif command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --permanent --remove-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        info "已通过 firewalld 关闭 ${port} 端口 喵"
    elif command -v iptables >/dev/null 2>&1; then
        while iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; do
            iptables -D INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1 || break
        done
        info "已通过 iptables 关闭 ${port} 端口 喵"
    else
        warn "小MK没找到常见防火墙，手动关闭 ${port} 端口 喵"
    fi
}

napcat_open_port_6099() {
    napcat_firewall_open_port 6099
}

napcat_show_login_info() {
    if napcat_docker_has_any; then
        napcat_docker_show_login_info
        return 0
    fi

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

    title "NapCat WebUI 登录信息"
    echo "  面板地址: ${url}"
    echo "  登录密钥: ${token:-未获取到，请先启动框架或查看日志}"
    if [[ -f "$NAPCAT_VER_FILE" ]]; then
        echo "  安装版本: $(cat "$NAPCAT_VER_FILE" 2>/dev/null || echo 未知)"
    fi
    echo
    warn "若无法访问，请在安全组放行 ${port} 端口 喵"
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
        printf '%s' "$MK_CLEAR_LINE"
    done
}

napcat_draw_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  NapCat 安装进度"
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
            info "NapCat 已装好 喵"
            return 0
        fi
        warn "当前没有正在进行的 NapCat 安装任务 喵"
        return 1
    fi

    pid="$(cat "$NAPCAT_INSTALL_PID")"
    start_ts="$(napcat_get_install_start_time)"

    echo
    info "正在跟踪 NapCat 安装进度，进程号=${pid} 喵"
    info "日志文件: ${NAPCAT_INSTALL_LOG} 喵"
    info "按 Ctrl+C 可退出监听，后台安装不会停止 喵"
    echo

    trap 'echo; info "已退出监听，安装仍在后台继续 喵"; trap - INT; return 0' INT

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
        info "NapCat 已装好，已开放 6099 端口 喵"
        info "未自动启动，请使用菜单「启动框架」手动启动 喵"
        napcat_clear_install_state
        return 0
    fi

    if (( panel_active == 1 )); then
        napcat_panel_cursor_up
    fi
    napcat_draw_progress_panel "$last_percent" "$stage" "$elapsed" ".."
    echo
    warn "安装进程已结束，请查看日志确认结果 喵"
    info "日志: tail -f ${NAPCAT_INSTALL_LOG} 喵"
    return 0
}

menu_napcat_select_version() {
    while true; do
        title "选择 NapCat 安装版本"
        show_nav_hint
        echo "  [2] 最新版 (官方一键脚本)"
        echo "  [3] v4.18.5 (插件最后支持)"
        echo "  [4] v4.17.23 (支持上传插件)"
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
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# 安装方式选择：Docker（可多开，每账号一个容器）还是 Shell（官方一键脚本，单账号）。
menu_napcat_select_mode() {
    NAPCAT_INSTALL_MODE=""
    while true; do
        title "选择 NapCat 安装方式"
        show_nav_hint
        echo "  [2] Docker 安装"
        echo "  [3] Shell 直接安装"
        echo
        echo "提示：NapCat 不支持单框架多开，一台机器要跑多个 QQ 机器人"
        echo "  只能 Docker 每个账号一个容器"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) NAPCAT_INSTALL_MODE="docker"; return 0 ;;
            3) NAPCAT_INSTALL_MODE="native"; return 0 ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# Docker 镜像加速源选择（国内拉不动 Docker Hub 时用）
menu_napcat_select_docker_mirror() {
    local i=0 idx=0
    while true; do
        title "选择 Docker 镜像加速源"
        show_nav_hint
        echo "  国内服务器拉不动 Docker Hub 时，选一个加速源"
        echo
        for ((i=0; i<${#napcat_docker_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            echo "  [${idx}] ${napcat_docker_mirror_labels[$i]}"
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
                    if (( idx >= 0 && idx < ${#napcat_docker_mirror_labels[@]} )); then
                        NAPCAT_DOCKER_MIRROR_INDEX="$idx"
                        info "已选择: ${napcat_docker_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

menu_napcat_select_mirror() {
    local i=0
    local idx=0
    local ms=""
    local do_probe=0
    local probed=0
    local -a lat=()

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择下载镜像源"
        show_nav_hint
        echo "  国内服务器若无法访问 GitHub，请选择镜像源"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo

        for ((i=0; i<${#napcat_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${napcat_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                # 先把节点名打出来，测完再把延迟接在同一行（一个一个测）
                printf '  [%s] %s  ' "$idx" "${napcat_mirror_labels[$i]}"
                ms="$(mk_mirror_latency_ms "$(mk_mirror_join_url "${napcat_mirror_urls[$i]}" "$MK_PROBE_TARGET")")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${napcat_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#napcat_mirror_labels[@]} + 2 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#napcat_mirror_labels[@]} + 2 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#napcat_mirror_labels[@]} )); then
                        NAPCAT_PROXY_INDEX="$idx"
                        info "已选择: ${napcat_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

napcat_do_install() {
    if napcat_install_running; then
        napcat_watch_install
        return $?
    fi

    menu_napcat_select_mode || return 0
    if mk_nav_bubble_up; then
        return 0
    fi
    if [[ "$NAPCAT_INSTALL_MODE" == "docker" ]]; then
        napcat_do_install_docker
        return $?
    fi

    # 以下为 Shell（native）安装分支
    if napcat_detect_paths && [[ -n "$NAPCAT_QQ_BIN" ]]; then
        local reinstall=""
        warn "小MK发现 NapCat（Shell 版）已装好 喵"
        read -r -p "是否重新安装? [y/N]: " reinstall
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

    info "正在后台启动 NapCat 安装: ${NAPCAT_VERSION_LABEL} 喵"

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

# ==================== NapCat Docker 容器管理 ====================

# 列出已登记的容器 QQ 号（一行一个）；无则无输出。
# 自动发现 docker 里所有 NapCat 容器名（按镜像名匹配，含手动安装的容器）
napcat_docker_discover() {
    docker ps -a --format '{{.Names}}\t{{.Image}}' 2>/dev/null \
        | awk -F'\t' 'tolower($2) ~ /napcat/ {print $1}'
}

# 返回所有 NapCat Docker 容器名（清单 ∪ 自动发现，去重）。
# 清单兼容旧格式：纯数字的一行视为 QQ 号，转成 napcat-<QQ>。
napcat_docker_list() {
    {
        if [[ -f "$NAPCAT_CONTAINERS_FILE" ]]; then
            local raw line name
            raw="$(grep -vE '^[[:space:]]*(#|$)' "$NAPCAT_CONTAINERS_FILE" 2>/dev/null | tr -d '\r' || true)"
            while IFS= read -r line; do
                line="${line%%#*}"
                line="${line//[[:space:]]/}"
                if [[ -z "$line" ]]; then
                    continue
                fi
                if [[ "$line" =~ ^[0-9]{5,15}$ ]]; then
                    name="$(napcat_docker_name "$line")"
                else
                    name="$line"
                fi
                printf '%s\n' "$name"
            done < <(printf '%s\n' "$raw")
        fi
        napcat_docker_discover
    } | sort -u
}

# QQ 号 → 容器名
napcat_docker_name() {
    printf '%s%s' "$NAPCAT_DOCKER_NAME_PREFIX" "${1:-}"
}

# 容器名 → QQ 号（仅 napcat-<QQ> 格式）；手动容器名不符时返回空
napcat_docker_qq_of() {
    local name="${1:-}"
    if [[ "$name" =~ ^napcat-([0-9]+)$ ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}

# 只返回清单里登记的容器名（mk 自己建的；不含自动发现的手动容器）
napcat_docker_list_registered() {
    [[ -f "$NAPCAT_CONTAINERS_FILE" ]] || return 0
    local raw line name
    raw="$(grep -vE '^[[:space:]]*(#|$)' "$NAPCAT_CONTAINERS_FILE" 2>/dev/null | tr -d '\r' || true)"
    while IFS= read -r line; do
        line="${line%%#*}"
        line="${line//[[:space:]]/}"
        if [[ -z "$line" ]]; then
            continue
        fi
        if [[ "$line" =~ ^[0-9]{5,15}$ ]]; then
            name="$(napcat_docker_name "$line")"
        else
            name="$line"
        fi
        printf '%s\n' "$name"
    done < <(printf '%s\n' "$raw")
}

napcat_docker_count() {
    local n
    n="$(napcat_docker_list | grep -c . || true)"
    printf '%s' "${n:-0}"
}

napcat_docker_has_any() {
    [[ "$(napcat_docker_count)" -gt 0 ]]
}

# 容器是否存在（参数：容器名）
napcat_docker_exists() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

# 容器是否 running（参数：容器名）
napcat_docker_running() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

# 有没有任一容器在跑
napcat_docker_any_running() {
    local name
    while IFS= read -r name; do
        if [[ -n "$name" ]] && napcat_docker_running "$name"; then
            return 0
        fi
    done < <(napcat_docker_list)
    return 1
}

# 在 [base, base+50] 里找第一个宿主机空闲端口；找不到返回 1
napcat_docker_free_port() {
    local base="${1:-}" p
    if [[ ! "$base" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    local ss_ok=0
    if command -v ss >/dev/null 2>&1; then
        ss_ok=1
    fi
    for ((p=base; p<base+50; p++)); do
        if (( ss_ok == 1 )); then
            if ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ":${p}$"; then
                printf '%s' "$p"
                return 0
            fi
        else
            printf '%s' "$p"
            return 0
        fi
    done
    return 1
}

# 记录容器名到清单；已存在则不重复
napcat_docker_register() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    mkdir -p "$LOG_DIR"
    if ! grep -qx "$name" "$NAPCAT_CONTAINERS_FILE" 2>/dev/null; then
        echo "$name" >> "$NAPCAT_CONTAINERS_FILE"
    fi
}

# 从清单移除容器名
napcat_docker_unregister() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    [[ -f "$NAPCAT_CONTAINERS_FILE" ]] || return 0
    local tmp="${NAPCAT_CONTAINERS_FILE}.tmp"
    grep -vx "$name" "$NAPCAT_CONTAINERS_FILE" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$NAPCAT_CONTAINERS_FILE"
}

# 容器内 /root 是镜像自带（700 root:root），补 o+x 才能让容器进程进入挂载点，
# 否则 -v 挂进去的 kakake 数据目录读不到（这就是「挂载已生效但读不到」的根因）。
napcat_docker_fix_mount_perms() {
    local name="${1:-}" p
    docker exec -u 0 "$name" chmod o+x /root >/dev/null 2>&1 || true
    p="${KAKAKE_DATA:-}"
    while [[ -n "$p" && "$p" != "/" ]]; do
        docker exec -u 0 "$name" chmod o+x "$p" >/dev/null 2>&1 || true
        p="$(dirname "$p")"
    done
}

# 重建容器以补挂载咔咔数据目录（保留镜像/端口/环境/挂载 + 新增 kakake 只读挂载）。
# 用 docker commit 固化当前状态作快照镜像再重建，登录态不丢；快照镜像名 napcat-snap-<name>。
napcat_docker_rebuild_with_mount() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi

    info "正在重建容器 ${name} 以补挂载 喵"
    if ! python3 - "$name" "${KAKAKE_DATA}" << 'PYEOF'
import json, subprocess, sys

name = sys.argv[1]
kakake_data = sys.argv[2]

def run(args):
    return subprocess.run(args, capture_output=True, text=True)

raw = run(['docker', 'inspect', name])
if raw.returncode != 0:
    print('无法读取容器配置', file=sys.stderr)
    sys.exit(1)

data = json.loads(raw.stdout)[0]
cfg = data.get('Config', {})
hc = data.get('HostConfig', {})

# 1. 固化快照（保留可写层 = 登录态）
snap = 'napcat-snap-' + name
if run(['docker', 'commit', name, snap]).returncode != 0:
    print('固化容器状态失败', file=sys.stderr)
    sys.exit(1)

# 2. 收集重建参数（subprocess 列表传参，环境变量含空格也安全）
args = ['docker', 'run', '-d', '--name', name]
args += ['--restart', hc.get('RestartPolicy', {}).get('Name') or 'unless-stopped']
net = hc.get('NetworkMode')
if net and net not in ('default', 'bridge', ''):
    args += ['--network', net]
for e in (cfg.get('Env') or []):
    args += ['-e', e]
for cport, bindings in (hc.get('PortBindings') or {}).items():
    for b in bindings:
        hp = b.get('HostPort')
        if hp:
            args += ['-p', hp + ':' + cport]
for m in data.get('Mounts', []):
    if m.get('Type') == 'volume' and m.get('Name'):
        args += ['-v', m['Name'] + ':' + m['Destination']]
    elif m.get('Type') == 'bind':
        ro = ':ro' if not m.get('RW', True) else ''
        args += ['-v', m['Source'] + ':' + m['Destination'] + ro]
args += ['-v', kakake_data + ':' + kakake_data + ':ro']
args += [snap]

# 3. 删原容器 + 用快照镜像重建
run(['docker', 'rm', '-f', name])
r = run(args)
if r.returncode != 0:
    print('重建容器失败: ' + r.stderr.strip(), file=sys.stderr)
    sys.exit(1)

print('REBUILD_OK')
PYEOF
    then
        error "重建容器失败"
        return 1
    fi

    # 容器内 /root 是镜像自带的 700，补 o+x 才能让容器进程进到挂载点
    sleep 2
    napcat_docker_fix_mount_perms "$name" || true

    info "容器 ${name} 已重建并挂载咔咔数据目录，发视频/图片就正常了 喵"
    return 0
}

# 给容器补挂载咔咔数据目录（检测 → 重建 → 权限修复）
napcat_docker_ensure_kakake_mount() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    if ! napcat_docker_exists "$name"; then
        error "容器 ${name} 不存在"
        return 1
    fi

    if [[ -z "${KAKAKE_DATA:-}" || ! -d "${KAKAKE_DATA}" ]]; then
        warn "没找到咔咔数据目录（${KAKAKE_DATA:-未定义}），先装好咔咔再挂载 喵"
        return 1
    fi

    if docker inspect -f '{{range .Mounts}}{{.Source}}{{println}}{{end}}' "$name" 2>/dev/null | grep -qx "${KAKAKE_DATA}"; then
        info "容器 ${name} 已经挂载咔咔数据目录（${KAKAKE_DATA}），无需操作 喵"
        return 0
    fi

    warn "容器 ${name} 还没挂载咔咔数据目录，发视频/图片可能会失败 喵"
    echo "  重建容器，把 ${KAKAKE_DATA} 以相同路径只读挂进去（保留镜像/端口/环境/登录态）"
    local confirm=""
    read -r -p "是否现在重建并挂载? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        info "那就不动 喵"
        return 0
    fi

    napcat_docker_rebuild_with_mount "$name"
}

# Docker 版安装：交互录入 QQ 号，创建独立容器（可重复调用实现多开）。
napcat_do_install_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        warn "没找到 docker 喵"
        local goinst=""
        read -r -p "是否现在自动安装 Docker? [Y/n]: " goinst
        if [[ ! "$goinst" =~ ^[Nn]$ ]]; then
            docker_install || true
        fi
        if ! command -v docker >/dev/null 2>&1; then
            error "还是没有 docker，请先装好 Docker（主菜单 [12]）再选 Docker 模式"
            return 1
        fi
    fi
    if ! docker info >/dev/null 2>&1; then
        error "Docker 守护进程没起来，先启动它（systemctl start docker）"
        return 1
    fi

    local qq=""
    while true; do
        read -r -p "请输入要运行的 QQ 号 (必填): " qq
        qq="$(normalize_choice "$qq")"
        if [[ "$qq" =~ ^[0-9]{5,15}$ ]]; then
            break
        fi
        warn "QQ 号不合法（5~15 位数字），请重新输入 喵"
    done

    local name=""
    name="$(napcat_docker_name "$qq")"
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
        local re=""
        warn "容器 ${name} 已经存在 喵"
        read -r -p "是否删除并重建? [y/N]: " re
        if [[ "$re" =~ ^[Yy]$ ]]; then
            docker rm -f "$name" >/dev/null 2>&1 || true
        else
            info "那就不动了，保持原样 喵"
            return 0
        fi
    fi

    local webui_port ws_port
    webui_port="$(napcat_docker_free_port "$NAPCAT_WEBUI_PORT_BASE" || true)"
    ws_port="$(napcat_docker_free_port "$NAPCAT_WS_PORT_BASE" || true)"

    menu_napcat_select_docker_mirror || return 0
    if mk_nav_bubble_up; then
        return 0
    fi

    local image_ref="$NAPCAT_DOCKER_IMAGE"
    local mirror_prefix="${napcat_docker_mirror_prefixes[$NAPCAT_DOCKER_MIRROR_INDEX]:-}"
    if [[ -n "$mirror_prefix" ]]; then
        image_ref="${mirror_prefix}/${NAPCAT_DOCKER_IMAGE}"
    fi

    info "拉取镜像 ${image_ref} 喵"
    if ! docker pull "$image_ref"; then
        error "拉取镜像失败，换个加速源再试"
        return 1
    fi
    if [[ -n "$mirror_prefix" ]]; then
        docker tag "$image_ref" "$NAPCAT_DOCKER_IMAGE" >/dev/null 2>&1 || true
    fi

    info "创建并启动容器 ${name} 喵"
    local uid gid
    uid="$(id -u)"
    gid="$(id -g)"
    local -a kakake_mount=()
    if [[ -n "${KAKAKE_DATA:-}" && -d "${KAKAKE_DATA}" ]]; then
        # 以相同绝对路径挂载 kakake 数据目录，让容器内 NapCat 能读到 kakake 下载的媒体文件
        kakake_mount=( -v "${KAKAKE_DATA}:${KAKAKE_DATA}:ro" )
    fi

    docker run -d \
        --name "$name" \
        --restart=always \
        -e NAPCAT_UID="${uid}" \
        -e NAPCAT_GID="${gid}" \
        -e TZ=Asia/Shanghai \
        -p "${webui_port}:6099" \
        -p "${ws_port}:3001" \
        -v "napcat-${qq}-config:/app/napcat/config" \
        -v "napcat-${qq}-plugins:/app/napcat/plugins" \
        -v "napcat-${qq}-qq:/app/.config/QQ" \
        ${kakake_mount[@]+"${kakake_mount[@]}"} \
        "$NAPCAT_DOCKER_IMAGE" || return 1

    napcat_docker_register "$name"

    # 等容器起来后补一次挂载点权限，避免 kakake 数据目录读不到
    sleep 2
    napcat_docker_fix_mount_perms "$name" || true

    info "容器 ${name} 已创建 喵"
    info "  WebUI 端口: ${webui_port}  正向WS端口: ${ws_port} 喵"
    info "  登录地址: http://$(napcat_get_server_ip):${webui_port}/webui"
    warn "  登录密钥(WebUi Token)请用「查看登录密钥」读取容器日志 喵"
    return 0
}

# Docker 版登录信息：遍历容器逐个打印 WebUI 地址与 Token；传容器名则只打印单个
napcat_docker_show_login_info() {
    local only_name="${1:-}"
    local host_ip name token port qq
    host_ip="$(napcat_get_server_ip)"
    if [[ -n "$only_name" ]]; then
        title "容器登录信息"
    else
        title "NapCat Docker 容器登录信息"
    fi
    echo
    while IFS= read -r name; do
        if [[ -z "$name" ]]; then
            continue
        fi
        if [[ -n "$only_name" && "$name" != "$only_name" ]]; then
            continue
        fi
        if ! napcat_docker_exists "$name"; then
            continue
        fi
        token="$(docker logs "$name" 2>&1 | grep -oE 'WebUi Token: [A-Za-z0-9_-]+' | tail -1 | awk '{print $NF}' || true)"
        if [[ -z "$token" ]]; then
            token="$(docker logs "$name" 2>&1 | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2 || true)"
        fi
        port="$(docker port "$name" 6099 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)"
        if [[ -z "$port" ]]; then
            port="6099"
        fi
        qq="$(napcat_docker_qq_of "$name")"
        if [[ -n "$qq" ]]; then
            echo "  【QQ ${qq}】容器 ${name}"
        else
            echo "  容器 ${name}（手动安装）"
        fi
        if napcat_docker_running "$name"; then
            echo "    状态: 运行中"
        else
            echo "    状态: 已停止"
        fi
        echo "    面板: http://${host_ip}:${port}/webui"
        if [[ -n "$token" ]]; then
            echo "    密钥: ${token}"
        else
            echo "    密钥: 没拿到，请 docker logs ${name} 查看"
        fi
        echo
    done < <(napcat_docker_list)
    warn "若无法访问，请在安全组放行对应端口 喵"
}

# 启动所有 Docker 容器
napcat_docker_start_all() {
    local name started=0
    while IFS= read -r name; do
        if [[ -z "$name" ]]; then
            continue
        fi
        if ! napcat_docker_exists "$name"; then
            warn "容器 ${name} 不存在，跳过（可能是清单残留） 喵"
            continue
        fi
        if napcat_docker_running "$name"; then
            info "容器 ${name} 已在运行，跳过 喵"
            continue
        fi
        if docker start "$name" >/dev/null 2>&1; then
            info "容器 ${name} 已启动 喵"
            started=$((started+1))
        else
            error "容器 ${name} 启动失败，看看 docker logs ${name}"
        fi
    done < <(napcat_docker_list)
    if (( started == 0 )) && ! napcat_docker_any_running; then
        error "没有容器被启动"
        return 1
    fi
    napcat_docker_show_login_info
}

# 停止所有 Docker 容器
napcat_docker_stop_all() {
    local name
    while IFS= read -r name; do
        if [[ -z "$name" ]]; then
            continue
        fi
        if ! napcat_docker_exists "$name"; then
            continue
        fi
        if napcat_docker_running "$name"; then
            docker stop "$name" >/dev/null 2>&1 || true
            info "容器 ${name} 已停止 喵"
        fi
    done < <(napcat_docker_list)
}

# 卸载 mk 自己管理的 Docker 容器（含数据卷，登录态会丢）。
# 手动装的容器不在清单里、不会被连坐删除，请到 [11] 单独处理。
napcat_docker_do_uninstall() {
    title "卸载 NapCat Docker 容器"
    echo "  将删除 mk 安装的 NapCat Docker 容器及数据卷（登录态会丢失）"
    echo
    local name qq
    while IFS= read -r name; do
        if [[ -n "$name" ]]; then
            qq="$(napcat_docker_qq_of "$name")"
            if [[ -n "$qq" ]]; then
                echo "  - ${name} (QQ ${qq})"
            else
                echo "  - ${name}"
            fi
        fi
    done < <(napcat_docker_list_registered)
    echo
    local confirm=""
    read -r -p "确认彻底卸载这些 NapCat Docker 容器? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "已取消卸载 喵"
        return 0
    }
    while IFS= read -r name; do
        if [[ -z "$name" ]]; then
            continue
        fi
        docker rm -f "$name" >/dev/null 2>&1 || true
        qq="$(napcat_docker_qq_of "$name")"
        if [[ -n "$qq" ]]; then
            docker volume rm "napcat-${qq}-config" "napcat-${qq}-plugins" "napcat-${qq}-qq" >/dev/null 2>&1 || true
        fi
    done < <(napcat_docker_list_registered)
    rm -f "$NAPCAT_CONTAINERS_FILE"
    info "mk 安装的 NapCat Docker 容器已卸载 喵"
}

# ==================== 单容器操作 ====================

# 单独启动某个容器（参数：容器名）
napcat_docker_container_start() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    if ! napcat_docker_exists "$name"; then
        error "容器 ${name} 不存在"
        return 1
    fi
    if napcat_docker_running "$name"; then
        warn "容器 ${name} 已在运行 喵"
        return 0
    fi
    if docker start "$name" >/dev/null 2>&1; then
        info "容器 ${name} 已启动 喵"
        return 0
    fi
    error "容器 ${name} 启动失败，看看 docker logs ${name}"
    return 1
}

# 单独停止某个容器（参数：容器名）
napcat_docker_container_stop() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    if ! napcat_docker_exists "$name"; then
        error "容器 ${name} 不存在"
        return 1
    fi
    if ! napcat_docker_running "$name"; then
        warn "容器 ${name} 已经停着 喵"
        return 0
    fi
    docker stop "$name" >/dev/null 2>&1 || true
    info "容器 ${name} 已停止 喵"
}

# 单独重启某个容器（参数：容器名）
napcat_docker_container_restart() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    if ! napcat_docker_exists "$name"; then
        error "容器 ${name} 不存在"
        return 1
    fi
    if docker restart "$name" >/dev/null 2>&1; then
        info "容器 ${name} 已重启 喵"
        return 0
    fi
    error "容器 ${name} 重启失败"
    return 1
}

# 单独查看某个容器日志（参数：容器名）
napcat_docker_container_logs() {
    local name="${1:-}"
    if [[ -z "$name" ]]; then
        return 1
    fi
    if ! napcat_docker_exists "$name"; then
        error "容器 ${name} 不存在"
        return 1
    fi
    title "容器 ${name} 日志 (最近 50 行)"
    docker logs --tail 50 "$name" 2>&1 || true
    echo
}

# 单独删除某个容器（参数：容器名；mk 建的连数据卷一起删，手动容器只删容器）
napcat_docker_container_delete() {
    local name="${1:-}" qq
    if [[ -z "$name" ]]; then
        return 1
    fi
    if ! napcat_docker_exists "$name"; then
        napcat_docker_unregister "$name"
        warn "容器 ${name} 本来就不存在，已从清单移除 喵"
        return 0
    fi
    local confirm=""
    read -r -p "确认删除容器 ${name} 及其数据卷（登录态会丢）? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        info "那就不删 喵"
        return 0
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    qq="$(napcat_docker_qq_of "$name")"
    if [[ -n "$qq" ]]; then
        docker volume rm "napcat-${qq}-config" "napcat-${qq}-plugins" "napcat-${qq}-qq" >/dev/null 2>&1 || true
    fi
    napcat_docker_unregister "$name"
    info "容器 ${name} 已删除 喵"
    return 0
}

# 单个容器详情子菜单（参数：容器名）
menu_napcat_docker_container_detail() {
    local name="${1:-}" qq
    qq="$(napcat_docker_qq_of "$name")"
    while true; do
        if [[ -n "$qq" ]]; then
            title "容器 ${name} (QQ ${qq})"
        else
            title "容器 ${name}（手动安装）"
        fi
        show_nav_hint
        if napcat_docker_running "$name"; then
            echo "  状态: 运行中"
        elif napcat_docker_exists "$name"; then
            echo "  状态: 已停止"
        else
            echo "  状态: 容器不存在（清单残留）"
        fi
        local mount_state="未挂载"
        if [[ -n "${KAKAKE_DATA:-}" ]] && docker inspect -f '{{range .Mounts}}{{.Source}}{{println}}{{end}}' "$name" 2>/dev/null | grep -qx "${KAKAKE_DATA}"; then
            mount_state="已挂载"
        fi
        echo "  咔咔数据目录: ${mount_state}"
        echo
        echo "  [2] 启动容器"
        echo "  [3] 停止容器"
        echo "  [4] 重启容器"
        echo "  [5] 查看登录密钥"
        echo "  [6] 查看日志"
        echo "  [7] 删除容器"
        echo "  [8] 挂载咔咔数据目录"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) napcat_docker_container_start "$name"; press_enter ;;
            3) napcat_docker_container_stop "$name"; press_enter ;;
            4) napcat_docker_container_restart "$name"; press_enter ;;
            5) napcat_docker_show_login_info "$name"; press_enter ;;
            6) napcat_docker_container_logs "$name"; press_enter ;;
            7)
                if napcat_docker_container_delete "$name"; then
                    mk_nav_back
                    return 0
                fi
                press_enter ;;
            8) napcat_docker_ensure_kakake_mount "$name"; press_enter ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# 容器列表子菜单：选中一个容器进入详情，可单独启停/删除
menu_napcat_docker_containers() {
    local -a CONTAINER_MAP=()
    while true; do
        CONTAINER_MAP=()
        local name qq qlabel n=0 idx=0 cnt
        cnt="$(napcat_docker_count)"
        title "NapCat Docker 容器列表"
        show_nav_hint
        if [[ "$cnt" == "0" ]]; then
            echo "  还没有 Docker 版 NapCat 容器"
            echo "  请先 [2] 安装框架 → 选择 Docker 安装"
            echo
            press_enter
            return 0
        fi
        echo "  选一个容器进行单独操作"
        echo
        while IFS= read -r name; do
            if [[ -z "$name" ]]; then
                continue
            fi
            n=$((n+1))
            idx=$((n+1))
            CONTAINER_MAP[$idx]="$name"
            qq="$(napcat_docker_qq_of "$name")"
            if [[ -n "$qq" ]]; then
                qlabel=" (QQ ${qq})"
            else
                qlabel="（手动安装）"
            fi
            if napcat_docker_running "$name"; then
                printf '  [%d] %s%s —— 运行中\n' "$idx" "$name" "$qlabel"
            elif napcat_docker_exists "$name"; then
                printf '  [%d] %s%s —— 已停止\n' "$idx" "$name" "$qlabel"
            else
                printf '  [%d] %s%s —— 不存在（清单残留）\n' "$idx" "$name" "$qlabel"
            fi
        done < <(napcat_docker_list)
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                if [[ -n "${CONTAINER_MAP[$choice]:-}" ]]; then
                    menu_napcat_docker_container_detail "${CONTAINER_MAP[$choice]}" || true
                    if mk_nav_bubble_up; then
                        return 0
                    fi
                else
                    warn "无法识别该选项，请重新输入 喵"
                fi
                ;;
        esac
    done
}

napcat_ensure_xvfb() {
    if command -v xvfb-run >/dev/null 2>&1; then
        return 0
    fi
    warn "xvfb-run 还没装，正在尝试安装 喵"
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
    if napcat_docker_has_any; then
        napcat_docker_start_all
        return $?
    fi

    napcat_detect_paths || {
        error "NapCat 还没装，请先安装框架"
        return 1
    }

    if napcat_is_running; then
        warn "NapCat 已在后台运行 喵"
        napcat_show_login_info
        return 0
    fi

    if ! napcat_ensure_xvfb; then
        error "少了 xvfb-run，无法启动 NapCat"
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
            error "启动失败了，看看日志: ${NAPCAT_LOG}"
            tail -15 "$NAPCAT_LOG" 2>/dev/null || true
            return 1
        fi
    fi

    info "正在等待 WebUI 就绪 喵"
    local i=0
    while (( i < 60 )); do
        if grep -qE 'WebUi.*(Panel Url|Token)' "$NAPCAT_LOG" 2>/dev/null; then
            break
        fi
        if ! napcat_is_running; then
            error "进程已退出，启动失败了"
            tail -15 "$NAPCAT_LOG" 2>/dev/null || true
            return 1
        fi
        sleep 1
        ((i++)) || true
    done

    napcat_open_port_6099
    info "NapCat 启动好啦 (后台运行) 喵"
    info "退出 mk 菜单不会停止 NapCat，请使用「停止框架」关闭 喵"
    napcat_show_login_info
}

napcat_stop() {
    if napcat_docker_has_any; then
        napcat_docker_stop_all
        return $?
    fi

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
        warn "部分进程可能仍在运行，手动检查 喵"
        return 1
    fi

    info "NapCat 已经停下来 喵"
}

napcat_restart() {
    info "正在重启 NapCat 喵"
    napcat_stop || true
    sleep 2
    napcat_start
}

napcat_show_logs() {
    if [[ ! -f "$NAPCAT_LOG" ]]; then
        warn "暂无运行日志 喵"
        if [[ -f "$NAPCAT_INSTALL_LOG" ]]; then
            info "可查看安装日志: ${NAPCAT_INSTALL_LOG} 喵"
        fi
        return 1
    fi

    title "NapCat 运行日志 (最近 80 行)"
    tail -n 80 "$NAPCAT_LOG"
    echo
    echo "  完整日志: ${NAPCAT_LOG}"
    echo "  实时跟踪: tail -f ${NAPCAT_LOG}"
    echo
    info "退出菜单不会停止 NapCat 后台进程 喵"
}

napcat_do_uninstall() {
    if napcat_docker_has_any; then
        napcat_docker_do_uninstall
        return 0
    fi

    title "卸载 NapCat 框架"
    echo "  将彻底删除 NapCat 目录、安装脚本及运行状态"
    echo "  包括: ~/Napcat、napcat.sh、NapCat.Shell.zip 等"
    echo

    local confirm=""
    read -r -p "确认彻底卸载 NapCat? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "已取消卸载 喵"
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

    info "NapCat 已彻底卸载，可重新安装 喵"
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
    warn "没找到 python3，正在尝试安装 喵"
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
            error "python3 安装失败，手动执行: pkg install python"
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
        echo -e "${YELLOW}还没打开${NC}"
        return
    fi
    if ! napcat_is_running; then
        echo -e "${RED}还没连上${NC}"
        return
    fi
    case "$category" in
        httpServers|websocketServers|httpSseServers)
            host="${addr%%:*}"
            port="${addr##*:}"
            if napcat_port_listening "$port"; then
                echo -e "${GREEN}连上${NC}"
            else
                echo -e "${RED}还没连上${NC}"
            fi
            ;;
        httpClients|websocketClients)
            if napcat_client_connected "$addr"; then
                echo -e "${GREEN}连上${NC}"
            else
                echo -e "${RED}还没连上${NC}"
            fi
            ;;
        *)
            echo -e "${YELLOW}未知${NC}"
            ;;
    esac
}

napcat_cfg_check_ready() {
    if ! napcat_is_installed; then
        error "NapCat 还没装，请先安装框架"
        return 1
    fi
    if ! napcat_cfg_require_python; then
        error "需要 python3 才能管理网络配置"
        return 1
    fi
    if [[ -z "$(napcat_get_config_dir 2>/dev/null || true)" ]]; then
        error "找不到 NapCat 配置目录"
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
        error "删除失败"
        return 1
    fi

    info "配置已删除，已立即生效 喵"

    if [[ -n "$del_port" && "$del_port" =~ ^[0-9]+$ && "$del_port" != "0" ]]; then
        if napcat_cfg_port_used_by_others "$del_port"; then
            info "端口 ${del_port} 仍被其他配置使用，防火墙规则保留 喵"
        else
            napcat_firewall_close_port "$del_port"
        fi
    fi

    return 0
}

menu_napcat_net_add() {
    local choice="" cat="" name="" host="" port="" url="" token="" enable="y"

    while true; do
        title "新增网络配置 - 选择类型"
        show_nav_hint
        echo "  [2] HTTP 服务端"
        echo "  [3] HTTP 客户端"
        echo "  [4] WebSocket Server (正向 WS，NapCat 监听)"
        echo "  [5] WebSocket Client (反向 WS，NapCat 连出)"
        echo

        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back ;;
            2) cat="httpServers"; break ;;
            3) cat="httpClients"; break ;;
            4) cat="websocketServers"; break ;;
            5) cat="websocketClients"; break ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done

    echo
    read -r -p "配置名称 (唯一标识):" name
    name="${name// /}"
    [[ -z "$name" ]] && name="NetCfg_$(date +%s)"

    if [[ "$cat" == "httpServers" || "$cat" == "websocketServers" ]]; then
        read -r -p "监听地址 [0.0.0.0]: " host
        host="${host:-0.0.0.0}"
        if [[ "$cat" == "httpServers" ]]; then
            read -r -p "监听端口 [3000]: " port
            port="${port:-3000}"
        else
            read -r -p "监听端口 [3001]: " port
            port="${port:-3001}"
        fi
        read -r -p "鉴权 Token (留空跳过):" token
        read -r -p "是否启用? [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        napcat_cfg_tool add "$cat" "$name" "$host" "$port" "$token" "$enable" || {
            error "添加配置失败"
            return 1
        }
        if [[ "$enable" == "y" && -n "$port" ]]; then
            napcat_firewall_open_port "$port"
        fi
    else
        if [[ "$cat" == "httpClients" ]]; then
            read -r -p "上报地址 [http://127.0.0.1:8080]: " url
            url="${url:-http://127.0.0.1:8080}"
        else
            read -r -p "连接地址 [ws://127.0.0.1:8082]: " url
            url="${url:-ws://127.0.0.1:8082}"
        fi
        read -r -p "鉴权 Token (留空跳过):" token
        read -r -p "是否启用? [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        napcat_cfg_tool add "$cat" "$name" "$url" "" "$token" "$enable" || {
            error "添加配置失败"
            return 1
        }
    fi

    local cfg_path=""
    cfg_path="$(napcat_cfg_tool path 2>/dev/null || true)"
    info "配置已保存: ${cfg_path:-onebot11.json} 喵"
    info "网络配置已立即生效，无需重启 NapCat 喵"
}

menu_napcat_net_detail() {
    local item_id="$1"
    local choice="" confirm=""

    while true; do
        title "网络配置详情"
        show_nav_hint
        echo "  [3] 删除本配置"
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
                read -r -p "确认删除此配置? [y/N]: " confirm
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    napcat_cfg_delete_item "$item_id"
                    press_enter
                    mk_nav_back
                    return 0
                fi
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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

        title "网络配置"
        show_nav_hint
        echo "  [3] 新增配置"
        echo

        mapfile -t lines < <(napcat_cfg_tool list 2>/dev/null || true)
        if [[ ${#lines[@]} -eq 0 || -z "${lines[0]:-}" ]]; then
            echo "  (暂无网络配置)"
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
                    warn "无法识别该选项，请重新输入 喵"
                fi
                ;;
        esac
    done
}

menu_napcat_configure() {
    while true; do
        title "配置框架"
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
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_napcat() {
    if napcat_install_running; then
        info "小MK发现 NapCat 正在后台安装，正在找回进度显示 喵"
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
        echo "  [2] 安装框架"
        echo "  [3] 启动框架"
        echo "  [4] 停止框架"
        echo "  [5] 重启框架"
        echo "  [6] 配置框架"
        echo "  [7] 卸载框架"
        echo "  [8] 查看日志"
        echo "  [9] 查看NapCat面板登录密钥"
        if napcat_docker_has_any; then
            echo "  [11] Docker 容器列表"
        fi
        if napcat_install_running; then
            echo "  [10] 查看安装进度"
            echo
            echo -e "  ${YELLOW}* NapCat 正在后台努力装${NC}"
        elif napcat_is_running; then
            echo
            echo -e "  ${GREEN}* NapCat 正在后台运行${NC}"
        elif napcat_is_installed; then
            echo
            echo -e "  ${YELLOW}* NapCat 已装好 (未运行)${NC}"
        else
            echo
            echo -e "  ${YELLOW}* NapCat 还没装${NC}"
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
                    warn "当前没有安装任务 喵"
                fi
                ;;
            11)
                if napcat_docker_has_any; then
                    menu_napcat_docker_containers || true
                    if mk_nav_bubble_up; then
                        MK_GO_HOME=0
                        return 0
                    fi
                else
                    warn "还没有 Docker 容器 喵"
                    press_enter
                fi
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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
# WebUI 外部访问桥接（SnowLuma 原生只绑 127.0.0.1 时，用 socat 在本机 IP 同端口转发）
readonly SNOWLUMA_WEBUI_BRIDGE_PID="${LOG_DIR}/snowluma-webui-bridge.pid"
readonly SNOWLUMA_WEBUI_BRIDGE_CFG="${LOG_DIR}/snowluma-webui-bridge.env"
readonly SNOWLUMA_WEBUI_BRIDGE_LOG="${LOG_DIR}/snowluma-webui-bridge.log"
# 直接安装(native) WebUI 期望监听地址偏好（写入后下次启动 SnowLuma 时作为 SNOWLUMA_WEBUI_HOST 注入）
readonly SNOWLUMA_WEBUI_HOST_FILE="${LOG_DIR}/snowluma-webui-host"
# Docker 模式的 WebUI 端口映射（宿主机绑定地址 + 宿主机端口）。
# 容器内部永远监听 0.0.0.0:${SNOWLUMA_WEBUI_PORT}（不然宿主机映射过去也是空的），
# 真正决定「谁能访问」的是宿主机这一侧 -p 的绑定地址，所以改它要重建容器。
readonly SNOWLUMA_WEBUI_DOCKER_CFG="${LOG_DIR}/snowluma-webui-docker.env"
SNOWLUMA_WEBUI_BIND_IP="0.0.0.0"
SNOWLUMA_WEBUI_HOST_PORT="$SNOWLUMA_WEBUI_PORT"

# ---- 多账号（多开）----
# 一个 SnowLuma 即可跑多个 QQ：Linux QQ 的单实例锁落在 $HOME/.config/QQ/SingletonLock，
# 所以每个额外账号必须独占一个 HOME —— 这是多开唯一的硬性条件，Docker 与常规安装都一样。
# 框架侧无需配置：HookManager 会遍历所有 QQ 主进程逐个注入（按 PID 建 pipe），
# 每个 UIN 自动起一个 OneBotInstance，WebUI 自动列出所有 UIN。
#
# Docker：给 SNOWLUMA_EXTRA_QQ_HOMES 传逗号分隔的 HOME 列表，容器启动时 supervisor
#         为每个 HOME 生成一个 program（qq-extra-1、qq-extra-2…）。
# 常规安装(native)：没有 supervisor，由 mk 自己按账号逐个拉起（各自 PID 文件管理）。
#
# 清单文件每行存一个「账号名」（如 qq-acct2），两种模式各自派生出真实 HOME 路径；
# 兼容 2.8.0/2.9.0 的旧写法（整条 /app/qq-acctN 路径），读取时只取最后一段。
readonly SNOWLUMA_ACCOUNTS_FILE="${LOG_DIR}/snowluma-accounts"
readonly SNOWLUMA_ACCT_NAME_PREFIX="qq-acct"
# Docker：账号 HOME 一律在容器 /app 下
readonly SNOWLUMA_ACCT_HOME_PREFIX="/app/qq-acct"
readonly SNOWLUMA_ACCT_VOLUME_PREFIX="snowluma-qq-acct-"
# 常规安装：账号 HOME 落在宿主机。不要放 $SNOWLUMA_HOME 里 —— 重装时会整目录被 mv 备份走。
readonly SNOWLUMA_NATIVE_ACCT_HOME_ROOT="/opt/snowluma-qq-acct"
# 多开时每个 QQ 进程（Chromium）约吃 300-500MB，共享内存要从 1g 提上去
readonly SNOWLUMA_SHM_SINGLE="1g"
readonly SNOWLUMA_SHM_MULTI="2g"
# 额外挂载：把宿主机目录以「相同绝对路径」挂进容器，让容器里的 SnowLuma 能读到
# kakake 的媒体文件（详见 snowluma_mounts_* 那一节的说明）。默认只读 :ro。
readonly SNOWLUMA_MOUNTS_FILE="${LOG_DIR}/snowluma-mounts"
readonly SNOWLUMA_MOUNTS_RO_FILE="${LOG_DIR}/snowluma-mounts-ro"

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

# 官方 SnowLuma 镜像会把「公开示例密码」当作未设置并改用随机密码，vncpasswd 就是被拉黑的示例值。
# 这里判断某密码是否属于这类弱/示例值（docker 模式必须避开，否则用户填了也进不去）。
snowluma_vnc_pass_is_example() {
    case "${1:-}" in
        ""|vncpasswd|password|passwd|123456|admin|snowluma|changeme) return 0 ;;
        *) return 1 ;;
    esac
}

# 生成一个不属于示例值的随机强密码（形如 snow-a1b2c3d4e5）
snowluma_gen_password() {
    local p=""
    if command -v openssl >/dev/null 2>&1; then
        p="$(openssl rand -hex 6 2>/dev/null || true)"
    fi
    if [[ -z "$p" && -r /dev/urandom ]]; then
        p="$(head -c 200 /dev/urandom 2>/dev/null | tr -dc 'a-z0-9' 2>/dev/null | head -c 10 || true)"
    fi
    [[ -n "$p" ]] || p="$(date +%s 2>/dev/null | tail -c 7)${RANDOM}"
    printf 'snow-%s' "$p"
}

# 从 docker 容器日志抓「实际生效」的密码：$1 = vnc | webui。抓不到返回空字符串。
# 日志实际格式（官方文档）：
#   VNC   ： "远程桌面密码: XXX" / "remote desktop password: XXX"
#   WebUI ： "临时密码: XXX"     / "initial credentials: user=admin password=XXX"
snowluma_docker_log_pass() {
    local kind="$1"
    case "$kind" in
        vnc)
            docker logs "$SNOWLUMA_DOCKER_NAME" 2>&1 \
                | grep -iE '远程桌面密码[：:]|remote desktop password[：:]' \
                | tail -n 1 \
                | sed -E 's/.*(：|:)[[:space:]]*//' \
                | tr -d '\r' || true
            ;;
        webui)
            docker logs "$SNOWLUMA_DOCKER_NAME" 2>&1 \
                | grep -iE '临时密码|initial credentials' \
                | tail -n 1 \
                | sed -nE 's/.*(临时密码[：:][[:space:]]*|password=)([^[:space:]]+).*/\2/p' \
                | tr -d '\r' || true
            ;;
        *) return 0 ;;
    esac
}

menu_snowluma_vnc_config() {
    local np vp pw
    snowluma_vnc_load_cfg
    title "配置扫码桌面端口"
    show_nav_hint
    echo "  当前 noVNC 端口: ${SNOWLUMA_NOVNC_PORT}  (浏览器扫码，默认 6081，可改)"
    echo "  当前 VNC 端口:   ${SNOWLUMA_VNC_PORT}  (客户端，默认 5900，可改)"
    echo "  当前 VNC 密码:   ${SNOWLUMA_VNC_PASS}"
    echo "  配置文件: ${SNOWLUMA_VNC_CFG}"
    echo
    echo "  直接回车保留原值；改完后需重启扫码桌面/QQ 才生效"
    echo
    read -r -p "noVNC 端口 [${SNOWLUMA_NOVNC_PORT}]: " np
    read -r -p "VNC 端口 [${SNOWLUMA_VNC_PORT}]: " vp
    read -r -p "VNC 密码 [${SNOWLUMA_VNC_PASS}]: " pw
    np="$(normalize_choice "${np:-}")"
    vp="$(normalize_choice "${vp:-}")"
    pw="${pw#"${pw%%[![:space:]]*}"}"
    pw="${pw%"${pw##*[![:space:]]}"}"
    [[ -n "$np" ]] && SNOWLUMA_NOVNC_PORT="$np"
    [[ -n "$vp" ]] && SNOWLUMA_VNC_PORT="$vp"
    [[ -n "$pw" ]] && SNOWLUMA_VNC_PASS="$pw"
    if ! [[ "$SNOWLUMA_NOVNC_PORT" =~ ^[0-9]+$ ]] || (( SNOWLUMA_NOVNC_PORT < 1 || SNOWLUMA_NOVNC_PORT > 65535 )); then
        error "noVNC 端口无法识别"
        return 1
    fi
    if ! [[ "$SNOWLUMA_VNC_PORT" =~ ^[0-9]+$ ]] || (( SNOWLUMA_VNC_PORT < 1 || SNOWLUMA_VNC_PORT > 65535 )); then
        error "VNC 端口无法识别"
        return 1
    fi
    if [[ "$SNOWLUMA_NOVNC_PORT" == "$SNOWLUMA_VNC_PORT" ]]; then
        error "noVNC 与 VNC 端口不能相同"
        return 1
    fi
    snowluma_vnc_save_cfg
    info "已保存: noVNC=${SNOWLUMA_NOVNC_PORT}  VNC=${SNOWLUMA_VNC_PORT} 喵"
    if [[ "$(snowluma_get_mode)" == "docker" ]]; then
        warn "Docker 模式下端口/密码在容器创建时固定，改这里需「卸载→重装」容器才生效 喵"
    fi
    if snowluma_vnc_is_running || snowluma_qq_is_running; then
        local restart=""
        read -r -p "扫码桌面/QQ 正在跑，是否立即按新端口重启? [y/N]: " restart
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
            warn "请稍后手动「停止」再「启动」使新端口生效 喵"
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

# 与 snowluma_mirror_labels 一一对应（第 0 项为空 = 直连）；下载与测速共用这一份，别只改一边
snowluma_mirror_urls=(
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

# ==================== SnowLuma Docker Hub 镜像加速源 ====================
# 与 napcat 的 napcat_docker_mirror_* 对应：docker 模式拉 motricseven7/snowluma 镜像时，
# 用这些代理前缀套到镜像名前面（第 0 项为空 = 直连 Docker Hub）。
SNOWLUMA_DOCKER_MIRROR_INDEX="0"

snowluma_docker_mirror_labels=(
    "直连 Docker Hub (国外/可访问 Docker Hub 的服务器)"
    "docker.1ms.run"
    "docker.xuanyuan.me"
    "docker.mybacc.com"
    "dytt.online"
    "lispy.org"
)
# 与 snowluma_docker_mirror_labels 一一对应（第 0 项为空 = 直连）
snowluma_docker_mirror_prefixes=(
    ""
    "docker.1ms.run"
    "docker.xuanyuan.me"
    "docker.mybacc.com"
    "dytt.online"
    "lispy.org"
)

# Docker Hub 镜像源探活（深度测试响应）：用 registry v2 根路径 /v2/，
# 只要镜像站返回了任何 HTTP 状态码（含 401/403/429/5xx，都说明站点可达且能响应）
# 就计入延迟；只有 curl 失败（域名解析/连接超时/拒绝连接）才算测速失败。
# 空前缀 = 直连 Docker Hub 官方（registry-1.docker.io）。
# 与 mk_mirror_latency_ms 不同：它只认 2xx/3xx，而 Docker 匿名探测 /v2/ 常返回 401，
# 这里放宽到「任意三位状态码即视为可达」，避免把所有能用的镜像站误判成红/失败。
snowluma_docker_latency_ms() {
    local host="${1:-}" out="" code="" t="" sec="" frac=""
    local url
    if [[ -z "$host" ]]; then
        url="https://registry-1.docker.io/v2/"
    else
        url="https://${host}/v2/"
    fi
    command -v curl >/dev/null 2>&1 || { printf ''; return 0; }
    out="$(curl -sS -L -o /dev/null \
        --connect-timeout "$MK_PROBE_TIMEOUT" --max-time "$MK_PROBE_TIMEOUT" \
        -A 'mk-tools' \
        -w '%{http_code} %{time_total}' "$url" 2>/dev/null || true)"
    code="${out%% *}"
    t="${out##* }"
    [[ "$code" =~ ^[1-9][0-9]{2}$ ]] || { printf ''; return 0; }
    [[ "$t" =~ ^[0-9]+\.[0-9]+$ ]] || { printf ''; return 0; }
    sec="${t%%.*}"
    frac="${t#*.}000"
    printf '%s' "$(( sec * 1000 + 10#${frac:0:3} ))"
    return 0
}

menu_snowluma_select_docker_mirror() {
    local i=0 idx=0
    local do_probe=0
    local probed=0
    local -a lat=()
    SNOWLUMA_DOCKER_MIRROR_INDEX="${SNOWLUMA_DOCKER_MIRROR_INDEX:-0}"

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择 Docker 镜像加速源"
        show_nav_hint
        echo "  国内服务器拉不动 Docker Hub 时，选一个加速源（进菜单会逐个测速）"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo
        for ((i=0; i<${#snowluma_docker_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${snowluma_docker_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                printf '  [%s] %s  ' "$idx" "${snowluma_docker_mirror_labels[$i]}"
                ms="$(snowluma_docker_latency_ms "${snowluma_docker_mirror_prefixes[$i]}")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${snowluma_docker_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#snowluma_docker_mirror_labels[@]} + 2 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#snowluma_docker_mirror_labels[@]} + 2 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#snowluma_docker_mirror_labels[@]} )); then
                        SNOWLUMA_DOCKER_MIRROR_INDEX="$idx"
                        info "已选择: ${snowluma_docker_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

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
    local proxy=""
    if [[ "$proxy_idx" =~ ^[0-9]+$ ]] && (( proxy_idx > 0 && proxy_idx < ${#snowluma_mirror_urls[@]} )); then
        proxy="${snowluma_mirror_urls[$proxy_idx]}"
        proxy="${proxy%/}"
        echo "${proxy}/${raw_url}"
    else
        echo "$raw_url"
    fi
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
    local ms=""
    local do_probe=0
    local probed=0
    local -a lat=()
    SNOWLUMA_PROXY_INDEX="${SNOWLUMA_PROXY_INDEX:-0}"

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择下载镜像源"
        show_nav_hint
        echo "  国内服务器若无法访问 GitHub，请选择镜像源"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo
        for ((i=0; i<${#snowluma_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${snowluma_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                printf '  [%s] %s  ' "$idx" "${snowluma_mirror_labels[$i]}"
                ms="$(mk_mirror_latency_ms "$(mk_mirror_join_url "${snowluma_mirror_urls[$i]}" "$MK_PROBE_TARGET")")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${snowluma_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#snowluma_mirror_labels[@]} + 2 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#snowluma_mirror_labels[@]} + 2 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#snowluma_mirror_labels[@]} )); then
                        SNOWLUMA_PROXY_INDEX="$idx"
                        info "已选择: ${snowluma_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

menu_snowluma_select_version() {
    SNOWLUMA_VERSION_TAG="latest"
    SNOWLUMA_VERSION_LABEL="最新版"
    while true; do
        title "选择 SnowLuma 版本"
        show_nav_hint
        echo "  [2] 最新版 (GitHub Releases latest)"
        echo "  [3] 手动输入版本号 (如 v1.13.0)"
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
                read -r -p "请输入版本号 (如 v1.13.0):" tag
                tag="$(normalize_choice "$tag")"
                if [[ -z "$tag" ]]; then
                    warn "版本号不能为空 喵"
                    continue
                fi
                [[ "$tag" != v* ]] && tag="v${tag}"
                SNOWLUMA_VERSION_TAG="$tag"
                SNOWLUMA_VERSION_LABEL="$tag"
                return 0
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_snowluma_select_mode() {
    SNOWLUMA_INSTALL_MODE=""
    while true; do
        title "选择 SnowLuma 安装模式"
        show_nav_hint
        echo "  [2] Docker 安装"
        echo "  [3] 直接安装 (解压发行包到 ${SNOWLUMA_HOME})"
        echo
        echo "  Docker：镜像 ${SNOWLUMA_DOCKER_IMAGE}"
        echo "  直接安装：需本机自行装兼容 QQ，WebUI 默认 ${SNOWLUMA_WEBUI_PORT}"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) SNOWLUMA_INSTALL_MODE="docker"; return 0 ;;
            3) SNOWLUMA_INSTALL_MODE="native"; return 0 ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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
    warn "无法解析 latest，回退使用 v1.13.0 喵"
    echo "v1.13.0"
}

snowluma_native_asset_name() {
    local tag="$1" arch
    arch="$(snowluma_detect_arch)"
    case "$arch" in
        amd64) echo "SnowLuma-${tag}-linux-x64.tar.gz" ;;
        arm64) echo "SnowLuma-${tag}-linux-arm64.tar.gz" ;;
        *)
            error "帮不上忙的架构: ${arch}（仅 amd64/arm64）"
            return 1
            ;;
    esac
}

# ==================== SnowLuma 多账号（多开）====================

# 列出已配置的额外账号名（一行一个，如 qq-acct2）；无配置则无输出。
# 兼容 2.8.0/2.9.0 的旧写法（清单里存的是 /app/qq-acctN 整条路径）：只取最后一段。
snowluma_accounts_list() {
    [[ -f "$SNOWLUMA_ACCOUNTS_FILE" ]] || return 0
    local raw line name
    raw="$(grep -vE '^[[:space:]]*(#|$)' "$SNOWLUMA_ACCOUNTS_FILE" 2>/dev/null | tr -d '\r' || true)"
    while IFS= read -r line; do
        line="${line%%#*}"
        line="${line//[[:space:]]/}"
        [[ -n "$line" ]] || continue
        name="${line##*/}"
        [[ -n "$name" ]] || continue
        printf '%s\n' "$name"
    done < <(printf '%s\n' "$raw")
}

# 额外账号数量（不含主账号）
snowluma_accounts_count() {
    local n
    n="$(snowluma_accounts_list | grep -c . || true)"
    printf '%s' "${n:-0}"
}

# 账号名 → 容器内 HOME
snowluma_acct_docker_home() {
    printf '/app/%s' "$1"
}

# 账号名 → 宿主机 HOME（常规安装）
snowluma_acct_native_home() {
    printf '%s/%s' "$SNOWLUMA_NATIVE_ACCT_HOME_ROOT" "$1"
}

# 账号名 / main → 当前模式下的真实 HOME（不存在"配置文件路径"概念时给描述串）
snowluma_acct_home_of() {
    local name="$1" mode="${2:-$(snowluma_get_mode)}"
    if [[ "$name" == "main" ]]; then
        if [[ "$mode" == "docker" ]]; then
            printf '/app/.config + /app/.local/share'
        else
            printf '%s' "${HOME:-/root}"
        fi
        return 0
    fi
    if [[ "$mode" == "docker" ]]; then
        snowluma_acct_docker_home "$name"
    else
        snowluma_acct_native_home "$name"
    fi
}

# 用于展示的账号名
snowluma_acct_label() {
    if [[ "$1" == "main" ]]; then
        printf '主账号'
    else
        printf '%s' "$1"
    fi
}

# 账号名 → 数据卷名（qq-acct2 → snowluma-qq-acct-qq-acct2）
snowluma_acct_volume_name() {
    printf '%s%s' "$SNOWLUMA_ACCT_VOLUME_PREFIX" "$1"
}

# 账号名 → 每账号 PID 文件（常规安装：靠它精确管理单个 QQ）
snowluma_acct_pid_file() {
    printf '%s/snowluma-qq-%s.pid' "$LOG_DIR" "$1"
}

# 逗号分隔的容器 HOME 列表，直接喂给 SNOWLUMA_EXTRA_QQ_HOMES
snowluma_accounts_csv() {
    local n out=""
    while IFS= read -r n; do
        [[ -n "$n" ]] || continue
        if [[ -z "$out" ]]; then
            out="$(snowluma_acct_docker_home "$n")"
        else
            out="${out},$(snowluma_acct_docker_home "$n")"
        fi
    done < <(snowluma_accounts_list)
    printf '%s' "$out"
}

# 分配下一个未占用的账号名（主账号占 1，额外账号从 qq-acct2 起）
snowluma_accounts_next_name() {
    local n=2 used=""
    used="$(snowluma_accounts_list)"
    while printf '%s\n' "$used" | grep -qx "${SNOWLUMA_ACCT_NAME_PREFIX}${n}"; do
        n=$((n + 1))
    done
    printf '%s%s' "$SNOWLUMA_ACCT_NAME_PREFIX" "$n"
}

# 该账号名是否已登记
snowluma_account_has() {
    local want="$1" n
    while IFS= read -r n; do
        [[ -n "$n" ]] || continue
        if [[ "$n" == "$want" ]]; then
            return 0
        fi
    done < <(snowluma_accounts_list)
    return 1
}

# 追加一个账号名到清单（返回值 0 表示成功）
snowluma_account_add() {
    local name="$1"
    [[ -n "$name" ]] || return 1
    if snowluma_account_has "$name"; then
        warn "账号 ${name} 已经在清单里了 喵"
        return 1
    fi
    mkdir -p "$LOG_DIR"
    printf '%s\n' "$name" >> "$SNOWLUMA_ACCOUNTS_FILE"
    return 0
}

# 从清单里移除一个账号名（按「归一化后的账号名」比对，所以旧格式 /app/qq-acctN
# 和带空格/CRLF 的行都能剔除；注释行与空行原样保留）
snowluma_account_remove() {
    local target="$1" tmp="" line name stripped=""
    [[ -f "$SNOWLUMA_ACCOUNTS_FILE" ]] || return 0
    tmp="$(mktemp "${MK_TMP}/snowluma-acct.XXXXXX" 2>/dev/null || true)"
    if [[ -z "$tmp" ]]; then
        tmp="${SNOWLUMA_ACCOUNTS_FILE}.tmp.$$"
    fi
    : > "$tmp"
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line//$'\r'/}"
        stripped="${line//[[:space:]]/}"
        if [[ -z "$stripped" ]]; then
            printf '%s\n' "$line" >> "$tmp"
            continue
        fi
        if [[ "$stripped" == \#* ]]; then
            printf '%s\n' "$line" >> "$tmp"
            continue
        fi
        name="${stripped##*/}"
        if [[ "$name" == "$target" ]]; then
            continue
        fi
        printf '%s\n' "$line" >> "$tmp"
    done < "$SNOWLUMA_ACCOUNTS_FILE"
    mv "$tmp" "$SNOWLUMA_ACCOUNTS_FILE"
    return 0
}

# 按当前账号列表拼出 docker run 的卷参数（每行一个，供 mapfile 读取）
snowluma_accounts_volume_args() {
    local n
    while IFS= read -r n; do
        [[ -n "$n" ]] || continue
        printf '%s\n' "-v"
        printf '%s\n' "$(snowluma_acct_volume_name "$n"):$(snowluma_acct_docker_home "$n")"
    done < <(snowluma_accounts_list)
}

# 多账号需要的共享内存大小（仅 Docker 用；常规安装走真实内存）
snowluma_accounts_shm() {
    if (( $(snowluma_accounts_count) > 0 )); then
        printf '%s' "$SNOWLUMA_SHM_MULTI"
    else
        printf '%s' "$SNOWLUMA_SHM_SINGLE"
    fi
}

# 容器内各账号进程状态（supervisor）
snowluma_accounts_proc_status() {
    docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl status 2>/dev/null || true
}

# 账号名 → supervisor program 名（主账号 qq，额外账号按清单顺序 qq-extra-N）
snowluma_acct_supervisor_name() {
    local want="$1" i=1 n
    if [[ "$want" == "main" ]]; then
        printf 'qq'
        return 0
    fi
    while IFS= read -r n; do
        [[ -n "$n" ]] || continue
        if [[ "$n" == "$want" ]]; then
            printf 'qq-extra-%s' "$i"
            return 0
        fi
        i=$((i + 1))
    done < <(snowluma_accounts_list)
    return 1
}

# ---------------- 常规安装(native)：按账号精确管理 QQ 进程 ----------------

# 读某个进程的 HOME（/proc/<pid>/environ）
snowluma_qq_proc_home() {
    local pid="$1" envf="/proc/${pid}/environ"
    [[ -r "$envf" ]] || return 1
    tr '\0' '\n' < "$envf" 2>/dev/null | sed -n 's/^HOME=//p' | head -n1
}

# 某账号当前存活的 PID 列表（一行一个）。$1 = 账号名 或 main
# 两条线索：① 自己的 PID 文件（快）② 扫 /proc 比对 HOME（PID 文件丢了也能找回）
# 主账号用排除法：不属于任何额外账号 HOME 的 /opt/QQ 进程都算它。
snowluma_acct_pids() {
    local name="$1" pid p h exe
    local -a out=() others=() seen_list=()
    local pf n o is_other x

    pf="$(snowluma_acct_pid_file "$name")"
    if [[ -f "$pf" ]]; then
        p="$(tr -d '[:space:]' < "$pf" 2>/dev/null || true)"
        if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
            exe="$(readlink -f "/proc/${p}/exe" 2>/dev/null || true)"
            if [[ "$exe" == /opt/QQ/* ]]; then
                out+=( "$p" )
            else
                rm -f "$pf" 2>/dev/null || true
            fi
        else
            rm -f "$pf" 2>/dev/null || true
        fi
    fi

    while IFS= read -r n; do
        [[ -n "$n" ]] || continue
        others+=( "$(snowluma_acct_native_home "$n")" )
    done < <(snowluma_accounts_list)

    for pid in $(snowluma_qq_real_pids 2>/dev/null || true); do
        h="$(snowluma_qq_proc_home "$pid" || true)"
        if [[ "$name" == "main" ]]; then
            is_other=0
            for o in ${others[@]+"${others[@]}"}; do
                if [[ -n "$h" && "$h" == "$o" ]]; then
                    is_other=1
                    break
                fi
            done
            if (( is_other == 0 )); then
                out+=( "$pid" )
            fi
        else
            if [[ -n "$h" && "$h" == "$(snowluma_acct_native_home "$name")" ]]; then
                out+=( "$pid" )
            fi
        fi
    done

    for x in ${out[@]+"${out[@]}"}; do
        case " ${seen_list[*]} " in
            *" ${x} "*) ;;
            *) seen_list+=( "$x" ); printf '%s\n' "$x" ;;
        esac
    done
    return 0
}

# 某账号是否在跑（native）
snowluma_acct_is_running() {
    [[ -n "$(snowluma_acct_pids "$1" | head -n1 || true)" ]]
}

# 启动某一个额外账号的 QQ（native）。所有账号共用同一块 Xvfb 屏。
snowluma_acct_start_native() {
    local name="$1" home pf
    if [[ ! -x "/opt/QQ/qq" ]]; then
        error "还没装宿主 QQ，请先「安装 QQ」"
        return 1
    fi
    if snowluma_acct_is_running "$name"; then
        info "${name} 已经在跑，不用重复启动 喵"
        return 0
    fi

    home="$(snowluma_acct_native_home "$name")"
    snowluma_qq_ensure_runtime_deps || return 1
    snowluma_vnc_start_stack || return 1

    mkdir -p "$home" "$LOG_DIR"
    echo "===== QQ[${name}] start $(date '+%Y-%m-%d %H:%M:%S') HOME=${home} DISPLAY=${SNOWLUMA_DISPLAY} =====" >> "$SNOWLUMA_QQ_LOG"
    # HOME 是隔离关键（Linux QQ 靠 $HOME/.config/QQ/SingletonLock 做单实例锁）
    # 无头服务器上 Chromium 仍会尝试拉 GPU 进程 → launch failed → FATAL Goodbye（实测 3.2.28-48517）。
    # --disable-gpu 只禁加速不阻止拉进程，必须 --in-process-gpu 让 GPU 在主进程内跑，
    # --disable-gpu-sandbox 关掉 GPU 沙箱（沙箱初始化也会崩），--use-gl=swiftshader 走软件 OpenGL。
    nohup setsid env HOME="$home" DISPLAY="$SNOWLUMA_DISPLAY" \
        '/opt/QQ/qq' --no-sandbox \
        --disable-gpu --disable-software-rasterizer --disable-gpu-compositing \
        --disable-gpu-sandbox --in-process-gpu --use-gl=swiftshader \
        >> "$SNOWLUMA_QQ_LOG" 2>&1 &
    echo $! > "$(snowluma_acct_pid_file "$name")"

    sleep 3
    if snowluma_acct_is_running "$name"; then
        info "${name} 已启动（HOME=${home}，屏 ${SNOWLUMA_DISPLAY}） 喵"
        snowluma_show_vnc_info
        info "noVNC 里会多出一个 QQ 窗口，扫码登录后 WebUI 自动出现新 UIN 喵"
        return 0
    fi
    error "${name} 启动失败了，见日志: ${SNOWLUMA_QQ_LOG}"
    tail -20 "$SNOWLUMA_QQ_LOG" 2>/dev/null || true
    return 1
}

# 停止某一个账号的 QQ（native）。只杀这一个账号，其它账号不动。
snowluma_acct_stop_native() {
    local name="$1" pf pid pgid p i left=0
    local -a pids=()

    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        pids+=( "$p" )
    done < <(snowluma_acct_pids "$name")

    if (( ${#pids[@]} == 0 )); then
        info "$(snowluma_acct_label "$name") 本来就未运行 喵"
        return 0
    fi

    mkdir -p "$LOG_DIR"
    date '+%F %T acct-stop' > "$SNOWLUMA_QQ_STOP_FLAG"

    # 先按进程组收尾（启动时用了 setsid，一个账号一个组）
    pf="$(snowluma_acct_pid_file "$name")"
    if [[ -f "$pf" ]]; then
        pid="$(tr -d '[:space:]' < "$pf" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
            if [[ -n "$pgid" && "$pgid" =~ ^[0-9]+$ ]]; then
                kill -TERM -- "-${pgid}" 2>/dev/null || true
                sleep 1
                kill -9 -- "-${pgid}" 2>/dev/null || true
            fi
        fi
        rm -f "$pf" 2>/dev/null || true
    fi

    for p in "${pids[@]}"; do kill -TERM "$p" 2>/dev/null || true; done
    sleep 1
    for p in "${pids[@]}"; do kill -9 "$p" 2>/dev/null || true; done

    # Electron 常见：主进程死后 crashpad 会短暂再拉起，短窗口压一下
    for ((i=0; i<6; i++)); do
        left=0
        for p in $(snowluma_acct_pids "$name"); do
            kill -9 "$p" 2>/dev/null || true
            left=1
        done
        if (( left == 0 )); then
            break
        fi
        sleep 0.6
    done

    if snowluma_acct_is_running "$name"; then
        error "$(snowluma_acct_label "$name") 还有残留没杀干净"
        return 1
    fi
    info "$(snowluma_acct_label "$name") 已停止，其它账号不受影响 喵"
    return 0
}

# 按当前模式启动指定账号（$1 = 账号名 或 main）
snowluma_acct_start() {
    local name="$1" mode prog
    mode="$(snowluma_get_mode)"
    if [[ -z "$mode" ]]; then
        error "SnowLuma 还没装，请先安装"
        return 1
    fi
    if [[ "$mode" == "docker" ]]; then
        if ! snowluma_is_running; then
            error "容器未运行，请先「启动 SnowLuma」"
            return 1
        fi
        if [[ "$name" == "main" ]]; then
            prog="qq"
        else
            prog="$(snowluma_acct_supervisor_name "$name")" || {
                error "找不到 ${name} 对应的 supervisor program"
                return 1
            }
        fi
        if docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl start "$prog" >/dev/null 2>&1; then
            info "容器内 ${prog} 已经跑起来 喵"
        else
            warn "supervisorctl start ${prog} 没成功（镜像较旧？） 喵"
        fi
        return 0
    fi
    if [[ "$name" == "main" ]]; then
        snowluma_qq_start
        return $?
    fi
    snowluma_acct_start_native "$name"
}

# 按当前模式停止指定账号（$1 = 账号名 或 main）
snowluma_acct_stop() {
    local name="$1" mode prog pid
    mode="$(snowluma_get_mode)"
    if [[ -z "$mode" ]]; then
        error "SnowLuma 还没装"
        return 1
    fi
    if [[ "$mode" == "docker" ]]; then
        if [[ "$name" == "main" ]]; then
            prog="qq"
        else
            prog="$(snowluma_acct_supervisor_name "$name")" || {
                error "找不到 ${name} 对应的 supervisor program"
                return 1
            }
        fi
        docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl stop "$prog" >/dev/null 2>&1 || true
        # supervisor 有时管不到逃逸出去的子进程，按它记录的 PID 再补一刀
        pid="$(docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl pid "$prog" 2>/dev/null | tr -d '[:space:]' || true)"
        if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]]; then
            docker exec "$SNOWLUMA_DOCKER_NAME" kill -9 "$pid" >/dev/null 2>&1 || true
        fi
        info "已停止容器内 ${prog} 喵"
        return 0
    fi
    snowluma_acct_stop_native "$name"
}

# ==================== SnowLuma 容器额外挂载（让容器读到宿主目录）====================
#
# 用途：SnowLuma 跑在容器里，而 kakake 在宿主机上。kakake 发媒体时只给协议端一个
# 本地路径字符串（file:///…），真去读盘上传的是容器里的 SnowLuma —— 它按这个
# 字符串在「容器自己的文件系统」里找，宿主机路径在容器里不存在，于是 realpath
# EACCES；合并转发里只要含本地路径，整条消息会被协议端拒（retcode=100）。
#
# 正解是把宿主机目录以「相同的绝对路径」挂进容器：-v /root/kakake:/root/kakake
# 左右两边路径必须逐字一致，否则 kakake 传的字符串在容器里依旧对不上。
# 这里默认只读（:ro）——协议端只需要读，只读能避免容器误改 kakake 数据。

# 已配置的挂载目录（一行一个宿主机绝对路径）
snowluma_mounts_list() {
    [[ -f "$SNOWLUMA_MOUNTS_FILE" ]] || return 0
    local raw line p
    raw="$(grep -vE '^[[:space:]]*(#|$)' "$SNOWLUMA_MOUNTS_FILE" 2>/dev/null | tr -d '\r' || true)"
    while IFS= read -r line; do
        line="${line%%#*}"
        line="${line//[[:space:]]/}"
        [[ -n "$line" ]] || continue
        case "$line" in
            /*) p="$line" ;;
            *) continue ;;
        esac
        # 去掉结尾多余的斜杠（/a/b/ → /a/b）
        while [[ "$p" == */ && "$p" != "/" ]]; do
            p="${p%/}"
        done
        printf '%s\n' "$p"
    done < <(printf '%s\n' "$raw")
}

snowluma_mounts_count() {
    local n
    n="$(snowluma_mounts_list | grep -c . || true)"
    printf '%s' "${n:-0}"
}

# 只读挂载？输出 ":ro" 或空串
snowluma_mounts_ro_flag() {
    if [[ -f "$SNOWLUMA_MOUNTS_RO_FILE" ]] \
        && [[ "$(tr -d '[:space:]' < "$SNOWLUMA_MOUNTS_RO_FILE" 2>/dev/null || true)" == "0" ]]; then
        printf ''
        return 0
    fi
    printf ':ro'
}

snowluma_mounts_is_ro() {
    [[ "$(snowluma_mounts_ro_flag)" == ":ro" ]]
}

# docker run 的挂载参数（每行一个，供 mapfile 读取）
snowluma_mounts_args() {
    local p ro
    ro="$(snowluma_mounts_ro_flag)"
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        printf '%s\n' "-v"
        printf '%s\n' "${p}:${p}${ro}"
    done < <(snowluma_mounts_list)
}

snowluma_mount_has() {
    local want="${1:-}" p
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if [[ "$p" == "$want" ]]; then
            return 0
        fi
    done < <(snowluma_mounts_list)
    return 1
}

# 猜 kakake 装在哪个目录：优先 mk 自己的安装位，再试几个常见位置。
# 找不到就输出空串，由调用方提示手填。
snowluma_mounts_suggest_kakake() {
    local -a cands=()
    # KAKAKE_HOME 在脚本后半段才 readonly，这里做惰性判断避免未定义报错
    if [[ -n "${KAKAKE_HOME:-}" ]]; then
        cands+=( "$KAKAKE_HOME" )
    fi
    cands+=(
        "${HOME:-/root}/kakake"
        /root/kakake
        /opt/kakake
        /home/kakake
    )
    local c
    for c in "${cands[@]}"; do
        [[ -n "$c" ]] || continue
        [[ "$c" == /* ]] || continue
        # 认目录里有 package.json 或 data 目录的，避免匹配到空壳
        if [[ -d "$c" ]] && { [[ -f "${c}/package.json" ]] || [[ -d "${c}/data" ]]; }; then
            printf '%s' "$c"
            return 0
        fi
    done
    printf ''
}

# 已配置的挂载里是否覆盖了某个路径（含其父目录）
snowluma_mounts_covers() {
    local want="${1:-}" p
    want="${want%/}"
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if [[ "$want" == "$p" || "$want" == "${p}/"* ]]; then
            return 0
        fi
    done < <(snowluma_mounts_list)
    return 1
}

# 添加一个挂载目录：$1=路径（必须是已存在的绝对路径）
snowluma_mount_add() {
    local p="${1:-}"
    [[ -n "$p" ]] || return 1
    case "$p" in
        /*) ;;
        *) error "要填绝对路径（比如 /root/kakake），你填的是: ${p}"; return 1 ;;
    esac
    while [[ "$p" == */ && "$p" != "/" ]]; do
        p="${p%/}"
    done
    if [[ ! -d "$p" ]]; then
        error "宿主机上找不到这个目录: ${p}"
        return 1
    fi
    if [[ "$p" == "/" ]]; then
        error "直接挂根目录太危险，请挂具体的数据目录"
        return 1
    fi
    # 清单按行读取并会去掉空白；含空格的路径会被悄悄改写成另一个路径，直接挡掉更省心
    if [[ "$p" =~ [[:space:]] ]]; then
        error "路径里不能有空格（${p}），换个不带空格的目录"
        return 1
    fi
    if snowluma_mount_has "$p"; then
        warn "${p} 已经在清单里了 喵"
        return 1
    fi
    mkdir -p "$LOG_DIR"
    printf '%s\n' "$p" >> "$SNOWLUMA_MOUNTS_FILE"
    return 0
}

snowluma_mount_remove() {
    local target="${1:-}" tmp="" line p
    [[ -f "$SNOWLUMA_MOUNTS_FILE" ]] || return 0
    tmp="$(mktemp "${MK_TMP}/snowluma-mount.XXXXXX" 2>/dev/null || true)"
    if [[ -z "$tmp" ]]; then
        tmp="${SNOWLUMA_MOUNTS_FILE}.tmp.$$"
    fi
    : > "$tmp"
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line//$'\r'/}"
        p="${line//[[:space:]]/}"
        if [[ -z "$p" ]]; then
            printf '%s\n' "$line" >> "$tmp"
            continue
        fi
        if [[ "$p" == "$target" ]]; then
            continue
        fi
        printf '%s\n' "$line" >> "$tmp"
    done < "$SNOWLUMA_MOUNTS_FILE"
    mv "$tmp" "$SNOWLUMA_MOUNTS_FILE"
    return 0
}

# 修宿主机权限：容器里是 snowluma(uid 1000)，宿主机是 root。
# 两件事：① 各级父目录给 o+x（否则连目录都进不去，典型是 /root 默认 700）
#         ② 挂载目录本身给 a+rX
# $1 = "recursive" 时连子文件一起递归（大目录会慢）；不传 = 只修目录本身
# 注意：本函数常被无参调用，位置参数一律写成 ${1:-}，
# 否则 set -u 下会直接 unbound variable 把整个 mk 顶出去（踩过一次）
snowluma_mounts_fix_perms() {
    local mode="${1:-}" p cur m om last
    local fixed=0
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if [[ ! -d "$p" ]]; then
            warn "跳过不存在的目录: ${p} 喵"
            continue
        fi
        # ① 父目录链：缺 others-x 就补上
        cur="$(dirname "$p")"
        while [[ -n "$cur" && "$cur" != "/" && "$cur" != "." ]]; do
            m="$(stat -c '%a' "$cur" 2>/dev/null || true)"
            if [[ -n "$m" ]]; then
                last="${m: -1}"
                om=$(( 8#${last} ))
                if (( (om & 1) == 0 )); then
                    chmod o+x "$cur" 2>/dev/null || true
                    info "已给父目录 ${cur}（${m}）补上 o+x（容器要能进来） 喵"
                    fixed=$((fixed + 1))
                else
                    # 明确报一声，免得用户以为这一步没执行
                    info "父目录 ${cur} 权限 ${m}，已有 o+x，不用改 喵"
                fi
            fi
            cur="$(dirname "$cur")"
        done
        # ② 目录本身
        if [[ "$mode" == "recursive" ]]; then
            chmod -R a+rX "$p" 2>/dev/null || true
            info "已递归放开 ${p} 的读权限 喵"
        else
            chmod a+rX "$p" 2>/dev/null || true
        fi
        fixed=$((fixed + 1))
    done < <(snowluma_mounts_list)
    if (( fixed == 0 )); then
        info "权限看着都没问题，没改动 喵"
    fi
    return 0
}

# 修「容器内」的父目录权限 —— 这一步和宿主机上的 [7] 是两回事，别混。
#
# 挂载 -v /root/kakake:/root/kakake 只覆盖了 /root/kakake 这一层；
# 它上面的 /root 是**容器镜像自己**的目录（默认 700 root:root）。
# 在宿主机上 chmod o+x /root 改的是宿主机的 /root，跟容器里那层毫无关系，
# 所以会出现「挂载有了 ✓、但 snowluma 进不去 ✗」。必须进容器里改。
#
# 因为是改容器的可写层，docker rm 重建后会丢 —— 所以建完容器要自动补一次。
snowluma_mounts_fix_container_perms() {
    local p cur fixed=0 i=0
    if ! snowluma_is_running; then
        warn "容器未运行，先启动 SnowLuma 再修 喵"
        return 1
    fi
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        cur="$(dirname "$p")"
        while [[ -n "$cur" && "$cur" != "/" && "$cur" != "." ]]; do
            # 容器刚起来时 exec 可能还没就绪，重试几轮
            i=0
            while (( i < 5 )); do
                if docker exec -u 0 "$SNOWLUMA_DOCKER_NAME" chmod o+x "$cur" >/dev/null 2>&1; then
                    info "已给容器内父目录 ${cur} 补上 o+x 喵"
                    fixed=$((fixed + 1))
                    break
                fi
                i=$((i + 1))
                sleep 1
            done
            cur="$(dirname "$cur")"
        done
    done < <(snowluma_mounts_list)
    if (( fixed == 0 )); then
        local n
        n="$(snowluma_mounts_count)"
        if (( n > 0 )); then
            warn "容器里的父目录没能 chmod（容器没跑起来？或路径不匹配） 喵"
        fi
    fi
    return 0
}

# 容器当前是否真的挂了这个宿主目录。
# 挂载是「建容器时」写进去的，所以重建容器之前这里恒为「没挂」——
# 验证时报「读不到」往往是这个原因，不是权限问题，别误报成父目录权限。
snowluma_mounts_in_container() {
    local want="${1:-}"
    [[ -n "$want" ]] || return 1
    snowluma_is_running || return 1
    local mounts
    mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' \
        "$SNOWLUMA_DOCKER_NAME" 2>/dev/null | tr -d '\r' || true)"
    [[ -n "$mounts" ]] || return 1
    printf '%s\n' "$mounts" | grep -qxF "$want"
}

# 容器里以 snowluma 用户验证能不能读（用 root 验是假阳性）
snowluma_mounts_verify() {
    local p found="" probe=""
    if ! snowluma_is_running; then
        warn "容器未运行，先「启动 SnowLuma」再验证 喵"
        return 1
    fi
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        echo
        echo "  ${p}"
        # 先看「挂了没有」，再看「读不读得到」——两者症状一样，原因完全不同
        if ! snowluma_mounts_in_container "$p"; then
            echo -e "    ${YELLOW}还没生效：容器里没有这个挂载 ✗${NC}"
            echo -e "    → 挂载是建容器时写进去的，请先用 ${CYAN}[6] 重建容器${NC}，再回来 [8] 验证"
            continue
        fi
        echo -e "    ${GREEN}容器已挂载 ✓${NC}"
        if docker exec -u snowluma "$SNOWLUMA_DOCKER_NAME" test -r "$p" 2>/dev/null; then
            echo -e "    ${GREEN}容器可读 ✓${NC}"
        else
            echo -e "    ${YELLOW}容器读不到 ✗ —— 挂载有了但进不去${NC}"
            # 挂载只覆盖这一层，父目录是镜像自带的，把两边的权限都摊开看
            local par st=""
            par="$(dirname "$p")"
            echo "    逐层排查（容器视角）:"
            while [[ -n "$par" && "$par" != "/" ]]; do
                st="$(docker exec -u 0 "$SNOWLUMA_DOCKER_NAME" \
                    stat -c '%a %U:%G' "$par" 2>/dev/null | tr -d '\r' || true)"
                if [[ -z "$st" ]]; then
                    echo "      ${par}  （容器里取不到状态）"
                else
                    local pmode="${st%% *}"
                    local plast="${pmode: -1}"
                    if (( ( 8#${plast} & 1) == 0 )); then
                        echo -e "      ${par}  ${st}  ${YELLOW}缺 o+x ← 卡在这层${NC}"
                    else
                        echo -e "      ${par}  ${st}  ${GREEN}o+x 正常${NC}"
                    fi
                fi
                par="$(dirname "$par")"
            done
            echo "    → 父目录缺 o+x 就选 [7] 的 ${CYAN}[3]${NC}（修容器内，不用重建）"
            echo "      挂载点本身缺 r/x 就选 [7] 的 [1]（修宿主机），然后 [6] 重建"
            continue
        fi
        # 再挑一个真实文件试着读 100 字节
        probe="$(docker exec -u snowluma "$SNOWLUMA_DOCKER_NAME" \
            sh -lc "find '$p' -maxdepth 4 -type f -size +0c 2>/dev/null | head -n1" 2>/dev/null | tr -d '\r' || true)"
        if [[ -n "$probe" ]]; then
            if docker exec -u snowluma "$SNOWLUMA_DOCKER_NAME" head -c 100 "$probe" >/dev/null 2>&1; then
                echo -e "    ${GREEN}可读到文件内容 ✓  ${probe}${NC}"
                found=1
            else
                echo -e "    ${YELLOW}文件存在但读不到: ${probe}（文件权限可能还是 600）${NC}"
            fi
        else
            echo "    （目录下还没找到文件，无法做读测试）"
        fi
    done < <(snowluma_mounts_list)
    echo
    if [[ -n "$found" ]]; then
        info "挂载验证通过：协议端现在能按本地路径读盘 喵"
    fi
    return 0
}

# 用「当前账号配置」创建并启动容器；调用前请确保同名容器已不存在。
# VNC 密码由调用方通过 snowluma_vnc_load_cfg 准备好。
snowluma_docker_create() {
    local extra_csv shm line
    extra_csv="$(snowluma_accounts_csv)"
    shm="$(snowluma_accounts_shm)"
    # WebUI 映射到宿主机的哪张网卡/哪个端口（菜单 [18] 可改，默认 0.0.0.0:5099）
    snowluma_webui_docker_load_cfg
    local webui_pub
    webui_pub="$(snowluma_webui_docker_pub_arg)"

    local -a extra_env=()
    if [[ -n "$extra_csv" ]]; then
        extra_env=( -e "SNOWLUMA_EXTRA_QQ_HOMES=${extra_csv}" )
    fi

    local -a vol_args=()
    while IFS= read -r line; do
        # 注意：不能写成 [[ -n "$line" ]] && ... ，set -e 下空行会让整条语句返回 1 而中断
        if [[ -n "$line" ]]; then
            vol_args+=( "$line" )
        fi
    done < <(snowluma_accounts_volume_args)

    # 额外挂载（宿主目录 → 容器同路径，默认只读）
    local -a mount_args=()
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then
            mount_args+=( "$line" )
        fi
    done < <(snowluma_mounts_args)

    local acct_n
    acct_n="$(snowluma_accounts_count)"
    if (( acct_n > 0 )); then
        info "本次挂载 ${acct_n} 个额外账号卷，共享内存 ${shm} 喵"
    fi
    local mount_n
    mount_n="$(snowluma_mounts_count)"
    if (( mount_n > 0 )); then
        local ro_txt="只读"
        if ! snowluma_mounts_is_ro; then
            ro_txt="可写"
        fi
        info "本次额外挂载 ${mount_n} 个宿主目录（${ro_txt}） 喵"
    fi

    docker run -d \
        --name "$SNOWLUMA_DOCKER_NAME" \
        --restart unless-stopped \
        --shm-size="$shm" \
        --ulimit nofile=65536:1048576 \
        --cap-add=SYS_PTRACE \
        --security-opt seccomp=unconfined \
        -e VNC_PASSWD="${SNOWLUMA_VNC_PASS}" \
        -e SNOWLUMA_WEBUI_HOST=0.0.0.0 \
        -e SNOWLUMA_WEBUI_PORT="${SNOWLUMA_WEBUI_PORT}" \
        -e SNOWLUMA_QQ_FLAGS="--disable-gpu --disable-software-rasterizer --disable-gpu-compositing" \
        -e SNOWLUMA_ACCEPT_EULA=1 \
        -e SNOWLUMA_ACCEPT_PRIVACY=1 \
        -e TZ=Asia/Shanghai \
        ${extra_env[@]+"${extra_env[@]}"} \
        -p 5900:5900 \
        -p 6081:6081 \
        -p "${webui_pub}" \
        -p 3000:3000 \
        -p 3001:3001 \
        -v snowluma-data:/app/data \
        -v snowluma-qq-config:/app/.config \
        -v snowluma-qq-data:/app/.local/share \
        ${vol_args[@]+"${vol_args[@]}"} \
        ${mount_args[@]+"${mount_args[@]}"} \
        "$SNOWLUMA_DOCKER_IMAGE" || return 1

    # 容器里的 /root 是镜像自带的（700），不补 o+x 的话 snowluma 进不去挂载点。
    # 改的是容器可写层，重建即丢，所以每次建完都要补。
    if (( mount_n > 0 )); then
        snowluma_mounts_fix_container_perms || true
    fi
    return 0
}

# 增删账号后重建容器让配置生效。数据卷一律保留，所以登录态不会丢。
snowluma_recreate_docker() {
    if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        error "容器 ${SNOWLUMA_DOCKER_NAME} 还不存在，请先安装 SnowLuma"
        return 1
    fi

    info "正在重建容器使账号配置生效（数据卷保留，登录态不丢） 喵"
    snowluma_vnc_load_cfg
    docker rm -f "$SNOWLUMA_DOCKER_NAME" >/dev/null 2>&1 || true

    if snowluma_docker_create; then
        snowluma_set_mode "docker"
        echo "docker" > "$SNOWLUMA_VER_FILE"
        info "容器已重建 喵"
        return 0
    fi

    error "重建容器失败了"
    return 1
}

snowluma_install_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        warn "没找到 docker 喵"
        local goinst=""
        read -r -p "是否现在自动安装 Docker? [Y/n]: " goinst
        if [[ ! "$goinst" =~ ^[Nn]$ ]]; then
            docker_install || true
        fi
        if ! command -v docker >/dev/null 2>&1; then
            error "还是没有 docker，请先装好 Docker（主菜单 [12]）再选 Docker 模式"
            return 1
        fi
    fi

    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        local re=""
        warn "已经有同名容器: ${SNOWLUMA_DOCKER_NAME} 喵"
        read -r -p "是否删除并重建? [y/N]: " re
        [[ "$re" =~ ^[Yy]$ ]] || return 0
        docker rm -f "$SNOWLUMA_DOCKER_NAME" >/dev/null 2>&1 || true
    fi

    local image_ref="$SNOWLUMA_DOCKER_IMAGE"
    local mirror_prefix="${snowluma_docker_mirror_prefixes[$SNOWLUMA_DOCKER_MIRROR_INDEX]:-}"
    if [[ -n "$mirror_prefix" ]]; then
        image_ref="${mirror_prefix}/${SNOWLUMA_DOCKER_IMAGE}"
    fi
    info "拉取镜像 ${image_ref} 喵"
    if ! docker pull "$image_ref"; then
        error "拉取镜像失败，换个加速源再试"
        return 1
    fi
    if [[ -n "$mirror_prefix" ]]; then
        docker tag "$image_ref" "$SNOWLUMA_DOCKER_IMAGE" >/dev/null 2>&1 || true
    fi

    info "创建并启动容器 喵"
    # 官方镜像会拒绝 vncpasswd 这类公开示例值（当成未设置→随机密码），所以这里确保用一个非示例密码
    snowluma_vnc_load_cfg
    if snowluma_vnc_pass_is_example "$SNOWLUMA_VNC_PASS"; then
        SNOWLUMA_VNC_PASS="$(snowluma_gen_password)"
        snowluma_vnc_save_cfg
        info "已为 noVNC/VNC 生成随机密码（避开镜像黑名单）: ${SNOWLUMA_VNC_PASS} 喵"
    fi
    if snowluma_docker_create; then
        snowluma_set_mode "docker"
        echo "docker" > "$SNOWLUMA_VER_FILE"
        snowluma_open_ports 5900 6081 "${SNOWLUMA_WEBUI_HOST_PORT:-$SNOWLUMA_WEBUI_PORT}" 3000 3001
        info "Docker 装好 喵"
        snowluma_show_login_info
    else
        error "创建容器失败"
        return 1
    fi
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
    info "下载 ${asset} 喵"
    info "URL: ${dl_url}"
    if ! curl -fL --retry 3 --connect-timeout 30 -A 'mk-tools' -o "${tmpdir}/${asset}" "$dl_url"; then
        error "下载失败"
        rm -rf "$tmpdir"
        return 1
    fi

    info "解压到 ${SNOWLUMA_HOME} 喵"
    if [[ -d "$SNOWLUMA_HOME" ]] && [[ -n "$(ls -A "$SNOWLUMA_HOME" 2>/dev/null || true)" ]]; then
        local bak="${SNOWLUMA_HOME}.bak.$(date +%Y%m%d%H%M%S)"
        warn "已有文件，备份到 ${bak} 喵"
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
                error "解压后没找到 launcher.sh / index.mjs"
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
    info "直接装好啦: ${tag} → ${SNOWLUMA_HOME} 喵"
    info "请先「安装 QQ」，再「启动 SnowLuma」 喵"
}

snowluma_do_install() {
    SNOWLUMA_PROXY_INDEX="0"
    SNOWLUMA_VERSION_TAG="latest"
    SNOWLUMA_VERSION_LABEL=""
    SNOWLUMA_INSTALL_MODE=""

    if snowluma_is_installed; then
        local re=""
        warn "小MK发现 SnowLuma 已装好 (模式: $(snowluma_get_mode)) 喵"
        read -r -p "是否重新安装? [y/N]: " re
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
        menu_snowluma_select_docker_mirror || return 0
        if mk_nav_bubble_up; then return 0; fi
        snowluma_install_docker
    fi
}

snowluma_do_uninstall() {
    title "卸载 SnowLuma"
    local mode
    mode="$(snowluma_get_mode)"
    echo "  当前模式: ${mode:-未安装}"
    echo "  Docker：删除容器（默认保留数据卷）"
    echo "  直接安装：删除 ${SNOWLUMA_HOME}"
    echo
    local confirm=""
    read -r -p "确认卸载 SnowLuma? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "已经取消 喵"; return 0; }

    snowluma_stop || true
    snowluma_qq_stop || true
    snowluma_vnc_stop_stack >/dev/null 2>&1 || true
    snowluma_webui_bridge_stop >/dev/null 2>&1 || true

    if [[ "$mode" == "docker" ]] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        docker rm -f "$SNOWLUMA_DOCKER_NAME" >/dev/null 2>&1 || true
        local wipe=""
        read -r -p "是否同时删除 Docker 数据卷 (扫码登录会丢失)? [y/N]: " wipe
        if [[ "$wipe" =~ ^[Yy]$ ]]; then
            local -a vols=( snowluma-data snowluma-qq-config snowluma-qq-data )
            local ah=""
            while IFS= read -r ah; do
                [[ -n "$ah" ]] || continue
                vols+=( "$(snowluma_acct_volume_name "$ah")" )
            done < <(snowluma_accounts_list)
            docker volume rm "${vols[@]}" >/dev/null 2>&1 || true
            info "已删除 ${#vols[@]} 个数据卷 喵"
        fi
    fi

    if [[ -d "$SNOWLUMA_HOME" ]]; then
        rm -rf "$SNOWLUMA_HOME"
    fi

    # 常规安装的多账号 HOME（不在 $SNOWLUMA_HOME 里，得单独问）
    if [[ "$mode" != "docker" && -d "$SNOWLUMA_NATIVE_ACCT_HOME_ROOT" ]]; then
        local wipe2=""
        read -r -p "是否同时删除多账号 HOME 目录 ${SNOWLUMA_NATIVE_ACCT_HOME_ROOT} (各账号登录态会丢失)? [y/N]: " wipe2
        if [[ "$wipe2" =~ ^[Yy]$ ]]; then
            rm -rf "$SNOWLUMA_NATIVE_ACCT_HOME_ROOT"
            info "已删除多账号 HOME 目录 喵"
        fi
    fi

    rm -f "$SNOWLUMA_MODE_FILE" "$SNOWLUMA_VER_FILE" "$SNOWLUMA_PID_FILE" \
        "$SNOWLUMA_LOG" "$SNOWLUMA_INSTALL_LOG" \
        "$SNOWLUMA_WEBUI_BRIDGE_PID" "$SNOWLUMA_WEBUI_BRIDGE_CFG" "$SNOWLUMA_WEBUI_BRIDGE_LOG" \
        "$SNOWLUMA_WEBUI_HOST_FILE" "$SNOWLUMA_WEBUI_DOCKER_CFG" "$SNOWLUMA_ACCOUNTS_FILE" \
        "$SNOWLUMA_MOUNTS_FILE" "$SNOWLUMA_MOUNTS_RO_FILE" 2>/dev/null || true
    # 每账号 PID 文件（常规安装多开）
    rm -f "${LOG_DIR}"/snowluma-qq-*.pid 2>/dev/null || true
    info "SnowLuma 已卸载 喵"
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
            SNOWLUMA_QQ_MATCH_LABELS+=
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

    info "正在刷新 QQ 下载列表（官网 rainbow + 内置兼容源） 喵"
    snowluma_list_qq_options

    while true; do
        title "安装 QQ（SnowLuma 兼容列表）"
        show_nav_hint
        echo "  系统架构: ${arch}    包格式偏好: ${pkg}"
        echo "  SnowLuma 版本: ${snow_ver:-未安装}    模式: ${mode:-无}"
        echo "  下载域名: 优先 dldir1v6.qq.com（官网新域名），失败自动试 GitHub 归档"
        echo "  官网: https://im.qq.com/linuxqq/index.shtml"
        echo
        if [[ "$mode" == "docker" ]]; then
            echo -e "  ${YELLOW}* Docker 模式镜像已内置 QQ，一般无需再装宿主 QQ${NC}"
            echo -e "  ${YELLOW}* 下列地址供对照/备用；选安装将装到宿主机 /opt/QQ${NC}"
            echo
        fi

        if ((${#SNOWLUMA_QQ_MATCH_LABELS[@]} == 0)); then
            warn "当前架构暂无可用直链，请到官网下载对应 ${arch} 包 喵"
            echo
        else
            for ((i=0; i<${#SNOWLUMA_QQ_MATCH_LABELS[@]}; i++)); do
                idx=$((i + 2))
                echo "  [${idx}] 安装 ${SNOWLUMA_QQ_MATCH_LABELS[$i]}"
                local u
                IFS=';' read -r -a _show <<<"${SNOWLUMA_QQ_MATCH_URLSETS[$i]}"
                for u in "${_show[@]}"; do
                    echo "       - ${u#GH:}"
                done
            done
            echo
            echo "  选择序号后会按顺序探测可用源并下载安装"
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
                warn "无法识别该选项，请重新输入 喵"
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
        warn "小MK发现已安装 /opt/QQ/qq 喵"
        read -r -p "是否覆盖安装 ${ver}? [y/N]: " re
        [[ "$re" =~ ^[Yy]$ ]] || return 0
        snowluma_qq_stop || true
    fi

    tmp="$(mktemp -d /tmp/snowluma-qq.XXXXXX)"
    if [[ "$urlset" == *.rpm* && "$urlset" != *.deb* ]]; then
        pkgfile="${tmp}/linuxqq_${ver}.rpm"
    else
        pkgfile="${tmp}/linuxqq_${ver}.deb"
    fi

    info "探测可用下载源: ${ver} 喵"
    IFS=';' read -r -a _cands <<<"$urlset"
    for cand in "${_cands[@]}"; do
        [[ -z "$cand" ]] && continue
        resolved="$(snowluma_qq_resolve_candidate "$cand" "$proxy_idx")"
        info "尝试: ${resolved} 喵"
        if snowluma_qq_url_alive "$resolved"; then
            ok_url="$resolved"
            break
        fi
        # 部分 CDN 对 HEAD 不友好，再试小段 GET
        if curl -fsSL --max-time 20 -A 'mk-tools' -r 0-1023 -o /dev/null "$resolved" 2>/dev/null; then
            ok_url="$resolved"
            break
        fi
        warn "不可用，跳过 喵"
    done

    if [[ -z "$ok_url" ]]; then
        error "所有下载源均不可用（含官网 dldir1v6 与归档镜像）"
        rm -rf "$tmp"
        return 1
    fi

    info "下载 QQ ${ver} 喵"
    info "$ok_url"
    if ! curl -fL --retry 3 --connect-timeout 30 -A 'mk-tools' -o "$pkgfile" "$ok_url"; then
        error "下载失败"
        rm -rf "$tmp"
        return 1
    fi
    sz="$(wc -c < "$pkgfile" 2>/dev/null || echo 0)"
    if [[ "${sz:-0}" -lt 1000000 ]]; then
        error "下载文件异常偏小 (${sz} bytes)，可能仍是 404 页"
        rm -rf "$tmp"
        return 1
    fi

    info "安装 QQ 喵"
    if [[ "$pkgfile" == *.rpm ]]; then
        if command -v rpm >/dev/null 2>&1; then
            rpm -Uvh "$pkgfile" || true
        else
            error "当前系统无 rpm，无法安装 rpm 包"
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
            error "当前系统无 dpkg/apt，无法安装 deb 包"
            rm -rf "$tmp"
            return 1
        fi
    fi

    rm -rf "$tmp"
    if [[ -x "/opt/QQ/qq" ]]; then
        info "QQ ${ver} 装好啦: /opt/QQ/qq 喵"
        snowluma_qq_ensure_runtime_deps || true
    else
        warn "安装命令已执行，但小MK没找到 /opt/QQ/qq，帮忙检查一下输出 喵"
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
    warn "少了扫码桌面依赖，正在装 Xvfb / x11vnc / 轻量窗口管理器 喵"
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
    command -v Xvfb >/dev/null 2>&1 || { error "Xvfb 安装失败"; return 1; }
    command -v x11vnc >/dev/null 2>&1 || { error "x11vnc 安装失败"; return 1; }
    command -v openbox >/dev/null 2>&1 || command -v fluxbox >/dev/null 2>&1 \
        || { error "openbox/fluxbox 安装失败"; return 1; }
    info "扫码桌面依赖已经准备好 喵"
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
    command -v git >/dev/null 2>&1 || { error "需要 git 以下载 noVNC"; return 1; }
    info "下载 noVNC 到 ${SNOWLUMA_NOVNC_DIR} 喵"
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
    error "noVNC 准备失败"
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
    snowluma_vnc_ensure_index "$webroot" || warn "未能写入 noVNC index.html，请改用 /vnc.html 喵"

    # QQ 已在虚拟屏上跑时：只补远程查看，绝不重启 Xvfb（否则会杀掉 QQ）
    if snowluma_xvfb_is_up; then
        if snowluma_qq_is_running && snowluma_qq_on_mk_display; then
            info "小MK发现 QQ 已在 ${SNOWLUMA_DISPLAY} 运行，仅拉起/保持远程查看（不重启虚拟屏） 喵"
            snowluma_vnc_start_viewer "$webroot" || return 1
            return 0
        fi
        # 虚拟屏在、QQ 不在或未挂本屏：只保证远程查看可用
        if snowluma_vnc_is_running; then
            snowluma_vnc_ensure_index "$webroot" || true
            info "扫码桌面已在运行 喵"
            snowluma_open_ports "$SNOWLUMA_VNC_PORT" "$SNOWLUMA_NOVNC_PORT"
            info "若根路径是目录列表，请打开: http://$(napcat_get_server_ip):${SNOWLUMA_NOVNC_PORT}/vnc.html 喵"
            return 0
        fi
        snowluma_vnc_start_viewer "$webroot" || return 1
        if ! snowluma_qq_is_running; then
            warn "当前还没启动 QQ：桌面可能是灰/黑空屏，请回菜单点「启动 QQ」 喵"
        fi
        return 0
    fi

    # 无虚拟屏，但有「脱管 QQ」（没挂 :99）——不能瞎重建，也不能干等
    if snowluma_qq_is_running; then
        if snowluma_qq_on_mk_display; then
            # 极端：声称在 :99 但 X 已死 → QQ 也基本废了，必须清掉重建
            warn "虚拟屏 ${SNOWLUMA_DISPLAY} 已丢失，但 QQ 仍占着该 DISPLAY，将结束 QQ 后重建扫码桌面 喵"
            snowluma_qq_kill_all || true
            sleep 1
        else
            error "小MK发现脱管 QQ（未挂扫码屏 ${SNOWLUMA_DISPLAY}），且虚拟屏未运行"
            error "请先点「彻底杀死 QQ」或「启动 QQ」（启动会自动清掉脱管进程再拉起）"
            return 1
        fi
    fi

    snowluma_vnc_stop_stack >/dev/null 2>&1 || true
    snowluma_vnc_load_cfg
    rm -f "/tmp/.X${SNOWLUMA_DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${SNOWLUMA_DISPLAY_NUM}" 2>/dev/null || true
    mkdir -p /tmp/.X11-unix
    chmod 1777 /tmp/.X11-unix 2>/dev/null || true

    x11vnc -storepasswd "$SNOWLUMA_VNC_PASS" "$SNOWLUMA_VNC_PASSFILE" >/dev/null 2>&1 || true

    info "启动 Xvfb ${SNOWLUMA_DISPLAY} 喵"
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
        error "Xvfb 启动失败了，见 ${SNOWLUMA_VNC_LOG}"
        return 1
    fi

    if command -v openbox >/dev/null 2>&1; then
        wm_bin="openbox"
    else
        wm_bin="fluxbox"
    fi
    info "启动窗口管理器 ${wm_bin} 喵"
    nohup env DISPLAY="$SNOWLUMA_DISPLAY" "$wm_bin" >>"$SNOWLUMA_VNC_LOG" 2>&1 &
    echo $! > "$SNOWLUMA_WM_PID"
    sleep 0.5
    if command -v xsetroot >/dev/null 2>&1; then
        DISPLAY="$SNOWLUMA_DISPLAY" xsetroot -solid '#2b2b2b' >/dev/null 2>&1 || true
    fi

    snowluma_vnc_start_viewer "$webroot" || return 1
    if ! snowluma_qq_is_running; then
        warn "当前还没启动 QQ：桌面可能是灰/黑空屏，请回菜单点「启动 QQ」 喵"
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
        info "启动 x11vnc :${SNOWLUMA_VNC_PORT} 喵"
        nohup x11vnc -display "$SNOWLUMA_DISPLAY" \
            -rfbport "$SNOWLUMA_VNC_PORT" \
            -rfbauth "$SNOWLUMA_VNC_PASSFILE" \
            -forever -shared -xkb -noxrecord \
            >>"$SNOWLUMA_VNC_LOG" 2>&1 &
        echo $! > "$SNOWLUMA_VNC_PID"
        sleep 0.5
        if ! snowluma_vnc_is_running; then
            error "x11vnc 启动失败了，见 ${SNOWLUMA_VNC_LOG}"
            return 1
        fi
    fi

    if ! snowluma_pidfile_running "$SNOWLUMA_NOVNC_PID"; then
        info "启动 noVNC :${SNOWLUMA_NOVNC_PORT} 喵"
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
            error "没找到 websockify / novnc_proxy"
            return 1
        fi
        sleep 0.5
    fi

    snowluma_open_ports "$SNOWLUMA_VNC_PORT" "$SNOWLUMA_NOVNC_PORT"
    info "远程查看已经准备好啦（QQ/虚拟屏保持不动） 喵"
    info "noVNC: http://$(napcat_get_server_ip):${SNOWLUMA_NOVNC_PORT}/vnc.html"
    info "VNC:   $(napcat_get_server_ip):${SNOWLUMA_VNC_PORT}  密码: ${SNOWLUMA_VNC_PASS} 喵"
}

# 只停远程查看（x11vnc/noVNC），保留 Xvfb + QQ
snowluma_vnc_stop_viewer() {
    snowluma_vnc_load_cfg
    snowluma_kill_pidfile "$SNOWLUMA_NOVNC_PID"
    snowluma_kill_pidfile "$SNOWLUMA_VNC_PID"
    pkill -f "x11vnc.*${SNOWLUMA_DISPLAY}" 2>/dev/null || true
    pkill -f "websockify.*${SNOWLUMA_NOVNC_PORT}" 2>/dev/null || true
    pkill -f "novnc_proxy.*${SNOWLUMA_NOVNC_PORT}" 2>/dev/null || true
    info "已停止远程查看 (noVNC/VNC)，QQ 与虚拟屏 ${SNOWLUMA_DISPLAY} 仍在运行 喵"
    if snowluma_qq_is_running; then
        info "QQ 进程未受影响 喵"
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
    info "虚拟屏与扫码桌面已全部停止 喵"
}

snowluma_show_vnc_info() {
    local host_ip
    snowluma_vnc_load_cfg
    host_ip="$(napcat_get_server_ip)"
    title "SnowLuma 扫码桌面 (VNC / noVNC)"
    echo "  用途:     浏览器打开 noVNC，在 QQ 窗口里扫码登录"
    echo "  显示:     ${SNOWLUMA_DISPLAY} (虚拟屏，非完整桌面)"
    if snowluma_vnc_is_running || [[ "$(snowluma_get_mode)" == "docker" ]]; then
        echo -e "  状态:     ${GREEN}运行中${NC}"
    elif snowluma_xvfb_is_up; then
        echo -e "  状态:     ${YELLOW}虚拟屏在、远程查看未开${NC}"
    else
        echo -e "  状态:     ${YELLOW}未运行${NC}"
    fi
    if snowluma_qq_is_running && ! snowluma_qq_on_mk_display; then
        echo -e "  警告:     ${YELLOW}QQ 脱管（未挂 ${SNOWLUMA_DISPLAY}），扫码无法识别；请「启动 QQ」自动修复${NC}"
    fi
    echo "  noVNC:    http://${host_ip}:${SNOWLUMA_NOVNC_PORT}/vnc.html"
    echo "            http://${host_ip}:${SNOWLUMA_NOVNC_PORT}/"
    echo "  VNC:      ${host_ip}:${SNOWLUMA_VNC_PORT}"
    echo "  密码:     ${SNOWLUMA_VNC_PASS}"
    echo "  改端口:   菜单「配置扫码端口」或编辑 ${SNOWLUMA_VNC_CFG}"
    if [[ "$(snowluma_get_mode)" == "docker" ]]; then
        echo "  说明:     Docker 模式由容器映射提供（改端口需改 docker -p）"
    else
        echo "  日志:     ${SNOWLUMA_VNC_LOG}"
        echo "  提示:     「启动 QQ」会自动拉起扫码桌面"
        echo "  注意:     若根路径显示目录列表，请点开 /vnc.html"
        echo "  登完后:   可「仅停止远程查看」，QQ 继续跑；关浏览器即可不扫码"
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

    warn "小MK发现 QQ 少了系统库，正在装运行依赖 喵"
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
        error "仍少了 libasound.so.2，手动安装: apt install libasound2 或 libasound2t64"
        return 1
    fi
    if command -v ldd >/dev/null 2>&1 && [[ -x /opt/QQ/qq ]]; then
        local miss
        miss="$(ldd /opt/QQ/qq 2>/dev/null | awk '/not found/{print $1}' | head -8 | tr '\n' ' ')"
        if [[ -n "$miss" ]]; then
            warn "仍有缺失库: ${miss} 喵"
            warn "可执行: ldd /opt/QQ/qq | grep 'not found' 后按包名补装"
        fi
    fi
    info "QQ 运行依赖已处理 喵"
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
            warn "小MK发现 ${AUTOSTART_NAPCAT_UNIT} 已启用：它也可能拉起 /opt/QQ/qq 喵"
            warn "若 QQ 仍反复自启，请到主菜单「开机自启」关闭 NapCat 自启 喵"
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
            error "Docker 容器未运行，请先启动 SnowLuma"
            return 1
        fi
        info "Docker 模式下通过 supervisor 拉起 QQ 喵"
        docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl start qq >/dev/null 2>&1 \
            || docker exec -u snowluma -e DISPLAY=:1 -d "$SNOWLUMA_DOCKER_NAME" \
                sh -lc 'qq --no-sandbox ${SNOWLUMA_QQ_FLAGS:-}' >/dev/null 2>&1 || true
        sleep 2
        if snowluma_qq_is_running; then
            info "容器内 QQ 已经跑起来；扫码请用 noVNC: http://$(napcat_get_server_ip):${SNOWLUMA_NOVNC_PORT}/ 喵"
        else
            warn "未能确认 QQ 进程，请 docker logs / VNC 排查 喵"
        fi
        return 0
    fi

    if [[ ! -x "/opt/QQ/qq" ]]; then
        error "还没装宿主 QQ，请先「安装 QQ」"
        return 1
    fi

    # 多账号场景：下面的"有没有在跑/是否脱管"都要只看主账号自己，
    # 否则别的账号跑着就会让主账号永远起不来（旧逻辑是全量 /opt/QQ 判定）。
    if (( $(snowluma_accounts_count) > 0 )); then
        if snowluma_main_qq_is_running && snowluma_main_qq_on_display && snowluma_xvfb_is_up; then
            warn "主账号 QQ 已在扫码屏 ${SNOWLUMA_DISPLAY} 运行 喵"
            snowluma_vnc_start_stack || true
            snowluma_show_vnc_info
            return 0
        fi
        if snowluma_main_qq_is_running; then
            warn "主账号脱管或虚拟屏已死，将只重启主账号（其它账号不受影响） 喵"
            snowluma_acct_stop_native main || true
        fi
        # 走到这里正常拉起主账号（共用同一块 Xvfb）
        snowluma_qq_ensure_runtime_deps || return 1
        snowluma_vnc_start_stack || return 1
        mkdir -p "$LOG_DIR"
        rm -f "$SNOWLUMA_QQ_STOP_FLAG"
        echo "===== QQ[主账号] start $(date '+%Y-%m-%d %H:%M:%S') HOME=${HOME:-/root} DISPLAY=${SNOWLUMA_DISPLAY} =====" >> "$SNOWLUMA_QQ_LOG"
        nohup setsid env DISPLAY="$SNOWLUMA_DISPLAY" \
            '/opt/QQ/qq' --no-sandbox \
            --disable-gpu --disable-software-rasterizer --disable-gpu-compositing \
            --disable-gpu-sandbox --in-process-gpu --use-gl=swiftshader \
            >> "$SNOWLUMA_QQ_LOG" 2>&1 &
        echo $! > "$SNOWLUMA_QQ_PID"
        sleep 3
        if snowluma_main_qq_is_running; then
            info "主账号 QQ 已启动（DISPLAY=${SNOWLUMA_DISPLAY}） 喵"
            snowluma_show_vnc_info
        else
            error "QQ 启动失败了，见日志: ${SNOWLUMA_QQ_LOG}"
            tail -20 "$SNOWLUMA_QQ_LOG" 2>/dev/null || true
            return 1
        fi
        return 0
    fi

    # 已在扫码屏上正常跑：只补 VNC/noVNC
    if snowluma_qq_is_running && snowluma_qq_on_mk_display && snowluma_xvfb_is_up; then
        warn "QQ 已在扫码屏 ${SNOWLUMA_DISPLAY} 运行 喵"
        snowluma_vnc_start_stack || true
        snowluma_show_vnc_info
        return 0
    fi

    # 脱管：有 QQ 但不在 :99，或虚拟屏已死 —— 清掉再按正确 DISPLAY 拉起
    if snowluma_qq_is_running; then
        warn "小MK发现脱管/残缺 QQ（未正确挂在 ${SNOWLUMA_DISPLAY} 或虚拟屏已停） 喵"
        info "将结束旧进程，再连同扫码桌面重新启动 喵"
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
            error "无法结束脱管 QQ，请先用「彻底杀死 QQ」，并检查是否有 systemd/外部守护在拉起"
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
        info "QQ 已后台启动（DISPLAY=${SNOWLUMA_DISPLAY}） 喵"
        snowluma_show_vnc_info
        info "请用手机扫 noVNC 里 QQ 窗口的二维码 喵"
    else
        error "QQ 启动失败了，见日志: ${SNOWLUMA_QQ_LOG}"
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
        info "已尝试停止容器内 QQ 喵"
        return 0
    fi

    mkdir -p "$LOG_DIR"
    # 意图标记：便于排查「非 mk 拉起」的残留
    date '+%F %T' > "$SNOWLUMA_QQ_STOP_FLAG"
    info "正在彻底停止宿主 QQ（含子进程，并短时压制自动拉起） 喵"
    snowluma_qq_disable_autostart_hints || true
    snowluma_qq_kill_all || true

    if snowluma_qq_is_running; then
        warn "仍小MK发现 /opt/QQ/qq，再次强杀 喵"
        snowluma_qq_kill_all || true
    fi

    # 先停 QQ，再拆虚拟屏（避免先拆屏导致 QQ 崩溃拉起）
    snowluma_vnc_stop_stack || true

    if snowluma_qq_is_running; then
        error "QQ 仍在运行（可能被 systemd/NapCat 自启或其他守护拉起）"
        warn "排查: systemctl status ${AUTOSTART_NAPCAT_UNIT} 喵"
        warn "排查: ps -ef | grep -E '/opt/QQ|qq' | grep -v grep"
        return 1
    fi

    info "宿主 QQ 已经停下来；远程查看/虚拟屏已关闭 喵"
    info "若再次被拉起，请关闭 NapCat 开机自启，并检查: ps -ef | grep /opt/QQ"
}

# 菜单「彻底杀死 QQ」：不拆 VNC，只死磕 /opt/QQ 进程树 + 更长防拉起窗口
snowluma_qq_force_kill() {
    local mode confirm="" i left=0
    mode="$(snowluma_get_mode)"
    title "彻底杀死 QQ"
    echo "  将强制结束宿主 /opt/QQ 全部相关进程（含子进程/crashpad）"
    echo "  并在约 15 秒内反复压制自动拉起"
    echo "  默认不关闭 VNC/虚拟屏（需要可再点「仅停止远程查看」）"
    echo "  不会卸载 QQ 软件包"
    echo
    if [[ "$mode" == "docker" ]]; then
        echo "  当前为 Docker 模式：将在容器内强杀 QQ"
    fi
    read -r -p "确认彻底杀死? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "已经取消 喵"; return 0; }

    mkdir -p "$LOG_DIR"
    date '+%F %T force-kill' > "$SNOWLUMA_QQ_STOP_FLAG"
    snowluma_qq_disable_autostart_hints || true

    if [[ "$mode" == "docker" ]]; then
        docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl stop qq >/dev/null 2>&1 || true
        for ((i=0; i<15; i++)); do
            docker exec "$SNOWLUMA_DOCKER_NAME" pkill -9 -f '/opt/QQ/' >/dev/null 2>&1 || true
            sleep 1
        done
        info "已在容器内执行强杀 喵"
        return 0
    fi

    info "第 1 轮强杀 喵"
    snowluma_qq_kill_all || true
    info "持续压制自动拉起（约 15 秒） 喵"
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
        error "压制后仍有 /opt/QQ/qq，帮忙检查一下外部守护："
        ps -ef | grep -E '/opt/QQ|mk-napcat' | grep -v grep || true
        warn "可尝试: sudo systemctl stop ${AUTOSTART_NAPCAT_UNIT} && sudo systemctl disable ${AUTOSTART_NAPCAT_UNIT} 喵"
        return 1
    fi
    info "QQ 已彻底杀死 喵"
    info "之后请用菜单「启动 QQ」重新拉起（才会带上 VNC DISPLAY） 喵"
}

snowluma_qq_uninstall() {
    title "卸载 QQ"
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        warn "Docker 模式 QQ 在镜像内，卸载宿主包不会移除容器内 QQ 喵"
        warn "若要彻底去掉 Docker QQ，请卸载 SnowLuma 容器 喵"
    fi
    echo "  将卸载系统包 linuxqq（/opt/QQ）"
    echo
    local confirm=""
    read -r -p "确认卸载宿主 QQ? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "已经取消 喵"; return 0; }

    snowluma_qq_stop || true
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get remove -y linuxqq >/dev/null 2>&1 || dpkg -r linuxqq >/dev/null 2>&1 || true
    elif command -v rpm >/dev/null 2>&1; then
        rpm -e linuxqq >/dev/null 2>&1 || true
    fi
    if [[ -d /opt/QQ ]]; then
        local wipe=""
        read -r -p "/opt/QQ 仍在，是否强制删除目录? [y/N]: " wipe
        [[ "$wipe" =~ ^[Yy]$ ]] && rm -rf /opt/QQ
    fi
    info "QQ 拆干净 喵"
}

snowluma_start() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ -z "$mode" ]]; then
        error "SnowLuma 还没装"
        return 1
    fi

    if [[ "$mode" == "docker" ]]; then
        if snowluma_is_running; then
            warn "容器已在运行 喵"
            snowluma_show_login_info
            return 0
        fi
        docker start "$SNOWLUMA_DOCKER_NAME" >/dev/null
        sleep 2
        if snowluma_is_running; then
            info "SnowLuma 容器已经跑起来 喵"
            snowluma_show_login_info
        else
            error "启动失败了: docker logs ${SNOWLUMA_DOCKER_NAME}"
            return 1
        fi
        return 0
    fi

    if [[ ! -x "${SNOWLUMA_HOME}/launcher.sh" && ! -f "${SNOWLUMA_HOME}/index.mjs" ]]; then
        error "没找到 ${SNOWLUMA_HOME}/launcher.sh"
        return 1
    fi
    if snowluma_is_running; then
        warn "SnowLuma 已在运行 喵"
        snowluma_show_login_info
        return 0
    fi

    mkdir -p "$LOG_DIR"
    echo "===== SnowLuma start $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$SNOWLUMA_LOG"
    # WebUI 监听地址偏好：菜单 [18] 写入后在这里作为 SNOWLUMA_WEBUI_HOST 注入（环境变量优先级高于 runtime.json）
    local webui_host=""
    if [[ -f "$SNOWLUMA_WEBUI_HOST_FILE" ]]; then
        webui_host="$(tr -d '[:space:]' < "$SNOWLUMA_WEBUI_HOST_FILE" 2>/dev/null || true)"
    fi
    (
        cd "$SNOWLUMA_HOME" || exit 1
        export SNOWLUMA_ACCEPT_EULA=1
        export SNOWLUMA_ACCEPT_PRIVACY=1
        [[ -n "$webui_host" ]] && export SNOWLUMA_WEBUI_HOST="$webui_host"
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
        info "SnowLuma 已后台启动 喵"
        snowluma_show_login_info
    else
        error "启动失败了，见日志: ${SNOWLUMA_LOG}"
        tail -20 "$SNOWLUMA_LOG" 2>/dev/null || true
        return 1
    fi

    # native 模式：SnowLuma 起来后自动拉起所有 QQ（像 docker 那样一键全套）
    # 主账号
    if [[ -x "/opt/QQ/qq" ]] && ! snowluma_qq_is_running; then
        info "顺手拉起主账号 QQ 喵"
        snowluma_qq_start || warn "主账号 QQ 拉起失败，请用菜单 [5] 手动启动 喵"
    fi
    # 额外账号
    local acct
    while IFS= read -r acct; do
        [[ -n "$acct" ]] || continue
        if snowluma_acct_is_running "$acct"; then
            continue
        fi
        info "顺手拉起额外账号 ${acct} 喵"
        snowluma_acct_start_native "$acct" || warn "${acct} 拉起失败，请手动启动 喵"
    done < <(snowluma_accounts_list)
}

snowluma_stop() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
            docker stop "$SNOWLUMA_DOCKER_NAME" >/dev/null
            info "SnowLuma 容器已经停下来 喵"
        else
            info "容器未在运行 喵"
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
    info "SnowLuma 已经停下来 喵"
}

snowluma_restart() {
    info "正在重启 SnowLuma 喵"
    snowluma_stop || true
    sleep 2
    snowluma_start
}

snowluma_show_logs() {
    local mode
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        title "SnowLuma Docker 日志 (最近 80 行)"
        docker logs --tail 80 "$SNOWLUMA_DOCKER_NAME" 2>&1 || warn "无法读取容器日志 喵"
        echo
        echo "  实时: docker logs -f ${SNOWLUMA_DOCKER_NAME}"
        return 0
    fi
    if [[ ! -f "$SNOWLUMA_LOG" ]]; then
        warn "暂无运行日志: ${SNOWLUMA_LOG} 喵"
        return 1
    fi
    title "SnowLuma 运行日志 (最近 80 行)"
    tail -n 80 "$SNOWLUMA_LOG"
    echo
    echo "  完整日志: ${SNOWLUMA_LOG}"
}

snowluma_show_login_info() {
    local host_ip mode vnc_pass webui_pass wport wbind=""
    snowluma_vnc_load_cfg
    host_ip="$(napcat_get_server_ip)"
    mode="$(snowluma_get_mode)"
    # Docker 模式下对外端口是宿主机映射端口（可与容器内 5099 不同）
    wport="$(snowluma_webui_access_port)"
    if [[ "$mode" == "docker" ]]; then
        snowluma_webui_docker_load_cfg
        # 只绑回环时，外网/局域网 IP 是连不上的，别把用户往死路上指
        [[ "$SNOWLUMA_WEBUI_BIND_IP" == "127.0.0.1" ]] && wbind="127.0.0.1"
    fi
    [[ -n "$wbind" ]] && host_ip="$wbind"
    title "SnowLuma WebUI 登录信息"
    echo "  模式:     ${mode:-未知}"
    echo "  版本:     $(snowluma_get_display_version || echo 未知)"
    echo "  WebUI:    http://${host_ip}:${wport}/"
    echo "  用户名:   admin"
    echo "  noVNC:    http://${host_ip}:${SNOWLUMA_NOVNC_PORT}/   (扫码登录 QQ)"
    if [[ "$mode" == "docker" ]]; then
        # 密码实际获取：优先读容器日志里镜像真正生效的值
        vnc_pass="$(snowluma_docker_log_pass vnc)"
        webui_pass="$(snowluma_docker_log_pass webui)"
        if [[ -n "$vnc_pass" ]]; then
            echo "  noVNC/VNC 密码: ${vnc_pass}"
        elif [[ -n "$SNOWLUMA_VNC_PASS" ]] && ! snowluma_vnc_pass_is_example "$SNOWLUMA_VNC_PASS"; then
            echo "  noVNC/VNC 密码: ${SNOWLUMA_VNC_PASS}"
        else
            echo -e "  noVNC/VNC 密码: ${YELLOW}暂时没读到，复制下面这条命令自己查一下就行${NC}"
            echo "     docker logs ${SNOWLUMA_DOCKER_NAME} 2>&1 | grep -iE '远程桌面密码|remote desktop password' | tail -n1"
        fi
        echo "  VNC 端口: ${host_ip}:${SNOWLUMA_VNC_PORT}"
        if [[ -n "$webui_pass" ]]; then
            echo "  WebUI 密码: ${webui_pass}"
        else
            echo -e "  WebUI 密码: ${YELLOW}暂时没读到，复制下面这条命令自己查一下就行${NC}"
            echo "     docker logs ${SNOWLUMA_DOCKER_NAME} 2>&1 | grep -iE '临时密码|initial credentials' | tail -n1"
            echo "     (若这条也没输出：密码只在数据卷全新首次启动时打印过一次，请用你当时记下的那串)"
        fi
    else
        echo "  VNC:      ${host_ip}:${SNOWLUMA_VNC_PORT}  密码 ${SNOWLUMA_VNC_PASS}（mk 内置 VNC，本地生效）"
        if [[ -f "$SNOWLUMA_LOG" ]]; then
            webui_pass="$(grep -iE '临时密码|initial credentials' "$SNOWLUMA_LOG" 2>/dev/null | tail -1 | sed -nE 's/.*(临时密码[：:][[:space:]]*|password=)([^[:space:]]+).*/\2/p' | tr -d '\r' || true)"
        fi
        if [[ -n "$webui_pass" ]]; then
            echo "  WebUI 密码: ${webui_pass}"
        else
            echo -e "  WebUI 密码: ${YELLOW}暂时没读到，复制下面这条命令自己查一下就行${NC}"
            echo "     grep -iE '临时密码|initial credentials' ${SNOWLUMA_LOG} | tail -n1"
        fi
        echo "  安装目录: ${SNOWLUMA_HOME}"
        if snowluma_vnc_is_running; then
            echo -e "  扫码桌面: ${GREEN}运行中${NC}（常规安装已内置 Docker 同款 VNC/noVNC）"
        else
            echo -e "  扫码桌面: ${YELLOW}未运行${NC}（「启动 QQ」会自动拉起）"
        fi
    fi
    echo
}

# ==================== SnowLuma WebUI 监听地址 / 外部访问 ====================
# 背景：直接安装(native)的 SnowLuma，某些版本的 WebUI(默认 5099) 只绑 127.0.0.1，
# 转发/中转服务器无所谓，但直连服务器外部就访问不到。
# 首选做法：SnowLuma 支持环境变量 SNOWLUMA_WEBUI_HOST（优先级高于 runtime.json），
# 启动时注入 0.0.0.0 即可让本体直接对外监听（见 snowluma_start）。
# 兜底做法：万一某旧版本不认这个变量，再用 socat 在「本机 IP:同端口」转发到 127.0.0.1，
# 不动 SnowLuma 本体、随时可开关、升级不会被覆盖。

# 读取/写入 native WebUI 期望监听地址偏好（供 snowluma_start 注入 SNOWLUMA_WEBUI_HOST）
snowluma_webui_host_pref() {
    [[ -f "$SNOWLUMA_WEBUI_HOST_FILE" ]] || return 0
    tr -d '[:space:]' < "$SNOWLUMA_WEBUI_HOST_FILE" 2>/dev/null || true
}

snowluma_webui_host_set() {
    mkdir -p "$LOG_DIR"
    printf '%s\n' "$1" > "$SNOWLUMA_WEBUI_HOST_FILE"
}

snowluma_webui_host_clear() {
    rm -f "$SNOWLUMA_WEBUI_HOST_FILE"
}

# 严格一点的 IPv4 校验：四段数字且每段 0-255。
# 只写 ^([0-9]{1,3}\.){3}[0-9]{1,3}$ 会把 300.1.1.1 也放过去，docker -p 绑这种地址必定失败。
mk_is_ipv4() {
    local ip="${1:-}" o
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    local IFS='.'
    local -a parts=( $ip )
    for o in "${parts[@]}"; do
        # 10# 前缀：防止 08 这类被 bash 当八进制解析报错
        (( 10#$o >= 0 && 10#$o <= 255 )) || return 1
    done
    return 0
}

# ---- Docker 模式：宿主机侧 WebUI 端口映射（绑定地址 + 对外端口）----
snowluma_webui_docker_load_cfg() {
    SNOWLUMA_WEBUI_BIND_IP="0.0.0.0"
    SNOWLUMA_WEBUI_HOST_PORT="$SNOWLUMA_WEBUI_PORT"
    if [[ -f "$SNOWLUMA_WEBUI_DOCKER_CFG" ]]; then
        # shellcheck disable=SC1090
        source "$SNOWLUMA_WEBUI_DOCKER_CFG" 2>/dev/null || true
    fi
    mk_is_ipv4 "${SNOWLUMA_WEBUI_BIND_IP:-}" \
        || SNOWLUMA_WEBUI_BIND_IP="0.0.0.0"
    [[ "${SNOWLUMA_WEBUI_HOST_PORT:-}" =~ ^[0-9]+$ ]] \
        && (( SNOWLUMA_WEBUI_HOST_PORT >= 1 && SNOWLUMA_WEBUI_HOST_PORT <= 65535 )) \
        || SNOWLUMA_WEBUI_HOST_PORT="$SNOWLUMA_WEBUI_PORT"
}

snowluma_webui_docker_save_cfg() {
    mkdir -p "$LOG_DIR"
    cat > "$SNOWLUMA_WEBUI_DOCKER_CFG" <<EOF
# mk SnowLuma WebUI 端口映射（Docker 模式，菜单 [18] 可改）
# 容器内固定监听 0.0.0.0:${SNOWLUMA_WEBUI_PORT}，这两项只控制宿主机把端口开在哪张网卡上
SNOWLUMA_WEBUI_BIND_IP="${SNOWLUMA_WEBUI_BIND_IP}"
SNOWLUMA_WEBUI_HOST_PORT="${SNOWLUMA_WEBUI_HOST_PORT}"
EOF
}

# docker run 的 -p 参数（形如 0.0.0.0:5099:5099 / 127.0.0.1:5099:5099）
snowluma_webui_docker_pub_arg() {
    printf '%s:%s:%s' "${SNOWLUMA_WEBUI_BIND_IP}" "${SNOWLUMA_WEBUI_HOST_PORT}" "${SNOWLUMA_WEBUI_PORT}"
}

# 容器「当前实际生效」的宿主机映射（来自 docker port，形如 0.0.0.0:5099）；取不到返回空
snowluma_webui_docker_pub_actual() {
    docker port "$SNOWLUMA_DOCKER_NAME" "${SNOWLUMA_WEBUI_PORT}/tcp" 2>/dev/null \
        | head -n1 | tr -d '\r' || true
}

# 对外访问端口：Docker 用宿主机映射端口，其他用 runtime.json/默认
snowluma_webui_access_port() {
    if [[ "$(snowluma_get_mode)" == "docker" ]]; then
        snowluma_webui_docker_load_cfg
        printf '%s' "$SNOWLUMA_WEBUI_HOST_PORT"
        return 0
    fi
    snowluma_webui_port
}

# 读取 WebUI 端口：优先 runtime.json 的 webuiPort，否则回退默认 5099
snowluma_webui_port() {
    local f="${SNOWLUMA_HOME}/config/runtime.json" p=""
    if [[ -f "$f" ]]; then
        p="$(grep -oE '"webuiPort"[[:space:]]*:[[:space:]]*[0-9]+' "$f" 2>/dev/null \
            | grep -oE '[0-9]+' | tail -1 || true)"
    fi
    if ! [[ "$p" =~ ^[0-9]+$ ]] || (( p < 1 || p > 65535 )); then
        p="$SNOWLUMA_WEBUI_PORT"
    fi
    printf '%s' "$p"
}

# 一个可绑定的本机地址（公网 VPS 一般是绑在 eth0 上的公网 IP；否则取局域网首选）
snowluma_bindable_ip() {
    local ip=""
    ip="$(mk_lan_ipv4_best 2>/dev/null | cut -f1 || true)"
    if [[ -z "$ip" ]]; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
    printf '%s' "$ip"
}

# 探测某端口当前的监听范围：all(外部可达) | local(仅回环) | none(没在监听) | unknown(没工具)
snowluma_webui_bind_scope() {
    local port="$1" addrs="" a host reachable=0 loop=0
    if command -v ss >/dev/null 2>&1; then
        addrs="$(ss -Htln 2>/dev/null | awk '{print $4}')"
    elif command -v netstat >/dev/null 2>&1; then
        addrs="$(netstat -tln 2>/dev/null | awk 'NR>2{print $4}')"
    else
        printf '%s' "unknown"
        return 0
    fi
    while IFS= read -r a; do
        [[ -n "$a" ]] || continue
        [[ "$a" == *":${port}" ]] || continue
        host="${a%:*}"
        host="${host#\[}"; host="${host%\]}"
        case "$host" in
            127.*|::1) loop=1 ;;
            *)         reachable=1 ;;
        esac
    done <<< "$addrs"
    if (( reachable == 1 )); then
        printf '%s' "all"
    elif (( loop == 1 )); then
        printf '%s' "local"
    else
        printf '%s' "none"
    fi
}

snowluma_webui_bridge_running() {
    snowluma_pidfile_running "$SNOWLUMA_WEBUI_BRIDGE_PID"
}

# 读取桥接配置里保存的对外地址（供状态显示用）
snowluma_webui_bridge_target() {
    local ip="" port=""
    if [[ -f "$SNOWLUMA_WEBUI_BRIDGE_CFG" ]]; then
        # shellcheck disable=SC1090
        source "$SNOWLUMA_WEBUI_BRIDGE_CFG" 2>/dev/null || true
        ip="${SNOWLUMA_WEBUI_BRIDGE_IP:-}"
        port="${SNOWLUMA_WEBUI_BRIDGE_PORT:-}"
    fi
    printf '%s:%s' "$ip" "$port"
}

snowluma_ensure_socat() {
    command -v socat >/dev/null 2>&1 && return 0
    info "检测到缺少 socat，正在尝试安装 喵"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y >/dev/null 2>&1 || true
        apt-get install -y socat >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y socat >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y socat >/dev/null 2>&1 || true
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm socat >/dev/null 2>&1 || true
    elif command -v zypper >/dev/null 2>&1; then
        zypper install -y socat >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then
        apk add socat >/dev/null 2>&1 || true
    elif command -v pkg >/dev/null 2>&1; then
        pkg install -y socat >/dev/null 2>&1 || true
    fi
    if command -v socat >/dev/null 2>&1; then
        return 0
    fi
    error "socat 安装失败，请手动安装后再试"
    return 1
}

snowluma_webui_bridge_stop() {
    local port=""
    if [[ -f "$SNOWLUMA_WEBUI_BRIDGE_CFG" ]]; then
        # shellcheck disable=SC1090
        source "$SNOWLUMA_WEBUI_BRIDGE_CFG" 2>/dev/null || true
        port="${SNOWLUMA_WEBUI_BRIDGE_PORT:-}"
    fi
    snowluma_kill_pidfile "$SNOWLUMA_WEBUI_BRIDGE_PID"
    if [[ -n "$port" ]]; then
        pkill -f "TCP4-LISTEN:${port},.*TCP4:127.0.0.1:${port}" 2>/dev/null || true
    fi
    rm -f "$SNOWLUMA_WEBUI_BRIDGE_CFG"
}

snowluma_webui_bridge_start() {
    local bind_ip="$1" port="$2"
    require_root || return 1
    snowluma_ensure_socat || return 1
    # 先停掉旧的，避免同端口冲突
    snowluma_webui_bridge_stop >/dev/null 2>&1 || true
    mkdir -p "$LOG_DIR"
    echo "===== bridge start $(date '+%Y-%m-%d %H:%M:%S') bind=${bind_ip}:${port} -> 127.0.0.1:${port} =====" \
        >> "$SNOWLUMA_WEBUI_BRIDGE_LOG"
    nohup socat "TCP4-LISTEN:${port},bind=${bind_ip},fork,reuseaddr" "TCP4:127.0.0.1:${port}" \
        >> "$SNOWLUMA_WEBUI_BRIDGE_LOG" 2>&1 &
    local pid=$!
    echo "$pid" > "$SNOWLUMA_WEBUI_BRIDGE_PID"
    cat > "$SNOWLUMA_WEBUI_BRIDGE_CFG" <<EOF
# mk SnowLuma WebUI 外部访问桥接（菜单可改）
SNOWLUMA_WEBUI_BRIDGE_IP="${bind_ip}"
SNOWLUMA_WEBUI_BRIDGE_PORT="${port}"
EOF
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
        error "桥接启动失败了，多半是地址不在本机或端口被占"
        tail -n 8 "$SNOWLUMA_WEBUI_BRIDGE_LOG" 2>/dev/null || true
        rm -f "$SNOWLUMA_WEBUI_BRIDGE_PID" "$SNOWLUMA_WEBUI_BRIDGE_CFG"
        return 1
    fi
    snowluma_open_ports "$port"
    info "已开启外部访问：${bind_ip}:${port} → 127.0.0.1:${port} 喵"
    info "外部现在可用 http://${bind_ip}:${port}/ 打开 WebUI 喵"
    warn "提醒：WebUI 暴露到公网有风险，请确保已设置强密码/仅放行可信来源 喵"
    return 0
}

# Docker 模式下改完配置后统一落盘 + 询问是否重建容器
# （docker 不允许改运行中容器的端口映射，只能 rm + run；数据卷保留所以登录态不丢）
snowluma_webui_docker_apply() {
    snowluma_webui_docker_save_cfg
    info "已保存：宿主机 ${SNOWLUMA_WEBUI_BIND_IP}:${SNOWLUMA_WEBUI_HOST_PORT} → 容器 ${SNOWLUMA_WEBUI_PORT} 喵"
    if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
        info "容器还不存在，下次安装/创建时自动生效 喵"
        return 0
    fi
    local re=""
    read -r -p "是否立即重建容器使其生效（数据卷保留，登录态不丢）? [Y/n]: " re
    if [[ "$re" =~ ^[Nn]$ ]]; then
        warn "已保存，下次重建容器时才生效（可随时回来选 [8]） 喵"
        return 0
    fi
    if ! snowluma_recreate_docker; then
        error "重建失败了，配置已经存好，稍后可用 [8] 重试 喵"
        return 1
    fi
    if [[ "$SNOWLUMA_WEBUI_BIND_IP" != "127.0.0.1" ]]; then
        snowluma_open_ports "$SNOWLUMA_WEBUI_HOST_PORT"
    fi
    local ip="$SNOWLUMA_WEBUI_BIND_IP"
    [[ "$ip" == "0.0.0.0" ]] && ip="$(snowluma_bindable_ip)"
    info "WebUI 现在可从 http://${ip:-本机IP}:${SNOWLUMA_WEBUI_HOST_PORT}/ 访问 喵"
    return 0
}

# Docker 模式的「监听地址 / 外部访问」子菜单。
# 容器里 WebUI 必须监听 0.0.0.0（否则宿主机 -p 映射过去也是空的），
# 所以这里能改的是宿主机这一侧：把端口开在哪张网卡、以及对外用哪个端口。
menu_snowluma_webui_listen_docker() {
    local choice="" ans port want want_host actual host_ip fw_txt run_txt acc_ip
    local -a ips=()
    local line i=0 pick=""

    while true; do
        snowluma_vnc_load_cfg
        snowluma_webui_docker_load_cfg
        port="$SNOWLUMA_WEBUI_HOST_PORT"
        want_host="${SNOWLUMA_WEBUI_BIND_IP}:${port}"
        want="$(snowluma_webui_docker_pub_arg)"
        actual="$(snowluma_webui_docker_pub_actual)"
        host_ip="$(snowluma_bindable_ip)"

        title "SnowLuma WebUI 监听地址 / 外部访问"
        show_nav_hint

        if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
            warn "容器 ${SNOWLUMA_DOCKER_NAME} 还不存在，请先安装 SnowLuma 喵"
            echo
            return 0
        fi

        if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SNOWLUMA_DOCKER_NAME"; then
            run_txt="${GREEN}运行中${NC}"
        else
            run_txt="${YELLOW}未运行${NC}"
        fi
        if port_firewall_is_open "$port" 2>/dev/null; then
            fw_txt="${GREEN}系统防火墙已放行${NC}"
        else
            fw_txt="${YELLOW}系统防火墙未放行（云安全组另算）${NC}"
        fi

        case "$SNOWLUMA_WEBUI_BIND_IP" in
            0.0.0.0) acc_ip="${host_ip:-本机IP}" ;;
            *)       acc_ip="$SNOWLUMA_WEBUI_BIND_IP" ;;
        esac

        echo "  模式:         Docker"
        echo "  容器内监听:   0.0.0.0:${SNOWLUMA_WEBUI_PORT}（SNOWLUMA_WEBUI_HOST，固定不动）"
        echo -e "  宿主机映射:   ${actual:-（容器没在跑，读不到）}  ${YELLOW}← 当前实际生效${NC}"
        echo "  mk 里的配置:  ${want_host} → 容器 ${SNOWLUMA_WEBUI_PORT}"
        if [[ -n "$actual" && "$actual" != "$want_host" ]]; then
            echo -e "  ${YELLOW}⚠ 实际映射和上面的配置不一致，选 [8] 重建容器即可对齐${NC}"
        fi
        echo -e "  容器状态:     ${run_txt}"
        echo -e "  防火墙:       ${fw_txt}"
        echo "  本机地址:     ${host_ip:-没探测到，可在 [4] 里手动填}"
        echo "  访问地址:     http://${acc_ip}:${port}/"
        echo
        echo "  说明：容器里的 WebUI 必须绑 0.0.0.0，宿主机才映射得到；"
        echo "        所以「谁能访问」由宿主机这一侧的绑定地址决定 —— 改它要重建容器。"
        echo
        echo "  [2] 允许所有网卡访问（绑定 0.0.0.0，默认）啦"
        echo "  [3] 仅本机访问（绑定 127.0.0.1，外部要靠 SSH 隧道）啦"
        echo "  [4] 只绑定到指定 IP（局域网/内网网卡，从列表挑或手填）啦"
        echo "  [5] 修改对外端口（容器内仍是 ${SNOWLUMA_WEBUI_PORT}）啦"
        echo "  [6] 防火墙放行 ${port} 啦"
        echo "  [7] 防火墙关闭 ${port} 啦"
        echo "  [8] 立即按当前配置重建容器（数据卷保留，登录态不丢）啦"
        echo

        choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                if [[ "$SNOWLUMA_WEBUI_BIND_IP" == "0.0.0.0" ]]; then
                    info "已经是绑定所有网卡了 喵"
                    press_enter
                    continue
                fi
                SNOWLUMA_WEBUI_BIND_IP="0.0.0.0"
                warn "提醒：WebUI 会暴露到公网，请务必设强密码/只放行可信来源 喵"
                snowluma_webui_docker_apply || true
                press_enter
                ;;
            3)
                if [[ "$SNOWLUMA_WEBUI_BIND_IP" == "127.0.0.1" ]]; then
                    info "已经只绑本机了 喵"
                    press_enter
                    continue
                fi
                SNOWLUMA_WEBUI_BIND_IP="127.0.0.1"
                snowluma_webui_docker_apply || true
                info "改完只有这台机器能开 http://127.0.0.1:${port}/ 喵"
                info "想在外面用就走 SSH 隧道: ssh -L ${port}:127.0.0.1:${port} 用户@本机 喵"
                press_enter
                ;;
            4)
                ips=()
                while IFS=$'\t' read -r ip iface; do
                    [[ -n "${ip:-}" ]] || continue
                    ips+=( "${ip}${iface:+ (${iface})}" )
                done < <(mk_lan_ipv4_candidates)
                echo
                echo "  要绑定到哪个地址?"
                i=0
                for line in "${ips[@]}"; do
                    i=$((i + 1))
                    echo "    [${i}] ${line}"
                done
                echo "    [$((i + 1))] 手动输入"
                echo "    [0] 取消"
                pick=""
                read_choice pick
                if [[ -z "$pick" || "$pick" == "0" ]]; then
                    continue
                fi
                if [[ "$pick" == "$((i + 1))" ]]; then
                    read -r -p "请输入要绑定的 IPv4 地址: " ans
                    ans="$(normalize_choice "${ans:-}")"
                else
                    if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#ips[@]} )); then
                        error "没这个选项 喵"
                        press_enter
                        continue
                    fi
                    ans="${ips[$((pick - 1))]%% *}"
                fi
                if ! mk_is_ipv4 "${ans:-}"; then
                    error "这不是一个合法的 IPv4 地址: ${ans:-（空）}"
                    press_enter
                    continue
                fi
                if [[ "$ans" != "127.0.0.1" ]] \
                    && ! printf '%s\n' "${ips[@]}" | grep -q "^${ans}"; then
                    warn "这个地址不在本机网卡列表里，docker 可能会绑不上 喵"
                    local go=""
                    read -r -p "仍要继续? [y/N]: " go
                    [[ "$go" =~ ^[Yy]$ ]] || { press_enter; continue; }
                fi
                SNOWLUMA_WEBUI_BIND_IP="$ans"
                snowluma_webui_docker_apply || true
                press_enter
                ;;
            5)
                read -r -p "新的对外端口 [${port}]: " ans
                ans="$(normalize_choice "${ans:-}")"
                if [[ -z "$ans" ]]; then
                    info "没改 喵"
                    press_enter
                    continue
                fi
                if ! [[ "$ans" =~ ^[0-9]+$ ]] || (( ans < 1 || ans > 65535 )); then
                    error "端口要在 1-65535 之间"
                    press_enter
                    continue
                fi
                if (( ans == SNOWLUMA_VNC_PORT || ans == SNOWLUMA_NOVNC_PORT )) \
                    || (( ans == 3000 || ans == 3001 )); then
                    error "${ans} 和容器里别的服务撞了（VNC ${SNOWLUMA_VNC_PORT} / noVNC ${SNOWLUMA_NOVNC_PORT} / 3000 / 3001），换一个"
                    press_enter
                    continue
                fi
                SNOWLUMA_WEBUI_HOST_PORT="$ans"
                snowluma_webui_docker_apply || true
                press_enter
                ;;
            6)
                snowluma_open_ports "$port"
                info "已尝试放行 ${port}（云服务器别忘了安全组也要开） 喵"
                press_enter
                ;;
            7)
                napcat_firewall_close_port "$port" || true
                warn "已关闭 ${port}；注意 Docker 自己会插一条转发规则，"
                warn "要彻底断外网请改用 [3] 只绑 127.0.0.1 喵"
                press_enter
                ;;
            8)
                if snowluma_recreate_docker; then
                    if [[ "$SNOWLUMA_WEBUI_BIND_IP" != "127.0.0.1" ]]; then
                        snowluma_open_ports "$port"
                    fi
                    info "已按 ${want_host} → 容器 ${SNOWLUMA_WEBUI_PORT} 重建 喵"
                fi
                press_enter
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_snowluma_webui_listen() {
    local ans in_ip mode port scope host_ip bridge_tgt host_pref rescope restart
    while true; do
        mode="$(snowluma_get_mode)"
        port="$(snowluma_webui_port)"
        title "SnowLuma WebUI 监听地址 / 外部访问"
        show_nav_hint
        if [[ -z "$mode" ]]; then
            warn "SnowLuma 还没装，装好再来设置监听地址 喵"
            echo
            return 0
        fi
        if [[ "$mode" == "docker" ]]; then
            menu_snowluma_webui_listen_docker
            return 0
        fi
        scope="$(snowluma_webui_bind_scope "$port")"
        host_ip="$(snowluma_bindable_ip)"
        host_pref="$(snowluma_webui_host_pref)"
        echo "  WebUI 端口:     ${port}  (来自 runtime.json 的 webuiPort)"
        case "$scope" in
            all)     echo -e "  当前监听范围:   ${GREEN}所有网卡 / 外部可达${NC}" ;;
            local)   echo -e "  当前监听范围:   ${YELLOW}仅本机 127.0.0.1（外部访问不到）${NC}" ;;
            none)    echo -e "  当前监听范围:   ${YELLOW}没在监听（SnowLuma 可能没启动）${NC}" ;;
            *)       echo -e "  当前监听范围:   未知（缺 ss / netstat 工具）" ;;
        esac
        echo "  期望监听地址:   ${host_pref:-默认(未设置，视 SnowLuma 版本)}  (下次启动生效)"
        if snowluma_webui_bridge_running; then
            bridge_tgt="$(snowluma_webui_bridge_target)"
            echo -e "  socat 兜底桥接: ${GREEN}已开启 → ${bridge_tgt} → 127.0.0.1:${port}${NC}"
        else
            echo -e "  socat 兜底桥接: ${YELLOW}未开启${NC}"
        fi
        echo "  可用本机地址:   ${host_ip:-没探测到，请手动输入}"
        echo
        echo "  首选：让 SnowLuma 本体监听 0.0.0.0（通过环境变量 SNOWLUMA_WEBUI_HOST，"
        echo "        启动时注入，优先级高于 runtime.json），干净、不占额外端口"
        echo "  兜底：万一某旧版本不认这个变量，再用 socat 在「本机IP:${port}」转发到本机回环"
        echo
        echo "  [2] 开启外部访问（改 SnowLuma 监听 0.0.0.0，推荐）啦"
        echo "  [3] 关闭外部访问（改回仅本机 127.0.0.1）啦"
        echo "  [4] 兜底：socat 端口桥接 开/关（仅在 [2] 重启后仍访问不到时用）啦"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                snowluma_webui_host_set "0.0.0.0"
                info "已设置：下次启动 SnowLuma 时 WebUI 监听 0.0.0.0 喵"
                warn "提醒：WebUI 暴露到公网有风险，请设置强密码/仅放行可信来源 喵"
                if snowluma_is_running; then
                    restart=""
                    read -r -p "SnowLuma 正在跑，是否立即重启使其生效? [Y/n]: " restart
                    if [[ ! "$restart" =~ ^[Nn]$ ]]; then
                        snowluma_restart || true
                        sleep 1
                        rescope="$(snowluma_webui_bind_scope "$port")"
                        if [[ "$rescope" == "all" ]]; then
                            snowluma_open_ports "$port"
                            info "SnowLuma 已对外监听，外部可用 http://${host_ip:-本机IP}:${port}/ 喵"
                            if snowluma_webui_bridge_running; then
                                snowluma_webui_bridge_stop
                                info "已关闭多余的 socat 兜底桥接 喵"
                            fi
                        elif [[ "$rescope" == "local" ]]; then
                            warn "重启后仍是仅本机，这个版本可能不认 SNOWLUMA_WEBUI_HOST，请用 [4] socat 兜底 喵"
                        else
                            warn "暂时没探测到监听状态（${rescope}），稍等片刻再看，或用 [4] socat 兜底 喵"
                        fi
                    else
                        warn "请稍后手动「重启 SnowLuma」使新监听地址生效 喵"
                    fi
                else
                    info "SnowLuma 未运行，下次启动即会监听 0.0.0.0 喵"
                fi
                press_enter ;;
            3)
                snowluma_webui_host_set "127.0.0.1"
                info "已设置：下次启动 SnowLuma 时 WebUI 只监听 127.0.0.1（仅本机） 喵"
                if snowluma_webui_bridge_running; then
                    snowluma_webui_bridge_stop
                    info "已一并关闭 socat 兜底桥接 喵"
                fi
                if snowluma_is_running; then
                    restart=""
                    read -r -p "SnowLuma 正在跑，是否立即重启使其生效? [Y/n]: " restart
                    if [[ ! "$restart" =~ ^[Nn]$ ]]; then
                        snowluma_restart || true
                    else
                        warn "请稍后手动「重启 SnowLuma」使其生效 喵"
                    fi
                fi
                press_enter ;;
            4)
                if snowluma_webui_bridge_running; then
                    snowluma_webui_bridge_stop
                    info "已关闭 socat 兜底桥接 喵"
                    press_enter
                    continue
                fi
                if [[ "$scope" == "all" ]]; then
                    warn "当前已对外监听，无需 socat 兜底 喵"
                    press_enter
                    continue
                fi
                in_ip="$host_ip"
                read -r -p "socat 对外监听地址 (直接回车用探测到的) [${host_ip:-请输入本机IP}]: " ans
                ans="${ans//$'\r'/}"
                ans="${ans#"${ans%%[![:space:]]*}"}"
                ans="${ans%"${ans##*[![:space:]]}"}"
                [[ -n "$ans" ]] && in_ip="$ans"
                if [[ -z "$in_ip" ]]; then
                    error "没有可用地址，请手动输入本机 IP"
                    press_enter
                    continue
                fi
                snowluma_webui_bridge_start "$in_ip" "$port" || true
                press_enter ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# ---------------- 主账号判定（多账号场景下的隔离版） ----------------
# 旧逻辑是「有没有任意 /opt/QQ 进程在跑」，多开之后这个判据会把别的账号算进来，
# 导致主账号永远被当成"已在跑"。所以多账号时改为只看归属主账号的那些 PID。

snowluma_main_qq_is_running() {
    if (( $(snowluma_accounts_count) > 0 )); then
        snowluma_acct_is_running main
        return $?
    fi
    snowluma_qq_is_running
}

snowluma_main_qq_on_display() {
    if (( $(snowluma_accounts_count) > 0 )); then
        local pid disp found=0
        for pid in $(snowluma_acct_pids main); do
            disp="$(snowluma_qq_proc_display "$pid" || true)"
            if [[ "$disp" == "$SNOWLUMA_DISPLAY" ]]; then
                found=1
                break
            fi
        done
        if (( found == 1 )); then
            return 0
        fi
        return 1
    fi
    snowluma_qq_on_mk_display
}

snowluma_acct_state_text() {
    local name="$1" mode st prog
    mode="$(snowluma_get_mode)"
    if [[ "$mode" == "docker" ]]; then
        if ! snowluma_is_running; then
            printf '容器未运行'
            return 0
        fi
        prog="$(snowluma_acct_supervisor_name "$name" 2>/dev/null || true)"
        if [[ -z "$prog" ]]; then
            printf '未登记'
            return 0
        fi
        st="$(docker exec "$SNOWLUMA_DOCKER_NAME" supervisorctl status "$prog" 2>/dev/null | awk '{print $2}' | head -n1 || true)"
        printf '%s' "${st:-未知}"
        return 0
    fi
    if [[ -z "$mode" ]]; then
        printf '未安装'
        return 0
    fi
    if snowluma_acct_is_running "$name"; then
        printf '运行中 PID %s' "$(snowluma_acct_pids "$name" | paste -sd, - 2>/dev/null || true)"
    else
        printf '未运行'
    fi
}

# 让用户在「主账号 + 各额外账号」里挑一个；只有一个账号时直接返回 main
# $1 = 动作描述（如 启动 / 停止）
snowluma_menu_pick_account() {
    local act="$1" i=0 pick="" h
    local -a names=( "main" )
    while IFS= read -r h; do
        [[ -n "$h" ]] || continue
        names+=( "$h" )
    done < <(snowluma_accounts_list)

    if (( ${#names[@]} == 1 )); then
        printf 'main'
        return 0
    fi
    echo
    echo "  要${act}哪个账号?"
    for h in "${names[@]}"; do
        i=$((i + 1))
        echo "    [${i}] $(snowluma_acct_label "$h")  HOME $(snowluma_acct_home_of "$h")"
    done
    echo "    [0] 取消"
    read_choice pick
    if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#names[@]} )); then
        return 1
    fi
    printf '%s' "${names[$((pick - 1))]}"
}

# ==================== SnowLuma 多账号（多开）菜单 ====================
menu_snowluma_accounts() {
    while true; do
        title "SnowLuma 多账号（多开）"
        show_nav_hint
        echo "  [2] 添加一个 QQ 账号"
        echo "  [3] 移除一个 QQ 账号"
        echo "  [4] 查看各账号状态"
        echo "  [5] 启动指定账号"
        echo "  [6] 停止指定账号"
        echo

        local mode n h
        mode="$(snowluma_get_mode)"
        n="$(snowluma_accounts_count)"

        echo -e "  ${CYAN}* 主账号: $(snowluma_acct_home_of main)（始终存在，第 1 个）${NC}"
        if (( n > 0 )); then
            echo -e "  ${GREEN}* 额外账号 ${n} 个${NC}"
            while IFS= read -r h; do
                [[ -n "$h" ]] || continue
                local extra=""
                if [[ "$mode" == "docker" ]]; then
                    extra="  →  卷 $(snowluma_acct_volume_name "$h")"
                fi
                echo -e "      ${h}  HOME ${CYAN}$(snowluma_acct_home_of "$h")${NC}${extra}"
                echo -e "           状态: $(snowluma_acct_state_text "$h")"
            done < <(snowluma_accounts_list)
        else
            echo -e "  ${YELLOW}* 还没添加额外账号，当前只有主账号${NC}"
        fi
        echo
        case "$mode" in
            docker)
                echo -e "  ${CYAN}* 模式: Docker —— 账号由容器内 supervisor 托管，增删账号后需重建容器${NC}"
                echo -e "  ${CYAN}* 共享内存: $(snowluma_accounts_shm)（多开需更大）${NC}"
                ;;
            native)
                echo -e "  ${CYAN}* 模式: 常规安装 —— 由 mk 按账号逐个拉起，共用扫码屏 ${SNOWLUMA_DISPLAY}${NC}"
                echo -e "  ${CYAN}* 每个账号独占一个 HOME（Linux QQ 单实例锁），约需 300-500MB 内存${NC}"
                ;;
            *)
                echo -e "  ${YELLOW}* SnowLuma 还没装，装好后才能管理账号${NC}"
                ;;
        esac
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2)
                if [[ -z "$mode" ]]; then
                    error "还没装 SnowLuma，请先「安装 SnowLuma」"
                    press_enter
                    continue
                fi
                local name cf=""
                name="$(snowluma_accounts_next_name)"
                echo
                echo "  即将添加账号: ${name}"
                if [[ "$mode" == "docker" ]]; then
                    echo "    容器 HOME: $(snowluma_acct_docker_home "$name")"
                    echo "    数据卷   : $(snowluma_acct_volume_name "$name")"
                    echo "  —— 添加后需重建容器才生效；数据卷保留，已有账号登录态不丢"
                else
                    echo "    HOME    : $(snowluma_acct_native_home "$name")"
                    echo "  —— 每个账号独占 HOME；共用扫码屏 ${SNOWLUMA_DISPLAY}，noVNC 里多窗口切换扫码"
                fi
                read -r -p "确认添加? [y/N]: " cf
                if [[ ! "$cf" =~ ^[Yy]$ ]]; then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                if ! snowluma_account_add "$name"; then
                    press_enter
                    continue
                fi
                if [[ "$mode" == "docker" ]]; then
                    info "已记录 ${name}，正在重建容器 喵"
                    if snowluma_recreate_docker; then
                        info "账号已就位：用 noVNC 扫码登录，VNC 里可切换 QQ 窗口 喵"
                        snowluma_show_vnc_info 2>/dev/null || true
                    fi
                else
                    mkdir -p "$(snowluma_acct_native_home "$name")"
                    info "已创建 HOME $(snowluma_acct_native_home "$name") 喵"
                    local go=""
                    read -r -p "现在就启动 ${name} 吗（会拉起扫码桌面）? [y/N]: " go
                    if [[ "$go" =~ ^[Yy]$ ]]; then
                        snowluma_acct_start_native "$name" || true
                    else
                        info "之后可在本菜单 [5] 启动它 喵"
                    fi
                fi
                press_enter
                ;;
            3)
                if (( n == 0 )); then
                    warn "没有可移除的额外账号 喵"
                    press_enter
                    continue
                fi
                local -a homes=()
                local i=0 pick="" target="" cf2="" wipe=""
                echo
                echo "  要移除哪个账号?"
                while IFS= read -r h; do
                    [[ -n "$h" ]] || continue
                    i=$((i + 1))
                    homes+=( "$h" )
                    echo "    [${i}] ${h}  HOME $(snowluma_acct_home_of "$h")"
                done < <(snowluma_accounts_list)
                echo "    [0] 取消"
                read_choice pick
                if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#homes[@]} )); then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                target="${homes[$((pick - 1))]}"
                read -r -p "确认移除 ${target}? [y/N]: " cf2
                if [[ ! "$cf2" =~ ^[Yy]$ ]]; then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                snowluma_account_remove "$target"
                info "已从清单移除 ${target} 喵"
                if [[ "$mode" == "docker" ]]; then
                    snowluma_recreate_docker || true
                    read -r -p "是否同时删除数据卷 $(snowluma_acct_volume_name "$target")（该账号登录态会丢失）? [y/N]: " wipe
                    if [[ "$wipe" =~ ^[Yy]$ ]]; then
                        docker volume rm "$(snowluma_acct_volume_name "$target")" >/dev/null 2>&1 || true
                        info "已删除数据卷 喵"
                    fi
                else
                    snowluma_acct_stop_native "$target" 2>/dev/null || true
                    read -r -p "是否同时删除 HOME $(snowluma_acct_native_home "$target")（该账号登录态会丢失）? [y/N]: " wipe
                    if [[ "$wipe" =~ ^[Yy]$ ]]; then
                        rm -rf "$(snowluma_acct_native_home "$target")" 2>/dev/null || true
                        info "已删除该账号 HOME 喵"
                    fi
                fi
                press_enter
                ;;
            4)
                title "各账号状态"
                if [[ -z "$mode" ]]; then
                    warn "SnowLuma 还没装 喵"
                    press_enter
                    continue
                fi
                echo "  主账号"
                echo "    HOME : $(snowluma_acct_home_of main)"
                echo "    状态 : $(snowluma_acct_state_text main)"
                if (( n > 0 )); then
                    echo
                    while IFS= read -r h; do
                        [[ -n "$h" ]] || continue
                        echo "  ${h}"
                        echo "    HOME : $(snowluma_acct_home_of "$h")"
                        echo "    状态 : $(snowluma_acct_state_text "$h")"
                        if [[ "$mode" != "docker" ]]; then
                            echo "    PID  : $(snowluma_acct_pid_file "$h")"
                        fi
                        echo
                    done < <(snowluma_accounts_list)
                fi
                if [[ "$mode" == "docker" ]]; then
                    if ! snowluma_is_running; then
                        warn "容器未运行，先「启动 SnowLuma」再看吧 喵"
                    else
                        echo "  容器内 supervisor 明细:"
                        local st=""
                        st="$(snowluma_accounts_proc_status)"
                        if [[ -n "$st" ]]; then
                            printf '%s\n' "$st"
                        else
                            warn "没读到 supervisor 状态（镜像版本较旧或容器未就绪） 喵"
                        fi
                        echo
                        echo "  qq         = 主账号"
                        echo "  qq-extra-N = 额外账号（按添加顺序）"
                        echo "  snowluma   = 框架主进程"
                    fi
                else
                    echo "  提示：所有账号共用同一块扫码屏 ${SNOWLUMA_DISPLAY}，noVNC 里每个 QQ 一个窗口"
                fi
                press_enter
                ;;
            5)
                if [[ -z "$mode" ]]; then
                    error "还没装 SnowLuma"
                    press_enter
                    continue
                fi
                local tgt=""
                if tgt="$(snowluma_menu_pick_account 启动)"; then
                    snowluma_acct_start "$tgt" || true
                else
                    info "已取消 喵"
                fi
                press_enter
                ;;
            6)
                if [[ -z "$mode" ]]; then
                    error "还没装 SnowLuma"
                    press_enter
                    continue
                fi
                local tgt2=""
                if tgt2="$(snowluma_menu_pick_account 停止)"; then
                    if [[ "$mode" != "docker" && "$tgt2" == "main" ]]; then
                        warn "主账号建议用菜单 [6]「停止 QQ」（会连扫码屏一起收） 喵"
                    fi
                    snowluma_acct_stop "$tgt2" || true
                else
                    info "已取消 喵"
                fi
                press_enter
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# ==================== SnowLuma 容器额外挂载菜单 ====================
menu_snowluma_mounts() {
    while true; do
        title "容器额外挂载（让容器读到宿主目录）"
        show_nav_hint
        echo "  [2] 添加一个挂载目录"
        echo "  [3] 移除一个挂载目录"
        echo "  [4] 查看当前挂载清单"
        echo "  [5] 切换 只读 / 可写"
        echo "  [6] 重建容器使挂载生效"
        echo "  [7] 修复宿主机权限（父目录 o+x + 目录 rX）"
        echo "  [8] 容器内验证能不能读"
        echo

        local mode n p ro_txt="只读" cf5="" cf6=""
        mode="$(snowluma_get_mode)"
        n="$(snowluma_mounts_count)"
        if ! snowluma_mounts_is_ro; then
            ro_txt="可写"
        fi

        echo "  用途：kakake 在宿主机、SnowLuma 在容器里时，kakake 发媒体只给一个本地路径，"
        echo "        真读盘的是容器里的 SnowLuma —— 不挂载它就会 EACCES / 合并转发被拒。"
        echo "        挂载时左右路径相同（-v /root/kakake:/root/kakake），路径不变才对得上。"
        echo
        echo -e "  ${CYAN}* 当前模式: ${ro_txt}（协议端只需读，建议保持只读）${NC}"

        local kakake_dir=""
        kakake_dir="$(snowluma_mounts_suggest_kakake)"
        if (( n > 0 )); then
            echo -e "  ${GREEN}* 已配置 ${n} 个挂载目录:${NC}"
            while IFS= read -r p; do
                [[ -n "$p" ]] || continue
                echo -e "      ${p}  →  ${p}$(snowluma_mounts_ro_flag)"
            done < <(snowluma_mounts_list)
            if [[ -n "$kakake_dir" ]] && ! snowluma_mounts_covers "$kakake_dir"; then
                echo -e "  ${YELLOW}* 注意: 检测到 kakake 在 ${kakake_dir}，但还没被上面的目录覆盖到${NC}"
            fi
            # 「记在清单里」≠「已经挂进容器」，这里把实际生效情况摊开
            if [[ "$mode" == "docker" ]] && snowluma_is_running; then
                local pending=0
                while IFS= read -r p; do
                    [[ -n "$p" ]] || continue
                    snowluma_mounts_in_container "$p" || pending=$((pending + 1))
                done < <(snowluma_mounts_list)
                if (( pending > 0 )); then
                    echo -e "  ${YELLOW}* 其中 ${pending} 个还没挂进正在跑的容器 → 选 ${CYAN}[6] 重建容器${NC}才生效"
                else
                    echo -e "  ${GREEN}* 清单里的目录都已挂进容器${NC}"
                fi
            fi
        else
            echo -e "  ${YELLOW}* 还没配置挂载目录${NC}"
            if [[ -n "$kakake_dir" ]]; then
                echo -e "  ${GREEN}* 检测到 kakake 目录: ${kakake_dir}${NC}"
                echo -e "    → 选 ${CYAN}[2]${NC} 后直接回车就能用它（推荐，一次覆盖 data 与 plugins_two）"
            else
                echo "  * 没自动找到 kakake 目录，选 [2] 手填绝对路径（比如 /root/kakake）"
            fi
        fi
        if [[ "$mode" != "docker" ]]; then
            echo
            echo -e "  ${YELLOW}* 当前不是 Docker 模式（${mode:-未安装}）：常规安装本来就在同一文件系统，不需要挂载${NC}"
        fi
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2)
                local path="" cf3="" guess=""
                guess="$(snowluma_mounts_suggest_kakake)"
                echo
                if [[ -n "$guess" ]]; then
                    echo -e "  检测到 kakake 目录: ${GREEN}${guess}${NC}"
                    echo -e "  ${CYAN}直接回车 = 用它${NC}（一次覆盖 data 与 plugins_two，推荐）"
                    echo "  也可以手填别的绝对路径，例如 ${guess}/data 只挂数据目录"
                else
                    echo "  填要挂进容器的宿主机绝对路径，例如 /root/kakake"
                    echo "  （会按相同路径挂进去，容器内看到的路径一模一样）"
                fi
                if [[ -n "$guess" ]]; then
                    read -r -p "路径 [回车=${guess}]: " path
                    [[ -n "$path" ]] || path="$guess"
                else
                    read -r -p "路径: " path
                fi
                if [[ -z "$path" ]]; then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                if ! snowluma_mount_add "$path"; then
                    press_enter
                    continue
                fi
                info "已记录 ${path} 喵"
                read -r -p "现在顺手修一下宿主机权限吗（父目录补 o+x）? [Y/n]: " cf3
                if [[ ! "$cf3" =~ ^[Nn]$ ]]; then
                    snowluma_mounts_fix_perms || true
                fi
                warn "挂载要重建容器才生效，记得用 [6] 或 [8] 验证 喵"
                press_enter
                ;;
            3)
                if (( n == 0 )); then
                    warn "没有可移除的挂载目录 喵"
                    press_enter
                    continue
                fi
                local -a dirs=()
                local i=0 pick="" target="" cf4=""
                echo
                echo "  要移除哪个挂载目录?"
                while IFS= read -r p; do
                    [[ -n "$p" ]] || continue
                    i=$((i + 1))
                    dirs+=( "$p" )
                    echo "    [${i}] ${p}"
                done < <(snowluma_mounts_list)
                echo "    [0] 取消"
                read_choice pick
                if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#dirs[@]} )); then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                target="${dirs[$((pick - 1))]}"
                read -r -p "确认移除 ${target}? [y/N]: " cf4
                if [[ ! "$cf4" =~ ^[Yy]$ ]]; then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                snowluma_mount_remove "$target"
                info "已移除 ${target}（重建容器后才不再挂载） 喵"
                press_enter
                ;;
            4)
                title "当前挂载清单"
                if (( n == 0 )); then
                    warn "还没配置挂载目录 喵"
                else
                    while IFS= read -r p; do
                        [[ -n "$p" ]] || continue
                        echo "  ${p}"
                        echo "    docker 参数: -v ${p}:${p}$(snowluma_mounts_ro_flag)"
                        if [[ -d "$p" ]]; then
                            echo "    宿主机状态: 目录存在"
                        else
                            echo -e "    ${YELLOW}宿主机状态: 目录不存在！${NC}"
                        fi
                        echo
                    done < <(snowluma_mounts_list)
                fi
                press_enter
                ;;
            5)
                if snowluma_mounts_is_ro; then
                    echo
                    warn "改成可写后，容器里的进程就能改/删这些文件了 喵"
                    read -r -p "确认切换为可写? [y/N]: " cf5
                    if [[ "$cf5" =~ ^[Yy]$ ]]; then
                        mkdir -p "$LOG_DIR"
                        printf '0\n' > "$SNOWLUMA_MOUNTS_RO_FILE"
                        info "已切换为可写（重建容器后生效） 喵"
                    else
                        info "已取消 喵"
                    fi
                else
                    mkdir -p "$LOG_DIR"
                    printf '1\n' > "$SNOWLUMA_MOUNTS_RO_FILE"
                    info "已切换为只读（重建容器后生效） 喵"
                fi
                press_enter
                ;;
            6)
                if [[ "$mode" != "docker" ]]; then
                    error "只有 Docker 模式才需要重建容器"
                    press_enter
                    continue
                fi
                echo
                warn "会删掉现有容器再重建（几十秒中断）；只删容器，数据卷保留，登录态不丢 喵"
                read -r -p "确认重建? [y/N]: " cf6
                if [[ ! "$cf6" =~ ^[Yy]$ ]]; then
                    info "已取消 喵"
                    press_enter
                    continue
                fi
                snowluma_mounts_fix_perms || true
                if snowluma_recreate_docker; then
                    info "重建完成，建议再用 [8] 验证 喵"
                fi
                press_enter
                ;;
            7)
                echo
                echo "  注意有「两侧」权限，别只修一边:"
                echo -e "    ${CYAN}[1]${NC} 宿主机：目录本身 a+rX + 父目录补 o+x（快，推荐先试）"
                echo -e "    ${CYAN}[2]${NC} 宿主机：递归放开整个目录（文件是 600 时才需要，大目录会慢）"
                echo -e "    ${CYAN}[3]${NC} 容器内：给挂载点之上的父目录补 o+x"
                echo "         —— 挂载只覆盖 /root/kakake 这一层，它上面的 /root 是**镜像自带**的"
                echo "            （默认 700 root:root），宿主机上怎么 chmod 都影响不到；"
                echo "            挂载有了却读不到，八成就是它。改的是容器可写层，重建容器会丢。"
                local pm=""
                read_choice pm
                case "$pm" in
                    1) snowluma_mounts_fix_perms || true ;;
                    2) snowluma_mounts_fix_perms recursive || true ;;
                    3)
                        if snowluma_mounts_fix_container_perms; then
                            info "容器内的父目录已处理，现在用 [8] 验证（不用重建容器） 喵"
                        fi
                        ;;
                    *) info "已取消 喵" ;;
                esac
                press_enter
                ;;
            8)
                snowluma_mounts_verify || true
                press_enter
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
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
        echo "  [18] WebUI 监听地址 / 外部访问啦"
        echo "  [19] 多账号（多开）啦"
        echo "  [20] 容器挂载目录      让容器读到 kakake 数据（视频发不出去时用这个）啦"
        echo
        snowluma_vnc_load_cfg
        if snowluma_is_running; then
            echo -e "  ${GREEN}* SnowLuma 正在运行 (${mode:-?})${NC}"
        elif snowluma_is_installed; then
            echo -e "  ${YELLOW}* SnowLuma 已装好，但未运行 (${mode:-?})${NC}"
        else
            echo -e "  ${YELLOW}* SnowLuma 还没装${NC}"
        fi
        if [[ "$mode" == "docker" || "$mode" == "native" ]]; then
            local acct_n
            acct_n="$(snowluma_accounts_count)"
            if (( acct_n > 0 )); then
                echo -e "  ${GREEN}* QQ 账号: 主账号 + ${acct_n} 个额外账号（多开中）${NC}"
                if [[ "$mode" == "native" ]]; then
                    echo -e "  ${YELLOW}  提醒: [6]/[7] 会连带停掉全部账号；只想停某一个请进 [19]${NC}"
                fi
            else
                echo -e "  ${CYAN}* QQ 账号: 仅主账号，选 [19] 可添加多开账号${NC}"
            fi
        fi
        if snowluma_qq_is_running; then
            if snowluma_qq_on_mk_display && snowluma_xvfb_is_up; then
                echo -e "  ${GREEN}* QQ 正在运行（扫码屏 ${SNOWLUMA_DISPLAY}）${NC}"
            else
                echo -e "  ${YELLOW}* QQ 脱管运行中（未挂扫码屏，点「启动 QQ」可自动修复）${NC}"
            fi
        elif snowluma_qq_is_installed; then
            echo -e "  ${YELLOW}* QQ 已装好，但未运行${NC}"
        fi
        if [[ "$mode" == "docker" ]] || snowluma_vnc_is_running; then
            echo -e "  ${GREEN}* 扫码桌面 VNC/noVNC 可用 :${SNOWLUMA_NOVNC_PORT}${NC}"
        elif snowluma_xvfb_is_up; then
            echo -e "  ${YELLOW}* 虚拟屏已开，远程查看未开（可点「仅启动远程查看」）${NC}"
        fi
        if [[ "$mode" == "docker" ]]; then
            snowluma_webui_docker_load_cfg
            echo -e "  ${CYAN}* WebUI 端口映射: ${SNOWLUMA_WEBUI_BIND_IP}:${SNOWLUMA_WEBUI_HOST_PORT} → 容器 ${SNOWLUMA_WEBUI_PORT}（[18] 可改）${NC}"
        elif snowluma_webui_bridge_running; then
            echo -e "  ${GREEN}* WebUI 外部访问桥接已开启（$(snowluma_webui_bridge_target)）${NC}"
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
            6)
                if [[ "$(snowluma_get_mode)" == "native" ]] && (( $(snowluma_accounts_count) > 0 )); then
                    warn "这会连所有多开账号一起停掉；只想停某一个，请进 [19] 多账号 喵"
                fi
                snowluma_qq_stop; press_enter ;;
            7)
                if [[ "$(snowluma_get_mode)" == "native" ]] && (( $(snowluma_accounts_count) > 0 )); then
                    warn "这会连所有多开账号一起强杀；只想强杀某一个，请进 [19] 多账号 喵"
                fi
                snowluma_qq_force_kill; press_enter ;;
            8) snowluma_qq_uninstall; press_enter ;;
            9) snowluma_start; press_enter ;;
            10) snowluma_stop; press_enter ;;
            11) snowluma_restart; press_enter ;;
            12) snowluma_show_logs; press_enter ;;
            13) snowluma_show_login_info; press_enter ;;
            14) snowluma_show_vnc_info; press_enter ;;
            15)
                if [[ "$(snowluma_get_mode)" == "docker" ]]; then
                    info "Docker 模式扫码桌面由容器提供，启动 SnowLuma 即可 喵"
                else
                    snowluma_vnc_start_stack || true
                fi
                press_enter ;;
            16)
                if [[ "$(snowluma_get_mode)" == "docker" ]]; then
                    warn "Docker 模式请用「停止 SnowLuma」关闭容器；不能只停远程查看而保留容器内 QQ 屏 喵"
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
            18) menu_snowluma_webui_listen || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
            19) menu_snowluma_accounts || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               ;;
            20) menu_snowluma_mounts || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# ==================== 咔咔珂 Kakake ====================

# 安装目录解析顺序：环境变量 > mk 持久配置 > $HOME/kakake
#
# 为什么让它可覆盖：kakake 自身是绿色便携的（src/paths.ts 按自身位置定位，
# data/、plugins/、log/ 全在安装目录内），装到哪都能跑；但默认落在
# $HOME/kakake 会占系统盘，而服务器常把数据盘挂在 /data 之类，需要指过去。
readonly KAKAKE_HOME_CFG="${LOG_DIR}/kakake-home.env"
# 是否由环境变量指定：菜单里改配置对它无效，要在界面上说清楚
readonly KAKAKE_HOME_FROM_ENV="${KAKAKE_HOME:-}"

kakake_resolve_home() {
    local v=""
    if [[ -n "${KAKAKE_HOME:-}" ]]; then
        v="$KAKAKE_HOME"
    elif [[ -f "$KAKAKE_HOME_CFG" ]]; then
        v="$(head -1 "$KAKAKE_HOME_CFG" 2>/dev/null | tr -d '\r\n' || true)"
    fi
    [[ -n "$v" ]] || v="${HOME:-/root}/kakake"
    printf '%s\n' "$v"
}

readonly KAKAKE_HOME="$(kakake_resolve_home)"
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
readonly KAKAKE_NODE_STABLE_24="24.22.1"
readonly KAKAKE_NODE_STABLE_22="22.23.4"
readonly KAKAKE_NODE_STABLE_26="26.12.1"
readonly KAKAKE_DOWNLOAD_URL="https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/kakake.zip"
readonly KAKAKE_DOWNLOAD_URL_PORTABLE="https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/kakake-linux-x64.zip"
# GitHub 源（源码版）：拉取仓库最新「正式发布版」的源码 tarball（非便携包）
# 参考咔咔珂「检查更新」模块：仓库 tc-404/kakake，用 releases/latest 取正式版 tag + tarball_url
readonly KAKAKE_GH_REPO="tc-404/kakake"
# GitHub 镜像源（源码版安装时自选，进菜单会逐个测速）：
# 头两项是咔咔珂更新模块原本用的镜像，其余与 NapCat / SnowLuma / 字体共用同一批 gh-proxy 节点
kakake_gh_mirror_labels=(
    "直连 GitHub (国外/可访问 GitHub 的服务器)"
    "gh-proxy.com"
    "gh.catmak.name"
    "ghfast.top"
    "git.yylx.win"
    "ghfile.geekertao.top"
    "gh-proxy.net"
    "j.1win.ggff.net"
    "ghm.078465.xyz"
    "gitproxy.127731.xyz"
    "jiashu.1win.eu.org"
    "github.tbedu.top"
)
kakake_gh_mirror_urls=(
    ""
    "https://gh-proxy.com/"
    "https://gh.catmak.name/"
    "https://ghfast.top"
    "https://git.yylx.win/"
    "https://ghfile.geekertao.top"
    "https://gh-proxy.net"
    "https://j.1win.ggff.net"
    "https://ghm.078465.xyz"
    "https://gitproxy.127731.xyz"
    "https://jiashu.1win.eu.org"
    "https://github.tbedu.top"
)
# 菜单里选中的镜像下标；拉源码时先试这个，失败再按下面的兜底顺序继续
KAKAKE_GH_PROXY_INDEX="0"
# 自动兜底顺序（项数别多，每个失败都要等一轮超时）
kakake_gh_proxy_prefixes=(
    ""
    "https://gh-proxy.com/"
    "https://gh.catmak.name/"
)
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

# 服务端堆上限（跨平台一致）：优先 KAKAKE_MAX_OLD_SPACE_SIZE，
# Termux / 小内存默认 1024MB，其余 2048MB；NODE_OPTIONS 已含 max-old-space-size 则不覆盖。
# 与 scripts/bootstrap.mjs 的 resolveServerNodeOptions() 保持同一套规则。
kakake_server_node_options() {
    local existing="${NODE_OPTIONS:-}"
    if printf '%s' "$existing" | grep -q 'max-old-space-size'; then
        printf '%s' "$existing"
        return
    fi
    local mb="2048" forced="${KAKAKE_MAX_OLD_SPACE_SIZE:-}"
    if [[ -n "$forced" && "$forced" =~ ^[0-9]+$ && "$forced" -gt 0 ]]; then
        mb="$forced"
    elif [[ "${KAKAKE_IS_TERMUX:-0}" == "1" || -n "${TERMUX_VERSION:-}" || -d /data/data/com.termux/files/usr ]]; then
        mb=1024
    fi
    if [[ -n "$existing" ]]; then
        printf '%s --max-old-space-size=%s' "$existing" "$mb"
    else
        printf '%s' "--max-old-space-size=$mb"
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

# 当前 Node 的主线号（如 24）；没装 Node 或解析不出来则返回空。
# 推荐版本必须跟着这个走 —— 用户跑 24 却推 22 会让人以为推荐错了。
kakake_node_current_major() {
    local ver=""
    ver="$(kakake_get_node_version 2>/dev/null || true)"
    ver="${ver#v}"
    [[ "$ver" =~ ^[0-9]+(\.|$) ]] || return 0
    printf '%s\n' "${ver%%.*}"
}

# 当前主线对应的安全版；不在 22/24/26 内则回落到 22.x LTS
kakake_node_safe_for_current() {
    case "$(kakake_node_current_major)" in
        24) printf '%s\n' "$KAKAKE_NODE_STABLE_24" ;;
        26) printf '%s\n' "$KAKAKE_NODE_STABLE_26" ;;
        *)  printf '%s\n' "$KAKAKE_NODE_STABLE_22" ;;
    esac
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
        # 框架 v0.6.9+（auth-key v2）：文件里只有 scrypt 哈希，明文密钥不再落盘，
        # 快捷入口 ?key= 链接随之成为历史。返回 hashed 标记，让状态页显示
        # 「已加密存储 + 重置方法」，而不是误报「解析失败」。
        if grep -q '"keyHash"' "$KAKAKE_AUTH_KEY_FILE" 2>/dev/null; then
            printf '%s\t%s' "" "hashed"
            return 0
        fi
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
            # 框架 v0.5.2+ 日志里的密钥已打码（***，完整密钥只在启动屏幕与 data/auth-key.json）
            # 识别到打码行要当作「没拿到」，否则会把打码说明文字当密钥显示出去
            if [[ "$key" == *'***'* ]]; then
                key=""
            fi
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
        hashed) echo "已加密存储（scrypt 哈希，文件无明文）" ;;
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
        error "当前 Node 环境少了 npm: ${node_path}"
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
        info "npm registry → ${npm_config_registry}（已避开误配的 Node 二进制镜像） 喵"
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
        printf '%s' "$MK_CLEAR_LINE"
    done
}

kakake_draw_web_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  咔咔珂 Web 构建"
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
    error "Web UI 编译失败，关键出错:"
    echo "$content" | grep -E '\[MK-KAKAKE-WEB-ERROR\]|\[MK-WEB-ERROR\]|npm ERR!| ELIFECYCLE |Error:|error TS|command not found' | tail -20 || true
    echo
    info "完整日志: ${KAKAKE_WEB_BUILD_LOG} 喵"
    info "运行日志: ${KAKAKE_LOG} 喵"
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
    info "正在编译 Web UI（进度面板模式） 喵"
    info "按 Ctrl+C 可退出进度显示，后台构建不会停止 喵"
    echo

    trap 'echo; info "已退出进度显示，构建仍在后台继续 喵"; trap - INT; return 0' INT

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
        error "咔咔珂目录不存在: ${KAKAKE_HOME}"
        return 1
    fi

    # 便携版：Web 已随包提供，不可/不需在服务器上重建
    if kakake_is_portable; then
        if kakake_web_built; then
            info "便携版 Web UI 已随包提供 ($(kakake_web_label)) 喵"
            return 0
        fi
        error "便携版少了 packages/web/dist，请重新解压便携包"
        return 1
    fi

    if [[ "$force" != "1" ]] && ! kakake_web_needs_rebuild 0; then
        info "Web UI 已是最新 ($(kakake_web_label)) 喵"
        return 0
    fi

    if kakake_web_build_running; then
        info "小MK发现 Web 构建仍在进行，恢复进度显示 喵"
        if kakake_watch_web_build && kakake_web_built; then
            kakake_web_write_stamp || true
            info "Web UI 就绪 ($(kakake_web_label)) 喵"
            return 0
        fi
        return 1
    fi

    if [[ "$force" == "1" ]] || kakake_web_has_stale_next; then
        kakake_web_clean_legacy_next
    fi

    if [[ "$force" == "1" ]]; then
        args+=(build --force)
        info "强制重建 Web UI → packages/web/dist 喵"
    else
        info "需要构建 Web UI → packages/web/dist 喵"
    fi
    if mk_is_termux; then
        warn "手机上首次构建约 5-15 分钟（取决于机型与网络），请保持 Termux 在前台不要息屏 喵"
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
        error "构建结束但没找到 packages/web/dist/index.html"
        kakake_show_web_build_errors
        return 1
    fi

    # 摘要写入运行日志，便于排障
    {
        echo "===== Kakake web build OK $(date '+%Y-%m-%d %H:%M:%S') ====="
        tail -5 "$KAKAKE_WEB_BUILD_LOG" 2>/dev/null || true
    } >> "$KAKAKE_LOG"

    kakake_web_write_stamp || true
    info "Web UI 就绪 ($(kakake_web_label)) 喵"
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

kakake_lockdown_remaining_ms() {
    local port="" body="" ms=""
    port="$(kakake_get_admin_port)"
    [[ -z "$port" || "$port" == "0" ]] && return 1
    command -v curl >/dev/null 2>&1 || return 1
    body="$(curl -sS --connect-timeout 2 --max-time 4 "http://127.0.0.1:${port}/api/auth/state" 2>/dev/null || true)"
    [[ -n "$body" ]] || return 1
    ms="$(printf '%s' "$body" | grep -oE '"retryAfterMs"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1 || true)"
    [[ "$ms" =~ ^[0-9]+$ ]] || return 1
    if (( ms > 0 )); then
        printf '%s' "$ms"
        return 0
    fi
    return 1
}

kakake_fmt_remaining() {
    local ms="$1" total="" h="" m="" s=""
    [[ "$ms" =~ ^[0-9]+$ ]] || return 1
    total=$(( (ms + 999) / 1000 ))
    h=$(( total / 3600 ))
    m=$(( (total % 3600) / 60 ))
    s=$(( total % 60 ))
    if (( h > 0 )); then
        printf '%d 小时 %02d 分' "$h" "$m"
    else
        printf '%d 分 %02d 秒' "$m" "$s"
    fi
}

# 菜单用状态文案：健康 / 异常 / 未运行
kakake_status_line() {
    local port="" code="000"
    port="$(kakake_get_admin_port)"

    local lock_ms=""
    lock_ms="$(kakake_lockdown_remaining_ms || true)"
    if [[ -n "$lock_ms" ]]; then
        echo -e "  ${RED}* 全局封禁中（剩余 $(kakake_fmt_remaining "$lock_ms")）${NC}"
        echo -e "  ${YELLOW}  → 外部访问会被拒绝；本机 http://127.0.0.1:${port} 登录一次即可解除${NC}"
        return
    fi

    if command -v curl >/dev/null 2>&1; then
        code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
            "http://127.0.0.1:${port}/" 2>/dev/null || echo 000)"
    fi

    if [[ "$code" =~ ^(200|204|301|302|303|307|308|401|403|404)$ ]]; then
        if kakake_web_built; then
            echo -e "  ${GREEN}* 咔咔珂正在运行${NC}"
        else
            echo -e "  ${YELLOW}* 服务在响应但 Web UI 未构建 (HTTP ${code})，后台页面不可用${NC}"
            echo -e "  ${YELLOW}  → 请先 [6] 停止，再 [10] 构建，然后 [5] 启动${NC}"
        fi
        return
    fi

    if [[ "$code" == "503" ]]; then
        echo -e "  ${YELLOW}* 服务在跑但返回 503（多半 Web UI 未构建）${NC}"
        echo -e "  ${YELLOW}  → 请 [6] 停止 → [10] 构建 → [5] 启动${NC}"
        return
    fi

    if kakake_has_process || kakake_port_listening "$port"; then
        echo -e "  ${RED}* 进程/端口被别的东西占着，HTTP 无响应 (code=${code})${NC}"
        echo -e "  ${YELLOW}  → 请先 [6] 停止咔咔珂，再 [5] 重新启动${NC}"
        return
    fi

    if kakake_is_installed; then
        echo -e "  ${YELLOW}* 咔咔珂已装好 (未运行)${NC}"
    else
        echo -e "  ${YELLOW}* 咔咔珂还没装${NC}"
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

# 由前缀反查镜像名（菜单提示 / 日志用）
kakake_gh_mirror_label_of() {
    local prefix="${1:-}" i=0
    for ((i=0; i<${#kakake_gh_mirror_urls[@]}; i++)); do
        if [[ "${kakake_gh_mirror_urls[$i]}" == "$prefix" ]]; then
            printf '%s' "${kakake_gh_mirror_labels[$i]}"
            return 0
        fi
    done
    if [[ -z "$prefix" ]]; then
        printf '%s' "直连 GitHub"
    else
        printf '%s' "$prefix"
    fi
}

# 选择咔咔珂源码版的 GitHub 镜像源（进菜单先逐个测速：绿/黄/红 = 快/中/慢或不通）
menu_kakake_select_gh_mirror() {
    local i=0 idx=0
    local ms=""
    local do_probe=0
    local probed=0
    local -a lat=()
    KAKAKE_GH_PROXY_INDEX="${KAKAKE_GH_PROXY_INDEX:-0}"

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择 GitHub 镜像源（咔咔珂源码版）"
        show_nav_hint
        echo "  这条线走 api.github.com（releases/latest + 源码 tarball），所以按 API 地址测速"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo
        for ((i=0; i<${#kakake_gh_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${kakake_gh_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                printf '  [%s] %s  ' "$idx" "${kakake_gh_mirror_labels[$i]}"
                ms="$(mk_mirror_latency_ms "$(mk_mirror_join_url "${kakake_gh_mirror_urls[$i]}" "$MK_PROBE_API_TARGET")")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${kakake_gh_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#kakake_gh_mirror_labels[@]} + 2 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo
        echo "  选中的镜像先试，不行再按内置兜底顺序（直连 → gh-proxy.com → gh.catmak.name）继续试"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#kakake_gh_mirror_labels[@]} + 2 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#kakake_gh_mirror_labels[@]} )); then
                        KAKAKE_GH_PROXY_INDEX="$idx"
                        info "已选择: ${kakake_gh_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

# 取咔咔珂 GitHub 仓库「最新正式发布版」的 tag 与源码 tarball 地址。
# 先试 KAKAKE_GH_PROXY_INDEX 选中的镜像，失败再按 kakake_gh_proxy_prefixes 兜底。
# 成功时 stdout 三行：第 1 行 = tag，第 2 行 = 可直接下载的 tarball URL（已含代理前缀），
# 第 3 行 = 实际用上的镜像名；失败返回非 0。
kakake_gh_fetch_latest_source() {
    local prefix api resp tag tarball
    local p="" dup=0
    local -a order=()

    if [[ "${KAKAKE_GH_PROXY_INDEX:-0}" =~ ^[0-9]+$ ]] \
        && (( KAKAKE_GH_PROXY_INDEX >= 0 && KAKAKE_GH_PROXY_INDEX < ${#kakake_gh_mirror_urls[@]} )); then
        order+=("${kakake_gh_mirror_urls[$KAKAKE_GH_PROXY_INDEX]}")
    fi
    for prefix in "${kakake_gh_proxy_prefixes[@]}"; do
        dup=0
        for p in "${order[@]}"; do
            [[ "$p" == "$prefix" ]] && dup=1
        done
        if (( dup == 0 )); then
            order+=("$prefix")
        fi
    done

    for prefix in "${order[@]}"; do
        # 注意：镜像前缀有的带尾斜杠有的不带，统一用 mk_mirror_join_url 拼，别直接相接
        api="$(mk_mirror_join_url "$prefix" "https://api.github.com/repos/${KAKAKE_GH_REPO}/releases/latest")"
        resp="$(curl -fsSL --max-time 15 \
            -H 'Accept: application/vnd.github+json' \
            -H 'User-Agent: mk-tools' \
            "$api" 2>/dev/null || true)"
        [[ -n "$resp" ]] || continue
        tag="$(printf '%s' "$resp" \
            | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
            | head -n1 \
            | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
        [[ -n "$tag" ]] || continue
        tarball="$(printf '%s' "$resp" \
            | grep -oE '"tarball_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
            | head -n1 \
            | sed -E 's/.*"tarball_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
        [[ -n "$tarball" ]] || tarball="https://api.github.com/repos/${KAKAKE_GH_REPO}/tarball/${tag}"
        printf '%s\n%s\n%s\n' "$tag" "$(mk_mirror_join_url "$prefix" "$tarball")" "$(kakake_gh_mirror_label_of "$prefix")"
        return 0
    done
    return 1
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
    # 取不到最新版时兜底：给当前主线的安全版，别把 24 用户硬拉到 22
    kakake_node_safe_for_current
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
    local cur_major="" rec22="" rec24="" rec26="" rec_hint=""

    # 推荐哪条线取决于当前跑的是哪条线：同线升小版本只需换运行时，
    # 跨大版本会换 ABI（原生模块要重装），三条线都含本次修复时没必要跨线
    cur_major="$(kakake_node_current_major)"
    case "$cur_major" in
        22)
            rec22="，推荐 · 与当前主线一致"
            rec_hint="当前为 22.x，建议原地升到 ${KAKAKE_NODE_STABLE_22}（同线升级不必重装原生模块）"
            ;;
        24)
            rec24="，推荐 · 与当前主线一致"
            rec_hint="当前为 24.x，建议原地升到 ${KAKAKE_NODE_STABLE_24}（同线升级不必重装原生模块）"
            ;;
        26)
            rec26="，推荐 · 与当前主线一致"
            rec_hint="当前为 26.x，建议原地升到 ${KAKAKE_NODE_STABLE_26}（同线升级不必重装原生模块）"
            ;;
        *)
            rec22="，推荐"
            rec_hint="未检测到受支持的 Node 主线，建议装 22.x LTS"
            ;;
    esac

    while true; do
        latest="$(kakake_node_fetch_latest_version)"
        title "选择 Node.js 版本"
        show_nav_hint
        echo "  咔咔珂要求 Node.js >= 20；下列版本均已包含 2026-10-21 安全修复"
        echo "  [2] 稳定版 ${KAKAKE_NODE_STABLE_22} (22.x LTS${rec22})"
        echo "  [3] 稳定版 ${KAKAKE_NODE_STABLE_24} (24.x LTS「Krypton」${rec24})"
        echo "  [4] 稳定版 ${KAKAKE_NODE_STABLE_26} (26.x${rec26})"
        echo "  [5] 最新版 (当前约 v${latest})"
        echo
        echo "  ${rec_hint}"
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
                NODE_INSTALL_VERSION="$KAKAKE_NODE_STABLE_24"
                NODE_INSTALL_VERSION_LABEL="稳定版 ${KAKAKE_NODE_STABLE_24}"
                return 0
                ;;
            4)
                NODE_INSTALL_VERSION="$KAKAKE_NODE_STABLE_26"
                NODE_INSTALL_VERSION_LABEL="稳定版 ${KAKAKE_NODE_STABLE_26}"
                return 0
                ;;
            5)
                NODE_INSTALL_VERSION="$(kakake_node_fetch_latest_version)"
                NODE_INSTALL_VERSION_LABEL="最新版 ${NODE_INSTALL_VERSION}"
                return 0
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_node_select_mirror() {
    local i=0 idx=0
    local ms=""
    local do_probe=0
    local probed=0
    local -a lat=()

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择 Node.js 下载镜像"
        show_nav_hint
        echo "  国内服务器建议选择镜像源加速下载"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo

        for ((i=0; i<${#node_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${node_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                # 用各镜像自己的 index.json 探活（range 只取 1 字节）
                printf '  [%s] %s  ' "$idx" "${node_mirror_labels[$i]}"
                ms="$(mk_mirror_latency_ms "$(mk_mirror_join_url "${node_mirror_urls[$i]}" "$MK_PROBE_NODE_TARGET")")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${node_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#node_mirror_labels[@]} + 2 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#node_mirror_labels[@]} + 2 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#node_mirror_labels[@]} )); then
                        NODE_INSTALL_MIRROR_IDX="$idx"
                        info "已选择: ${node_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
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
        info "Termux 已装好 Node.js ${cur_ver:-未知} 喵"
        read -r -p "是否重新安装/升级 Node.js? [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || return 0
    fi

    title "安装 Node.js（Termux）"
    echo "  安装方式: pkg install ${pkg_name}"
    echo "  说明:     安卓用的是 bionic libc，官网的 Linux 版 Node 无法运行"
    echo "            只能用 Termux 仓库里编译好的版本"
    echo "  当前仓库 nodejs-lts 为 22.x，满足咔咔珂 >= 20 的要求"
    echo "  装完请 node -v 核对是否达到所在主线的安全基线："
    echo "    22.x >= ${KAKAKE_NODE_STABLE_22} / 24.x >= ${KAKAKE_NODE_STABLE_24} / 26.x >= ${KAKAKE_NODE_STABLE_26}"
    echo "  Termux 仓库的版本由仓库决定，本工具无法指定"
    echo
    warn "nodejs 与 nodejs-lts 冲突，装前会先卸掉另一个 喵"
    echo

    read -r -p "确认安装? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "已取消安装 喵"
        return 0
    }

    if ! command -v pkg >/dev/null 2>&1; then
        error "找不到 pkg 命令，当前似乎不是标准 Termux 环境"
        return 1
    fi

    info "正在更新软件源 喵"
    pkg update -y >/dev/null 2>&1 || warn "软件源更新失败，继续尝试安装 喵"

    # nodejs 与 nodejs-lts 互斥，先移除另一个免得 dpkg 冲突
    pkg uninstall -y nodejs >/dev/null 2>&1 || true

    info "正在装 ${pkg_name} 喵"
    if ! pkg install -y "$pkg_name"; then
        error "安装失败，请先换国内镜像源再重试: termux-change-repo"
        return 1
    fi

    # 源码版编译原生依赖时要用到，缺了会在 npm install 阶段报 gyp ERR
    info "正在装编译依赖（python / clang / make / git / unzip） 喵"
    pkg install -y python clang make git unzip >/dev/null 2>&1 \
        || warn "编译依赖安装失败，若后续 npm install 报 gyp 出错手动安装 喵"

    if ! command -v node >/dev/null 2>&1; then
        error "Node.js 安装校验失败"
        return 1
    fi

    printf '%s\n' "termux-pkg" > "$KAKAKE_NODE_VER_FILE" 2>/dev/null || true
    info "Node.js 装好啦: $(node -v) 喵"
    info "路径: $(command -v node) 喵"
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
        warn "mk 管理的 Node 已装好: ${ver:-未知} 喵"
        read -r -p "是否重新安装 Node.js? [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || return 0
    elif sys_bin="$(kakake_resolve_node_bin 2>/dev/null)"; then
        sys_ver="$("$sys_bin" -v 2>/dev/null || echo 未知)"
        info "小MK发现系统已有 Node.js ${sys_ver}（${sys_bin}） 喵"
        info "咔咔珂启动会直接使用它；也可继续安装一份 mk 私有 Node（启动时优先） 喵"
        read -r -p "是否仍安装 mk 私有 Node.js? [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || return 0
    fi

    NODE_INSTALL_VERSION=""
    NODE_INSTALL_VERSION_LABEL=""
    NODE_INSTALL_MIRROR_IDX="0"
    menu_node_select_version || return 0
    menu_node_select_mirror || return 0

    install_ver="$NODE_INSTALL_VERSION"

    title "安装 Node.js"
    echo "  版本:     ${NODE_INSTALL_VERSION_LABEL}"
    echo "  镜像:     ${node_mirror_labels[$NODE_INSTALL_MIRROR_IDX]}"
    echo "  安装路径: ${KAKAKE_NODE_DIR}"
    echo "  咔咔珂启动将优先使用此 Node"
    echo
    warn "若服务器上已有其他 Node 项目，切换版本可能导致那些项目无法正常运行 喵"
    echo

    read -r -p "确认安装 Node.js v${install_ver}? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "已取消安装 喵"
        return 0
    }

    local arch="" url="" tmp=""
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            error "帮不上忙的 CPU 架构: $(uname -m)"
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

    tmp="$(mktemp /tmp/mk-node.XXXXXX.tar.xz)"

    info "正在下载 Node.js v${install_ver} 喵"
    # 安全版刚发布那几天，国内镜像常常还没同步（实测过：官方源与 npmmirror 已有
    # 22.23.4，腾讯云/华为云仍返回 404）。主镜像取不到就顺着剩下的镜像挨个试，
    # 别让用户卡在一句「下载失败，请更换镜像源」上手动重试一遍。
    local -a try_order=()
    local i=0 idx=0 got=0
    for ((i=0; i<${#node_mirror_urls[@]}; i++)); do
        try_order+=("$(( (NODE_INSTALL_MIRROR_IDX + i) % ${#node_mirror_urls[@]} ))")
    done
    for idx in "${try_order[@]}"; do
        url="$(kakake_node_build_download_url "$install_ver" "$arch" "$idx")"
        info "尝试镜像: ${node_mirror_labels[$idx]}（${url}）喵"
        if curl -fL --retry 2 --connect-timeout 30 -o "$tmp" "$url"; then
            got=1
            break
        fi
    done
    if (( got == 0 )); then
        error "所有镜像都下载失败了，请检查网络；若装的是刚发布的安全版，镜像同步可能有延迟"
        rm -f "$tmp"
        return 1
    fi

    mkdir -p "$INSTALL_DIR"
    rm -rf "$KAKAKE_NODE_DIR"
    mkdir -p "$KAKAKE_NODE_DIR"

    if ! tar -xJf "$tmp" -C "$KAKAKE_NODE_DIR" --strip-components=1; then
        error "解压 Node.js 失败"
        rm -f "$tmp"
        return 1
    fi
    rm -f "$tmp"

    if ! kakake_node_private_installed; then
        error "Node.js 安装校验失败"
        return 1
    fi

    echo "$install_ver" > "$KAKAKE_NODE_VER_FILE"
    echo "${NODE_INSTALL_MIRROR_IDX}" > "$KAKAKE_NODE_MIRROR_FILE"
    info "Node.js 装好啦: $("$KAKAKE_NODE_BIN" -v) 喵"
    info "路径: ${KAKAKE_NODE_BIN} 喵"
}

kakake_node_uninstall() {
    # Termux 的 Node 由 pkg 管，mk 没有自己的私有副本可删
    if mk_is_termux; then
        title "卸载 Node.js（Termux）"
        if ! command -v node >/dev/null 2>&1; then
            warn "当前没有小MK发现 Node.js 喵"
            press_enter
            return 0
        fi
        echo "  当前版本: $(node -v 2>/dev/null || echo 未知)"
        echo "  安装来源: Termux 软件仓库（pkg），不是 mk 私有副本"
        echo
        warn "卸载后咔咔珂将无法启动，其他依赖 node 的工具也会失效 喵"
        echo
        local confirm=""
        read -r -p "确认执行 pkg uninstall nodejs-lts? [y/N]: " confirm
        [[ "$confirm" =~ ^[Yy]$ ]] || {
            info "已取消卸载 喵"
            return 0
        }
        if kakake_http_alive "$(kakake_get_admin_port)" || kakake_has_process; then
            warn "咔咔珂正在跑，请先停止再卸载 Node 喵"
            return 1
        fi
        pkg uninstall -y nodejs-lts >/dev/null 2>&1 || pkg uninstall -y nodejs >/dev/null 2>&1 || true
        rm -f "$KAKAKE_NODE_VER_FILE" "$KAKAKE_NODE_MIRROR_FILE" 2>/dev/null || true
        info "Node.js 已卸载 喵"
        return 0
    fi

    require_root || return 1

    if ! kakake_node_private_installed && [[ ! -f "$KAKAKE_NODE_VER_FILE" ]]; then
        warn "小MK没找到 mk 安装的 Node.js 喵"
        if kakake_node_installed; then
            info "系统全局 Node 仍可用: $(kakake_get_node_version)（不会被本操作卸载） 喵"
        fi
        return 0
    fi

    local installed_ver=""
    installed_ver="$(cat "$KAKAKE_NODE_VER_FILE" 2>/dev/null || echo 未知)"

    local confirm=""
    read -r -p "确认卸载 mk 管理的 Node.js (v${installed_ver})? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "已取消卸载 喵"
        return 0
    }

    if kakake_http_alive "$(kakake_get_admin_port)" || kakake_has_process; then
        warn "咔咔珂正在跑或残留进程占用，请先停止 喵"
        return 1
    fi

    rm -rf "$KAKAKE_NODE_DIR"
    rm -f "$KAKAKE_NODE_VER_FILE" "$KAKAKE_NODE_MIRROR_FILE"
    info "Node.js 已卸载 (mk 管理版本) 喵"
    warn "系统自带的 node 命令(若有)不受影响 喵"
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

    local edition_choice="" download_url="" zip_label="" want_edition="" download_format="zip"

    title "安装咔咔珂"
    echo "  安装目录均为: ${KAKAKE_HOME}"
    echo "  重新安装会保留 data/ 与 plugins/"
    echo
    if mk_is_termux; then
        echo "  [1] 源码版（开发版）— 下载 kakake.zip，需装 Node、可构建 Web"
        echo "  [2] 便携版 — 手机不可用（内置的是 x86_64 glibc 版 Node）"
        echo "  [0] 取消"
        echo
        echo "  当前环境: $(mk_platform_label) · 只能装源码版"
    else
        echo "  [1] 源码版（开发版）— 下载 kakake.zip，需装 Node、可构建 Web"
        echo "  [2] 便携版 — 下载 kakake-linux-x64.zip，内置 Node、免装免构建"
        echo "  [0] 取消"
    fi
    echo
    read_choice edition_choice
    case "$edition_choice" in
        0)
            info "已取消安装 喵"
            return 0
            ;;
        1)
            want_edition="source"
            # 源码版再选下载来源
            echo
            echo "  源码版从哪拉取?"
            echo "  [1] Kakake 服务器源"
            echo "  [2] GitHub 源（拉取仓库最新正式发布版的源码，较新）"
            echo "  [0] 取消"
            echo
            local src_choice=""
            read_choice src_choice
            case "$src_choice" in
                1)
                    download_url="$KAKAKE_DOWNLOAD_URL"
                    download_format="zip"
                    zip_label="kakake.zip"
                    ;;
                2)
                    local gh_out="" gh_tag="" gh_url="" gh_src=""
                    # 先选镜像源（列表带测速），再按它去查最新正式版
                    menu_kakake_select_gh_mirror || return 0
                    info "正在向 GitHub 查询最新正式发布版 喵"
                    gh_out="$(kakake_gh_fetch_latest_source || true)"
                    gh_tag="$(printf '%s\n' "$gh_out" | sed -n '1p')"
                    gh_url="$(printf '%s\n' "$gh_out" | sed -n '2p')"
                    gh_src="$(printf '%s\n' "$gh_out" | sed -n '3p')"
                    if [[ -z "$gh_tag" || -z "$gh_url" ]]; then
                        error "没能从 GitHub 取到发布版（可能被墙或仓库暂无正式版），换 [1] Kakake 源试试"
                        return 1
                    fi
                    download_url="$gh_url"
                    download_format="tar.gz"
                    zip_label="GitHub 源码版 ${gh_tag}"
                    info "GitHub 最新正式版: ${gh_tag}（镜像: ${gh_src:-直连 GitHub}） 喵"
                    ;;
                0|"")
                    info "已取消安装 喵"
                    return 0
                    ;;
                *)
                    warn "无法识别该选项 喵"
                    return 1
                    ;;
            esac
            ;;
        2)
            if mk_is_termux; then
                error "便携版内置的是 x86_64 + glibc 的 Node，安卓（arm64 + bionic）跑不起来"
                info "请选择 [1] 源码版，mk 会用 Termux 仓库里的 Node 启动 喵"
                return 1
            fi
            want_edition="portable"
            download_url="$KAKAKE_DOWNLOAD_URL_PORTABLE"
            zip_label="kakake-linux-x64.zip（便携版）"
            ;;
        *)
            warn "无法识别该选项 喵"
            return 1
            ;;
    esac

    info "已选择: ${zip_label} 喵"

    if kakake_is_installed; then
        local reinstall=""
        warn "小MK发现咔咔珂已装好 ($(kakake_edition_label)) 喵"
        info "重新安装将保留 data/ 与 plugins/，其余文件会被替换 喵"
        read -r -p "是否重新安装为所选版本? [y/N]: " reinstall
        [[ "$reinstall" =~ ^[Yy]$ ]] || return 0
        kakake_stop || true
    fi

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        error "需要 curl 或 wget 才能下载"
        return 1
    fi
    if [[ "$download_format" == "tar.gz" ]]; then
        if ! command -v tar >/dev/null 2>&1; then
            error "GitHub 源码包是 tar.gz，需要 tar 命令，请先安装"
            return 1
        fi
        if ! command -v gzip >/dev/null 2>&1 && ! tar --help 2>&1 | grep -q -- '-z'; then
            warn "没探测到 gzip，解压可能失败，装一下 gzip 更保险 喵"
        fi
    else
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
            error "需要 unzip 命令，请先安装"
            if mk_is_termux; then
                info "Termux 执行: pkg install unzip 喵"
            fi
            return 1
        fi
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

    info "正在下载咔咔珂 (${zip_label}) 喵"
    info "地址: ${download_url} 喵"
    if [[ "$preserved" -eq 1 ]]; then
        info "将保留现有 data/ 与 plugins/ 喵"
    fi

    {
        echo "[MK-KAKAKE] install start: $(date '+%Y-%m-%d %H:%M:%S') want=${want_edition} url=${download_url}"
        if curl -fL --retry 3 -o "$tmp_zip" "$download_url"; then
            echo "[MK-KAKAKE] download ok"
        elif wget -O "$tmp_zip" "$download_url"; then
            echo "[MK-KAKAKE] download ok (wget)"
        else
            echo "[ERROR] 下载失败: ${download_url}"
            exit 1
        fi

        rm -rf "$tmp_dir"
        mkdir -p "$tmp_dir"
        if [[ "$download_format" == "tar.gz" ]]; then
            tar -xzf "$tmp_zip" -C "$tmp_dir"
        else
            unzip -oq "$tmp_zip" -d "$tmp_dir"
        fi

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
        error "安装失败，详见: ${KAKAKE_INSTALL_LOG}"
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
        warn "已下载便携包，但目录未识别为便携版，帮忙检查一下 zip 内容是否含 runtime/bin/node 喵"
    elif [[ "$want_edition" == "source" ]] && ! kakake_is_source; then
        warn "已下载源码包，但目录未识别为源码版，帮忙检查一下是否含 scripts/bootstrap.mjs 喵"
    fi

    mkdir -p "$KAKAKE_DATA"
    kakake_open_admin_port
    info "咔咔珂装好啦: ${KAKAKE_HOME} ($(kakake_edition_label)) 喵"
    if [[ "$preserved" -eq 1 ]]; then
        info "已保留原 data/ 与 plugins/ 喵"
    fi
    if mk_is_termux; then
        info "安卓不需要放行端口，同一 Wi-Fi 下别的设备可直接访问，未自动启动 喵"
        info "请先「安装 Node.js」（pkg 版），再「启动咔咔珂」 喵"
        info "首次启动要装依赖 + 构建前端，手机上约 5-15 分钟，请保持 Termux 前台 喵"
        return 0
    fi
    info "已开放 ${KAKAKE_ADMIN_PORT} 端口，未自动启动 喵"
    if kakake_is_portable; then
        info "当前为便携版（内置 Node），可直接「启动咔咔珂」，无需再装系统 Node 喵"
    else
        info "请先「安装 Node.js」（若本机尚无），再「启动咔咔珂」 喵"
    fi
}

kakake_start_panel_cursor_up() {
    local i=0
    for ((i=0; i<KAKAKE_START_PANEL_LINES; i++)); do
        printf '%s' "$MK_CLEAR_LINE"
    done
}

kakake_draw_start_progress_panel() {
    local percent="$1"
    local stage="$2"
    local elapsed="$3"
    local spin="$4"

    echo "--------------------------------------"
    echo "  咔咔珂 启动进度"
    echo "--------------------------------------"
    echo "  当前步骤: ${stage}"
    printf '  进度: '
    baota_make_bar "$percent"
    echo
    echo "  已用时间: ${elapsed} 秒    状态: ${spin} 运行中"
    echo "--------------------------------------"
}

kakake_start() {
    local node_bin="" node_path="" port="" i=0 entry=""
    local start_ts="" now_ts="" elapsed=0 panel_active=0
    local spinner=('|' '/' '-' '+') spin_idx=0
    local percent=15 stage="准备启动"

    if ! kakake_is_installed; then
        error "咔咔珂还没装，请先安装咔咔珂"
        return 1
    fi

    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        if kakake_is_portable; then
            error "便携版少了 runtime/bin/node，帮忙检查一下目录是否完整"
        else
            error "没找到 Node.js，请先安装 Node.js"
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
            warn "咔咔珂已在正常运行 ($(kakake_edition_label)) 喵"
            kakake_show_login_info
            return 0
        fi
        warn "服务在响应但 Web UI 未构建，将重启并先构建前端 喵"
        kakake_stop || true
        sleep 1
    elif kakake_has_process || kakake_port_listening "$port"; then
        warn "小MK发现残留进程或端口占用但 HTTP 无响应，先清理 喵"
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
            info "已获取 Termux 唤醒锁（锁屏后仍保持运行） 喵"
        else
            warn "还没装 Termux:API，锁屏后可能被系统冻结 喵"
            warn "建议执行: pkg install termux-api，并安装 Termux:API 应用 喵"
        fi
    fi

    info "正在后台启动咔咔珂（$(kakake_edition_label) · ${entry}） 喵"
    (
        cd "$KAKAKE_HOME" || exit 1
        export PATH="${node_path}:${PATH}"
        # 受管重启循环：后端以退出码 86 请求「应用暂存更新并重启」；本循环据此
        # 调用 scripts/apply-update.mjs 后重新拉起。其它退出码则如常结束（含 mk 停止发来的信号）。
        nohup env PATH="${node_path}:${PATH}" NODE_OPTIONS="$(kakake_server_node_options)" KAKAKE_MANAGED_RELAUNCH=1 \
            bash -c '
                cd "$1" || exit 1
                nb="$2"; ent="$3"; applier="$1/scripts/apply-update.mjs"
                while :; do
                    "$nb" "$ent"
                    st=$?
                    if [ "$st" = "86" ]; then
                        [ -f "$applier" ] && "$nb" "$applier" || true
                        continue
                    fi
                    exit "$st"
                done
            ' kakake-run "$KAKAKE_HOME" "$node_bin" "$entry" >> "$KAKAKE_LOG" 2>&1 &
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
                error "启动失败了，看看日志: ${KAKAKE_LOG}"
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
        error "等待超时（HTTP :${port} 无响应），看看: ${KAKAKE_LOG}"
        tail -40 "$KAKAKE_LOG" 2>/dev/null || true
        return 1
    fi

    sleep 1

    kakake_open_admin_port
    info "咔咔珂启动好啦 (后台运行 · $(kakake_edition_label)) 喵"
    kakake_show_login_info
    if mk_is_termux; then
        info "退出 mk 菜单不会停止咔咔珂，请使用「停止咔咔珂」关闭 喵"
        warn "别在最近任务里划掉 Termux，那等于直接杀进程 喵"
        warn "请到系统设置里给 Termux 关闭电池优化（允许后台活动） 喵"
    else
        info "退出 mk 菜单不会停止咔咔珂，请使用「停止咔咔珂」关闭 喵"
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
            info "已停止 systemd 服务 ${AUTOSTART_KAKAKE_UNIT}（避免自动拉起） 喵"
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
        warn "端口 ${port} 仍被占用，尝试释放 喵"
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
        warn "部分进程/端口可能仍在占用 喵"
        if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1; then
            warn "小MK发现 ${AUTOSTART_KAKAKE_UNIT} 仍启用；若日志在刷 bootstrap 找不到，请到「开机自启」关闭后重装自启 喵"
        fi
        if mk_is_termux; then
            warn "可手动: pkill -f kakake ；查看占用: ss -lptn 'sport = :${port}' 喵"
        else
            warn "可手动: systemctl stop ${AUTOSTART_KAKAKE_UNIT}; fuser -k ${port}/tcp 喵"
        fi
        return 1
    fi

    # 进程确实停了再放唤醒锁，否则会白耗电
    if mk_is_termux && command -v termux-wake-unlock >/dev/null 2>&1; then
        termux-wake-unlock >/dev/null 2>&1 || true
    fi

    info "咔咔珂已经停下来 喵"
}

kakake_restart() {
    info "正在重启咔咔珂 喵"
    kakake_stop || true
    sleep 2
    kakake_start
}

kakake_get_server_ip() {
    napcat_get_server_ip
}

kakake_show_login_info() {
    local ip="" port="" key="" kind="" kind_label="" key_q="" lock_ms=""
    local lan_if="" cand_ip="" cand_if=""
    # Termux 下顺带取出网卡名，好让用户一眼看出这是 Wi-Fi 地址还是蜂窝/VPN 地址
    if mk_is_termux; then
        IFS=$'\t' read -r ip lan_if < <(mk_lan_ipv4_best) || true
    fi
    [[ -z "$ip" ]] && ip="$(kakake_get_server_ip)"
    port="$(kakake_get_admin_port)"
    # 不用 IFS read：行首制表符会被当分隔符吞掉，空的首字段（key 为空 + hashed 标记）会错位
    local auth_out=""
    auth_out="$(kakake_get_auth_key)"
    key="${auth_out%%$'\t'*}"
    kind="${auth_out#*$'\t'}"
    if [[ "$kind" == "$auth_out" ]]; then
        kind=""
    fi
    kind_label="$(kakake_auth_kind_label "$kind")"
    lock_ms="$(kakake_lockdown_remaining_ms || true)"

    title "咔咔珂 控制台"
    if [[ -n "$lock_ms" ]]; then
        echo -e "  ${RED}* 全局封禁中（剩余 $(kakake_fmt_remaining "$lock_ms")）${NC}"
        echo -e "  ${YELLOW}  → 外部设备此刻打不开后台；在本机浏览器打开 http://127.0.0.1:${port} 用登录密码登录一次即可解除${NC}"
        echo -e "  ${YELLOW}  → 或在本菜单 [6] 停止后 [5] 重新启动${NC}"
        echo
    fi
    if mk_is_termux; then
        # 手机上最常用的是本机浏览器直接开，公网地址反而没用
        echo "  手机浏览器: http://127.0.0.1:${port}"
        if [[ -n "$lan_if" ]]; then
            echo "  同 Wi-Fi 其他设备: http://${ip}:${port}  ← ${lan_if}（$(mk_nic_kind_label "$lan_if")）"
        else
            echo "  同 Wi-Fi 其他设备: 小MK没找到局域网地址（手机是不是没连 Wi-Fi？）"
        fi
    else
        echo "  后台地址: http://${ip}:${port}"
        echo "  本机地址: http://127.0.0.1:${port}"
    fi
    if [[ -n "$key" ]]; then
        echo "  登录密钥: ${key}"
        echo "  密钥类型: ${kind_label}"
        if command -v python3 >/dev/null 2>&1; then
            key_q="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$key" 2>/dev/null || true)"
        fi
        # 地址没探到时（占位文字）就别拼快捷链接了，点了也打不开
        if [[ -n "$key_q" && "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ && -z "$lock_ms" ]]; then
            echo "  快捷入口: http://${ip}:${port}/?key=${key_q}"
        fi
    elif [[ "$kind" == "hashed" ]]; then
        # v0.6.9+ 密钥哈希化：明文不存在于任何文件，/?key= 快捷链接随之退役
        echo "  登录密钥: 已加密存储（文件里只有 scrypt 哈希，无明文）"
        echo "  密钥类型: ${kind_label}"
        echo "  忘记密码: 停止框架 → 删除 ${KAKAKE_AUTH_KEY_FILE} → 重启，会生成新的初始密钥"
    else
        echo "  登录密钥: 未获取到"
        if [[ -f "$KAKAKE_AUTH_KEY_FILE" ]]; then
            warn "已找到 ${KAKAKE_AUTH_KEY_FILE} 但解析失败 喵"
        else
            warn "尚未生成 ${KAKAKE_AUTH_KEY_FILE}，请先成功启动一次框架 喵"
        fi
    fi
    if kakake_node_installed; then
        echo "  Node 版本: $(kakake_get_node_version || echo 未知) ($(kakake_node_source_label))"
    fi
    if kakake_web_built; then
        echo "  Web 构建: 已就绪 ($(kakake_web_label))"
    else
        echo "  Web 构建: 未完成（启动时会自动 build:web）"
    fi
    echo
    if mk_is_termux; then
        if [[ -n "$lan_if" ]] && ! mk_nic_is_lan "$lan_if"; then
            warn "上面的地址来自 ${lan_if}（$(mk_nic_kind_label "$lan_if")），同一 Wi-Fi 的电脑访问不到它 喵"
            echo "  请先让手机连上 Wi-Fi，并关掉 VPN / 加速器，然后重新查看本页"
        fi
        # 手机上常常同时有多个网卡，把其余地址一并列出，方便逐个试
        while IFS=$'\t' read -r cand_ip cand_if; do
            [[ -z "$cand_ip" || -z "$cand_if" || "$cand_ip" == "$ip" ]] && continue
            echo "  备选地址: http://${cand_ip}:${port}  ← ${cand_if}（$(mk_nic_kind_label "$cand_if")）"
        done < <(mk_lan_ipv4_candidates)
        echo "  若仍打不开: 确认电脑连的是同一个 Wi-Fi（不是访客网络），并关闭路由器的「AP 隔离」"
    else
        warn "若无法访问，请在安全组放行 ${port} 端口 喵"
    fi
}

kakake_do_uninstall() {
    title "卸载咔咔珂"
    echo "  将删除 ${KAKAKE_HOME} 及运行状态"
    echo

    local confirm="" admin_port=""
    read -r -p "确认彻底卸载咔咔珂? [y/N]: " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || {
        info "已取消卸载 喵"
        return 0
    }

    admin_port="$(kakake_get_admin_port)"
    kakake_stop || true
    rm -rf "$KAKAKE_HOME"
    rm -f "$KAKAKE_LOG" "$KAKAKE_PID_FILE" "$KAKAKE_INSTALL_LOG" 2>/dev/null || true

    if ! kakake_port_listening "$admin_port"; then
        napcat_firewall_close_port "$admin_port" || true
    fi

    info "咔咔珂已彻底卸载 喵"
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
        warn "同时启用了「${rev_name}」(咔咔珂 Server) 和「${fwd_name}」(咔咔珂 Client)，通常只需一种 喵"
        echo "  Server=正向(监听)  Client=反向(连出)"
        echo "  A 反向: 咔咔珂 Server :${rev_port} ← NapCat WebSocket Client"
        echo "  B 正向: 咔咔珂 Client → NapCat WebSocket Server :3001"
    fi

    if [[ "$has_fwd" -eq 1 && "$fwd_port" == "6700" ]]; then
        error "「${fwd_name}」正向 WS 指向 6700 有误"
        echo "  6700 是咔咔珂反向监听口；正向连 6700 会连到咔咔珂自己，不是 NapCat"
        echo "  日志里「连上啦」是假象，真正连 NapCat 的是「${rev_name:-反向连接}」"
    elif [[ "$has_fwd" -eq 1 && "$has_rev" -eq 1 && "$fwd_port" == "$rev_port" ]]; then
        error "正向与反向使用了同一端口 ${rev_port}，正向会连到咔咔珂自身"
    fi
}

kakake_show_pairing_hint() {
    echo -e "${CYAN}  术语: WebSocket Server=正向(监听)  Client=反向(连出)${NC}"
    echo "  A. NapCat Client(反向) → ws://127.0.0.1:6700  [咔咔珂=Server，反向]"
    echo "  B. NapCat Server(正向) ← ws://127.0.0.1:3001  [咔咔珂=Client，正向]"
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

    echo -e "${BOLD}【连接诊断】${NC} ${name:-连接}"
    echo

    if ! kakake_conn_is_enabled "$enable"; then
        warn "此连接未启用 (enable=false) 喵"
        return 0
    fi
    if ! kakake_is_running; then
        error "咔咔珂未运行，请先: 咔咔珂操作 → 启动咔咔珂"
        return 0
    fi

    if [[ "$mode" == "reverse" ]]; then
        if kakake_reverse_ws_has_client "$port"; then
            info "正常: NapCat 已连入咔咔珂 ${host}:${port} 喵"
        elif kakake_port_listening "$port"; then
            warn "咔咔珂正在 ${host}:${port} 监听，但 NapCat 尚未连入 喵"
            echo "  NapCat 侧: 网络配置 → WebSocket Client (反向 WS)"
            echo "  连接地址: ws://127.0.0.1:${port}"
            echo "  Token 需与咔咔珂连接配置中的 Access Token 一致"
        else
            error "咔咔珂未在端口 ${port} 监听"
            echo "  请重启咔咔珂，或用「端口验证」检查 ${port} 是否被占用"
        fi
        return 0
    fi

    if [[ "$mode" == "forward" ]]; then
        host="${host:-127.0.0.1}"
        if [[ "$port" == "6700" ]] && kakake_port_listening "6700"; then
            error "「${name}」正向 WS 连 ws://${host}:6700 实际连的是咔咔珂自己的反向监听"
            echo "  这不是 NapCat！日志「连上啦」是连到本机 6700，数据未进 NapCat"
            echo "  NapCat 侧应配 WebSocket Client (反向) → ws://127.0.0.1:6700"
            echo "  由「NapCat 默认接入」等反向连接负责，请禁用或删除本正向连接"
            kakake_show_pairing_hint
            return 0
        fi
        if kakake_forward_ws_has_session "$host" "$port"; then
            info "正常: 咔咔珂已连上 NapCat ws://${host}:${port} 喵"
            return 0
        fi

        if kakake_port_listening "$port"; then
            if [[ "$port" == "6700" ]]; then
                error "6700 上有咔咔珂反向监听，正向 WS 不应连此端口"
            else
                warn "ws://${host}:${port} 有程序在监听，但 WebSocket 未握手成功 喵"
            fi
            echo "  检查 Token 是否与 NapCat WebSocket Server (正向) 一致"
            echo "  查看日志: tail -f ${KAKAKE_LOG}"
            return 0
        fi

        error "连接被拒绝 (ECONNREFUSED): ws://${host}:${port} 没有任何服务在监听"
        echo
        echo "  正向 = 咔咔珂 Client 连 NapCat WebSocket Server (正向，NapCat 监听)"
        echo "  反向 = 咔咔珂 Server 监听，NapCat WebSocket Client (反向) 连入"
        echo
        if [[ "$port" == "6700" ]]; then
            warn "6700 是咔咔珂「反向 WS」的默认监听端口，不是 NapCat 的端口 喵"
            echo "  你当前配成了正向 WS 去连 6700，所以一定会 ECONNREFUSED"
            echo
            echo "  方案 A (推荐，常用): 改用反向 WS"
            echo "    1. 删除连接「${name}」，重新添加 → OneBot 反向 WS，端口 6700"
            echo "    2. NapCat → WebSocket Client (反向) → ws://127.0.0.1:6700"
            echo
            echo "  方案 B: 继续用正向 (咔咔珂 Client → NapCat Server)"
            echo "    1. NapCat → WebSocket Server (正向)，端口 3001"
            echo "    2. 咔咔珂 → OneBot 正向 (Client)，ws://127.0.0.1:3001"
        else
            echo "  确认一下:"
            echo "    1. NapCat 已经跑起来啦 (NapCat操作 → 启动框架)"
            echo "    2. NapCat 已添加 WebSocket Server (正向)，端口 ${port} (常用 3001)"
            echo "    3. 咔咔珂 OneBot 正向 (Client) 地址与 NapCat Server 端口一致"
        fi
        return 0
    fi

    info "看看咔咔珂控制台日志获取更多信息 喵"
}

kakake_conn_status_text() {
    local enable="$1" category="$2" addr="$3"
    local host="" port="" parsed=""

    if [[ "$enable" != "true" ]]; then
        echo -e "${YELLOW}还没打开${NC}"
        return
    fi
    if ! kakake_is_running; then
        echo -e "${RED}未运行${NC}"
        return
    fi
    case "$category" in
        onebot:reverse)
            port="${addr##*:}"
            if kakake_reverse_ws_has_client "$port"; then
                echo -e "${GREEN}连上${NC}"
            elif kakake_port_listening "$port"; then
                echo -e "${YELLOW}等待接入${NC}"
            else
                echo -e "${RED}未监听${NC}"
            fi
            ;;
        onebot:forward)
            parsed="$(kakake_parse_ws_target "$addr")"
            host="${parsed%% *}"
            port="${parsed##* }"
            if kakake_forward_ws_has_session "$host" "$port"; then
                echo -e "${GREEN}连上${NC}"
            elif kakake_port_listening "$port"; then
                echo -e "${YELLOW}未握手${NC}"
            else
                echo -e "${RED}目标未监听${NC}"
            fi
            ;;
        qq_official)
            if kakake_qq_official_has_session; then
                echo -e "${GREEN}连上${NC}"
            else
                echo -e "${RED}还没连上${NC}"
            fi
            ;;
        *)
            echo -e "${YELLOW}未知${NC}"
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
        error "删除失败"
        return 1
    fi
    if [[ -n "$del_port" && "$del_port" =~ ^[0-9]+$ && "$del_port" != "0" ]]; then
        if ! kakake_cfg_port_used_by_others "$del_port"; then
            napcat_firewall_close_port "$del_port"
        fi
    fi
    info "连接配置已删除，已立即保存 喵"
}

kakake_cfg_check_ready() {
    if ! kakake_is_installed; then
        error "咔咔珂还没装"
        return 1
    fi
    kakake_cfg_require_python || return 1
    return 0
}

menu_kakake_conn_add() {
    local choice="" kind="" name="" host="" port="" token="" enable="y"
    local app_id="" app_secret="" sandbox="y"

    while true; do
        title "新增连接 - 选择类型"
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
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done

    echo
    read -r -p "连接名称:" name
    name="${name// /}"
    [[ -z "$name" ]] && name="连接_$(date +%s)"

    if [[ "$kind" == "qq_official" ]]; then
        read -r -p "AppID: " app_id
        read -r -p "AppSecret: " app_secret
        read -r -p "沙箱环境? [Y/n]: " sandbox
        [[ "$sandbox" =~ ^[Nn]$ ]] && sandbox="n" || sandbox="y"
        read -r -p "是否启用? [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        kakake_cfg_tool add "$kind" "$name" "$app_id" "$app_secret" "$sandbox" "" "$enable" || {
            error "添加失败"
            return 1
        }
    elif [[ "$kind" == "onebot:reverse" ]]; then
        read -r -p "监听地址 [0.0.0.0]: " host
        host="${host:-0.0.0.0}"
        read -r -p "监听端口 [6700]: " port
        port="${port:-6700}"
        read -r -p "Access Token (留空跳过):" token
        read -r -p "是否启用? [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        kakake_cfg_tool add "$kind" "$name" "$host" "$port" "" "$token" "$enable" || {
            error "添加失败"
            return 1
        }
        if [[ "$enable" == "y" && -n "$port" ]]; then
            napcat_firewall_open_port "$port"
        fi
    else
        read -r -p "NapCat WS 地址 [127.0.0.1]: " host
        host="${host:-127.0.0.1}"
        read -r -p "NapCat WS 端口 [3001]: " port
        port="${port:-3001}"
        if [[ "$port" == "6700" ]]; then
            echo
            error "6700 是咔咔珂「反向 WS」监听端口，不是 NapCat 服务端端口"
            echo "  若 NapCat 配 WebSocket Server (正向)，咔咔珂应选 OneBot 正向 (Client)，端口 3001"
            echo "  若要用 6700，咔咔珂选 OneBot 反向 (Server)，NapCat 配 WebSocket Client (反向)"
            read -r -p "是否改用 3001? [Y/n]: " fix_port
            [[ ! "$fix_port" =~ ^[Nn]$ ]] && port="3001"
        fi
        read -r -p "Access Token (留空跳过):" token
        read -r -p "是否启用? [Y/n]: " enable
        [[ "$enable" =~ ^[Nn]$ ]] && enable="n" || enable="y"
        kakake_cfg_tool add "$kind" "$name" "$host" "$port" "" "$token" "$enable" || {
            error "添加失败"
            return 1
        }
    fi

    info "连接配置已保存: ${KAKAKE_CONNECTIONS_FILE} 喵"
    info "配置已写入，重启咔咔珂后可确保连接完全生效 喵"
}

menu_kakake_conn_detail() {
    local idx="$1"
    local choice="" confirm=""

    while true; do
        title "连接配置详情"
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
                        echo "  模式:     正向 (咔咔珂 Client → NapCat Server)"
                    elif [[ "$val" == "reverse" ]]; then
                        echo "  模式:     反向 (咔咔珂 Server ← NapCat Client)"
                    else
                        echo "  模式:     ${val}"
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
                read -r -p "确认删除此连接? [y/N]: " confirm
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    kakake_cfg_delete_item "$idx"
                    press_enter
                    mk_nav_back
                    return 0
                fi
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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

        title "咔咔珂 - 连接管理"
        show_nav_hint
        kakake_show_pairing_hint
        kakake_conn_check_conflicts
        echo "  [3] 新增连接"
        echo
        echo "  状态: 已连接 | 等待接入 | 目标未监听 | 未握手"
        echo

        mapfile -t lines < <(kakake_cfg_tool list 2>/dev/null || true)
        if [[ ${#lines[@]} -eq 0 || -z "${lines[0]:-}" ]]; then
            echo "  (暂无连接配置)"
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
        info "配置文件: ${KAKAKE_CONNECTIONS_FILE} 喵"
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
                    warn "无法识别该选项，请重新输入 喵"
                fi
                ;;
        esac
    done
}

# 目录迁移后改写自启动配置里的安装路径。
#
# systemd unit / Termux 开机脚本里的路径是「生成时展开」的绝对路径（WorkingDirectory、
# ExecStart、pkill 匹配串）。目录一搬家，它们就指向了已经不存在的位置，systemd 会按
# Restart=on-failure 反复拉起失败。
#
# 注意不能用 autostart_kakake_enable 重写：本会话的 KAKAKE_HOME 是 readonly 旧值，
# 重写等于把旧路径再写一遍。所以这里就地做整串替换。
kakake_autostart_relink() {
    local old="$1" new="$2"
    local unit="/etc/systemd/system/${AUTOSTART_KAKAKE_UNIT}"
    local boot="" fixed=0

    [[ -n "$old" && -n "$new" && "$old" != "$new" ]] || return 0

    # 新目录在旧目录之下时，整串替换会把目录名改坏，只能等重开 mk 重建
    if [[ "$new" == "$old"* ]]; then
        warn "新目录位于旧目录之下，开机自启请重开 mk 后到「开机自启」关一次再开一次 喵"
        return 1
    fi
    # sed 表达式用 | 作分隔符，路径里出现 | 会破坏替换
    if [[ "$old" == *"|"* || "$new" == *"|"* ]]; then
        warn "路径含特殊字符，开机自启请重开 mk 后到「开机自启」关一次再开一次 喵"
        return 1
    fi

    if [[ -f "$unit" ]] && grep -qF -- "$old" "$unit" 2>/dev/null; then
        if sed -i "s|${old}|${new}|g" "$unit" 2>/dev/null; then
            systemctl daemon-reload >/dev/null 2>&1 || true
            fixed=1
            info "已把开机自启 unit 里的安装路径改为 ${new} 喵"
        else
            warn "改写 ${unit} 失败，请重开 mk 后到「开机自启」关一次再开一次 喵"
        fi
    fi

    if mk_is_termux; then
        boot="$(termux_boot_script_path 2>/dev/null || true)"
        if [[ -n "$boot" && -f "$boot" ]] && grep -qF -- "$old" "$boot" 2>/dev/null; then
            if sed -i "s|${old}|${new}|g" "$boot" 2>/dev/null; then
                fixed=1
                info "已把 Termux 开机自启脚本里的安装路径改为 ${new} 喵"
            else
                warn "改写 ${boot} 失败，请重开 mk 后到「开机自启」关一次再开一次 喵"
            fi
        fi
    fi

    if [[ "$fixed" -eq 1 ]]; then
        # 迁移前已经停过服务，这里按 enabled 状态恢复，免得自启变成「配了但不跑」
        if command -v systemctl >/dev/null 2>&1 \
            && systemctl is-enabled -q "$AUTOSTART_KAKAKE_UNIT" 2>/dev/null; then
            systemctl reset-failed "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
            systemctl restart "$AUTOSTART_KAKAKE_UNIT" >/dev/null 2>&1 || true
        fi
        return 0
    fi

    if autostart_kakake_enabled 2>/dev/null; then
        warn "开机自启仍指向旧目录 ${old}，请重开 mk 后到「开机自启」关一次再开一次 喵"
        return 1
    fi
    return 0
}

menu_kakake_dir() {
    local cur="$KAKAKE_HOME"
    local choice="" new="" ans="" moved=0

    while true; do
        title "咔咔珂安装目录"
        show_nav_hint
        echo "  当前: ${cur}"
        if [[ -n "$KAKAKE_HOME_FROM_ENV" ]]; then
            echo "  来源: 环境变量 KAKAKE_HOME（优先级最高）"
        elif [[ -f "$KAKAKE_HOME_CFG" ]]; then
            echo "  来源: mk 持久配置 ${KAKAKE_HOME_CFG}"
        else
            echo "  来源: 默认 \$HOME/kakake"
        fi
        echo
        echo "  kakake 是绿色便携的：data/、plugins/、log/ 都在安装目录内，"
        echo "  换目录等于整体搬家，放到数据盘就不必占系统盘了。"
        echo
        echo "  [2] 修改安装目录"
        if [[ -f "$KAKAKE_HOME_CFG" ]]; then
            echo "  [3] 恢复默认（\$HOME/kakake）"
        fi
        echo

        read_choice choice
        case "$choice" in
            0|1) return 0 ;;
            2)
                if [[ -n "$KAKAKE_HOME_FROM_ENV" ]]; then
                    warn "当前由环境变量 KAKAKE_HOME 指定，下面改的配置对它无效"
                    echo "  要改请这样启动 mk：sudo KAKAKE_HOME=/新路径 mk"
                    echo
                fi
                read -r -p "  新的安装目录（绝对路径，直接回车取消）: " new
                new="$(printf '%s' "$new" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
                new="${new%/}"
                [[ -n "$new" ]] || continue

                if [[ "$new" != /* ]]; then
                    error "必须填绝对路径（以 / 开头）"
                    continue
                fi
                if [[ "$new" == *[[:space:]]* ]]; then
                    error "路径不要含空格（脚本多处按空格切分参数）"
                    continue
                fi
                # 系统目录根上直接铺 kakake 会污染系统分区，也容易覆盖别人的东西
                case "$new" in
                    /|/bin|/boot|/dev|/etc|/lib|/lib64|/proc|/root|/sbin|/sys|/usr|/var|/tmp)
                        error "不能直接装到 ${new} 这种系统目录根上，请加一级子目录"
                        continue
                        ;;
                    /bin/*|/boot/*|/dev/*|/etc/*|/lib/*|/lib64/*|/proc/*|/sbin/*|/sys/*|/usr/*)
                        error "不能装进系统目录：${new}"
                        continue
                        ;;
                esac
                if [[ -e "$new" && ! -d "$new" ]]; then
                    error "目标已存在，且不是目录：${new}"
                    continue
                fi
                if [[ "$new" == "$cur" ]]; then
                    info "和当前安装目录一样，无需修改"
                    continue
                fi

                # 已装过就问要不要搬家：不搬的话旧 data/plugins 会留在原处
                if kakake_is_installed && [[ -d "$cur" ]]; then
                    echo
                    warn "检测到现有安装：${cur}"
                    echo "  只改目录不会自动搬家，旧的 data/ 与 plugins/ 会留在原处。"
                    read -r -p "  是否把整个目录迁移过去? [y/N]: " ans
                    if [[ "$ans" =~ ^[Yy]$ ]]; then
                        info "先停止正在运行的咔咔珂…"
                        kakake_stop >/dev/null 2>&1 || true
                        if ! mkdir -p "$(dirname "$new")" 2>/dev/null; then
                            error "无法创建上级目录 $(dirname "$new")"
                            continue
                        fi
                        if [[ -d "$new" ]]; then
                            if [[ -z "$(ls -A "$new" 2>/dev/null)" ]]; then
                                # 空目录：删掉再 mv，否则会变成 $new/kakake 多套一层
                                rmdir "$new" 2>/dev/null || true
                            else
                                error "目标目录已存在且不为空：${new}"
                                echo "  请先清空或换一个路径"
                                continue
                            fi
                        fi
                        if ! mv "$cur" "$new" 2>/dev/null; then
                            error "迁移失败（跨分区大目录可能耗时，请检查空间与权限）"
                            continue
                        fi
                        info "已迁移到 ${new} 喵"
                        moved=1
                        # 自启配置里写的是搬家前的绝对路径，不改写就会一直指向已搬走的旧目录
                        kakake_autostart_relink "$cur" "$new"
                    fi
                fi

                if ! mkdir -p "$(dirname "$KAKAKE_HOME_CFG")" 2>/dev/null; then
                    error "无法写入配置目录"
                    continue
                fi
                if ! printf '%s\n' "$new" > "$KAKAKE_HOME_CFG" 2>/dev/null; then
                    error "写入 ${KAKAKE_HOME_CFG} 失败"
                    continue
                fi
                info "安装目录已设为 ${new} 喵"
                if [[ "$moved" -eq 0 ]] && kakake_is_installed; then
                    # 没搬家 = 新目录是空的，下次安装会在这里装出第二份；
                    # 自启仍指着旧目录，装完得重建一次才切得过去
                    warn "旧目录 ${cur} 保留未动，新目录装完后开机自启仍指向它"
                    echo "  装完新目录后，请到「开机自启」关一次再开一次，切到新安装 喵"
                fi
                warn "本会话的 KAKAKE_HOME 已固定，请退出后重新运行 mk 才会生效"
                return 0
                ;;
            3)
                [[ -f "$KAKAKE_HOME_CFG" ]] || continue
                rm -f "$KAKAKE_HOME_CFG" 2>/dev/null
                info "已清除自定义目录，下次启动 mk 回到 ${HOME:-/root}/kakake 喵"
                warn "本会话仍用旧值，请退出重新运行 mk 生效"
                return 0
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_kakake() {
    while true; do
        title "咔咔珂配置 (mk ${MK_VERSION})"
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
        echo "  [12] 安装目录 / 迁移"
        echo

        local choice="" kakake_node_ver="" port="" node_bin="" node_src=""

        if node_bin="$(kakake_resolve_node_bin 2>/dev/null)"; then
            kakake_node_ver="$("$node_bin" -v 2>/dev/null || echo 已安装)"
            node_src="$(kakake_node_source_label)"
        fi

        kakake_status_line
        echo -e "  ${CYAN}* 安装目录: ${KAKAKE_HOME}${NC}"
        if mk_is_termux; then
            echo -e "  ${CYAN}* 运行环境: $(mk_platform_label)${NC}"
        fi
        if kakake_is_installed; then
            echo -e "  ${GREEN}* 安装方式: $(kakake_edition_label)${NC}"
        fi
        if [[ -n "$node_bin" ]]; then
            echo -e "  ${GREEN}* Node.js ${kakake_node_ver} (${node_src})${NC}"
        else
            echo -e "  ${YELLOW}* Node.js 还没装${NC}"
            if kakake_is_portable; then
                echo -e "  ${YELLOW}  → 便携版应自带 runtime/bin/node，帮忙检查一下目录完整性${NC}"
            fi
        fi
        if kakake_is_installed; then
            port="$(kakake_get_admin_port)"
            if kakake_web_built; then
                echo -e "  ${GREEN}* Web UI 已构建 · 端口 ${port}${NC}"
            else
                echo -e "  ${YELLOW}* Web UI 未构建 · 端口 ${port}${NC}"
                if kakake_is_portable; then
                    echo -e "  ${YELLOW}  → 便携版缺 dist，请重新解压完整便携包${NC}"
                else
                    echo -e "  ${YELLOW}  → 选 [10] 构建，或 [5] 启动时会先构建${NC}"
                fi
            fi
        fi
        echo

        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) kakake_do_install
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   return 0
               fi
               press_enter ;;
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
                    warn "便携版 Web UI 已随包提供，无需/无法在此重建 喵"
                    if kakake_web_built; then
                        info "当前 dist 正常: ${KAKAKE_WEB_DIST_INDEX} 喵"
                    else
                        error "少了 packages/web/dist，请重新解压便携包"
                    fi
                else
                    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
                    if [[ -z "$node_bin" ]]; then
                        error "没找到 Node.js，请先安装 Node.js"
                    elif ! kakake_is_installed; then
                        error "咔咔珂还没装"
                    else
                        kakake_ensure_node_tools "$node_bin" || true
                        # 强制重建：清旧 Next/.next + Vite dist，不吞掉失败
                        if ! KAKAKE_FORCE_WEB_BUILD=1 kakake_ensure_web_build "$node_bin"; then
                            error "强制编译失败，看看: ${KAKAKE_LOG}"
                        fi
                    fi
                fi
                press_enter
                ;;
            11) kakake_do_uninstall; press_enter ;;
            12) menu_kakake_dir
                if mk_nav_bubble_up; then
                    MK_GO_HOME=0
                    return 0
                fi
                press_enter ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# ==================== QQ 文件下载 ====================
# 只干一件事：把 QQ 的安装包下载成 /root/QQ.deb —— 不安装、不改配置、不碰别的东西。
# 源用 GitHub 上 zydou/QQ-Linux 的 Releases（不是 QQ 官网），只列 3.2.26 及以上的版本；
# 一个版本里常有好几个 asset（amd64/arm64 的 deb、rpm 之类），按本机架构 + 包类型自己挑。
readonly QQ_DL_REPO="zydou/QQ-Linux"
readonly QQ_DL_MIN_VERSION="3.2.26"
readonly QQ_DL_DIR="/root"
readonly QQ_DL_FILE="${QQ_DL_DIR}/QQ.deb"
readonly QQ_DL_API_URL="https://api.github.com/repos/${QQ_DL_REPO}/releases?per_page=100"
# 小于这个大小就当成「被镜像拦下来的错误页」，不算下载成功
readonly QQ_DL_MIN_BYTES=1048576

QQ_DL_PROXY_INDEX="0"
QQ_DL_TAG=""
QQ_DL_ASSET=""

qq_dl_mirror_labels=(
    "直连 GitHub (国外/可访问 GitHub 的服务器)"
    "gh-proxy.com"
    "gh.catmak.name"
    "ghfast.top"
    "git.yylx.win"
    "ghfile.geekertao.top"
    "gh-proxy.net"
    "j.1win.ggff.net"
    "ghm.078465.xyz"
    "gitproxy.127731.xyz"
    "jiashu.1win.eu.org"
    "github.tbedu.top"
)
qq_dl_mirror_urls=(
    ""
    "https://gh-proxy.com/"
    "https://gh.catmak.name/"
    "https://ghfast.top"
    "https://git.yylx.win/"
    "https://ghfile.geekertao.top"
    "https://gh-proxy.net"
    "https://j.1win.ggff.net"
    "https://ghm.078465.xyz"
    "https://gitproxy.127731.xyz"
    "https://jiashu.1win.eu.org"
    "https://github.tbedu.top"
)

qq_dl_selected_prefix() {
    local idx="${QQ_DL_PROXY_INDEX:-0}"
    if [[ "$idx" =~ ^[0-9]+$ ]] && (( idx >= 0 && idx < ${#qq_dl_mirror_urls[@]} )); then
        printf '%s' "${qq_dl_mirror_urls[$idx]}"
    fi
}

# 本机架构（dpkg 优先，退回 uname）
qq_dl_system_arch() {
    local a=""
    if command -v dpkg >/dev/null 2>&1; then
        a="$(dpkg --print-architecture 2>/dev/null || true)"
    fi
    [[ -n "$a" ]] || a="$(uname -m 2>/dev/null || true)"
    case "$a" in
        x86_64|amd64)        printf '%s' "amd64" ;;
        aarch64|arm64)       printf '%s' "arm64" ;;
        armv7l|armv7|armhf)  printf '%s' "armhf" ;;
        i386|i486|i586|i686) printf '%s' "i386" ;;
        *)                   printf '%s' "${a:-unknown}" ;;
    esac
}

# 本机包类型：有 dpkg 就算 deb 系统，其次 rpm，都没有就按 deb 试
qq_dl_system_pkg() {
    if command -v dpkg >/dev/null 2>&1; then
        printf '%s' "deb"
    elif command -v rpm >/dev/null 2>&1; then
        printf '%s' "rpm"
    else
        printf '%s' "deb"
    fi
}

# asset 名是否对得上本机架构（amd64/x86_64、arm64/aarch64 两种写法都认）
qq_dl_asset_is_arch() {
    local a="$1" arch=""
    arch="$(qq_dl_system_arch)"
    case "$arch" in
        amd64) [[ "$a" == *amd64* || "$a" == *x86_64* || "$a" == *x64* ]] ;;
        arm64) [[ "$a" == *arm64* || "$a" == *aarch64* ]] ;;
        armhf) [[ "$a" == *armhf* || "$a" == *armv7* || "$a" == *armv6* ]] ;;
        i386)  [[ "$a" == *i386* || "$a" == *i486* || "$a" == *i586* || "$a" == *i686* ]] ;;
        *)     [[ "$a" == *"$arch"* ]] ;;
    esac
}

# asset 名里有没有写架构（写了才谈得上「是不是本机的」）
qq_dl_asset_has_arch_token() {
    local a="$1"
    case "$a" in
        *amd64*|*x86_64*|*x64*|*arm64*|*aarch64*|*armhf*|*armv7*|*armv6*|*i386*|*i486*|*i586*|*i686*) return 0 ;;
    esac
    return 1
}

# 在某个版本的 asset 列表里挑一个：
#   1) 本机包类型+本机架构  2) 另一种包类型+本机架构  3) 本机包类型但没标架构  4) 另一种但没标架构
#   5) 最后退到 AppImage 之类非包管理器的产物（本机不一定装得上，但这里只负责下载）
# 明确写了「别的架构」的包不会被选中，避免下错架构
qq_dl_pick_asset() {
    local pkg="" other="" ext="" a="" tier=""
    pkg="$(qq_dl_system_pkg)"
    if [[ "$pkg" == "deb" ]]; then other="rpm"; else other="deb"; fi

    for tier in 1 0; do
        for ext in "$pkg" "$other"; do
            for a in "$@"; do
                [[ "${a,,}" == *".${ext}" ]] || continue
                if (( tier == 1 )); then
                    qq_dl_asset_is_arch "${a,,}" || continue
                else
                    if qq_dl_asset_has_arch_token "${a,,}"; then continue; fi
                fi
                printf '%s' "$a"
                return 0
            done
        done
    done

    for tier in 1 0; do
        for a in "$@"; do
            case "${a,,}" in
                *.appimage) ;;                               # 只认 AppImage 这类，别把 .tar.gz/.sha256 当下错
                *) continue ;;
            esac
            if (( tier == 1 )); then
                qq_dl_asset_is_arch "${a,,}" || continue
            else
                if qq_dl_asset_has_arch_token "${a,,}"; then continue; fi
            fi
            printf '%s' "$a"
            return 0
        done
    done
    return 1
}

# 拉 releases 列表（走选中镜像，失败按整张镜像表兜底），只输出 "<tag>|<asset>"
qq_dl_fetch_releases() {
    local prefix="" api="" resp="" lines=""
    local -a order=()
    local p="" q="" dup=0

    order+=("$(qq_dl_selected_prefix)")
    for p in "${qq_dl_mirror_urls[@]}"; do
        dup=0
        for q in "${order[@]}"; do
            [[ "$q" == "$p" ]] && dup=1
        done
        if (( dup == 0 )); then
            order+=("$p")
        fi
    done

    for prefix in "${order[@]}"; do
        api="$(mk_mirror_join_url "$prefix" "$QQ_DL_API_URL")"
        resp="$(curl -fsSL --max-time 20 \
            -H 'Accept: application/vnd.github+json' \
            -H 'User-Agent: mk-tools' \
            "$api" 2>/dev/null || true)"
        [[ -n "$resp" ]] || continue
        # 只认 releases/download 直链：从 URL 里就能同时还原 tag 和 asset 名
        lines="$(printf '%s\n' "$resp" \
            | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://github\.com/[^"]*/releases/download/[^"]+"' \
            | sed -E 's/^.*"(https:[^"]+)".*$/\1/' \
            | sed -E 's#^.*/releases/download/##' \
            | sed -E 's#^([^/]+)/(.+)$#\1|\2#')"
        [[ -n "$lines" ]] || continue
        printf '%s\n' "$lines"
        return 0
    done
    return 1
}

# 过滤 >= QQ_DL_MIN_VERSION、按版本从新到旧分组，每组挑一个本机可用的 asset
# 输出 "<tag>|<挑中的 asset 名>"；该版本没有可用包时第二段为空
qq_dl_build_list() {
    local line="" tag="" asset="" cur_tag="" picked=""
    local -a cur=()

    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        tag="${line%%|*}"
        asset="${line#*|}"
        [[ -n "$tag" && -n "$asset" && "$asset" != "$line" ]] || continue
        snowluma_ver_ge "$tag" "$QQ_DL_MIN_VERSION" || continue
        if [[ "$tag" != "$cur_tag" ]]; then
            if [[ -n "$cur_tag" ]]; then
                picked="$(qq_dl_pick_asset "${cur[@]}" || true)"
                printf '%s|%s\n' "$cur_tag" "$picked"
            fi
            cur_tag="$tag"
            cur=()
        fi
        cur+=("$asset")
    done < <(qq_dl_fetch_releases | sort -V -r -t'|' -k1,1)
    if [[ -n "$cur_tag" ]]; then
        picked="$(qq_dl_pick_asset "${cur[@]}" || true)"
        printf '%s|%s\n' "$cur_tag" "$picked"
    fi
}

# 选镜像源（带测速）
menu_qq_dl_select_mirror() {
    local i=0 idx=0
    local ms=""
    local do_probe=0
    local probed=0
    local -a lat=()
    QQ_DL_PROXY_INDEX="${QQ_DL_PROXY_INDEX:-0}"

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择 GitHub 镜像源（QQ 下载）"
        show_nav_hint
        echo "  版本列表走 api.github.com、安装包走 github.com，都走这一个镜像"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo
        for ((i=0; i<${#qq_dl_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${qq_dl_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                printf '  [%s] %s  ' "$idx" "${qq_dl_mirror_labels[$i]}"
                ms="$(mk_mirror_latency_ms "$(mk_mirror_join_url "${qq_dl_mirror_urls[$i]}" "$MK_PROBE_TARGET")")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${qq_dl_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#qq_dl_mirror_labels[@]} + 2 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#qq_dl_mirror_labels[@]} + 2 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#qq_dl_mirror_labels[@]} )); then
                        QQ_DL_PROXY_INDEX="$idx"
                        info "已选择: ${qq_dl_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

# 列版本（>= 3.2.26，从新到旧），每个版本后面带上给本机挑的那个 asset
menu_qq_dl_select_version() {
    local line="" i=0 idx=0
    local -a tags=() files=()

    info "正在向 GitHub 拉 QQ 版本列表（只看 >= ${QQ_DL_MIN_VERSION}） 喵"
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        tags+=("${line%%|*}")
        files+=("${line#*|}")
    done < <(qq_dl_build_list)

    if (( ${#tags[@]} == 0 )); then
        error "没取到版本列表（镜像/网络不通，或仓库里没有 >= ${QQ_DL_MIN_VERSION} 的发布版）"
        return 1
    fi

    while true; do
        title "选择 QQ 版本（>= ${QQ_DL_MIN_VERSION}）"
        show_nav_hint
        echo "  本机: $(qq_dl_system_arch) · $(qq_dl_system_pkg) 包 —— 每个版本自动挑对应的 asset"
        echo
        for ((i=0; i<${#tags[@]}; i++)); do
            idx=$((i + 2))
            if [[ -n "${files[$i]:-}" ]]; then
                echo "  [${idx}] ${tags[$i]}  (${files[$i]})"
            else
                echo -e "  [${idx}] ${tags[$i]}  ${RED}这一版没有可下载的安装包${NC}"
            fi
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
                    if (( idx >= 0 && idx < ${#tags[@]} )); then
                        if [[ -z "${files[$idx]:-}" ]]; then
                            warn "这个版本翻不出能下的安装包，换个版本 喵"
                            continue
                        fi
                        QQ_DL_TAG="${tags[$idx]}"
                        QQ_DL_ASSET="${files[$idx]}"
                        info "已选择: QQ ${QQ_DL_TAG} → ${QQ_DL_ASSET} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done
}

# 字节数 → 人看的（纯 bash，不依赖 awk）
qq_dl_human_bytes() {
    local b="${1:-0}" whole=0 frac=0
    [[ "$b" =~ ^[0-9]+$ ]] || b=0
    if (( b >= 1073741824 )); then
        whole=$(( b / 1073741824 ))
        frac=$(( (b % 1073741824) * 100 / 1073741824 ))
        printf '%s.%02d GB' "$whole" "$frac"
    elif (( b >= 1048576 )); then
        whole=$(( b / 1048576 ))
        frac=$(( (b % 1048576) * 10 / 1048576 ))
        printf '%s.%d MB' "$whole" "$frac"
    elif (( b >= 1024 )); then
        printf '%s KB' "$(( b / 1024 ))"
    else
        printf '%s B' "$b"
    fi
}

# 用 HEAD 问一下远端多大（拿不到就返回 0，进度里就不显示百分比）
qq_dl_remote_size() {
    local url="$1" len=""
    len="$(curl -fsSIL --max-time 15 -A 'mk-tools' "$url" 2>/dev/null \
        | tr -d '\r' \
        | grep -i '^content-length:' \
        | tail -n1 \
        | grep -oE '[0-9]+' || true)"
    [[ "$len" =~ ^[0-9]+$ ]] || len=0
    printf '%s' "$len"
}

# 下载中每秒报一次：已下载 / 百分比 / 实时速度 / 已用时间
# 终端里原地刷新同一行；输出被重定向到日志时第 1 秒先打一行、之后每 5 秒一行，不刷屏
qq_dl_show_progress() {
    local pid="$1" file="$2" total="${3:-0}"
    local last=0 now=0 speed=0 sec=0 tty=0 line=""
    if [[ -t 1 ]]; then tty=1; fi
    while kill -0 "$pid" 2>/dev/null; do
        sleep 1
        now="$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]')"
        [[ "$now" =~ ^[0-9]+$ ]] || now=0
        speed=$(( now - last ))
        if (( speed < 0 )); then speed=0; fi
        last="$now"
        sec=$(( sec + 1 ))
        if (( total > 0 )); then
            line="  已下载 $(qq_dl_human_bytes "$now") / $(qq_dl_human_bytes "$total")（$(( now * 100 / total ))%） · 速度 $(qq_dl_human_bytes "$speed")/s · 已用 ${sec}s"
        else
            line="  已下载 $(qq_dl_human_bytes "$now") · 速度 $(qq_dl_human_bytes "$speed")/s · 已用 ${sec}s"
        fi
        if (( tty == 1 )); then
            printf '\r\033[K%s' "$line"
        elif (( sec == 1 || sec % 5 == 0 )); then
            printf '%s\n' "$line"
        fi
    done
    if (( tty == 1 && sec > 0 )); then
        printf '\n'
    fi
}

# 真正下载：后台跑 curl/wget，前台刷新进度（带实时速度）；大文件先落 .part，成了再改名
qq_dl_fetch_file() {
    local url="$1" dest="$2" size=0 total=0 pid=0
    if command -v curl >/dev/null 2>&1; then
        total="$(qq_dl_remote_size "$url")"
        curl -fsSL --connect-timeout 15 --max-time 3600 \
            -A 'mk-tools' -o "$dest" "$url" &
        pid=$!
    elif command -v wget >/dev/null 2>&1; then
        total="$(qq_dl_remote_size "$url")"
        wget -q -O "$dest" "$url" &
        pid=$!
    else
        error "需要 curl 或 wget 才能下载"
        return 1
    fi
    qq_dl_show_progress "$pid" "$dest" "$total"
    if ! wait "$pid"; then
        return 1
    fi
    size=0
    if [[ -f "$dest" ]]; then
        size="$(wc -c < "$dest" 2>/dev/null | tr -d '[:space:]')"
    fi
    [[ "$size" =~ ^[0-9]+$ ]] || size=0
    if (( size < QQ_DL_MIN_BYTES )); then
        warn "只下到 ${size} 字节，不像安装包（可能被镜像拦了），换镜像再试 喵"
        return 1
    fi
    return 0
}

qq_dl_do_download() {
    local tag="$1" asset="$2" prefix="" url="" label="" part="${QQ_DL_FILE}.part" bytes=0
    local -a order=()
    local p="" q="" dup=0

    order+=("$(qq_dl_selected_prefix)")
    for p in "${qq_dl_mirror_urls[@]}"; do
        dup=0
        for q in "${order[@]}"; do
            [[ "$q" == "$p" ]] && dup=1
        done
        if (( dup == 0 )); then
            order+=("$p")
        fi
    done

    require_root || return 1
    mkdir -p "$QQ_DL_DIR" || return 1

    if [[ -f "$QQ_DL_FILE" ]]; then
        local overwrite=""
        read -r -p "${QQ_DL_FILE} 已存在，覆盖它吗? [y/N]: " overwrite
        if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
            info "已取消下载 喵"
            return 0
        fi
    fi

    info "要下的是 QQ ${tag} 的 ${asset} 喵"
    # 下载期间按 Ctrl-C：把半截文件清掉再退出，别留下像是下好了的 QQ.deb
    trap 'rm -f "$part"; trap - INT; exit 130' INT
    for prefix in "${order[@]}"; do
        label="$(mk_mirror_label_of qq_dl_mirror_labels qq_dl_mirror_urls "$prefix")"
        url="$(mk_mirror_join_url "$prefix" "https://github.com/${QQ_DL_REPO}/releases/download/${tag}/${asset}")"
        info "走镜像 ${label} 下载中…（下完只存成 ${QQ_DL_FILE}，不安装） 喵"
        rm -f "$part"
        if qq_dl_fetch_file "$url" "$part"; then
            mv -f "$part" "$QQ_DL_FILE"
            trap - INT
            bytes="$(wc -c < "$QQ_DL_FILE" 2>/dev/null | tr -d '[:space:]')"
            [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
            info "下好啦: ${QQ_DL_FILE}（$(qq_dl_human_bytes "$bytes")，来自 ${label}） 喵"
            return 0
        fi
        warn "这个镜像没下成，换下一个 喵"
    done
    trap - INT
    rm -f "$part"
    error "所有镜像都没下下来"
    return 1
}

menu_qq_download() {
    title "QQ 文件下载（只下载，不安装）"
    echo "  来源: GitHub ${QQ_DL_REPO}（不是 QQ 官网），只列 ${QQ_DL_MIN_VERSION} 及以上的版本"
    echo "  结果: 只下载并保存为 ${QQ_DL_FILE}，不安装、不改配置"
    echo "  下载中会实时显示进度：已下载 / 百分比 / 速度"
    echo
    require_root || return 1

    menu_qq_dl_select_mirror || return 0
    if mk_nav_bubble_up; then
        return 0
    fi
    menu_qq_dl_select_version || return 0
    if mk_nav_bubble_up; then
        return 0
    fi
    qq_dl_do_download "$QQ_DL_TAG" "$QQ_DL_ASSET" || true
    press_enter
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

    info "先去远程瞄一眼版本 喵"
    echo "  远程地址: ${MK_UPDATE_URL}"
    echo "  本地版本: v${local_ver}"
    echo

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        error "curl 和 wget 都不在，小MK没手没脚下载不动"
        return 1
    fi

    if ! mk_update_download "$tmp"; then
        rm -f "$tmp" 2>/dev/null || true
        error "下载失败了…… 网络不通或者地址访问不到，过会儿再试试"
        return 1
    fi

    if ! mk_update_verify "$tmp"; then
        rm -f "$tmp" 2>/dev/null || true
        error "下回来的东西不像一份 mk 脚本（可能被网关换成错误页了），小MK不敢往身上装！"
        return 1
    fi

    remote_ver="$(mk_update_read_version "$tmp" 2>/dev/null || true)"
    info "远程版本: v${remote_ver:-未知}"

    if ! mk_update_remote_is_newer "$remote_ver" "$local_ver"; then
        if [[ "$remote_ver" == "$local_ver" ]]; then
            info "已经是最新的，不用动它喵"
        else
            warn "远程 v${remote_ver:-未知} 不比本地 v${local_ver} 新，小MK就先不折腾了 喵"
        fi
        rm -f "$tmp" 2>/dev/null || true
        return 0
    fi

    echo
    info "嗷！抓到新版本: v${local_ver} → v${remote_ver} 喵"
    echo "  接下来会: 备份当前脚本 → 覆盖安装 → 重建全局命令与自启单元"
    echo
    read -r -p "现在就更新? [y/N]: " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        info "好哒，那这次先不更新 喵"
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
        error "更新途中失败…… 小MK先把旧版本还给你"
        if [[ -n "$bak" && -f "$bak" ]]; then
            cp -f "$bak" "$installed" 2>/dev/null || true
            warn "已经回滚回 v${local_ver}，别怕 喵"
        else
            warn "没找到备份文件，请手动检查: ${installed}"
        fi
        return 1
    fi

    rm -f "$tmp" 2>/dev/null || true

    info "更新成功！v${local_ver} → v${remote_ver} 好耶 喵"
    echo "  备份文件: ${bak:-无}"
    echo "  马上重载新版本"
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
    warn "小MK没找到 fontconfig（fc-list），尝试安装 喵"
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
        "${PREFIX:-/data/data/com.termux/files/usr}/share/fonts"
        /system/fonts
    )
    local d="" found=0
    for d in "${dirs[@]}"; do
        [[ -d "$d" ]] || continue
        while IFS= read -r -d '' f; do
            echo "  文件: $f"
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
            echo -e "  ${GREEN}* 软件包 ${name}: 已装好${NC}"
            return 0
        fi
        echo -e "  ${YELLOW}* 软件包 ${name}: 还没装${NC}"
        return 1
    fi
    if command -v rpm >/dev/null 2>&1; then
        if rpm -q "$name" >/dev/null 2>&1; then
            echo -e "  ${GREEN}* 软件包 ${name}: 已装好${NC}"
            return 0
        fi
        echo -e "  ${YELLOW}* 软件包 ${name}: 还没装${NC}"
        return 1
    fi
    if command -v pacman >/dev/null 2>&1; then
        if pacman -Qi "$name" >/dev/null 2>&1; then
            echo -e "  ${GREEN}* 软件包 ${name}: 已装好${NC}"
            return 0
        fi
        echo -e "  ${YELLOW}* 软件包 ${name}: 还没装${NC}"
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
    echo "  检测结果:"
    if command -v fc-list >/dev/null 2>&1; then
        if families="$(font_scan_fc_zh 2>/dev/null)"; then
            count="$(printf '%s\n' "$families" | grep -c . || true)"
            echo -e "  ${GREEN}* 已小MK发现中文字体族 ${count} 个（fontconfig）${NC}"
            printf '%s\n' "$families" | head -n 12 | while IFS= read -r line; do
                [[ -n "$line" ]] && echo "    - $line"
            done
            if (( count > 12 )); then
                echo "    ... 另有 $((count - 12)) 个未列出"
            fi
        else
            echo -e "  ${YELLOW}* fontconfig 未列出中文字体族${NC}"
        fi
    else
        echo -e "  ${YELLOW}* 还没装 fontconfig（无法用 fc-list 精确检测）${NC}"
    fi

    echo
    echo "  常见软件包:"
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
        echo "  （未识别到 apt/rpm/pacman，跳过软件包检测）"
    fi

    echo
    echo "  mk 手动安装目录: ${FONT_INSTALL_DIR}"
    if [[ -d "$FONT_INSTALL_DIR" ]] && find "$FONT_INSTALL_DIR" -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' \) 2>/dev/null | grep -q .; then
        echo -e "  ${GREEN}* 目录内已有字体文件:${NC}"
        find "$FONT_INSTALL_DIR" -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' \) 2>/dev/null | while IFS= read -r f; do
            echo "    - $f"
        done
    else
        echo -e "  ${YELLOW}* 目录为空或未创建${NC}"
    fi

    echo
    if font_has_cjk; then
        echo -e "  ${GREEN}结论: 系统已具备可用中文字体${NC}"
    else
        echo -e "  ${RED}结论: 未发现中文字体，建议安装（截图/渲染中文可能方块）${NC}"
    fi
}

font_refresh_cache() {
    mkdir -p "$FONT_INSTALL_DIR" 2>/dev/null || true
    if command -v fc-cache >/dev/null 2>&1; then
        info "正在刷新字体缓存 喵"
        fc-cache -fv "$FONT_INSTALL_DIR" >/dev/null 2>&1 || fc-cache -fv || true
        info "字体缓存已刷新 喵"
    else
        warn "无 fc-cache，跳过刷新；新字体可能需重启相关进程后生效 喵"
    fi
}

font_download_to() {
    local url="$1"
    local dest="$2"
    mkdir -p "$(dirname "$dest")" "$LOG_DIR"
    info "下载: $url 喵"
    info "保存: $dest 喵"
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
    error "下载失败，详见: $FONT_LOG"
    return 1
}

font_install_file() {
    local src="$1"
    local name=""
    [[ -f "$src" ]] || { error "文件不存在: $src"; return 1; }
    name="$(basename "$src")"
    mkdir -p "$FONT_INSTALL_DIR"
    cp -f "$src" "${FONT_INSTALL_DIR}/${name}"
    chmod 644 "${FONT_INSTALL_DIR}/${name}" || true
    info "已安装到: ${FONT_INSTALL_DIR}/${name} 喵"
    font_refresh_cache
}

menu_font_select_mirror() {
    local i=0 idx=0
    local ms=""
    local do_probe=0
    local probed=0
    local -a lat=()
    FONT_CUSTOM_URL=""
    FONT_PROXY_INDEX="0"

    if command -v curl >/dev/null 2>&1; then do_probe=1; fi

    while true; do
        title "选择字体下载镜像源"
        show_nav_hint
        echo "  无外网请返回后选「从本地文件安装」"
        echo "  国内服务器访问 GitHub 困难时，请选代理镜像"
        if (( do_probe == 1 )); then
            if (( probed == 0 )); then
                mk_mirror_probe_hint
            else
                mk_mirror_probe_done_hint
            fi
        fi
        echo
        for ((i=0; i<${#font_mirror_labels[@]}; i++)); do
            idx=$((i + 2))
            if (( do_probe == 0 )); then
                echo "  [${idx}] ${font_mirror_labels[$i]}"
            elif (( probed == 0 )); then
                printf '  [%s] %s  ' "$idx" "${font_mirror_labels[$i]}"
                ms="$(mk_mirror_latency_ms "$(mk_mirror_join_url "${font_mirror_urls[$i]}" "$MK_PROBE_TARGET")")"
                lat[$i]="$ms"
                printf '%s\n' "$(mk_mirror_latency_text "$ms")"
            else
                printf '  [%s] %s  %s\n' "$idx" "${font_mirror_labels[$i]}" "$(mk_mirror_latency_text "${lat[$i]:-}")"
            fi
        done
        if (( do_probe == 1 )) && (( probed == 0 )); then
            probed=1
            mk_mirror_probe_warn_if_all_failed "${lat[@]}"
        fi
        echo "  [$(( ${#font_mirror_labels[@]} + 2 ))] 自定义完整下载 URL"
        echo "  [$(( ${#font_mirror_labels[@]} + 3 ))] 重新测速（再测一遍，取更准的；也可以直接按 r）"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 1 ;;
            1) mk_nav_back; return 1 ;;
            *)
                # 重新测速：清掉缓存，回到循环开头重跑一遍
                if [[ "$choice" == "r" || "$choice" == "R" ]] \
                    || { [[ "$choice" =~ ^[0-9]+$ ]] && (( choice == ${#font_mirror_labels[@]} + 3 )); }; then
                    lat=()
                    probed=0
                    continue
                fi
                if [[ "$choice" =~ ^[0-9]+$ ]]; then
                    local custom_idx=$(( ${#font_mirror_labels[@]} + 2 ))
                    if (( choice == custom_idx )); then
                        local url=""
                        read -r -p "请粘贴字体文件完整 URL:" url </dev/tty 2>/dev/null || read -r -p "请粘贴字体文件完整 URL: " url
                        url="${url#"${url%%[![:space:]]*}"}"
                        url="${url%"${url##*[![:space:]]}"}"
                        if [[ -z "$url" ]]; then
                            warn "URL 为空 喵"
                            continue
                        fi
                        FONT_CUSTOM_URL="$url"
                        FONT_PROXY_INDEX="0"
                        info "已使用自定义 URL 喵"
                        return 0
                    fi
                    idx=$((choice - 2))
                    if (( idx >= 0 && idx < ${#font_mirror_labels[@]} )); then
                        FONT_PROXY_INDEX="$idx"
                        FONT_CUSTOM_URL=""
                        info "已选择: ${font_mirror_labels[$idx]} 喵"
                        return 0
                    fi
                fi
                warn "无法识别该选项，请重新输入 喵"
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
            error "未知字体类型: $kind"
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
        error "下载文件为空"
        rm -f "$tmp"
        return 1
    fi
    if head -c 200 "$tmp" 2>/dev/null | grep -qiE '<html|<!DOCTYPE'; then
        error "下载内容像网页而非字体文件，请换镜像或自定义 URL"
        rm -f "$tmp"
        return 1
    fi
    mkdir -p "$FONT_INSTALL_DIR"
    mv -f "$tmp" "$dest"
    chmod 644 "$dest" || true
    info "字体文件已经准备好啦: $dest 喵"
    font_refresh_cache
    echo
    font_show_status
}

font_install_via_packages() {
    require_root || return 1
    info "通过系统软件源安装中文字体（走本机 apt/yum 镜像，适合已配国内源的机器） 喵"
    echo
    local ok=0
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq || true
        if apt-get install -y fonts-wqy-microhei fonts-noto-cjk; then
            ok=1
        else
            warn "完整套装失败，尝试仅安装文泉驿 喵"
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
        error "未识别到 apt / dnf / yum / pacman，请改用下载安装或本地文件"
        return 1
    fi

    font_ensure_fc || true
    font_refresh_cache
    echo
    font_show_status
    if (( ok == 1 )) || font_has_cjk; then
        info "软件源安装流程结束 喵"
        return 0
    fi
    error "软件源安装可能失败（仓库无包或无外网）。可改用镜像下载，或把字体文件拷到服务器后「从本地文件安装」"
    return 1
}

font_install_from_local() {
    require_root || return 1
    local path=""
    echo "  支持 .ttf / .otf / .ttc；可先 scp 到服务器再填写路径"
    echo "  例: /root/wqy-microhei.ttc"
    echo
    read -r -p "本地字体文件路径:" path </dev/tty 2>/dev/null || read -r -p "本地字体文件路径: " path
    path="${path#"${path%%[![:space:]]*}"}"
    path="${path%"${path##*[![:space:]]}"}"
    path="${path%\"}"
    path="${path#\"}"
    if [[ "$path" == "~/"* ]]; then
        path="${HOME}/${path:2}"
    fi
    if [[ -z "$path" || ! -f "$path" ]]; then
        error "无法识别路径: ${path:-"(空)"}"
        return 1
    fi
    if [[ ! "$path" =~ \.(ttf|otf|ttc|TTF|OTF|TTC)$ ]]; then
        warn "扩展名不像字体文件，仍将尝试安装 喵"
    fi
    font_install_file "$path"
    echo
    font_show_status
}

menu_fonts() {
    while true; do
        title "字体包操作"
        show_nav_hint
        if font_has_cjk; then
            echo -e "  ${GREEN}* 状态: 已小MK发现中文字体${NC}"
        else
            echo -e "  ${YELLOW}* 状态: 小MK没找到中文字体（截图/中文渲染可能异常）${NC}"
        fi
        echo
        echo "  [2] 扫描检测中文字体"
        echo "  [3] 软件源一键安装（apt/yum，走系统镜像）"
        echo "  [4] 下载安装 文泉驿微米黑（体积较小）"
        echo "  [5] 下载安装 Noto Sans CJK SC（覆盖更好）"
        echo "  [6] 从本地文件安装（无外网 / 自备字体）"
        echo "  [7] 刷新字体缓存（fc-cache）"
        echo
        echo "  说明: [4]/[5] 可选国内代理或自定义 URL；完全断网请用 [6]"
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
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
        if mk_nav_bubble_up; then
            return 0
        fi
    done
}

# ==================== 字体检测（Termux 手机：仅检测不安装） ====================

# 手机端只读检测：不写系统目录、不装字体、不需要 root。
font_show_status_termux() {
    local families="" count=0
    echo "  检测结果:"
    if command -v fc-list >/dev/null 2>&1; then
        if families="$(font_scan_fc_zh 2>/dev/null)"; then
            count="$(printf '%s\n' "$families" | grep -c . || true)"
            echo -e "  ${GREEN}* fontconfig 发现中文字体族 ${count} 个${NC}"
            printf '%s\n' "$families" | head -n 12 | while IFS= read -r line; do
                [[ -n "$line" ]] && echo "    - $line"
            done
            if (( count > 12 )); then
                echo "    ... 另有 $((count - 12)) 个未列出"
            fi
        else
            echo -e "  ${YELLOW}* fontconfig 未列出中文字体族${NC}"
        fi
    else
        echo -e "  ${YELLOW}* 未装 fontconfig（无法用 fc-list 精确检测）；如需可自行 pkg install fontconfig-utils${NC}"
    fi

    echo
    echo "  字体文件扫描（/system/fonts、\$PREFIX/share/fonts、~/.fonts 等）:"
    if ! font_scan_files; then
        echo -e "  ${YELLOW}* 上述目录未匹配到常见 CJK 字体文件名${NC}"
    fi

    echo
    if font_has_cjk; then
        echo -e "  ${GREEN}结论: 当前环境已具备可用中文字体${NC}"
    else
        echo -e "  ${YELLOW}结论: 未按常见名匹配到中文字体；安卓系统通常自带 CJK（可能只是名称没命中），一般属正常${NC}"
    fi
}

menu_fonts_termux() {
    while true; do
        title "字体检测"
        show_nav_hint
        if font_has_cjk; then
            echo -e "  ${GREEN}* 状态: 已小MK发现中文字体${NC}"
        else
            echo -e "  ${YELLOW}* 状态: 暂未按常见名匹配到中文字体${NC}"
        fi
        echo
        echo "  [2] 扫描检测中文字体"
        echo
        echo "  说明: 手机端只检测、不安装，不写系统目录、也不需要 root"
        echo "        安装字体请在电脑/服务器上用完整的「字体包操作」"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2)
                font_show_status_termux
                press_enter
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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
    echo -e "  $(printf '%-6s' "$port")  占用:${listen_text}  连接:${conn_text}  防火墙:${fw_text}  mk:${cfg_text}"
}

port_scan_mk_ports() {
    local -a ports=()
    local p="" choice=""

    mapfile -t ports < <(port_collect_mk_ports)
    if [[ ${#ports[@]} -eq 0 ]]; then
        warn "没找到 mk 相关端口 喵"
        return 0
    fi

    title "mk 相关端口扫描 (共 ${#ports[@]} 个)"
    echo "  端口    占用        连接      防火墙      mk配置"
    echo "  --------------------------------------------------------------"
    for p in "${ports[@]}"; do
        port_show_verify_summary "$p"
    done
    echo
    info "端口列表: ${ports[*]} 喵"
    echo
    read -r -p "输入端口号查看详情 (直接回车返回):" choice
    choice="${choice//$'\r'/}"
    if [[ -n "$choice" ]] && port_is_valid "$choice"; then
        echo
        port_show_verify_report "$choice"
    fi
}

port_list_all_listeners() {
    local line="" proto="" state="" local_addr="" port="" host="" proc="" pid=""

    title "本机全部监听端口"
    if ! command -v ss >/dev/null 2>&1; then
        error "需要 ss 命令，无法列出端口"
        return 1
    fi

    echo -e "  ${BOLD}端口    协议        状态      监听地址              进程${NC}"
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
    info "共上表为当前监听/还没连上 UDP 端口；输入具体端口号可查看详情 喵"
}

port_verify_ports_input() {
    local raw="$1" p="" first=1
    raw="${raw//,/ }"
    raw="${raw//;/ }"
    raw="${raw//|/ }"

    for p in $raw; do
        if ! port_is_valid "$p"; then
            warn "跳过无法识别端口: ${p} 喵"
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
    [[ "$first" -eq 1 ]] && warn "没有有效的端口号 喵"
}

port_show_config_refs() {
    local port="$1"
    local found=0 addr="" cat="" name=""

    if [[ -f "${KAKAKE_CONNECTIONS_FILE:-}" ]] \
        && grep -qE "\"port\"[[:space:]]*:[[:space:]]*${port}([,}]|[[:space:]]*[,}])" "${KAKAKE_CONNECTIONS_FILE}" 2>/dev/null; then
        name="$(grep -E "\"port\"[[:space:]]*:[[:space:]]*${port}" "${KAKAKE_CONNECTIONS_FILE}" 2>/dev/null | head -1 | sed -n 's/.*\"name\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p')"
        echo "  咔咔珂连接配置: ${name:-未命名} (端口 ${port})"
        found=1
    fi

    if declare -f napcat_cfg_tool >/dev/null 2>&1; then
        while IFS=$'\t' read -r _ _ name addr _ cat; do
            [[ -z "$addr" ]] && continue
            if [[ "$(port_parse_addr_port "$addr")" == "$port" ]]; then
                echo "  NapCat 网络配置: ${name} (${cat}) -> ${addr}"
                found=1
            fi
        done < <(napcat_cfg_tool list 2>/dev/null || true)
    fi

    if [[ "$port" == "$KAKAKE_ADMIN_PORT" ]]; then
        echo "  咔咔珂控制台默认端口 ${KAKAKE_ADMIN_PORT}"
        found=1
    fi

    if [[ "$found" -eq 0 ]]; then
        echo "  mk 管理的配置中未发现此端口"
    fi
}

port_firewall_check() {
    local port="$1"
    local found=0 ufw_status="" ufw_active=0

    if command -v ufw >/dev/null 2>&1; then
        ufw_status="$(ufw status 2>/dev/null || true)"
        if echo "$ufw_status" | grep -qi inactive; then
            echo "  ufw: 已安装但未启用 (通常不拦截入站)"
        else
            ufw_active=1
            if echo "$ufw_status" | grep -qE "(^|[[:space:]])${port}/tcp([[:space:]]|$)"; then
                echo -e "  ufw: ${GREEN}已放行 TCP ${port}${NC}"
                found=1
            elif echo "$ufw_status" | grep -qE "(^|[[:space:]])${port}([[:space:]]|$)"; then
                echo -e "  ufw: ${GREEN}已放行 ${port}${NC}"
                found=1
            else
                echo -e "  ufw: ${YELLOW}未放行 TCP ${port}${NC}"
            fi
            if iptables -L ufw-user-input -n 2>/dev/null | grep -qE "dpt:${port}[[:space:]]"; then
                echo -e "  ufw 规则链: ${GREEN}存在 ${port} 入站规则${NC}"
                found=1
            fi
        fi
    fi

    if command -v firewall-cmd >/dev/null 2>&1; then
        local fw_ports=""
        fw_ports="$(firewall-cmd --list-ports 2>/dev/null || true)"
        if echo " $fw_ports " | grep -qE " ${port}/tcp "; then
            echo -e "  firewalld: ${GREEN}已放行 TCP ${port}${NC}"
            found=1
        elif echo " $fw_ports " | grep -qE " ${port}/udp "; then
            echo -e "  firewalld: ${GREEN}已放行 UDP ${port}${NC}"
            found=1
        else
            echo -e "  firewalld: ${YELLOW}未放行 ${port}${NC}"
        fi
    fi

    if command -v iptables >/dev/null 2>&1; then
        if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
            echo -e "  iptables INPUT: ${GREEN}已放行 TCP ${port}${NC}"
            found=1
        elif iptables -L INPUT -n 2>/dev/null | grep -qE "dpt:${port}([[:space:]]|$)"; then
            echo -e "  iptables INPUT: ${GREEN}存在 ${port} 相关规则${NC}"
            found=1
        elif [[ "$ufw_active" -eq 0 ]]; then
            echo -e "  iptables: ${YELLOW}没找到 ${port} 放行规则${NC}"
        fi
    fi

    if command -v nft >/dev/null 2>&1; then
        local port_hex=""
        port_hex="$(port_to_proc_hex "$port")"
        if nft list ruleset 2>/dev/null | grep -qE "dport[[:space:]]*(${port}|0x${port_hex}|${port_hex})"; then
            echo -e "  nftables: ${GREEN}存在 ${port} 相关规则${NC}"
            found=1
        fi
    fi

    if [[ "$found" -eq 0 ]] \
        && ! command -v ufw >/dev/null 2>&1 \
        && ! command -v firewall-cmd >/dev/null 2>&1 \
        && ! command -v iptables >/dev/null 2>&1 \
        && ! command -v nft >/dev/null 2>&1; then
        echo "  小MK没找到 ufw / firewalld / iptables / nftables"
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
            echo "  协议:     $(port_translate_proto "$proto")"
            echo "  状态:     $(port_translate_state "$state")"
            echo "  监听地址: $(port_translate_addr "$host") (${local_addr})"
            echo "  进程:     $(port_translate_process "$proc")"
            [[ -n "$pid" ]] && echo "  进程 ID:  ${pid}"
            if [[ "$proc" == "未知" && $EUID -ne 0 ]]; then
                if mk_is_termux; then
                    echo "  提示:     安卓限制，只能看到 Termux 自己的进程（sudo 也无法识别）"
                else
                    echo "  提示:     使用 sudo mk 可查看其他用户进程"
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
            echo "  协议:     ${proto^^}"
            echo "  状态:     监听中"
            echo "  监听地址: ${local_addr}"
            echo "  进程:     $(port_translate_process "$proc")"
            echo "  进程 ID:  ${pid}"
            echo "  ---"
        done < <(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1'; lsof -nP -iUDP:"${port}" 2>/dev/null | awk 'NR>1'; lsof -nP -i:"${port}" 2>/dev/null | awk 'NR>1' || true)
    fi

    if [[ "$has_listener" -eq 0 ]] && port_proc_has_listener "$port"; then
        has_listener=1
        echo -e "  ${GREEN}内核显示端口 ${port} 已被占用${NC}"
        echo "  说明: 小MK发现 /proc/net 中有此端口，但未能解析进程名"
        if mk_is_termux; then
            echo "  说明: 安卓不开放其他应用的进程信息，看不到进程名是正常的"
        elif [[ $EUID -ne 0 ]]; then
            echo "  建议: 使用 sudo mk 或 sudo ss -tulnp | grep :${port}"
        fi
    fi

    if [[ "$has_listener" -eq 0 ]]; then
        echo -e "  ${YELLOW}当前没有进程监听此端口${NC}"
        if port_has_established "$port"; then
            echo "  说明: 无监听，但存在指向此端口的已建立连接"
        else
            echo "  说明: 端口可能空闲，或服务尚还没跑起来"
        fi
    fi
}

port_show_connections() {
    local port="$1"
    local line="" state="" count=0
    declare -A state_map=()

    if ! command -v ss >/dev/null 2>&1; then
        echo "  无法统计 (少了 ss 命令)"
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
        echo "  当前无 TCP 连接记录"
        return 0
    fi

    echo "  TCP 连接总数: ${count}"
    for state in "${!state_map[@]}"; do
        echo "    $(port_translate_state "$state"): ${state_map[$state]} 条"
    done
}

port_show_verify_report() {
    local port="$1"
    local hint="" listening=0 established=0

    title "端口 ${port} 验证结果"

    listening=0
    established=0
    port_is_listening "$port" && listening=1
    port_has_established "$port" && established=1

    echo -e "${BOLD}【端口概览】${NC}"
    if [[ "$listening" -eq 1 ]]; then
        echo -e "  占用状态: ${GREEN}使用中 (有程序正在跟踪)${NC}"
    elif [[ "$established" -eq 1 ]]; then
        echo -e "  占用状态: ${YELLOW}有连接活动 (无监听，可能是出站连接)${NC}"
    else
        echo -e "  占用状态: ${YELLOW}未发现监听或连接${NC}"
    fi
    if hint="$(port_guess_service_hint "$port" 2>/dev/null)"; then
        echo "  ${hint}"
    fi
    echo

    echo -e "${BOLD}【mk 配置关联】${NC}"
    port_show_config_refs "$port"
    echo

    echo -e "${BOLD}【监听详情】${NC}"
    port_show_listeners "$port"
    echo

    echo -e "${BOLD}【连接统计】${NC}"
    port_show_connections "$port"
    echo

    echo -e "${BOLD}【本机防火墙】${NC}"
    port_firewall_check "$port"
    echo

    warn "云服务商「安全组」无法在此检测，外网访问失败时请去控制台放行 喵"
    if mk_is_termux; then
        info "手动验证: ss -tulnp '( sport = :${port} )'  或  cat /proc/net/tcp 喵"
    else
        info "手动验证: ss -tulnp '( sport = :${port} )'  或  sudo lsof -i :${port} 喵"
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
        error "无法识别进程 ID: ${pid}"
        return 1
    fi
    if [[ "$pid" -eq 1 ]]; then
        error "拒绝杀掉 PID 1 (init/systemd)"
        return 1
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
        warn "进程 ${pid} 已不存在 喵"
        return 0
    fi

    info "正在结束进程 ${pid}${name:+ (${name})} 喵"
    kill "$pid" 2>/dev/null || true
    sleep 0.4
    if kill -0 "$pid" 2>/dev/null; then
        warn "进程未退出，发送 SIGKILL 喵"
        kill -9 "$pid" 2>/dev/null || true
        sleep 0.2
    fi
    if kill -0 "$pid" 2>/dev/null; then
        if mk_is_termux; then
            error "无法结束进程 ${pid}：安卓只允许结束 Termux 自己的进程"
        else
            error "无法结束进程 ${pid}，可能需要 sudo mk"
        fi
        return 1
    fi
    info "已结束进程 ${pid} 喵"
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

    title "杀掉进程"
    if mk_is_termux; then
        warn "安卓限制：只能结束 Termux 自己启动的进程，其他 App 的进程动不了 喵"
    elif [[ $EUID -ne 0 ]]; then
        warn "当前非 root，可能无法结束其他用户的进程（建议 sudo mk） 喵"
    fi
    echo
    read -r -p "请输入要清理的端口号:" port
    port="${port//$'\r'/}"
    port="${port#"${port%%[![:space:]]*}"}"
    port="${port%"${port##*[![:space:]]}"}"

    if [[ -z "$port" ]]; then
        warn "未输入端口 喵"
        return 0
    fi
    if ! port_is_valid "$port"; then
        error "无法识别端口: ${port}"
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

        title "端口 ${port} 占用进程"
        if [[ ${#pids[@]} -eq 0 ]]; then
            info "端口 ${port} 当前没有可识别的占用进程 喵"
            if mk_is_termux; then
                echo "  提示: 安卓看不到其他 App 的进程，这里只统计 Termux 内的进程"
            elif [[ $EUID -ne 0 ]]; then
                echo "  提示: 使用 sudo mk 可查看更多进程信息"
            fi
            return 0
        fi

        echo -e "  ${BOLD}序号  PID       协议        状态          地址                    进程${NC}"
        echo "  --------------------------------------------------------------------------------"
        for i in "${!pids[@]}"; do
            seq="$(port_kill_index_to_seq "$i")"
            echo -e "  $(printf '%-4s' "[${seq}]")  $(printf '%-8s' "${pids[$i]}")  $(printf '%-10s' "$(port_translate_proto "${protos[$i]}")")  $(printf '%-12s' "$(port_translate_state "${states[$i]}")")  $(printf '%-22s' "${addrs[$i]}")  $(port_translate_process "${procs[$i]}")"
        done
        echo
        echo -e "  ${YELLOW}[2] 全部杀掉${NC}"
        echo "  输入上方序列号杀掉对应进程；输入 2 全部杀掉；输入 q 返回"
        echo

        read -r -p "请选择:" choice
        choice="$(normalize_choice "${choice:-}")"

        if [[ -z "$choice" || "$choice" == "q" || "$choice" == "Q" ]]; then
            return 0
        fi

        if [[ "$choice" == "2" ]]; then
            echo
            warn "即将结束端口 ${port} 上的全部 ${#pids[@]} 个进程 喵"
            read -r -p "确认全部杀掉? [y/N]: " choice
            choice="$(normalize_choice "${choice:-}")"
            if [[ "${choice,,}" != "y" && "${choice,,}" != "yes" ]]; then
                info "已经取消 喵"
                continue
            fi
            for i in "${!pids[@]}"; do
                port_kill_one_pid "${pids[$i]}" "${procs[$i]}" || true
            done
            echo
            info "已尝试结束全部进程，重新检测占用 喵"
            sleep 0.3
            continue
        fi

        if idx="$(port_kill_seq_to_index "$choice")"; then
            if (( idx < 0 || idx >= ${#pids[@]} )); then
                warn "序号不存在: ${choice} 喵"
                continue
            fi
            echo
            port_kill_one_pid "${pids[$idx]}" "${procs[$idx]}" || true
            echo
            info "重新检测端口 ${port} 占用 喵"
            sleep 0.3
            continue
        fi

        warn "无法识别输入，请输入列表中的序列号，或输入 2 全部杀掉 喵"
    done
}

menu_port_verify() {
    while true; do
        title "端口验证"
        show_nav_hint
        echo "  [2] 扫描 mk 相关端口 (NapCat/咔咔珂/宝塔等，自动)"
        echo "  [3] 列出本机全部监听端口"
        echo "  [4] 杀掉进程 (按端口列出并可结束)"
        echo
        echo "  也可直接输入端口号 (任意 1-65535，支持多个):"
        echo "  示例: 8700  或  3001,8787,6099  或  8080 9000"
        echo "  输入 q 返回上一步，0 返回首页"
        echo

        local port_input=""
        read -r -p "选项或端口号:" port_input
        port_input="${port_input//$'\r'/}"
        port_input="${port_input#"${port_input%%[![:space:]]*}"}"
        port_input="${port_input%"${port_input##*[![:space:]]}"}"

        case "$port_input" in
            0) mk_nav_home; return 0 ;;
            q|Q) return 0 ;;
            "") warn "请输入选项或端口号 喵"; continue ;;
            2) port_scan_mk_ports; press_enter ;;
            3) port_list_all_listeners; press_enter ;;
            4) port_kill_process_flow; press_enter ;;
            *)
                if [[ "$port_input" =~ ^[0-9]+$ ]] && port_is_valid "$port_input"; then
                    port_show_verify_report "$port_input"
                elif [[ "$port_input" =~ [0-9] ]]; then
                    port_verify_ports_input "$port_input"
                else
                    warn "无法识别输入，请输入 [2]/[3]/[4]、端口号或多个端口 喵"
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
            echo -e "  ${GREEN}* Node.js ${ver} (满足构建要求 20+)${NC}"
        else
            echo -e "  ${YELLOW}* Node.js ${ver} (版本过低，需要 20+)${NC}"
        fi
    else
        echo -e "  ${YELLOW}* Node.js 还没装 (构建需要 Node 20+)${NC}"
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
        printf '%s' "$MK_CLEAR_LINE"
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
    echo "  MKbot 源码构建"
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
    error "编译失败，关键出错信息:"
    echo "$content" | grep -E '\[MK-MKBOT-ERROR\]|npm ERR!| ELIFECYCLE |Error:|error TS|command not found' | tail -20 || true
    echo
    info "完整日志: ${MKBOT_BUILD_LOG} 喵"
}

mkbot_watch_build() {
    local last_percent=-1 spinner=('|' '/' '-' '+') spin_idx=0
    local result="" stage="" percent=0 state=""
    local start_ts="" now_ts="" elapsed=0 panel_active=0

    if ! mkbot_build_running; then
        warn "当前没有进行中的构建任务 喵"
        return 1
    fi

    start_ts="$(mkbot_get_build_start_time)"
    echo
    info "正在构建 MK 插件源码 (后台进程 $(cat "$MKBOT_BUILD_PID" 2>/dev/null || echo ?))"
    info "日志: ${MKBOT_BUILD_LOG} 喵"
    echo

    trap 'echo; info "已退出进度显示，构建仍在后台继续 喵"; trap - INT; return 0' INT

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
        info "构建成功 喵"
        echo "  成品目录: ${out}"
        echo "  入口文件: ${out}/index.mjs"
        echo "  插件清单: ${out}/plugin.json"
        echo
        info "可将 ${MKBOT_OUT_SUBDIR} 目录部署到 NapCat/咔咔珂 插件目录 喵"
    else
        warn "构建进程已结束，但没找到预期成品目录 喵"
        info "帮忙检查一下: ${MKBOT_BUILD_LOG} 喵"
        return 1
    fi
    return 0
}

mkbot_start_build() {
    local src_root="$1"
    local node_bin="" node_path=""

    if mkbot_build_running; then
        warn "已有构建任务进行中 喵"
        mkbot_watch_build
        return $?
    fi

    node_bin="$(mkbot_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        error "没找到 Node.js，请先「安装 Node.js」(需要 20+)"
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

    info "开始构建: ${src_root} 喵"

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
    read -r -p "MK 插件源码路径 (含 package.json 的目录):" raw
    raw="$(mkbot_normalize_path "$raw")"
    [[ -n "$raw" ]] || {
        warn "路径不能为空 喵"
        return 0
    }

    if ! src_root="$(mkbot_find_project_root "$raw")"; then
        error "未识别为 MKbot 源码目录: ${raw}"
        echo "  请指向解压后的 MK 目录 (含 package.json 与 vite.config.ts)"
        echo "  若解压为 MKbot.zip/MK/ 则路径可填上级或 MK 子目录"
        return 1
    fi

    if [[ "$src_root" != "$raw" ]]; then
        info "已识别源码根目录: ${src_root} 喵"
    fi

    mkbot_start_build "$src_root"
}

menu_mkbot_build() {
    while true; do
        title "构建 MK 源码"
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
            echo -e "  ${YELLOW}* 正在后台努力编译${NC}"
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
                    warn "当前没有构建任务 喵"
                fi
                ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
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
        echo -e "${NC}还没装${NC}"
        return
    fi
    if ! autostart_napcat_enabled; then
        echo -e "${NC}还没打开${NC}"
        return
    fi
    if napcat_is_running; then
        echo -e "${GREEN}运行中${NC}"
        return
    fi
    if autostart_unit_failed "$AUTOSTART_NAPCAT_UNIT"; then
        echo -e "${RED}启动失败了${NC}"
        return
    fi
    echo -e "${RED}未运行${NC}"
}

autostart_kakake_status_colored() {
    if ! kakake_is_installed; then
        echo -e "${NC}还没装${NC}"
        return
    fi
    if ! autostart_kakake_enabled; then
        echo -e "${NC}还没打开${NC}"
        return
    fi
    if kakake_http_alive "$(kakake_get_admin_port)"; then
        if kakake_has_any_connected; then
            echo -e "${GREEN}运行中${NC}"
        else
            echo -e "${YELLOW}没有连上的客户端${NC}"
        fi
        return
    fi
    if kakake_has_process || kakake_port_listening "$(kakake_get_admin_port)"; then
        echo -e "${RED}被别的东西占着${NC}"
        return
    fi
    if autostart_unit_failed "$AUTOSTART_KAKAKE_UNIT"; then
        echo -e "${RED}启动失败了${NC}"
        return
    fi
    echo -e "${RED}未运行${NC}"
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
        error "NapCat 还没装，请先安装框架"
        return 1
    fi
    napcat_detect_paths || return 1
    if ! napcat_ensure_xvfb; then
        error "少了 xvfb-run，无法配置 NapCat 开机自启"
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
        info "NapCat 开机自启已经打开，当前运行中 喵"
        napcat_open_port_6099
        return 0
    fi
    if autostart_unit_failed "$AUTOSTART_NAPCAT_UNIT"; then
        error "NapCat 开机自启已写入，但启动失败了，看看: ${NAPCAT_LOG}"
        journalctl -u "$AUTOSTART_NAPCAT_UNIT" -n 10 --no-pager 2>/dev/null || true
        return 1
    fi
    warn "NapCat 开机自启已经打开，服务正在拉起中 喵"
}

# Termux 版「开机自启」：安卓没有 systemd，靠 Termux:Boot 应用在开机时
# 执行 ~/.termux/boot/ 下的脚本，效果等价于一个极简的 service。
autostart_kakake_enable_termux() {
    local node_bin="" node_path="" entry="" boot_script=""

    if ! kakake_is_installed; then
        error "咔咔珂还没装，请先安装咔咔珂"
        return 1
    fi
    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
        error "没找到 Node.js，请先「安装 Node.js」"
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
export KAKAKE_MANAGED_RELAUNCH=1

mkdir -p "${LOG_DIR}"
cd "${KAKAKE_HOME}" || exit 1

# 服务端堆上限（跨平台一致；Termux / 小内存默认 1024MB，其余 2048MB）
export NODE_OPTIONS="$(kakake_server_node_options)"

echo "===== Kakake boot \$(date '+%Y-%m-%d %H:%M:%S') (Termux:Boot) =====" >> "${KAKAKE_LOG}"
# 受管重启循环：退出码 86 = 应用暂存更新后重启；其它码正常结束
nohup bash -c 'applier="${KAKAKE_HOME}/scripts/apply-update.mjs"; while :; do "${node_bin}" "${entry}"; st=\$?; if [ "\$st" = "86" ]; then [ -f "\$applier" ] && "${node_bin}" "\$applier" || true; continue; fi; exit "\$st"; done' >> "${KAKAKE_LOG}" 2>&1 &
echo \$! > "${KAKAKE_PID_FILE}"
EOF

    chmod 700 "$boot_script"

    info "咔咔珂开机自启已经打开啦（Termux:Boot） 喵"
    echo
    echo "  自启脚本: ${boot_script}"
    echo "  运行日志: ${KAKAKE_LOG}"
    echo
    warn "开机自启还需要满足下面 3 个条件，缺一个就不会生效： 喵"
    echo "  1) 已安装 Termux:Boot 应用（与 Termux 同一来源，F-Droid 或 GitHub）"
    echo "  2) 装好后手动打开过一次 Termux:Boot（不打开不会注册开机广播）"
    echo "  3) 系统设置里给 Termux / Termux:Boot 关闭电池优化、允许自启动"
    echo
    if ! kakake_http_alive "$(kakake_get_admin_port)"; then
        info "当前咔咔珂未运行，是否立即启动一次？ 喵"
        local now=""
        read -r -p "现在启动? [Y/n]: " now
        if [[ ! "$now" =~ ^[Nn]$ ]]; then
            kakake_start || return 1
        fi
    else
        info "咔咔珂当前已在运行 喵"
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
        error "咔咔珂还没装，请先安装咔咔珂"
        return 1
    fi
    node_bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
        if kakake_is_portable; then
            error "便携版少了 runtime/bin/node"
        else
            error "没找到 Node.js，请先安装 Node.js"
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
Environment=KAKAKE_MANAGED_RELAUNCH=1
Environment="NODE_OPTIONS=$(kakake_server_node_options)"
WorkingDirectory=${KAKAKE_HOME}
ExecStartPre=/bin/mkdir -p ${LOG_DIR}
ExecStart=/bin/bash -c 'applier="${KAKAKE_HOME}/scripts/apply-update.mjs"; while :; do "${node_bin}" "${entry}"; st=\$?; if [ "\$st" = "86" ]; then [ -f "\$applier" ] && "${node_bin}" "\$applier" || true; continue; fi; exit "\$st"; done'
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
        info "咔咔珂开机自启已经打开，当前运行中 ($(kakake_edition_label)) 喵"
        kakake_open_admin_port
        kakake_show_login_info
        return 0
    fi
    if kakake_has_process; then
        warn "咔咔珂开机自启已经打开，进程在拉起中（可能正在编译），等小MK一下下查看日志: ${KAKAKE_LOG} 喵"
        return 0
    fi
    if autostart_unit_failed "$AUTOSTART_KAKAKE_UNIT"; then
        error "咔咔珂开机自启已写入，但启动失败了，看看: ${KAKAKE_LOG}"
        journalctl -u "$AUTOSTART_KAKAKE_UNIT" -n 10 --no-pager 2>/dev/null || true
        return 1
    fi
    warn "咔咔珂开机自启已经打开，服务正在拉起中 喵"
}

autostart_toggle_napcat() {
    if autostart_napcat_enabled; then
        autostart_napcat_disable
        info "NapCat 开机自启已关闭 喵"
        return 0
    fi
    autostart_napcat_enable
}

autostart_toggle_kakake() {
    if autostart_kakake_enabled; then
        autostart_kakake_disable
        info "咔咔珂开机自启已关闭 喵"
        return 0
    fi
    autostart_kakake_enable
}

menu_autostart() {
    while true; do
        title "开机自启"
        show_nav_hint
        if mk_is_termux; then
            echo -e "  [2] kakake开机自启   $(autostart_kakake_status_colored)"
            echo
            echo "  当前环境: $(mk_platform_label) · 无 systemd，自启由 Termux:Boot 承担"
            echo "  选择 [2] 开启/关闭（已开启时再次选择则关闭）"
            echo "  NapCat 自启仅限 Linux 服务器，手机上不提供"
        else
            echo -e "  [1] NapCat开机自启  $(autostart_napcat_status_colored)"
            echo -e "  [2] kakake开机自启   $(autostart_kakake_status_colored)"
            echo
            echo "  选择序号开启/关闭自启（已开启时再次选择则关闭）"
        fi
        echo "  颜色: 白=未开启  绿=运行中  红=失败  黄=咔咔珂没有连上的客户端"
        echo

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1)
                if mk_is_termux; then
                    warn "手机上没有 NapCat 自启，请选 [2] 喵"
                else
                    autostart_toggle_napcat || true
                    press_enter
                fi
                ;;
            2) autostart_toggle_kakake || true; press_enter ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

menu_uninstall() {
    title "卸载 mk 工具"
    echo "  此操作将移除 mk 全局命令及安装文件"
    echo "  宝塔面板本身不会被卸载"
    echo
    uninstall_self
    press_enter
    exit 0
}

# ==================== Docker 操作 ====================
# 统一的 Docker 管理入口：安装/卸载引擎、启停服务、看容器、看端口与本机访问地址。
# 仅限 Linux 服务器（依赖内核特性 + root），Termux 上由主菜单拦截。

docker_is_installed() { command -v docker >/dev/null 2>&1; }

# 引擎装了且守护进程能连上（能跑 docker ps 才算真正可用）
docker_daemon_ok() {
    docker_is_installed || return 1
    docker info >/dev/null 2>&1
}

docker_version_str() {
    docker_is_installed || { printf '%s' "未安装"; return 0; }
    docker --version 2>/dev/null | sed 's/,.*$//' || printf '%s' "已安装"
}

docker_ensure_curl() {
    command -v curl >/dev/null 2>&1 && return 0
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y >/dev/null 2>&1 || true
        apt-get install -y curl >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y curl >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum install -y curl >/dev/null 2>&1 || true
    fi
    command -v curl >/dev/null 2>&1
}

# 手动注入 Docker 引擎的 apt 镜像源（腾讯云/华为云/清华/中科大等），再 apt-get 安装。
# 适用于 apt/deb 系（Ubuntu/Debian）；非 apt 系请用官方脚本安装。
docker_install_apt_source() {
    local root="$1"
    local distro="" codename=""
    if [[ -r /etc/os-release ]]; then
        . /etc/os-release 2>/dev/null || true
        codename="${VERSION_CODENAME:-}"
        case "${ID:-}" in
            ubuntu|linuxmint|neon|pop) distro="ubuntu" ;;
            debian) distro="debian" ;;
            *) distro="ubuntu" ;;
        esac
    fi
    if [[ -z "$codename" ]]; then
        codename="$(lsb_release -cs 2>/dev/null || true)"
    fi
    if [[ -z "$codename" ]]; then
        error "无法探测系统发行代号（VERSION_CODENAME），请改用官方脚本安装 Docker"
        return 1
    fi
    if ! command -v dpkg >/dev/null 2>&1; then
        error "当前系统不是 apt/deb 系（没有 dpkg），请改用官方脚本安装 Docker"
        return 1
    fi
    install -m 0755 -d /etc/apt/keyrings
    info "写入 Docker apt 镜像源: ${root}/${distro} (${codename}) 喵"
    if ! curl -fsSL "${root}/${distro}/gpg" -o /etc/apt/keyrings/docker.asc; then
        error "下载 GPG key 失败: ${root}/${distro}/gpg"
        return 1
    fi
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] ${root}/${distro} ${codename} stable" > /etc/apt/sources.list.d/docker.list
    apt-get update >/dev/null
}

docker_install() {
    require_root || return 1
    if docker_is_installed; then
        local re=""
        info "Docker 已装好: $(docker_version_str) 喵"
        read -r -p "是否重新运行官方安装脚本? [y/N]: " re
        [[ "$re" =~ ^[Yy]$ ]] || return 0
    fi

    title "安装 Docker"
    # 引擎 apt 镜像源：官方脚本（默认）/ 阿里云（--mirror）/ 各云厂商 apt 源（手动注入）
    local -a eng_labels=(
        "官方脚本 get.docker.com（默认；海外/能连通 Docker 官方时）"
        "官方脚本 + 阿里云镜像源（国内推荐）"
        "腾讯云镜像源（apt，手动注入）"
        "华为云镜像源（apt，手动注入）"
        "清华 TUNA 镜像源（apt，手动注入）"
        "中科大 USTC 镜像源（apt，手动注入）"
    )
    local -a eng_kind=( script aliyun apt apt apt apt )
    local -a eng_repo=(
        ""
        ""
        "https://mirrors.cloud.tencent.com/docker-ce/linux"
        "https://repo.huaweicloud.com/docker-ce/linux"
        "https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux"
        "https://mirrors.ustc.edu.cn/docker-ce/linux"
    )
    local n="${#eng_labels[@]}" ch="" idx=-1
    while true; do
        for ((i=0; i<n; i++)); do
            echo "  [$((i+1))] ${eng_labels[$i]}"
        done
        echo "  [0] 取消"
        echo
        read_choice ch
        case "$ch" in
            0|"") info "已取消 喵"; return 0 ;;
            *)
                if [[ "$ch" =~ ^[0-9]+$ ]] && (( ch>=1 && ch<=n )); then
                    idx=$((ch-1)); break
                fi
                warn "无法识别该选项，请重新输入 喵"
                ;;
        esac
    done

    if ! docker_ensure_curl; then
        error "没有 curl 且自动安装失败，请先装 curl 再来"
        return 1
    fi

    local tmp="${MK_TMP}/get-docker.sh"
    case "${eng_kind[$idx]}" in
        script|aliyun)
            mkdir -p "$MK_TMP"
            info "下载 Docker 官方安装脚本 喵"
            if ! curl -fsSL https://get.docker.com -o "$tmp"; then
                error "下载安装脚本失败，请检查网络"
                return 1
            fi
            info "开始安装（可能要几分钟） 喵"
            if [[ "${eng_kind[$idx]}" == "aliyun" ]]; then
                sh "$tmp" --mirror "Aliyun" || { error "安装失败"; rm -f "$tmp"; return 1; }
            else
                sh "$tmp" || { error "安装失败"; rm -f "$tmp"; return 1; }
            fi
            rm -f "$tmp"
            ;;
        apt)
            if ! docker_install_apt_source "${eng_repo[$idx]}"; then
                return 1
            fi
            info "开始安装（可能要几分钟） 喵"
            DEBIAN_FRONTEND=noninteractive apt-get -y install \
                ca-certificates curl docker-ce docker-ce-cli containerd.io \
                docker-compose-plugin docker-ce-rootless-extras docker-buildx-plugin \
                docker-model-plugin >/dev/null \
                || { error "apt 安装 Docker 失败，请检查网络或源的发行代号是否匹配"; return 1; }
            ;;
    esac

    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable --now docker >/dev/null 2>&1 || true
    fi

    if docker_daemon_ok; then
        info "Docker 装好并已启动: $(docker_version_str) 喵"
    elif docker_is_installed; then
        warn "Docker 已装好，但服务似乎没起来，可选 [4] 启动服务 或 systemctl start docker 喵"
    else
        error "装完还是没有 docker 命令，请手动排查"
        return 1
    fi
}

docker_uninstall() {
    require_root || return 1
    if ! docker_is_installed; then
        info "Docker 本来就没装 喵"
        return 0
    fi
    title "卸载 Docker"
    warn "高风险：这会移除 Docker 引擎，运行中的容器会被停掉 喵"
    echo "  受影响软件包：docker-ce / docker-ce-cli / containerd.io 等"
    echo
    local c=""
    read -r -p "确认卸载 Docker? [y/N]: " c
    [[ "$c" =~ ^[Yy]$ ]] || { info "已取消 喵"; return 0; }
    local wipe=""
    read -r -p "是否同时删除全部镜像/容器/卷 (/var/lib/docker，不可逆)? [y/N]: " wipe

    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop docker docker.socket >/dev/null 2>&1 || true
        systemctl disable docker >/dev/null 2>&1 || true
    fi

    if command -v apt-get >/dev/null 2>&1; then
        apt-get remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
            docker-compose-plugin docker.io docker docker-engine >/dev/null 2>&1 || true
        apt-get autoremove -y >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
        dnf remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        yum remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1 || true
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Rns --noconfirm docker >/dev/null 2>&1 || true
    elif command -v zypper >/dev/null 2>&1; then
        zypper remove -y docker >/dev/null 2>&1 || true
    fi

    if [[ "$wipe" =~ ^[Yy]$ ]]; then
        rm -rf /var/lib/docker /var/lib/containerd 2>/dev/null || true
        info "已删除 /var/lib/docker 数据 喵"
    fi
    info "Docker 卸载完成 喵"
}

# 管理 systemd 下的 docker 服务：$1=start|stop|restart $2=中文动作名
docker_service_action() {
    local act="$1" label="$2"
    if ! docker_is_installed; then
        error "Docker 还没装，先选 [2] 安装"
        return 1
    fi
    require_root || return 1
    if ! command -v systemctl >/dev/null 2>&1; then
        error "没有 systemctl，无法管理 Docker 服务"
        return 1
    fi
    if systemctl "$act" docker; then
        info "Docker 服务已${label} 喵"
    else
        error "${label} Docker 失败，可看 journalctl -u docker"
        return 1
    fi
}

docker_list_containers() {
    docker_daemon_ok || { error "Docker 没在运行，先启动服务"; return 1; }
    title "Docker 容器列表（全部）"
    local any=0 name state status image color
    while IFS='|' read -r name state status image; do
        [[ -n "$name" ]] || continue
        any=1
        case "$state" in
            running) color="$GREEN" ;;
            paused)  color="$CYAN" ;;
            *)       color="$YELLOW" ;;
        esac
        echo -e "  ${color}● ${name}${NC}"
        echo -e "      状态: ${color}${status}${NC}"
        echo    "      镜像: ${image}"
        echo
    done < <(docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}' 2>/dev/null)
    if (( any == 0 )); then
        echo "  (还没有任何容器)"
        echo
    fi
    echo -e "  ${GREEN}●绿=运行中${NC} ${CYAN}●青=已暂停${NC} ${YELLOW}●黄=已停止${NC}；端口/访问地址请用 [9]"
}

docker_show_usage() {
    docker_daemon_ok || { error "Docker 没在运行"; return 1; }
    title "Docker 资源使用"
    echo "== 运行中容器 CPU / 内存 / 网络 (快照) =="
    docker stats --no-stream \
        --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}' 2>/dev/null \
        || warn "拿不到 stats（可能没有运行中的容器） 喵"
    echo
    echo "== 磁盘占用 (镜像/容器/卷/缓存) =="
    docker system df 2>/dev/null || true
}

# 从容器名解析发布到宿主机的端口：输出每行 "HostIp|HostPort|容器端口/协议"
docker_container_bindings() {
    docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{range $conf}}{{.HostIp}}|{{.HostPort}}|{{$p}}{{"\n"}}{{end}}{{end}}{{end}}' "$1" 2>/dev/null || true
}

docker_show_ports() {
    docker_daemon_ok || { error "Docker 没在运行"; return 1; }
    local lan_ip pub_ip any name lines hip hport cport bind_desc proto
    lan_ip="$(snowluma_bindable_ip)"
    pub_ip="$(napcat_get_server_ip)"
    title "Docker 外放端口 / 本机访问地址"
    echo "  局域网/本机 IP: ${lan_ip:-未探测到}"
    echo "  公网/出口   IP: ${pub_ip:-未探测到}"
    echo "  (只列真正发布到宿主机的端口；http:// 链接可直接点开，非网页服务忽略即可)"
    echo
    any=0
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        lines="$(docker_container_bindings "$name")"
        [[ -n "$lines" ]] || continue
        any=1
        echo -e "  ${BOLD}${CYAN}● ${name}${NC}"
        while IFS='|' read -r hip hport cport; do
            [[ -n "$hport" ]] || continue
            proto="${cport##*/}"
            case "$hip" in
                0.0.0.0|"") bind_desc="所有网卡" ;;
                ::)         bind_desc="所有网卡(IPv6)" ;;
                127.0.0.1|::1) bind_desc="仅本机" ;;
                *)          bind_desc="$hip" ;;
            esac
            if [[ "$proto" == "tcp" && ( "$hip" == "127.0.0.1" || "$hip" == "::1" ) ]]; then
                echo "      ${cport}  绑定:${bind_desc}  → http://127.0.0.1:${hport}/"
            elif [[ "$proto" == "tcp" ]]; then
                echo "      ${cport}  绑定:${bind_desc}  → http://${lan_ip:-本机IP}:${hport}/   公网 http://${pub_ip:-出口IP}:${hport}/"
            else
                echo "      ${cport}  绑定:${bind_desc}  宿主端口:${hport} (${proto})"
            fi
        done <<< "$lines"
        echo
    done < <(docker ps --format '{{.Names}}' 2>/dev/null)
    if (( any == 0 )); then
        echo "  (当前没有正在运行、且发布了端口的容器)"
    fi
    echo "  绑定「仅本机」的端口外部访问不到；需要对外时改容器的 -p 映射或加反代"
}

docker_container_op() {
    docker_daemon_ok || { error "Docker 没在运行"; return 1; }
    title "容器 启动/停止/重启/暂停/恢复"
    docker ps -a --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || true
    echo
    local name="" act=""
    read -r -p "输入容器名/ID (直接回车返回):" name
    [[ -n "$name" ]] || return 0
    echo "  [1] 启动 start"
    echo "  [2] 停止 stop"
    echo "  [3] 重启 restart"
    echo "  [4] 暂停 pause"
    echo "  [5] 恢复 unpause"
    read_choice act
    case "$act" in
        1) docker start "$name"   && info "已启动 ${name}" || error "操作失败" ;;
        2) docker stop "$name"    && info "已停止 ${name}" || error "操作失败" ;;
        3) docker restart "$name" && info "已重启 ${name}" || error "操作失败" ;;
        4) docker pause "$name"   && info "已暂停 ${name}" || error "操作失败" ;;
        5) docker unpause "$name" && info "已恢复 ${name}" || error "操作失败" ;;
        *) warn "无法识别该选项 喵" ;;
    esac
}

docker_container_remove() {
    docker_daemon_ok || { error "Docker 没在运行"; return 1; }
    title "删除容器（高风险）"
    docker ps -a --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || true
    echo
    local name="" c=""
    read -r -p "输入要删除的容器名/ID (直接回车返回):" name
    [[ -n "$name" ]] || return 0
    warn "删除不可逆：容器内未挂卷持久化的数据会一起没 喵"
    read -r -p "确认删除 ${name}? [y/N]: " c
    [[ "$c" =~ ^[Yy]$ ]] || { info "已取消 喵"; return 0; }
    docker rm -f "$name" && info "已删除 ${name}" || error "删除失败"
}

menu_docker() {
    while true; do
        title "Docker 操作"
        show_nav_hint
        if docker_is_installed; then
            if docker_daemon_ok; then
                echo -e "  ${GREEN}* $(docker_version_str) · 服务运行中${NC}"
            else
                echo -e "  ${YELLOW}* $(docker_version_str) · 服务未运行（可选 [4] 启动）${NC}"
            fi
        else
            echo -e "  ${YELLOW}* Docker 还没装，选 [2] 一键安装${NC}"
        fi
        echo
        echo "  [2] 安装 Docker（官方脚本，可选国内镜像源）啦"
        echo "  [3] 卸载 Docker啦"
        echo "  [4] 启动 Docker 服务啦"
        echo "  [5] 停止 Docker 服务啦"
        echo "  [6] 重启 Docker 服务啦"
        echo "  [7] 查看容器列表啦"
        echo "  [8] 查看资源使用 (CPU/内存/磁盘)啦"
        echo "  [9] 查看外放端口 / 本机访问地址啦"
        echo "  [10] 容器 启动/停止/重启/暂停/恢复啦"
        echo "  [11] 删除容器啦"
        echo
        local choice=""
        read_choice choice
        case "$choice" in
            0) mk_nav_home; return 0 ;;
            1) mk_nav_back; return 0 ;;
            2) docker_install || true; press_enter ;;
            3) docker_uninstall || true; press_enter ;;
            4) docker_service_action start 启动 || true; press_enter ;;
            5) docker_service_action stop 停止 || true; press_enter ;;
            6) docker_service_action restart 重启 || true; press_enter ;;
            7) docker_list_containers || true; press_enter ;;
            8) docker_show_usage || true; press_enter ;;
            9) docker_show_ports || true; press_enter ;;
            10) docker_container_op || true; press_enter ;;
            11) docker_container_remove || true; press_enter ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

# ==================== 性能体检 ====================
# 机器到底能不能跑得动咔咔珂 / SnowLuma / QQ，光看「几核几 G」不准：
# 云厂商超售、容器配额、/tmp 是不是内存盘、磁盘 IO 都会让标称配置大打折扣。
# 这里把排查时最有用的几项做成菜单，一项一项跑，能看几项看几项。
# 命令在精简镜像 / 安卓上不一定齐全，所以每项都自带降级，不做整套失败。

# 各单项跑过时把关键指标写进来，供 perf_verdict 做汇总评定。
# 单项跳过时保持为空，汇总时按「没测到就不参与判定」处理。
PERF_CPU_CORES=""
PERF_BENCH_MS=""
PERF_STEAL_MAX=""
PERF_CGROUP_CORES=""
PERF_DISK_MBPS=""
PERF_MEM_TOTAL_MB=""
PERF_MEM_AVAIL_MB=""

perf_has() { command -v "$1" >/dev/null 2>&1; }

perf_section() {
    echo
    echo -e "  ${CYAN}── ${1}${NC}"
    echo "  --------------------------------------------------------------"
}

perf_skip() {
    echo -e "    ${YELLOW}${1}${NC}"
}

# 找一个能用的 node：优先咔咔珂自带 / mk 管理的，再回落系统
perf_node_bin() {
    local bin=""
    bin="$(kakake_resolve_node_bin 2>/dev/null || true)"
    if [[ -n "$bin" && -x "$bin" ]]; then
        printf '%s' "$bin"
        return 0
    fi
    if perf_has node; then
        printf '%s' "$(command -v node 2>/dev/null || true)"
        return 0
    fi
    return 1
}

perf_cpu_info() {
    perf_section "CPU 型号 / 主频 / 核数"
    if perf_has lscpu; then
        lscpu 2>/dev/null \
            | grep -E 'Model name|Vendor ID|CPU\(s\)|Thread\(s\) per core|Core\(s\) per socket|Socket\(s\)|CPU MHz|CPU max MHz|CPU min MHz' \
            || perf_skip "lscpu 有输出但没匹配到字段"
    elif [[ -r /proc/cpuinfo ]]; then
        local model="" cores=""
        model="$(grep -m1 -E 'model name|Hardware' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || true)"
        cores="$(grep -c ^processor /proc/cpuinfo 2>/dev/null || true)"
        echo "    型号    : ${model:-未知}"
        echo "    逻辑核数: ${cores:-未知}"
        [[ "$cores" =~ ^[0-9]+$ ]] && PERF_CPU_CORES="$cores"
        perf_skip "没有 lscpu，只从 /proc/cpuinfo 取到这些"
    else
        perf_skip "没有 lscpu 也读不到 /proc/cpuinfo，跳过"
    fi
    # lscpu 分支：把 CPU(s) 记下来供汇总
    if [[ -z "$PERF_CPU_CORES" ]] && perf_has lscpu; then
        local n=""
        n="$(lscpu 2>/dev/null | grep -E '^CPU\(s\):' | awk '{print $2}' || true)"
        [[ "$n" =~ ^[0-9]+$ ]] && PERF_CPU_CORES="$n"
    fi
    return 0
}

perf_cpu_steal() {
    perf_section "宿主机超售（st 列，>5% 要警惕）"
    if ! perf_has vmstat; then
        perf_skip "没有 vmstat（精简镜像常见），跳过"
        return 0
    fi
    info "采样 5 次、间隔 1 秒，大概要等 5 秒 喵"
    local out=""
    out="$(vmstat 1 5 2>/dev/null || true)"
    if [[ -z "$out" ]]; then
        perf_skip "vmstat 没输出，跳过"
        return 0
    fi
    printf '%s\n' "$out" | sed 's/^/    /'
    # st 是最后一列，跳过两行表头
    local st_list st_max st_avg
    st_list="$(printf '%s\n' "$out" | tail -n +3 | awk '{print $NF}' | grep -E '^[0-9]+$' || true)"
    if [[ -n "$st_list" ]]; then
        st_max="$(printf '%s\n' "$st_list" | sort -n | tail -1)"
        st_avg="$(printf '%s\n' "$st_list" | awk '{s+=$1} END{printf "%d", (NR?s/NR:0)}')"
        [[ "$st_max" =~ ^[0-9]+$ ]] && PERF_STEAL_MAX="$st_max"
        echo
        echo "    st 峰值: ${st_max}%   均值: ${st_avg}%"
        if (( st_max > 5 )); then
            echo -e "    解读: ${RED}st 超过 5%，宿主机大概率超售了，算力会被邻居抢走${NC}"
        else
            echo -e "    解读: ${GREEN}st 正常，没看到明显超售${NC}"
        fi
    fi
    return 0
}

perf_cgroup_quota() {
    perf_section "cgroup CPU 配额（容器化环境）"
    local v2="/sys/fs/cgroup/cpu.max"
    local v1q="/sys/fs/cgroup/cpu/cpu.cfs_quota_us"
    local v1p="/sys/fs/cgroup/cpu/cpu.cfs_period_us"
    local quota="" period=""

    if [[ -r "$v2" ]]; then
        IFS=' ' read -r quota period < "$v2" 2>/dev/null || true
        echo "    cpu.max: ${quota:-?} ${period:-?}   (cgroup v2)"
    elif [[ -r "$v1q" && -r "$v1p" ]]; then
        quota="$(tr -d '[:space:]' < "$v1q" 2>/dev/null || true)"
        period="$(tr -d '[:space:]' < "$v1p" 2>/dev/null || true)"
        echo "    cfs_quota_us: ${quota:-?}   cfs_period_us: ${period:-?}   (cgroup v1)"
    else
        perf_skip "没读到 cgroup 配额（多半不是容器，或没暴露 cgroupfs）"
        return 0
    fi

    if [[ "$quota" == "max" || "$quota" == "-1" ]]; then
        echo -e "    解读: ${GREEN}无 CPU 上限${NC} —— 能吃到宿主机全部空闲算力"
    elif [[ "$quota" =~ ^[0-9]+$ && "$period" =~ ^[0-9]+$ && "$period" -gt 0 ]]; then
        local cores
        cores="$(awk -v q="$quota" -v p="$period" 'BEGIN{printf "%.2f", q/p}')"
        PERF_CGROUP_CORES="$cores"
        echo -e "    解读: ${YELLOW}上限约 ${cores} 核${NC} —— 跑分和核数都要按这个数看"
    fi
    return 0
}

perf_tmp_fs() {
    perf_section "/tmp 是不是内存盘"
    if ! perf_has df; then
        perf_skip "没有 df，跳过"
        return 0
    fi
    local out line fstype
    out="$(df -hT /tmp 2>/dev/null || true)"
    if [[ -z "$out" ]]; then
        perf_skip "df 没输出，跳过"
        return 0
    fi
    printf '%s\n' "$out" | sed 's/^/    /'
    line="$(printf '%s\n' "$out" | tail -1 || true)"
    fstype="$(printf '%s' "$line" | awk '{print $2}')"
    echo
    if [[ "$fstype" == "tmpfs" ]]; then
        echo -e "    解读: /tmp 是 ${GREEN}tmpfs（内存盘）${NC} —— 写很快但吃内存，重启即清空"
    else
        echo "    解读: /tmp 落在 ${fstype:-未知}（磁盘），写入速度受磁盘 IO 限制"
    fi
    return 0
}

perf_disk_write() {
    perf_section "磁盘写入速度（写 200MB 到 ${MK_TMP}）"
    local f="${MK_TMP}/mk-ddtest.$$"
    # 空间不够就别硬写，免得把机器写满
    local avail_mb=""
    if perf_has df; then
        avail_mb="$(df -Pm "$MK_TMP" 2>/dev/null | tail -1 | awk '{print $4}' || true)"
        if [[ "$avail_mb" =~ ^[0-9]+$ ]] && (( avail_mb < 400 )); then
            perf_skip "剩余空间只有 ${avail_mb}MB，不够写 200MB 测试文件，跳过"
            return 0
        fi
    fi

    info "正在写 200MB，稍等一下 喵"
    local out=""
    # oflag=direct 绕过页缓存，才测得到真实落盘速度；不支持的文件系统再降级
    out="$(dd if=/dev/zero of="$f" bs=1M count=200 oflag=direct 2>&1 || true)"
    if [[ -z "$out" || "$out" == *nvalid* || "$out" == *nsupported* ]]; then
        info "这个文件系统不支持 oflag=direct，改用普通写入 + fsync 喵"
        out="$(dd if=/dev/zero of="$f" bs=1M count=200 conv=fsync 2>&1 || true)"
    fi
    rm -f "$f" 2>/dev/null || true

    if [[ -z "$out" ]]; then
        perf_skip "dd 没输出，跳过"
        return 0
    fi
    printf '%s\n' "$out" | tail -1 | sed 's/^/    /'
    # 抠出速度值换算成 MB/s，供汇总判定（dd 可能是 kB/s / MB/s / GB/s）
    local rate unit num
    rate="$(printf '%s\n' "$out" | grep -oE '[0-9]+([.][0-9]+)? [kKmMgG]?B/s' | tail -1 || true)"
    if [[ -n "$rate" ]]; then
        num="$(printf '%s' "$rate" | awk '{print $1}')"
        unit="$(printf '%s' "$rate" | awk '{print $2}')"
        case "${unit^^}" in
            KB/S)  PERF_DISK_MBPS="$(awk -v n="$num" 'BEGIN{printf "%d", n/1024}')" ;;
            MB/S)  PERF_DISK_MBPS="$(awk -v n="$num" 'BEGIN{printf "%d", n}')" ;;
            GB/S)  PERF_DISK_MBPS="$(awk -v n="$num" 'BEGIN{printf "%d", n*1024}')" ;;
            B/S)   PERF_DISK_MBPS="$(awk -v n="$num" 'BEGIN{printf "%d", n/1048576}')" ;;
        esac
    fi
    return 0
}

perf_cpu_bench() {
    perf_section "CPU 单核跑分（node 纯计算 3 亿次累加）"
    local node_bin=""
    node_bin="$(perf_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        perf_skip "没找到 node，跳过（可在咔咔珂菜单 [3] 装 Node.js）"
        return 0
    fi
    echo "    node: ${node_bin} ($("$node_bin" -v 2>/dev/null || echo 版本未知))"
    info "跑起来了，几秒到十几秒 喵"
    local start end ms
    start="$(date +%s%N 2>/dev/null || echo 0)"
    "$node_bin" -e 'let s=0;for(let i=0;i<3e8;i++)s+=i;console.log(s)' 2>&1 | tail -1 | sed 's/^/    结果: /'
    end="$(date +%s%N 2>/dev/null || echo 0)"
    if [[ "$start" =~ ^[0-9]+$ && "$end" =~ ^[0-9]+$ && "$end" -gt "$start" ]]; then
        ms=$(( (end - start) / 1000000 ))
        PERF_BENCH_MS="$ms"
        echo
        echo "    耗时: ${ms} ms（含 node 启动开销）"
        # 只作粗参考：不同架构/Node 版本差异很大
        if (( ms < 1500 )); then
            echo -e "    参考: ${GREEN}很快${NC}，单核算力充裕"
        elif (( ms < 3000 )); then
            echo -e "    参考: ${GREEN}正常${NC}，够跑咔咔珂 + 一个 QQ"
        elif (( ms < 6000 )); then
            echo -e "    参考: ${YELLOW}偏慢${NC}，多开或图片处理会吃力"
        else
            echo -e "    参考: ${RED}很慢${NC}，建议查超售 / cgroup 配额，或减少并发"
        fi
    fi
    return 0
}

perf_sharp_version() {
    perf_section "Node / sharp / libvips 版本"
    local node_bin=""
    node_bin="$(perf_node_bin 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
        perf_skip "没找到 node，跳过"
        return 0
    fi
    echo "    node   : $("$node_bin" -v 2>/dev/null || echo 未知)"
    # sharp 只在咔咔珂安装目录里才 require 得到，换目录跑会报找不到模块
    local v=""
    if [[ -d "$KAKAKE_HOME" ]]; then
        v="$(cd "$KAKAKE_HOME" 2>/dev/null && "$node_bin" -e "console.log(require('sharp').versions.vips)" 2>/dev/null | tail -1 || true)"
    fi
    if [[ -n "$v" && "$v" != *"Cannot find"* ]]; then
        echo "    libvips: ${v}"
        echo "    （咔咔珂的图片处理走 sharp/libvips，版本过旧可能在 ARM 上编译失败）"
    else
        perf_skip "没读到 sharp —— 咔咔珂未安装，或该环境没装 sharp 依赖"
    fi
    return 0
}

perf_memory() {
    perf_section "内存与 swap"
    # 数值统一从 /proc/meminfo 取（kB），free -h 只作展示，避免解析人类可读单位
    if [[ -r /proc/meminfo ]]; then
        local kb=""
        kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || true)"
        [[ "$kb" =~ ^[0-9]+$ ]] && PERF_MEM_TOTAL_MB=$(( kb / 1024 ))
        kb="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || true)"
        [[ "$kb" =~ ^[0-9]+$ ]] && PERF_MEM_AVAIL_MB=$(( kb / 1024 ))
    fi
    if perf_has free; then
        free -h 2>/dev/null | sed 's/^/    /' || perf_skip "free 执行失败"
    elif [[ -r /proc/meminfo ]]; then
        grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo 2>/dev/null | sed 's/^/    /' || true
        perf_skip "没有 free，从 /proc/meminfo 取"
    else
        perf_skip "没有 free 也读不到 /proc/meminfo，跳过"
    fi
    if perf_has swapon; then
        echo
        local sw=""
        sw="$(swapon --show 2>/dev/null || true)"
        if [[ -n "$sw" ]]; then
            printf '%s\n' "$sw" | sed 's/^/    /'
        else
            echo "    （无 swap）"
        fi
    fi
    return 0
}

# 汇总评定：把上面跑出来的指标收拢成一句「这机器能跑什么、瓶颈在哪」。
# 没测到的项不参与判定，所以命令不全时结论会相应保守，但不至于给错方向。
perf_verdict() {
    echo
    echo -e "  ${BOLD}══════ 体检结论 ══════${NC}"
    echo "  --------------------------------------------------------------"

    # —— 可用核数：容器里以配额为准，裸机用逻辑核 ——
    local cores_val="" cores_label=""
    if [[ -n "$PERF_CGROUP_CORES" ]]; then
        cores_val="$PERF_CGROUP_CORES"; cores_label="cgroup 配额"
    elif [[ -n "$PERF_CPU_CORES" ]]; then
        cores_val="$PERF_CPU_CORES"; cores_label="CPU 逻辑核"
    fi

    # —— 单核算力分档 ——
    local bench_txt="未测到（需要 node）" cpu_rank="" cpu_ms=""
    if [[ "$PERF_BENCH_MS" =~ ^[0-9]+$ ]]; then
        cpu_ms="$PERF_BENCH_MS"
        bench_txt="${PERF_BENCH_MS} ms"
        if   (( cpu_ms < 1500 )); then cpu_rank="很快"
        elif (( cpu_ms < 3000 )); then cpu_rank="正常"
        elif (( cpu_ms < 6000 )); then cpu_rank="偏慢"
        else cpu_rank="很慢"; fi
    fi

    # —— 内存 ——
    local mem_txt="未测到" mem_gb=0
    if [[ "$PERF_MEM_TOTAL_MB" =~ ^[0-9]+$ ]]; then
        mem_gb=$(( PERF_MEM_TOTAL_MB / 1024 ))
        mem_txt="${PERF_MEM_TOTAL_MB} MB（约 ${mem_gb} GB）"
        if [[ "$PERF_MEM_AVAIL_MB" =~ ^[0-9]+$ ]]; then
            mem_txt="${mem_txt}，当前可用 $(( PERF_MEM_AVAIL_MB / 1024 )) GB"
        fi
    fi

    local disk_txt="未测到"
    [[ "$PERF_DISK_MBPS" =~ ^[0-9]+$ ]] && disk_txt="${PERF_DISK_MBPS} MB/s"
    local steal_txt="未测到"
    [[ "$PERF_STEAL_MAX" =~ ^[0-9]+$ ]] && steal_txt="st 峰值 ${PERF_STEAL_MAX}%"

    echo "    单核算力 : ${bench_txt}${cpu_rank:+  （${cpu_rank}）}"
    echo "    可用核数 : ${cores_val:-未测到}${cores_label:+  （${cores_label}）}"
    echo "    内存     : ${mem_txt}"
    echo "    磁盘写速 : ${disk_txt}"
    echo "    宿主超售 : ${steal_txt}"
    echo

    # —— 瓶颈：按「最该先解决」排序，只报最主要的一个 ——
    local bottleneck="无明显瓶颈"
    if [[ "$PERF_STEAL_MAX" =~ ^[0-9]+$ ]] && (( PERF_STEAL_MAX > 5 )); then
        bottleneck="宿主机超售（st ${PERF_STEAL_MAX}%）—— 加配置没用，换机器最直接"
    elif [[ -n "$PERF_CGROUP_CORES" ]] \
         && (( $(awk -v c="$PERF_CGROUP_CORES" 'BEGIN{print (c<2)?1:0}') )); then
        bottleneck="容器 CPU 配额只有 ${PERF_CGROUP_CORES} 核 —— 找服务商提配额"
    elif [[ "$PERF_MEM_TOTAL_MB" =~ ^[0-9]+$ ]] && (( PERF_MEM_TOTAL_MB < 1024 )); then
        bottleneck="内存不到 1GB —— 咔咔珂本身就紧张，更别提挂 QQ"
    elif [[ -n "$cpu_ms" ]] && (( cpu_ms >= 3000 )); then
        bottleneck="单核算力偏弱（${cpu_ms} ms）"
    elif [[ "$PERF_DISK_MBPS" =~ ^[0-9]+$ ]] && (( PERF_DISK_MBPS < 50 )); then
        bottleneck="磁盘写入偏慢（${PERF_DISK_MBPS} MB/s）—— 装插件、写日志都会卡"
    elif [[ -z "$cpu_ms" ]]; then
        bottleneck="未测到 CPU 跑分（缺 node），结论仅供参考"
    fi

    # —— 综合评级 ——
    local grade="" verdict="" color="$GREEN"
    if [[ -n "$cpu_ms" ]]; then
        if   (( cpu_ms < 1500 && mem_gb >= 4 )); then grade="游刃有余"; verdict="咔咔珂 + 2~3 个 QQ 都能跑"
        elif (( cpu_ms < 3000 && mem_gb >= 2 )); then grade="够用";     verdict="咔咔珂 + 1 个 QQ 没问题"
        elif (( cpu_ms < 6000 && mem_gb >= 1 )); then grade="勉强";     verdict="够跑咔咔珂，加 QQ 会比较紧"; color="$YELLOW"
        else grade="吃力"; verdict="建议换机器，或先只跑咔咔珂、不挂 QQ"; color="$RED"
        fi
        # 跑分没问题时内存仍可能拖后腿
        if [[ "$grade" == "游刃有余" || "$grade" == "够用" ]] && [[ "$PERF_MEM_TOTAL_MB" =~ ^[0-9]+$ ]] && (( PERF_MEM_TOTAL_MB < 2048 )); then
            grade="勉强"; verdict="CPU 够，但内存偏小，多开会吃紧"; color="$YELLOW"
        fi
    else
        # 没有跑分，只能按内存给个保守结论
        if   (( mem_gb >= 4 )); then grade="够用（未测跑分）"; verdict="内存充足；建议装上 node 再测一次单核算力"
        elif (( mem_gb >= 2 )); then grade="勉强（未测跑分）"; verdict="内存够跑咔咔珂；单核算力未知"; color="$YELLOW"
        else grade="吃力（未测跑分）"; verdict="内存偏小且单核算力未知，建议换机器"; color="$RED"
        fi
    fi

    # 配额不足 2 核时，单核再快也带不动多个 QQ —— 评级至少压到「勉强」
    if [[ -n "$PERF_CGROUP_CORES" ]] \
       && (( $(awk -v c="$PERF_CGROUP_CORES" 'BEGIN{print (c<2)?1:0}') )) \
       && [[ "$grade" != "吃力"* ]]; then
        grade="勉强（配额仅 ${PERF_CGROUP_CORES} 核）"
        verdict="受容器配额限制，建议先只跑咔咔珂 + 1 个 QQ"
        color="$YELLOW"
    fi

    echo -e "    综合评级 : ${color}${grade}${NC}"
    echo -e "    能跑什么 : ${verdict}"
    echo -e "    主要瓶颈 : ${bottleneck}"
    echo
    echo "    说明: 单核跑分为 3 亿次累加耗时（含 node 启动开销），不同架构/Node 版本差异较大，"
    echo "          主要用来横向对比机器，别和网上其他基准直接比数字"
    return 0
}

perf_report_all() {
    title "性能体检 · 一键全检"
    echo "  接下来会依次跑全部项目，大概 20-40 秒："
    echo "  vmstat 采样占 5 秒、磁盘写 200MB、CPU 跑分几秒"
    echo "  看不完可以 Ctrl+C 中断，前面已经跑出来的结果仍然有效"
    perf_cpu_info
    perf_cpu_steal
    perf_cgroup_quota
    perf_tmp_fs
    perf_disk_write
    perf_cpu_bench
    perf_sharp_version
    perf_memory
    # 单项各自带解读，这里再给一句总评
    perf_verdict
    echo
    info "体检完成 喵"
    return 0
}

menu_perf_check() {
    while true; do
        title "性能体检 (mk ${MK_VERSION})"
        show_nav_hint
        echo "  [2] 一键全检          跑全部项目（约 20-40 秒）"
        echo "  [3] CPU 型号/主频/核数"
        echo "  [4] 宿主机超售        vmstat 的 st 列"
        echo "  [5] cgroup 配额       容器化环境的 CPU 上限"
        echo "  [6] /tmp 是否内存盘"
        echo "  [7] 磁盘写入速度      写 200MB 实测"
        echo "  [8] CPU 跑分          单核算力，最能说明问题"
        echo "  [9] Node / sharp / libvips"
        echo "  [10] 内存与 swap"
        echo
        if mk_is_termux; then
            echo -e "  ${YELLOW}* 安卓上 lscpu / vmstat / cgroup 通常没有，能跑的项目会少一些${NC}"
            echo
        fi

        local choice=""
        read_choice choice
        case "$choice" in
            0) return 0 ;;
            1) return 0 ;;
            2) perf_report_all; press_enter ;;
            3) perf_cpu_info; press_enter ;;
            4) perf_cpu_steal; press_enter ;;
            5) perf_cgroup_quota; press_enter ;;
            6) perf_tmp_fs; press_enter ;;
            7) perf_disk_write; press_enter ;;
            8) perf_cpu_bench; press_enter ;;
            9) perf_sharp_version; press_enter ;;
            10) perf_memory; press_enter ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
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
            echo "  [7] 卸载 mk 工具"
            echo "  [8] 开机自启        (Termux:Boot)"
            echo "  [9] 字体包操作      (手机仅检测)"
            echo "  [10] 检查脚本更新"
            echo "  [11] Docker操作     (仅服务器)"
            echo "  [12] 性能体检"
            echo "  [13] QQ文件下载     (仅服务器)"
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
            echo "  [7] 卸载 mk 工具"
            echo "  [8] 开机自启"
            echo "  [9] 字体包操作"
            echo "  [10] 检查脚本更新"
            echo "  [11] Docker操作"
            echo "  [12] 性能体检"
            echo "  [13] QQ文件下载"
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
            7) menu_uninstall ;;
            8) menu_autostart || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            9) if mk_is_termux; then
                   menu_fonts_termux || true
               else
                   menu_fonts || true
               fi
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            10) menu_self_update || true ;;
            11) mk_require_server "Docker 依赖内核特性与 root，安卓 Termux 上无法安装" || continue
               menu_docker || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            12) menu_perf_check || true
               if mk_nav_bubble_up; then
                   MK_GO_HOME=0
                   continue
               fi
               ;;
            13) mk_require_server "QQ 的安装包只有 x86_64/arm64 Linux 能用，而且要存到 /root 下，手机上没有" || continue
                menu_qq_download || true
                if mk_nav_bubble_up; then
                    MK_GO_HOME=0
                    continue
                fi
                ;;
            0) info "再见 喵"; exit 0 ;;
            *) warn "无法识别该选项，请重新输入 喵" ;;
        esac
    done
}

main() {
    case "${1:-}" in
        --install|-i)
            title "MK 工具 - 强制安装/更新"
            install_self
            ;;
        --uninstall|-u)
            title "MK 工具 - 卸载"
            uninstall_self
            ;;
        --check|-c)
            syntax_check "$SELF_PATH"
            info "语法检查通过 喵"
            ;;
        --version|-v)
            echo "mk 版本: ${MK_VERSION}"
            echo "运行平台: $(mk_platform_label)"
            echo "安装目录: ${INSTALL_DIR}"
            ;;
        --help|-h)
            echo "用法:"
            echo "  mk / MK / Mk / mK  打开交互菜单（字母大小写均可）"
            if mk_is_termux; then
                echo "  bash mk           首次安装/更新（Termux 免 sudo）"
            else
                echo "  sudo bash mk      首次安装/更新"
            fi
            echo "  mk --install      强制重装/更新"
            echo "  mk --uninstall    卸载 mk 工具"
            echo "  mk --check        语法检查"
            echo "  mk --version      查看版本"
            echo
            echo "当前平台: $(mk_platform_label)"
            if mk_is_termux; then
                echo "手机可用: 咔咔珂操作 / 端口验证 / 构建 MK 源码 / 开机自启(Termux:Boot)"
                echo "手机不可用: 宝塔 / NapCat / snowLuma / 字体包（需 root 或图形环境）"
            fi
            ;;
        "")
            if [[ "$SELF_PATH" != "${INSTALL_DIR}/${SCRIPT_FILE}" ]]; then
                auto_install_if_needed
            fi
            menu_main
            ;;
        *)
            error "未知参数: $1"
            echo "使用 mk --help 查看帮助"
            exit 1
            ;;
    esac
}

main "$@"
