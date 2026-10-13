#!/usr/bin/env bash
# 电池 v19（v0927.52 起生效；55 套件 = v18 阶段序 + round51-57）。
# 编排要点（重建时踩过的坑，勿再踩）：
#  - 夹具文件全带 fx- 前缀；fx() 内部统一拼 scripts/fx/fx-<name>.js
#  - fx-precfg-ui-cd 是 CDP 驱动活实例的夹具：必须先起实例再跑（fx() 对它跳过 kill_all）
#  - 其余夹具必须无实例存活时跑（sql.js 活实例 close 会用内存副本覆盖夹具写库）→ fx() 先 kill_all+sleep 2
#  - fresh/fresh_splash：kill 后 sleep 3 再启动（端口/(userData 锁)落定，否则级联 FATAL/树空/Splash 时长错）
#  - r17 是 Splash 套件：fresh_splash 8000 无 wait-main（套件自己轮询 splash target）；r18 同法
#  - 共享实例对仅 r22→r23、r29→r30（同实例连跑）；GUARD（失败重试一次）：r8/r10/r17/r30/42ui/44ui/45ui/47ui
#  - UI 组前离线 rm -rf '.tmp-ud7/Local Storage'（localStorage 毒态唯一确定性清除法）
cd /d/DataHelm || exit 1
PASS_TOTAL=0; FAIL_TOTAL=0; SUITES=0; FAIL_SUITES=""
T0=$(date +%s)
log() { echo "==== [$(date +%H:%M:%S)] $* ===="; }
kill_port() { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fx/fx-kill-ports.ps1 -Ports "$1" >/dev/null 2>&1; }
kill_all() { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fx/fx-kill-ports.ps1 >/dev/null 2>&1; }
start_inst() { (DH_USER_DATA=D:/DataHelm/.tmp-ud7 DH_SPLASH_MS="${2:-800}" DH_QUIET=1 npx electron . --remote-debugging-port="$1" >/dev/null 2>&1 &); }
fresh() { kill_port "$1"; sleep 3; start_inst "$1" "${2:-800}"; node scripts/fx/fx-wait-main.js "$1" >/dev/null 2>&1 || { log "MAIN-FAIL port=$1"; return 1; }; }
fresh_splash() { kill_port "$1"; sleep 3; start_inst "$1" "$2"; sleep 1; }
fx() { if [ "$1" != "precfg-ui-cd" ]; then kill_all; sleep 2; fi; node "scripts/fx/fx-$1.js" "${@:2}" >/dev/null 2>&1 || { log "FX-FAIL $1 ${@:2}"; return 1; }; }
run_suite() {
  local label="$1" file="$2" port="$3" guard="${4:-0}"
  SUITES=$((SUITES+1))
  local out rc p f
  out=$(CDP_PORT="$port" node "scripts/$file" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && [ "$guard" = "1" ]; then
    log "GUARD-RETRY $label (run1 rc=$rc)"
    sleep 2
    out=$(CDP_PORT="$port" node "scripts/$file" 2>&1); rc=$?
  fi
  p=$(printf '%s\n' "$out" | grep -c '^PASS ')
  f=$(printf '%s\n' "$out" | grep -c '^FAIL ')
  PASS_TOTAL=$((PASS_TOTAL+p)); FAIL_TOTAL=$((FAIL_TOTAL+f))
  if [ "$rc" -ne 0 ] || [ "$f" -gt 0 ]; then
    FAIL_SUITES="$FAIL_SUITES $label"
    log "SUIT-FAIL $label rc=$rc fails=$f"
    printf '%s\n' "$out" | grep '^FAIL ' | head -6
  else
    log "ok $label ($p checks)"
  fi
}

log "P0 kill_all + fx-reset"
kill_all
fx reset || true

log "9226 tree-matrix"
fresh 9226 && run_suite tree-matrix verify-tree-matrix.js 9226

log "9222 precfg + ui-cd（共享实例：precfg 是 CDP 驱动活实例的夹具，必须先起实例再跑）"
fresh 9222 && CDP_PORT=9222 fx precfg-ui-cd
run_suite ui-cd verify-ui-cd.js 9222

log "9227 r6-r11 fresh-each (r8/r10 GUARD)"
for s in 6 7 8 9 10 11; do
  g=0; [ "$s" = "8" ] || [ "$s" = "10" ] && g=1
  fresh 9227 && run_suite "r$s" "verify-round$s.js" 9227 "$g"
done

log "fx-tr-add + fx-reset + r12 + export"
fx tr-add; fx reset
fresh 9227 && run_suite r12 verify-round12.js 9227
fresh 9227 && run_suite export verify-export.js 9227

log "9228 r13/14/15 fresh + fx-er-add + r16 + r17(fresh_splash GUARD) + r18(fresh_splash) + r19"
for s in 13 14 15; do fresh 9228 && run_suite "r$s" "verify-round$s.js" 9228; done
fx er-add
fresh 9228 && run_suite r16 verify-round16.js 9228
fresh_splash 9228 8000 && run_suite r17 verify-round17.js 9228 1
fresh_splash 9228 8000 && run_suite r18 verify-round18.js 9228
fresh 9228 && run_suite r19 verify-round19.js 9228

log "9229 r20-r31"
fx imp
fresh 9229 && run_suite r20 verify-round20.js 9229
fx add
fresh 9229 && run_suite r21 verify-round21.js 9229
fx reset
fresh 9229 && run_suite r22 verify-round22.js 9229
run_suite r23 verify-round23.js 9229
fx add
fresh 9229 && run_suite r24 verify-round24.js 9229
fresh 9229 && run_suite r25 verify-round25.js 9229
fx w26
fresh 9229 && run_suite r26 verify-round26.js 9229
fx w27 stage1
fresh 9229 && run_suite r27 verify-round27.js 9229
fx reset; fx w28 stage1
fresh 9229 && run_suite r28 verify-round28.js 9229
fx w29 stage1
fresh 9229 && run_suite r29 verify-round29.js 9229
run_suite r30 verify-round30.js 9229 1
fx w31 stage1
fresh 9229 && run_suite r31 verify-round31.js 9229
fx w31 cleanup

log "离线清 localStorage 毒态（UI 组前）"
kill_all
rm -rf '/d/DataHelm/.tmp-ud7/Local Storage'

log "9227 UI 组 w32-w47ui"
fx w32ui; fresh 9227 && run_suite 32ui verify-round32-ui.js 9227
fx w33ui; fresh 9227 && run_suite 33ui verify-round33-ui.js 9227
fx w34ui; fresh 9227 && run_suite 34ui verify-round34-ui.js 9227
for s in 35 36 37 38 39; do fresh 9227 && run_suite "${s}ui" "verify-round${s}-ui.js" 9227; done
fx w40ui; fresh 9227 && run_suite 40ui verify-round40-ui.js 9227
fx w41ui; fresh 9227 && run_suite 41ui verify-round41-ui.js 9227
fresh 9227 && run_suite 42ui verify-round42-ui.js 9227 1
fresh 9227 && run_suite 43ui verify-round43-ui.js 9227
fresh 9227 && run_suite 44ui verify-round44-ui.js 9227 1
fresh 9227 && run_suite 45ui verify-round45-ui.js 9227 1
fx w46ui; fresh 9227 && run_suite 46ui verify-round46-ui.js 9227
fresh 9227 && run_suite 47ui verify-round47-ui.js 9227 1

log "9230 尾段 r48-r57"
fx w48 stage1
fresh 9230 && run_suite r48 verify-round48.js 9230
fx w48 cleanup
fx drop; fx drop
fx tr-del
fx reset
fresh 9230 && run_suite r49 verify-round49.js 9230
fresh 9230 && run_suite r50 verify-round50.js 9230
fresh 9230 && run_suite r51 verify-round51.js 9230
fresh 9230 && run_suite r52 verify-round52.js 9230
fresh 9230 && run_suite r53 verify-round53.js 9230
fresh 9230 && run_suite r54 verify-round54.js 9230
fresh 9230 && run_suite r55 verify-round55.js 9230
fresh 9230 && run_suite r56 verify-round56.js 9230
fresh 9230 && run_suite r57 verify-round57.js 9230
kill_all

ELAPSED=$(( $(date +%s) - T0 ))
log "TOTAL SUITES=$SUITES CHECKS=$PASS_TOTAL/$((PASS_TOTAL+FAIL_TOTAL)) FAIL_SUITES=${FAIL_SUITES:-none} ELAPSED=${ELAPSED}s"
