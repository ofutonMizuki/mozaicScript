#!/usr/bin/env bash
# ============================================================
#  run_bench.sh — 速度比較ランナー
#
#  各 speed_*.moz を以下の実行系で計測し、手書きネイティブと比較する:
#    interp    : mozaicScript ツリーウォーキング インタプリタ
#    moz-JS    : mozaicScript JS バックエンド生成コード   (node)
#    nat-JS    : 手書きネイティブ JS                       (node)
#    mozC-O0/2 : mozaicScript C バックエンド + gcc -O0/-O2
#    natC-O0/2 : 手書きネイティブ C + gcc -O0/-O2
#
#  生成物はすべて一時フォルダに置く（bench/ はソースのみ）。
#  併せて全実行系のチェックサム（出力）一致を検証する。
#  時間は ms。interp は 1 回計測（低速のため）、他は best-of-3。
# ============================================================
set -u
cd "$(dirname "$0")/.."

BENCHES=(speed_loopsum speed_fib speed_primes speed_collatz speed_matrix speed_mandelbrot)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
TS="npx ts-node"
INTERP_TIMEOUT=240

echo "dist/ をビルド中 (interpreter 計測の ts-node 起動コストを排除)..."
npm run build >/dev/null 2>&1 || { echo "npm run build 失敗"; exit 1; }

mkdir -p "$WORK/bench" "$WORK/sample"
cp sample/core.moc "$WORK/sample/"
cp bench/util.moz bench/speed_*.moz "$WORK/bench/"

ms_now() { date +%s%N; }
best_of() { # $1=N $2=outfile ; rest=cmd ; echoes min ms, writes rc to $WORK/lastrc
    local n="$1" out="$2"; shift 2
    local best=-1 i s e d rc=0
    for ((i=0;i<n;i++)); do
        s=$(ms_now); "$@" >"$out" 2>"$WORK/r.err"; rc=$?; e=$(ms_now)
        d=$(( (e - s) / 1000000 ))
        if [ "$best" -lt 0 ] || [ "$d" -lt "$best" ]; then best=$d; fi
        [ "$rc" -ne 0 ] && break
    done
    echo "$rc" > "$WORK/lastrc"
    echo "$best"
}
rc_of() { cat "$WORK/lastrc"; }

printf "\n%-16s %8s %8s %8s %8s %8s %8s %8s\n" \
    benchmark interp moz-JS nat-JS mozC-O0 natC-O0 mozC-O2 natC-O2
printf -- "--------------------------------------------------------------------------------------\n"

mismatches=""

for b in "${BENCHES[@]}"; do
    nat=${b#speed_}
    src="$WORK/bench/$b.moz"
    note=""

    $TS compiler/index.ts "$src" >/dev/null 2>"$WORK/cerr" || { printf "%-16s  COMPILE FAIL\n" "$b"; cat "$WORK/cerr"; continue; }

    # mozaicScript backends → C / JS
    $TS codegen/index.ts "$WORK/sample/core.moc" "$WORK/bench/core.c" >/dev/null 2>&1
    $TS codegen/index.ts "$WORK/bench/util.moz"  "$WORK/bench/util.c" >/dev/null 2>&1
    $TS codegen/index.ts "$src"                  "$WORK/bench/$b.c"   >/dev/null 2>&1
    $TS jscodegen/index.ts "$src"                "$WORK/bench/$b.js"  >/dev/null 2>&1
    gcc -O0 -o "$WORK/${b}_mozO0" "$WORK/bench/$b.c" -lm -lpthread 2>/dev/null
    gcc -O2 -o "$WORK/${b}_mozO2" "$WORK/bench/$b.c" -lm -lpthread 2>/dev/null

    # native baselines
    gcc -O0 -o "$WORK/${nat}_natO0" "bench/native/$nat.c" -lm 2>/dev/null
    gcc -O2 -o "$WORK/${nat}_natO2" "bench/native/$nat.c" -lm 2>/dev/null

    # --- interpreter (1 run, timeout guarded) ---
    s=$(ms_now)
    timeout "$INTERP_TIMEOUT" node dist/interpreter/index.js "$src.ast.json" >"$WORK/i.out" 2>"$WORK/i.err"
    irc=$?; e=$(ms_now)
    if   [ "$irc" -eq 124 ]; then ims="TIMEOUT"; note+="[interp timeout] "
    elif [ "$irc" -ne 0 ];   then ims="CRASH";   note+="[interp crash] "
    else ims=$(( (e - s) / 1000000 )); fi

    # --- timed runs ---
    mjs=$(best_of 3 "$WORK/mjs.out" node "$WORK/bench/$b.js");        [ "$(rc_of)" -ne 0 ] && mjs="CRASH"
    njs=$(best_of 3 "$WORK/njs.out" node "bench/native/$nat.js");     [ "$(rc_of)" -ne 0 ] && njs="CRASH"
    mc0="-"; [ -x "$WORK/${b}_mozO0" ]   && { mc0=$(best_of 3 "$WORK/mc0.out" "$WORK/${b}_mozO0");   [ "$(rc_of)" -ne 0 ] && mc0="CRASH"; }
    nc0="-"; [ -x "$WORK/${nat}_natO0" ] && { nc0=$(best_of 3 "$WORK/nc0.out" "$WORK/${nat}_natO0"); [ "$(rc_of)" -ne 0 ] && nc0="CRASH"; }
    mc2="-"; [ -x "$WORK/${b}_mozO2" ]   && { mc2=$(best_of 3 "$WORK/mc2.out" "$WORK/${b}_mozO2");   [ "$(rc_of)" -ne 0 ] && mc2="CRASH"; }
    nc2="-"; [ -x "$WORK/${nat}_natO2" ] && { nc2=$(best_of 3 "$WORK/nc2.out" "$WORK/${nat}_natO2"); [ "$(rc_of)" -ne 0 ] && nc2="CRASH"; }

    # --- checksum agreement (reference = native C -O2) ---
    ref="$WORK/nc2.out"
    for tag in "interp:$WORK/i.out" "moz-JS:$WORK/mjs.out" "nat-JS:$WORK/njs.out" "mozC-O0:$WORK/mc0.out" "natC-O0:$WORK/nc0.out" "mozC-O2:$WORK/mc2.out"; do
        f="${tag#*:}"; name="${tag%%:*}"
        [ -s "$f" ] || continue
        diff -q "$ref" "$f" >/dev/null 2>&1 || { note+="[MISMATCH:$name] "; mismatches+="$b/$name "; }
    done

    printf "%-16s %8s %8s %8s %8s %8s %8s %8s\n" "$b" "$ims" "$mjs" "$njs" "$mc0" "$nc0" "$mc2" "$nc2"
    [ -n "$note" ] && printf "%-16s   %s\n" "" "$note"
done

echo
echo "チェックサム: $([ -z "$mismatches" ] && echo "全実行系一致 ✓" || echo "不一致あり → $mismatches")"
echo
echo "注: interp は 1 回計測（低速）、他は best-of-3。単位 ms。"
echo "    C-O0 は doc 既定ビルド。入力非依存ベンチは gcc -O2 が全体を畳み込み得る。"
echo "    moz-* = mozaicScript バックエンド生成、nat-* = 手書きネイティブ(bench/native/)。"
