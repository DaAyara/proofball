#!/bin/bash
# Run this script to get a fresh TxLINE API session
# Usage: bash scripts/txline-session.sh
set -e
echo "Cloning tx-on-chain repo..."
rm -rf /tmp/tx-on-chain
git clone https://github.com/txodds/tx-on-chain /tmp/tx-on-chain --quiet
mkdir -p /tmp/tx-on-chain/_keys
cp ~/.config/solana/id.json /tmp/tx-on-chain/_keys/testuser-wallet-1.json
cd /tmp/tx-on-chain
npm install --silent 2>/dev/null
echo "Running subscription and data fetch..."
TOKEN_MINT_ADDRESS=4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG \
ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
ANCHOR_WALLET="./_keys/testuser-wallet-1.json" \
npx ts-node --transpile-only get_data.ts
