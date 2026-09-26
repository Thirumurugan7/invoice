#!/usr/bin/env bash
# Local demo chain on :8546 starting Fri 2026-09-25 10:00 JST, full deploy + demo invoice.
# Anvil accounts: #0 operator/admin, #1 supplier (さくら精工), #2 debtor (東京モーターズ), #3 investor,
# #4 / #5 new unrated companies (no name, 5,000,000 local JPYC each) for testing the open, no-KYB flow.
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -f "anvil --port 8546" 2>/dev/null || true
nohup anvil --port 8546 --timestamp 1790298000 > /tmp/tegata-anvil.log 2>&1 &
sleep 2
export SUPPLIER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export DEBTOR_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
export INVESTOR_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
export EXTRA_FUND_ADDRS=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8546 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast >/tmp/tegata-deploy.log 2>&1 \
  || { tail -30 /tmp/tegata-deploy.log; exit 1; }
mkdir -p web/public && cp deployments/31337.json web/public/deployment.json
grep -E "registry|hook|market" /tmp/tegata-deploy.log | head -3
echo "anvil on :8546"
