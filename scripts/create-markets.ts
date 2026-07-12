// scripts/create-markets.ts
// Creates markets on devnet using raw Solana transactions, no Anchor client needed.
// Run: npx ts-node --transpile-only scripts/create-markets.ts

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, clusterApiUrl, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("7JNc8D9Pt87apERHFsXoTnibWEvxF9n5wCJJinJopaPv");
const RPC        = clusterApiUrl("devnet");

function disc(name: string): Buffer {
  return Buffer.from(createHash("sha256").update(`global:${name}`).digest()).slice(0, 8);
}

function encodeCreateMarket(
  marketId: bigint, fixtureId: bigint,
  statKeyA: number, statKeyB: number,
  op: number, comparison: number,
  threshold: number, closeUnixTime: bigint
): Buffer {
  const buf = Buffer.alloc(8 + 8 + 8 + 4 + 4 + 1 + 1 + 4 + 8);
  let o = 0;
  disc("create_market").copy(buf, o); o += 8;
  buf.writeBigUInt64LE(marketId, o);  o += 8;
  buf.writeBigUInt64LE(fixtureId, o); o += 8;
  buf.writeUInt32LE(statKeyA, o);     o += 4;
  buf.writeUInt32LE(statKeyB, o);     o += 4;
  buf.writeUInt8(op, o);              o += 1;
  buf.writeUInt8(comparison, o);      o += 1;
  buf.writeInt32LE(threshold, o);     o += 4;
  buf.writeBigInt64LE(closeUnixTime, o);
  return buf;
}

const MARKETS = [
  {
    label:      "Total corners over 9 (Argentina vs Switzerland)",
    fixtureId:  18222446n,
    statKeyA:   3,
    statKeyB:   4,
    op:         0,
    comparison: 0,
    threshold:  9,
    hoursOpen:  72,
  },
  {
    label:      "Total yellow cards over 4 (France vs Spain)",
    fixtureId:  18237038n,
    statKeyA:   5,
    statKeyB:   6,
    op:         0,
    comparison: 0,
    threshold:  4,
    hoursOpen:  120,
  },
  {
    label:      "Total goals over 2 (England vs Argentina)",
    fixtureId:  18241006n,
    statKeyA:   1,
    statKeyB:   2,
    op:         0,
    comparison: 0,
    threshold:  2,
    hoursOpen:  144,
  },
];

async function main() {
  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const raw        = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const payer      = Keypair.fromSecretKey(Uint8Array.from(raw));
  const conn       = new Connection(RPC, "confirmed");

  console.log("Wallet:", payer.publicKey.toBase58());
  const bal = await conn.getBalance(payer.publicKey);
  console.log("Balance:", bal / 1e9, "SOL\n");

  console.log("Creating test token mint...");
  const mint = await createMint(conn, payer, payer.publicKey, null, 6);
  console.log("Mint:", mint.toBase58());

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  await mintTo(conn, payer, mint, userAta.address, payer, 1_000_000_000);
  console.log("Minted 1000 test tokens\n");

  const results: { label: string; market: string }[] = [];

  for (let i = 0; i < MARKETS.length; i++) {
    const m        = MARKETS[i];
    const marketId = BigInt(i + 3);
    const marketIdBuf = Buffer.alloc(8);
    marketIdBuf.writeBigUInt64LE(marketId);

    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketIdBuf], PROGRAM_ID
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketIdBuf], PROGRAM_ID
    );

    const closeTime = BigInt(Math.floor(Date.now() / 1000) + m.hoursOpen * 3600);
    const data      = encodeCreateMarket(
      marketId, m.fixtureId,
      m.statKeyA, m.statKeyB,
      m.op, m.comparison,
      m.threshold, closeTime
    );

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey,          isSigner: true,  isWritable: true  },
        { pubkey: marketPda,                isSigner: false, isWritable: true  },
        { pubkey: vaultPda,                 isSigner: false, isWritable: true  },
        { pubkey: mint,                     isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
      ],
      data,
    });

    console.log(`Creating market ${i + 1}: ${m.label}`);
    console.log("  Market PDA:", marketPda.toBase58());

    try {
      const tx  = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
      console.log("  Signature:", sig);
      console.log("  Explorer:  https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
      results.push({ label: m.label, market: marketPda.toBase58() });
    } catch (e: any) {
      console.error("  Failed:", e.message);
      if (e.logs) e.logs.forEach((l: string) => console.error("  log:", l));
    }
    console.log();
  }

  console.log("=== Update app/index.html SAMPLE_MARKETS with these ===");
  results.forEach((r, i) => {
    console.log(`Market ${i + 1} (${r.label}): ${r.market}`);
  });
  console.log("\nMint address:", mint.toBase58());
}

main().catch(console.error);