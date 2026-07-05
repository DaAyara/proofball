// scripts/subscribe-txline.ts
// Subscribes to TxLINE free World Cup tier on devnet and gets an API token.
// Run: npx ts-node --transpile-only scripts/subscribe-txline.ts
//
// Fix from TxODDS Discord: treasury PDA seed is "token_treasury_v2"
// and the vault is the ATA of that PDA using TOKEN_2022_PROGRAM_ID.

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, clusterApiUrl,
  sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
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
const SERVICE_LEVEL     = 1;  // free World Cup tier
const WEEKS = 4;  // must be multiple of 4  // minimum subscription period

function disc(name: string): Buffer {
  return Buffer.from(createHash("sha256").update(`global:${name}`).digest()).slice(0, 8);
}

async function main() {
  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const raw        = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const payer      = Keypair.fromSecretKey(Uint8Array.from(raw));
  const conn       = new Connection(RPC, "confirmed");

  console.log("Wallet:", payer.publicKey.toBase58());
  const bal = await conn.getBalance(payer.publicKey);
  console.log("Balance:", (bal / 1e9).toFixed(4), "SOL\n");

  // Step 1: Get guest JWT
  console.log("Getting guest JWT...");
  const authResp = await axios.post(`${TXLINE_API}/auth/guest/start`);
  const guestJwt = authResp.data.token;
  console.log("Got guest JWT\n");

  // Step 2: Derive the real PDA addresses
  // Discord confirmed: seed is "token_treasury_v2", not "token_treasury_pda"
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")], TXLINE_PROGRAM_ID
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")], TXLINE_PROGRAM_ID
  );
  // Vault is the ATA of the treasury PDA, using Token-2022
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXLINE_MINT,
    tokenTreasuryPda,
    true, // allowOwnerOffCurve = true since it's a PDA
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("pricing_matrix PDA:", pricingMatrixPda.toBase58());
  console.log("token_treasury PDA:", tokenTreasuryPda.toBase58());
  console.log("token_treasury vault:", tokenTreasuryVault.toBase58());

  // Verify these accounts exist on devnet
  const pmInfo = await conn.getAccountInfo(pricingMatrixPda);
  const vaultInfo = await conn.getAccountInfo(tokenTreasuryVault);
  console.log("pricing_matrix exists:", !!pmInfo);
  console.log("treasury vault exists:", !!vaultInfo, "\n");

  // Step 3: Create user's TxLINE token account if needed
  const userAta = await getAssociatedTokenAddress(
    TXLINE_MINT, payer.publicKey, false,
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction();
  try {
    await getAccount(conn, userAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    console.log("User token account exists:", userAta.toBase58());
  } catch {
    console.log("Creating user token account...");
    tx.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, userAta, payer.publicKey,
      TXLINE_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  // Step 4: Build subscribe instruction with real discriminator and args
  // Args: service_level_id (u16) + weeks (u8)
  const subscribeDisc = Buffer.from([254, 28, 191, 138, 156, 179, 183, 53]);
  const subscribeArgs = Buffer.alloc(3);
  subscribeArgs.writeUInt16LE(SERVICE_LEVEL, 0);
  subscribeArgs.writeUInt8(WEEKS, 2);
  const subscribeData = Buffer.concat([subscribeDisc, subscribeArgs]);

  // Account order from the real IDL (confirmed from devnet.md):
  // user, pricing_matrix, token_mint, user_token_account,
  // token_treasury_vault, token_treasury_pda,
  // token_program, system_program, associated_token_program
  tx.add(new TransactionInstruction({
    programId: TXLINE_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: pricingMatrixPda,            isSigner: false, isWritable: false },
      { pubkey: TXLINE_MINT,                 isSigner: false, isWritable: false },
      { pubkey: userAta,                     isSigner: false, isWritable: true  },
      { pubkey: tokenTreasuryVault,          isSigner: false, isWritable: true  },
      { pubkey: tokenTreasuryPda,            isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: subscribeData,
  }));

  console.log("Sending subscription transaction...");
  let sig: string;
  try {
    sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    console.log("Subscribed!");
    console.log("Signature:", sig);
    console.log("Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet\n");
  } catch (e: any) {
    console.error("Subscription failed:", e.message);
    if (e.logs) e.logs.forEach((l: string) => console.error("log:", l));
    process.exit(1);
  }

  // Step 5: Sign a message to prove wallet ownership
  const message   = `txline-activate:${payer.publicKey.toBase58()}`;
  const msgBytes  = Buffer.from(message, "utf8");
  const signature = nacl.sign.detached(msgBytes, payer.secretKey);
  const sigBase64 = Buffer.from(signature).toString("base64");

  // Step 6: Activate the API token
  console.log("Activating API token...");
  try {
    const activateResp = await axios.post(
      `${TXLINE_API}/api/token/activate`,
      {
        txSignature:     sig,
        walletPubkey:    payer.publicKey.toBase58(),
        signedMessage:   sigBase64,
        originalMessage: message,
      },
      { headers: { Authorization: `Bearer ${guestJwt}` } }
    );

    const apiToken = activateResp.data.token
      || activateResp.data.apiToken
      || activateResp.data.api_token;

    console.log("\nAPI token activated!\n");
    console.log("Save these two values in a .env file:\n");
    console.log(`TXLINE_GUEST_JWT=${guestJwt}`);
    console.log(`TXLINE_API_TOKEN=${apiToken}`);

    // Step 7: Test the API
    console.log("\nTesting API access with both headers...");
    const test = await axios.get(`${TXLINE_API}/api/scores/snapshot`, {
      headers: {
        Authorization: `Bearer ${guestJwt}`,
        "X-Api-Token":  apiToken,
      }
    });
    console.log("API works! Response keys:", Object.keys(test.data));

  } catch (e: any) {
    console.error("Activation failed:");
    console.error(e.response?.data || e.message);
    console.log("\nThe subscription went through but activation failed.");
    console.log("Try calling /api/token/activate manually with the signature above.");
  }
}

main().catch(console.error);