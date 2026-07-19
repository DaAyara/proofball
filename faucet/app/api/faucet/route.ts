import { NextResponse } from 'next/server'
import {
  Connection, Keypair, PublicKey, clusterApiUrl
} from '@solana/web3.js'
import {
  getOrCreateAssociatedTokenAccount, mintTo
} from '@solana/spl-token'

export const dynamic = 'force-dynamic'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const MINT = 'JsjcE84H8Mjgcgarwdz6c7gKCbEryngKmN6YM8BfBDn'
const AMOUNT = 100_000_000 // 100 test tokens

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders })
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const walletAddress = searchParams.get('wallet')

  if (!walletAddress) {
    return NextResponse.json({ error: 'wallet address required' }, { status: 400, headers: corsHeaders })
  }

  try {
    const payerSecret = JSON.parse(process.env.PAYER_SECRET_KEY!)
    const payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret))
    const conn = new Connection(clusterApiUrl('devnet'), 'confirmed')
    const mint = new PublicKey(MINT)
    const dest = new PublicKey(walletAddress)

    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, dest)
    const sig = await mintTo(conn, payer, mint, ata.address, payer, AMOUNT)

    return NextResponse.json({ success: true, sig }, { headers: corsHeaders })
  } catch (e: any) {
    console.error('Faucet error:', e)
    return NextResponse.json({ error: e.message }, { status: 500, headers: corsHeaders })
  }
}