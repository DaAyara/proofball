import * as anchor from "@coral-xyz/anchor";
import axios from "axios";
import * as fs from "fs";
import * as users from "./examples/devnet/common/users";
import TxoracleJson from "./examples/devnet/idl/txoracle.json";
import { Txoracle } from "./examples/devnet/types/txoracle";

const TOKEN_MINT = new anchor.web3.PublicKey(process.env.TOKEN_MINT_ADDRESS!);
const API_BASE = "https://txline-dev.txodds.com/api";
const FIXTURE_ID = 18187298;

async function main() {
  const connection = new anchor.web3.Connection(process.env.ANCHOR_PROVIDER_URL!, "confirmed");
  const wallet = new anchor.Wallet(anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET!, "utf8")))
  ));
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const program = new anchor.Program(TxoracleJson as Txoracle, provider);

  await users.setupUser("Trader A", process.env.ANCHOR_WALLET!, TOKEN_MINT,
    connection, program, 1, 4, []);

  const jwt = users.authState.jwt;
  const apiToken = users.authState.apiToken;
  const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

  console.log("\nTrying available endpoints...");
  
  for (const path of [
    `/scores/snapshot`,
    `/fixtures/snapshot`, 
    `/scores/updates`,
    `/worldcup/fixtures`,
  ]) {
    try {
      const r = await axios.get(`${API_BASE}${path}`, { headers });
      console.log(`${path}: ${r.status} - keys: ${Object.keys(r.data).slice(0,5).join(", ")}`);
      fs.writeFileSync(`/workspaces/proofball/scripts/data_${path.replace(/\//g,"_")}.json`, 
        JSON.stringify(r.data, null, 2));
    } catch(e: any) {
      console.log(`${path}: ${e.response?.status || e.message}`);
    }
  }
}

main().catch(console.error);
