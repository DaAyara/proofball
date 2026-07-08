#!/bin/bash
# Run this to get a fresh TxLINE API session and fetch World Cup data
# Usage: bash scripts/txline-session.sh
set -e

echo "Cloning tx-on-chain repo..."
rm -rf /tmp/tx-on-chain
git clone https://github.com/txodds/tx-on-chain /tmp/tx-on-chain --quiet
mkdir -p /tmp/tx-on-chain/_keys
cp ~/.config/solana/id.json /tmp/tx-on-chain/_keys/testuser-wallet-1.json
cd /tmp/tx-on-chain
npm install --silent 2>/dev/null

# Write the data fetch script
cat > /tmp/tx-on-chain/get_data.ts << 'EOF'
import * as anchor from "@coral-xyz/anchor";
import axios from "axios";
import * as fs from "fs";
import * as users from "./examples/devnet/common/users";
import TxoracleJson from "./examples/devnet/idl/txoracle.json";
import { Txoracle } from "./examples/devnet/types/txoracle";

const TOKEN_MINT = new anchor.web3.PublicKey(process.env.TOKEN_MINT_ADDRESS!);
const API_BASE = "https://txline-dev.txodds.com/api";

async function main() {
  const connection = new anchor.web3.Connection(process.env.ANCHOR_PROVIDER_URL!, "confirmed");
  const wallet = new anchor.Wallet(anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET!, "utf8")))
  ));
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const program = new anchor.Program(TxoracleJson as Txoracle, provider);
  await users.setupUser("A", process.env.ANCHOR_WALLET!, TOKEN_MINT, connection, program, 1, 4, []);

  const jwt = users.authState.jwt;
  const apiToken = users.authState.apiToken;
  const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

  console.log("API Token:", apiToken);

  for (const path of [
    "/fixtures/snapshot",
    "/scores/snapshot/18193785",
    "/scores/snapshot/18187298"
  ]) {
    try {
      const r = await axios.get(`${API_BASE}${path}`, { headers });
      const fname = `/workspaces/proofball/scripts/data${path.replace(/\//g,"_")}.json`;
      fs.writeFileSync(fname, JSON.stringify(r.data, null, 2));
      console.log(`${path}: 200 - saved`);
    } catch(e: any) {
      console.log(`${path}: ${e.response?.status}`);
    }
  }

  // Stat validation needs fixtureId + seq number from the stream
  // seq comes from score updates, try with known working example
  for (const url of [
    `/scores/stat-validation?fixtureId=18193785&seq=880&statKeys=1,2`,
    `/scores/stat-validation?fixtureId=18187298&seq=880&statKeys=1,2`,
  ]) {
    try {
      const r = await axios.get(`${API_BASE}${url}`, { headers });
      fs.writeFileSync(`/workspaces/proofball/scripts/stat_validation.json`, JSON.stringify(r.data, null, 2));
      console.log(`stat-validation: 200 - saved!`);
      break;
    } catch(e: any) {
      console.log(`${url}: ${e.response?.status}`);
    }
  }      
}
main().catch(e => console.error(e.message));
EOF

echo "Running data fetch..."
TOKEN_MINT_ADDRESS=4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG \
ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
ANCHOR_WALLET="./_keys/testuser-wallet-1.json" \
npx ts-node --transpile-only get_data.ts