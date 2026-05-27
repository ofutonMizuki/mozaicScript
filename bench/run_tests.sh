#!/usr/bin/env bash
# ============================================================
#  run_tests.sh — 正当性 / デグレ（回帰）検査ランナー
#
#  各 correct_*.moz について以下を検査する:
#    1. オプティマイザ不変性 : interpreter を -O0/-O1/-O2 で実行し出力一致
#    2. バックエンド間一致     : interpreter vs C vs JS (-O2) の出力一致
#    3. ゴールデン回帰         : bench/golden/<name>.out と一致
#
#  生成物（*.ast.json / *.c / *.js / バイナリ）はすべて一時フォルダに置き、
#  bench/ にはソースのみを残す。
#
#  使い方:
#    bench/run_tests.sh                 # 検査
#    bench/run_tests.sh --update-golden # ゴールデンを現在の出力で更新
# ============================================================
set -u
cd "$(dirname "$0")/.."

TESTS=(correct_arith correct_control correct_array correct_recursion correct_classes correct_atomic_api)
GOLDEN=bench/golden
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
TS="npx ts-node"
UPDATE=0
[ "${1:-}" = "--update-golden" ] && UPDATE=1

# --- 一時ワークスペースにソースを複製（import の相対構造を保つ） ---
mkdir -p "$WORK/bench" "$WORK/sample"
cp sample/core.moc "$WORK/sample/"
cp bench/util.moz bench/correct_*.moz "$WORK/bench/"
mkdir -p "$GOLDEN"

pass=0; fail=0

echo "=================================================================="
echo " mozaicScript 正当性 / 回帰検査   (生成物は $WORK)"
echo "=================================================================="

for t in "${TESTS[@]}"; do
    src="$WORK/bench/$t.moz"
    problems=""

    # --- compile & interpret at each opt level ---
    for opt in 0 1 2; do
        if ! $TS compiler/index.ts -O$opt "$src" >/dev/null 2>"$WORK/cerr"; then
            problems+="compile-O$opt-FAIL "
        fi
        if ! $TS interpreter/index.ts "$src.ast.json" >"$WORK/interp_O$opt.out" 2>"$WORK/ierr_O$opt"; then
            problems+="interp-O$opt-CRASH "
        fi
    done

    # --- optimizer invariance ---
    diff -q "$WORK/interp_O0.out" "$WORK/interp_O2.out" >/dev/null 2>&1 || problems+="OPT-O0!=O2 "
    diff -q "$WORK/interp_O1.out" "$WORK/interp_O2.out" >/dev/null 2>&1 || problems+="OPT-O1!=O2 "

    # --- C backend (from -O2 ast; gcc -O0 = doc 既定ビルド) ---
    $TS codegen/index.ts "$WORK/sample/core.moc" "$WORK/bench/core.c" >/dev/null 2>&1
    $TS codegen/index.ts "$WORK/bench/util.moz"  "$WORK/bench/util.c" >/dev/null 2>&1
    $TS codegen/index.ts "$src"                  "$WORK/bench/$t.c"   >/dev/null 2>&1
    if gcc -O0 -o "$WORK/${t}_c" "$WORK/bench/$t.c" -lm -lpthread 2>"$WORK/gccerr"; then
        "$WORK/${t}_c" >"$WORK/c.out" 2>"$WORK/cruntime.err" || problems+="C-CRASH "
    else
        problems+="C-GCC-FAIL "; : >"$WORK/c.out"
    fi

    # --- JS backend ---
    $TS jscodegen/index.ts "$src" "$WORK/bench/$t.js" >/dev/null 2>&1
    node "$WORK/bench/$t.js" >"$WORK/js.out" 2>"$WORK/jsruntime.err" || problems+="JS-CRASH "

    # --- WASM backend (single self-contained module from -O2 ast) ---
    $TS wasmcodegen/index.ts "$src" "$WORK/bench/$t.wasm" >/dev/null 2>"$WORK/wasmgen.err" || problems+="WASM-GEN-FAIL "
    node wasmcodegen/run.js "$WORK/bench/$t.wasm" >"$WORK/wasm.out" 2>"$WORK/wasmruntime.err" || problems+="WASM-CRASH "

    # --- cross-backend agreement (reference = interpreter -O2) ---
    ref="$WORK/interp_O2.out"
    diff -q "$ref" "$WORK/c.out"   >/dev/null 2>&1 || problems+="C!=INTERP "
    diff -q "$ref" "$WORK/js.out"  >/dev/null 2>&1 || problems+="JS!=INTERP "
    diff -q "$ref" "$WORK/wasm.out" >/dev/null 2>&1 || problems+="WASM!=INTERP "

    # --- golden snapshot ---
    gold="$GOLDEN/$t.out"
    gstat=""
    if [ "$UPDATE" = 1 ] || [ ! -f "$gold" ]; then
        cp "$ref" "$gold"; gstat="[golden saved]"
    else
        diff -q "$gold" "$ref" >/dev/null 2>&1 || problems+="GOLDEN-CHANGED "
    fi

    if [ -z "$problems" ]; then
        printf "  PASS  %-20s %s\n" "$t" "$gstat"
        pass=$((pass+1))
    else
        printf "  FAIL  %-20s :: %s\n" "$t" "$problems"
        fail=$((fail+1))
        if ! diff -q "$ref" "$WORK/c.out" >/dev/null 2>&1; then
            echo "        --- interp(O2) vs C ---"; diff "$ref" "$WORK/c.out" | sed 's/^/        /' | head -20
        fi
        if ! diff -q "$ref" "$WORK/js.out" >/dev/null 2>&1; then
            echo "        --- interp(O2) vs JS ---"; diff "$ref" "$WORK/js.out" | sed 's/^/        /' | head -20
        fi
        if ! diff -q "$ref" "$WORK/wasm.out" >/dev/null 2>&1; then
            echo "        --- interp(O2) vs WASM ---"; diff "$ref" "$WORK/wasm.out" | sed 's/^/        /' | head -20
        fi
        [ -s "$WORK/wasmgen.err" ]     && { echo "        --- WASM gen stderr ---"; tail -3 "$WORK/wasmgen.err" | sed 's/^/        /'; }
        [ -s "$WORK/wasmruntime.err" ] && { echo "        --- WASM runtime stderr ---"; tail -3 "$WORK/wasmruntime.err" | sed 's/^/        /'; }
        if ! diff -q "$WORK/interp_O0.out" "$WORK/interp_O2.out" >/dev/null 2>&1; then
            echo "        --- interp O0 vs O2 (optimizer) ---"; diff "$WORK/interp_O0.out" "$WORK/interp_O2.out" | sed 's/^/        /' | head -20
        fi
        for lvl in 0 1 2; do
            [ -s "$WORK/ierr_O$lvl" ] && { echo "        --- interp -O$lvl stderr ---"; tail -3 "$WORK/ierr_O$lvl" | sed 's/^/        /'; }
        done
        [ -s "$WORK/cruntime.err" ] && { echo "        --- C stderr ---"; tail -3 "$WORK/cruntime.err" | sed 's/^/        /'; }
    fi
done

echo "------------------------------------------------------------------"
echo "  合計: $((pass+fail))  /  PASS: $pass  /  FAIL: $fail"
echo "=================================================================="
[ "$fail" -eq 0 ]
