#!/usr/bin/env bash
# Move local chain time forward N days:  scripts/warp.sh 45
set -euo pipefail
R=http://127.0.0.1:8546
now=$(cast block latest --rpc-url $R -f timestamp)
t=$((now + ${1:-1} * 86400))
cast rpc evm_setNextBlockTimestamp "$t" --rpc-url $R >/dev/null && cast rpc evm_mine --rpc-url $R >/dev/null
echo "chain time -> $(TZ=Asia/Tokyo date -r "$t" '+%a %Y-%m-%d %H:%M JST')"
