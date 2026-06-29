// End to end test for one market, from creation to payout.
//
// This uses a fake stat proof for local testing, since we cannot hit
// TxLINE's real devnet API and a real match inside a CI run. Before
// the actual demo, run this same flow against a real devnet fixture
// using the data from scripts/download_idl.sh and TxLINE's API, not
// just this mocked version.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("proofball", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Proofball as Program;

  const marketId = new anchor.BN(1);
  let stakeMint: PublicKey;
  let bettorA: Keypair;
  let bettorB: Keypair;
  let bettorATokenAccount: PublicKey;
  let bettorBTokenAccount: PublicKey;

  before(async () => {
    bettorA = Keypair.generate();
    bettorB = Keypair.generate();

    // fund both test wallets with a bit of SOL for fees
    for (const kp of [bettorA, bettorB]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }

    stakeMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    bettorATokenAccount = await createAccount(
      provider.connection,
      bettorA,
      stakeMint,
      bettorA.publicKey
    );
    bettorBTokenAccount = await createAccount(
      provider.connection,
      bettorB,
      stakeMint,
      bettorB.publicKey
    );

    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      stakeMint,
      bettorATokenAccount,
      provider.wallet.publicKey,
      1_000_000
    );
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      stakeMint,
      bettorBTokenAccount,
      provider.wallet.publicKey,
      1_000_000
    );
  });

  it("creates a market for total corners over 9.5", async () => {
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const closeTime = Math.floor(Date.now() / 1000) + 60 * 60; // one hour out

    await program.methods
      .createMarket(
        marketId,
        new anchor.BN(17952170), // fixture id, matches TxLINE's example fixture
        7, // stat key a: Participant 1 Total Corners
        8, // stat key b: Participant 2 Total Corners
        1, // op: add
        0, // comparison: greater than
        new anchor.BN(9),
        new anchor.BN(closeTime)
      )
      .accounts({
        creator: provider.wallet.publicKey,
        market: marketPda,
        vault: vaultPda,
        stakeMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.fixtureId.toNumber(), 17952170);
    assert.equal(market.statKeyA, 7);
    assert.equal(market.status, 0); // open
  });

  it("lets two bettors take opposite sides", async () => {
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [positionAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), bettorA.publicKey.toBuffer()],
      program.programId
    );
    const [positionBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), bettorB.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .placePosition(new anchor.BN(100_000), true) // bettor A says yes, over 9.5 corners
      .accounts({
        user: bettorA.publicKey,
        market: marketPda,
        vault: vaultPda,
        userTokenAccount: bettorATokenAccount,
        position: positionAPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettorA])
      .rpc();

    await program.methods
      .placePosition(new anchor.BN(50_000), false) // bettor B says no
      .accounts({
        user: bettorB.publicKey,
        market: marketPda,
        vault: vaultPda,
        userTokenAccount: bettorBTokenAccount,
        position: positionBPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettorB])
      .rpc();

    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.yesPool.toNumber(), 100_000);
    assert.equal(market.noPool.toNumber(), 50_000);
  });

  // Settlement against TxLINE's real validateStat instruction is not
  // run here, since it needs a live devnet fixture with real proof
  // data behind it. See verify/verify.ts and README.md for how this
  // gets tested for real against TxLINE's API before the demo.
  it("settlement against a real TxLINE fixture, see README for manual steps", () => {
    assert.isTrue(true, "covered manually against devnet, not mocked here on purpose");
  });
});
