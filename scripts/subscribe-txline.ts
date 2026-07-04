// scripts/subscribe-txline.ts
// Subscribes to TxLINE free World Cup tier on devnet and gets an API token.
// Run: npx ts-node --transpile-only scripts/subscribe-txline.ts

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, clusterApiUrl,
  sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import axios from "axios";

const TXLINE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXLINE_MINT       = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const TXLINE_API        = "https://txline.txodds.com";
const RPC               = clusterApiUrl("devnet");

function disc(name: string): Buffer {
  return Buffer.from(createHash("sha256").update(`global:${name}`).digest()).slice(0, 8);
}

async function main() {
  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const raw        = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const payer      = Keypair.fromSecretKey(Uint8Array.from(raw));
  const conn       = new Connection(RPC, "confirmed");

  console.log("Wallet:", payer.publicKey.toBase58());

  // Step 1: Get guest JWT
  console.log("Getting guest JWT...");
  const authResp = await axios.post(`${TXLINE_API}/auth/guest/start`);
  const guestJwt = authResp.data.token;
  console.log("Got guest JWT\n");

  // Step 2: Check what program owns the TxLINE mint
  const mintInfo = await conn.getAccountInfo(TXLINE_MINT);
  console.log("TxLINE mint owner program:", mintInfo?.owner.toBase58());

  const tokenProgram = mintInfo?.owner || TOKEN_2022_PROGRAM_ID;

  // Step 3: Ensure associated token account exists
  const userAta = await getAssociatedTokenAddress(
    TXLINE_MINT, payer.publicKey, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const tx = new Transaction();

  try {
    await getAccount(conn, userAta, "confirmed", tokenProgram);
    console.log("Token account exists:", userAta.toBase58());
  } catch {
    console.log("Creating token account...");
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, userAta, payer.publicKey,
        TXLINE_MINT, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Step 4: Subscribe instruction
  const SERVICE_LEVEL = 1;
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")], TXLINE_PROGRAM_ID
  );
  const [subscriptionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("subscription"), payer.publicKey.toBuffer()], TXLINE_PROGRAM_ID
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury")], TXLINE_PROGRAM_ID
  );

  const subscribeData = Buffer.alloc(8 + 2);
  disc("subscribe").copy(subscribeData, 0);
  subscribeData.writeUInt16LE(SERVICE_LEVEL, 8);

  tx.add(new TransactionInstruction({
    programId: TXLINE_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: subscriptionPda,         isSigner: false, isWritable: true  },
      { pubkey: pricingMatrixPda,        isSigner: false, isWritable: false },
      { pubkey: userAta,                 isSigner: false, isWritable: true  },
      { pubkey: tokenTreasuryPda,        isSigner: false, isWritable: true  },
      { pubkey: TXLINE_MINT,             isSigner: false, isWritable: false },
      { pubkey: tokenProgram,            isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: subscribeData,
  }));

  console.log("Sending subscription transaction...");
  let sig: string;
  try {
    sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    console.log("Subscribed! Signature:", sig);
    console.log("Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet\n");
  } catch (e: any) {
    console.error("Subscription failed:", e.message);
    if (e.logs) e.logs.forEach((l: string) => console.error("log:", l));
    process.exit(1);
  }

  // Step 5: Sign message and activate token
  const message   = `txline-activate:${payer.publicKey.toBase58()}`;
  const msgBytes  = Buffer.from(message, "utf8");
  const signature = nacl.sign.detached(msgBytes, payer.secretKey);
  const sigBase64 = Buffer.from(signature).toString("base64");

  console.log("Activating API token...");
  try {
    const activateResp = await axios.post(
      `${TXLINE_API}/api/token/activate`,
      { txSignature: sig, walletPubkey: payer.publicKey.toBase58(), signedMessage: sigBase64, originalMessage: message },
      { headers: { Authorization: `Bearer ${guestJwt}` } }
    );
    const apiToken = activateResp.data.token || activateResp.data.apiToken;
    console.log("\nSave these:\n");
    console.log(`TXLINE_GUEST_JWT=${guestJwt}`);
    console.log(`TXLINE_API_TOKEN=${apiToken}`);

    // Test it
    const test = await axios.get(`${TXLINE_API}/api/scores/snapshot`, {
      headers: { Authorization: `Bearer ${guestJwt}`, "X-Api-Token": apiToken }
    });
    console.log("\nAPI works! Keys:", Object.keys(test.data));
  } catch (e: any) {
    console.error("Activation failed:", e.response?.data || e.message);
  }
}

main().catch(console.error);