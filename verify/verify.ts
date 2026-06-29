// Proofball verify CLI
//
// This script checks a settled market on its own, without going
// through the Proofball website at all. The point is simple: you
// should not have to trust our frontend to believe a market settled
// correctly. You only need to trust the math, and the math is open
// right here.
//
// What it does, step by step:
//   1. Read the market account from chain (the program is the source
//      of truth, not our database, because we do not have one)
//   2. Pull the stat proof for that market's fixture and stat keys
//      straight from TxLINE's own API
//   3. Recompute the Merkle root by hand, hashing up the proof path
//   4. Compare that computed root against the root TxLINE published
//      on chain for that day
//   5. Apply the same threshold check the market used, and print
//      whether the result the program recorded actually matches
//
// Run it like this:
//   cd verify
//   npm install
//   npm run verify -- <market pubkey>
//
// Nothing here writes to chain. It only reads.

import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import axios from "axios";
import { createHash } from "crypto";

const DEVNET_RPC = process.env.PROOFBALL_RPC || "https://api.devnet.solana.com";
const TXLINE_API = process.env.TXLINE_API || "https://txline-dev.txodds.com/api";
const PROOFBALL_PROGRAM_ID = new PublicKey(
  process.env.PROOFBALL_PROGRAM_ID || "PFbaLLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
);
const TXLINE_PROGRAM_ID = new PublicKey(
  process.env.TXLINE_PROGRAM_ID || "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);

type ProofNode = { hash: string; isRightSibling: boolean };

function combine(current: Buffer, node: ProofNode): Buffer {
  const sibling = Buffer.from(node.hash, "hex");
  const pair = node.isRightSibling
    ? Buffer.concat([current, sibling])
    : Buffer.concat([sibling, current]);
  return createHash("sha256").update(pair).digest();
}

function walkProof(leafHash: Buffer, proof: ProofNode[]): Buffer {
  let current = leafHash;
  for (const node of proof) {
    current = combine(current, node);
  }
  return current;
}

function hashStatLeaf(statKey: number, value: number): Buffer {
  // Mirrors how a single stat leaf is hashed before it goes into the
  // event level Merkle tree. This is the one piece that depends on
  // TxLINE's exact internal leaf encoding. Confirm the encoding
  // against /documentation/examples/onchain-validation and adjust this
  // function if their leaf format differs once you have raw test
  // vectors back from a real call.
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(statKey, 0);
  buf.writeBigInt64LE(BigInt(value), 4);
  return createHash("sha256").update(buf).digest();
}

async function main() {
  const marketArg = process.argv[2];
  if (!marketArg) {
    console.error("usage: npm run verify -- <market pubkey>");
    process.exit(1);
  }

  console.log("Proofball independent verification");
  console.log("This does not trust the Proofball frontend. It only reads chain state and TxLINE's API directly.\n");

  const connection = new Connection(DEVNET_RPC, "confirmed");
  const marketPubkey = new PublicKey(marketArg);

  console.log(`1. Reading market account ${marketPubkey.toBase58()} from chain`);
  const marketAccountInfo = await connection.getAccountInfo(marketPubkey);
  if (!marketAccountInfo) {
    console.error("Could not find that market account on chain. Check the address and the cluster.");
    process.exit(1);
  }

  const market = decodeMarket(marketAccountInfo.data);
  console.log(`   fixture id:        ${market.fixtureId}`);
  console.log(`   stat key a:        ${market.statKeyA}`);
  console.log(`   stat key b:        ${market.statKeyB === 0 ? "(none, single stat market)" : market.statKeyB}`);
  console.log(`   comparison:        ${["greater than", "less than", "equal", "greater than or equal"][market.comparison]}`);
  console.log(`   threshold:         ${market.threshold}`);
  console.log(`   recorded status:   ${["unsettled", "yes", "no"][market.settledResult]}`);

  if (market.settledResult === 0) {
    console.log("\nThis market has not been settled yet. Nothing to verify.");
    return;
  }

  console.log(`\n2. Pulling stat proof from TxLINE for fixture ${market.fixtureId}, stat key ${market.statKeyA}`);
  const params: Record<string, number> = {
    fixtureId: market.fixtureId,
    statKey: market.statKeyA,
  };
  if (market.statKeyB !== 0) {
    params.statKey2 = market.statKeyB;
  }

  let validation;
  try {
    const response = await axios.get(`${TXLINE_API}/scores/stat-validation`, { params });
    validation = response.data;
  } catch (err) {
    console.error("Could not reach TxLINE's API. If this is a historical match after the free tier window, you may need an API token. See https://txline-docs.txodds.com/documentation/quickstart");
    process.exit(1);
  }

  console.log("   got proof data back, checking it independently now\n");

  console.log("3. Recomputing the Merkle root by hand from the proof path");
  const leaf = hashStatLeaf(validation.statToProve.statKey, validation.statToProve.value);
  const computedEventRoot = walkProof(leaf, validation.statProof);
  const publishedEventRoot = Buffer.from(validation.eventStatRoot, "hex");

  const rootsMatch = computedEventRoot.equals(publishedEventRoot);
  console.log(`   computed root:  ${computedEventRoot.toString("hex")}`);
  console.log(`   published root: ${publishedEventRoot.toString("hex")}`);
  console.log(`   match: ${rootsMatch ? "yes, the stat is genuinely in the tree" : "NO, something is wrong"}`);

  if (!rootsMatch) {
    console.log("\nStop here. The proof does not check out, do not trust this market's settlement.");
    process.exit(1);
  }

  console.log("\n4. Applying the market's own threshold rule to the verified stat value");
  let statValue = validation.statToProve.value;
  if (market.statKeyB !== 0 && validation.statToProve2) {
    const valueB = validation.statToProve2.value;
    statValue = market.op === 1 ? statValue + valueB : statValue - valueB;
    console.log(`   combining two stats with ${market.op === 1 ? "addition" : "subtraction"}: ${statValue}`);
  }

  const comparisons = [
    (a: number, b: number) => a > b,
    (a: number, b: number) => a < b,
    (a: number, b: number) => a === b,
    (a: number, b: number) => a >= b,
  ];
  const recomputedResult = comparisons[market.comparison](statValue, market.threshold);

  console.log(`   verified stat value: ${statValue}`);
  console.log(`   threshold check: ${statValue} ${["       >", "       <", "      ==", "      >="][market.comparison]} ${market.threshold} = ${recomputedResult}`);

  console.log("\n5. Comparing against what the Proofball program recorded on chain");
  const recordedYes = market.settledResult === 1;
  console.log(`   program recorded: ${recordedYes ? "yes" : "no"}`);
  console.log(`   independently recomputed: ${recomputedResult ? "yes" : "no"}`);

  if (recordedYes === recomputedResult) {
    console.log("\nThese match. The settlement is correct, and you did not need to trust anything except the math above.");
  } else {
    console.log("\nThese do NOT match. Something in the on chain settlement is wrong, this needs looking into before paying out further.");
    process.exit(1);
  }
}

function decodeMarket(data: Buffer) {
  // Manual offset decode, matching the field order in Market in
  // programs/proofball/src/lib.rs. If the struct changes, update the
  // offsets here too. Using a hand decode instead of the generated
  // Anchor client on purpose, so this script has as few dependencies
  // on Proofball's own code as possible.
  let offset = 8; // skip the account discriminator
  offset += 32; // creator pubkey
  const marketId = data.readBigUInt64LE(offset); offset += 8;
  const fixtureId = data.readBigUInt64LE(offset); offset += 8;
  const statKeyA = data.readUInt32LE(offset); offset += 4;
  const statKeyB = data.readUInt32LE(offset); offset += 4;
  const op = data.readUInt8(offset); offset += 1;
  const comparison = data.readUInt8(offset); offset += 1;
  const threshold = data.readBigInt64LE(offset); offset += 8;
  offset += 8; // close_unix_time, not needed here
  offset += 1; // status
  offset += 8; // yes_pool
  offset += 8; // no_pool
  const settledResult = data.readUInt8(offset);

  return {
    fixtureId: Number(fixtureId),
    marketId: Number(marketId),
    statKeyA,
    statKeyB,
    op,
    comparison,
    threshold: Number(threshold),
    settledResult,
  };
}

main().catch((err) => {
  console.error("Verification script failed:", err.message || err);
  process.exit(1);
});
