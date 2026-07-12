// scripts/settle-market.ts
//
// Calls settle_market on a Proofball market using real TxLINE proof data.
// Run after bash scripts/txline-session.sh has saved stat_validation.json
//
// Usage: npx ts-node --transpile-only scripts/settle-market.ts <market_id>

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const PROGRAM_ID    = new PublicKey("7JNc8D9Pt87apERHFsXoTnibWEvxF9n5wCJJinJopaPv");
const TXLINE_ID     = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const RPC           = clusterApiUrl("devnet");

// Real discriminator from TxLINE's published IDL
const VALIDATE_STAT_DISC = Buffer.from([107, 197, 232, 90, 191, 136, 105, 185]);

// settle_market discriminator (Anchor standard)
const SETTLE_MARKET_DISC = Buffer.from(
  createHash("sha256").update("global:settle_market").digest()
).slice(0, 8);

// daily_scores_roots PDA: seeds = ["daily_scores_roots", epochDay as u16 le]
function dailyScoresRootsPda(ts: number): PublicKey {
  const epochDay = Math.floor(ts / 86400000);
  const dayBuf = Buffer.alloc(2);
  dayBuf.writeUInt16LE(epochDay % 65536);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), dayBuf],
    TXLINE_ID
  );
  return pda;
}

function encodeScoresBatchSummary(summary: any): Buffer {
  // ScoresBatchSummary: fixtureId (i64) + updateStats (updateCount i32, min i64, max i64) + eventsSubTreeRoot [u8;32]
  const buf = Buffer.alloc(8 + 4 + 8 + 8 + 32);
  let o = 0;
  buf.writeBigInt64LE(BigInt(summary.fixtureId), o);         o += 8;
  buf.writeInt32LE(summary.updateStats.updateCount, o);      o += 4;
  buf.writeBigInt64LE(BigInt(summary.updateStats.minTimestamp), o); o += 8;
  buf.writeBigInt64LE(BigInt(summary.updateStats.maxTimestamp), o); o += 8;
  // field is eventStatsSubTreeRoot in API, eventsSubTreeRoot in our types
  Buffer.from(summary.eventStatsSubTreeRoot).copy(buf, o);
  return buf;
}

function encodeProofNodes(nodes: any[]): Buffer {
  // Vec<ProofNode>: 4-byte length prefix + each node (32 bytes hash + 1 byte bool)
  const buf = Buffer.alloc(4 + nodes.length * 33);
  buf.writeUInt32LE(nodes.length, 0);
  nodes.forEach((n, i) => {
    Buffer.from(n.hash).copy(buf, 4 + i * 33);
    buf.writeUInt8(n.isRightSibling ? 1 : 0, 4 + i * 33 + 32);
  });
  return buf;
}

function encodeTraderPredicate(threshold: number, comparison: number): Buffer {
  // TraderPredicate: threshold (i32) + comparison (u8 enum variant index)
  const buf = Buffer.alloc(4 + 1);
  buf.writeInt32LE(threshold, 0);
  buf.writeUInt8(comparison, 4);
  return buf;
}

function encodeStatTerm(statToProve: any, eventStatRoot: number[], statProof: any[]): Buffer {
  // StatTerm: ScoreStat (key u32, value i32, period i32) + eventStatRoot [u8;32] + statProof Vec<ProofNode>
  const proofBuf = encodeProofNodes(statProof);
  const buf = Buffer.alloc(4 + 4 + 4 + 32 + proofBuf.length);
  let o = 0;
  buf.writeUInt32LE(statToProve.key, o);   o += 4;
  buf.writeInt32LE(statToProve.value, o);  o += 4;
  buf.writeInt32LE(statToProve.period, o); o += 4;
  Buffer.from(eventStatRoot).copy(buf, o); o += 32;
  proofBuf.copy(buf, o);
  return buf;
}

function encodeOption(present: boolean, data?: Buffer): Buffer {
  if (!present) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), data!]);
}

async function main() {
  const marketIdArg = process.argv[2] || "1";
  const marketId    = BigInt(marketIdArg);

  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer      = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const conn       = new Connection(RPC, "confirmed");
  const data       = JSON.parse(fs.readFileSync(path.join(__dirname, "stat_validation.json"), "utf8"));

  console.log("Settling market", marketId);
  console.log("Using fixture:", data.summary.fixtureId);
  console.log("Stats:", data.statsToProve);

  const marketIdBuf = Buffer.alloc(8);
  marketIdBuf.writeBigUInt64LE(marketId);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), marketIdBuf], PROGRAM_ID
  );

  const dailyRootsPda = dailyScoresRootsPda(data.ts);
  console.log("daily_scores_roots PDA:", dailyRootsPda.toBase58());

  // Check if the PDA exists on devnet
  const pdaInfo = await conn.getAccountInfo(dailyRootsPda);
  console.log("daily_scores_roots exists:", !!pdaInfo);

  // Encode the settle_market instruction data
  // Args: ts (i64), fixtureSummary, fixtureProof, mainTreeProof, stat_a, stat_b (Option)
  const summaryBuf    = encodeScoresBatchSummary(data.summary);
  const fixProofBuf   = encodeProofNodes(data.subTreeProof);
  const mainProofBuf  = encodeProofNodes(data.mainTreeProof);
  const predBuf       = encodeTraderPredicate(9, 0); // threshold 9, greaterThan
  const statABuf      = encodeStatTerm(data.statsToProve[0], data.eventStatRoot, data.statProofs[0]);

  // For a single-stat market (stat_key_b = 0), stat_b is None
  const statBBuf      = data.statsToProve[1]
    ? encodeOption(true, encodeStatTerm(data.statsToProve[1], data.eventStatRoot, data.statProofs[1]))
    : encodeOption(false);

  // op is None for single stat, Some(Add=0) for two-stat
  const opBuf = data.statsToProve[1]
    ? encodeOption(true, Buffer.from([0])) // Add
    : encodeOption(false);

  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64LE(BigInt(data.ts));

  const instructionData = Buffer.concat([
    SETTLE_MARKET_DISC,
    tsBuf,
    summaryBuf,
    fixProofBuf,
    mainProofBuf,
    statABuf,
    statBBuf,
    opBuf,
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: marketPda,    isSigner: false, isWritable: true  },
      { pubkey: dailyRootsPda, isSigner: false, isWritable: false },
      { pubkey: TXLINE_ID,    isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: instructionData,
  });

  try {
    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    console.log("\nSettlement successful!");
    console.log("Signature:", sig);
    console.log("Explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
  } catch(e: any) {
    console.error("\nSettlement failed:", e.message);
    if (e.logs) e.logs.forEach((l: string) => console.log("log:", l));
  }
}

main().catch(console.error);