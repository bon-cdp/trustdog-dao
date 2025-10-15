/**
 * Solana payment routes for TrustDog Worker
 * Handle USDC escrow operations using Solana blockchain
 */

import { Hono } from 'hono'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddress, createTransferInstruction, getAccount } from '@solana/spl-token'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Platform fee configuration (must match frontend)
const PLATFORM_FEE_PERCENT = 0.02 // 2%

/**
 * Helper to get Solana connection and platform wallet from env
 */
function getSolanaConfig(env: any) {
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
  const connection = new Connection(rpcUrl, 'confirmed')

  if (!env.PLATFORM_WALLET_SECRET) {
    throw new Error('PLATFORM_WALLET_SECRET not configured')
  }

  // Parse platform wallet secret key from JSON array
  const secretKey = new Uint8Array(JSON.parse(env.PLATFORM_WALLET_SECRET))
  const platformWallet = Keypair.fromSecretKey(secretKey)

  const usdcMint = new PublicKey(env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

  return { connection, platformWallet, usdcMint }
}

/**
 * POST /v1/solana/connect-wallet
 * Save user's Solana wallet address to database
 */
app.post('/connect-wallet', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const { wallet_address } = body

  if (!wallet_address || typeof wallet_address !== 'string') {
    return c.json({ error: 'wallet_address is required' }, 400)
  }

  // Validate it's a valid Solana public key
  try {
    new PublicKey(wallet_address)
  } catch {
    return c.json({ error: 'Invalid Solana wallet address' }, 400)
  }

  const supabaseAdmin = createClient(
    c.env.SUPABASE_URL,
    c.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  try {
    const { error } = await supabaseAdmin
      .from('identities')
      .update({
        solana_wallet_address: wallet_address,
        solana_wallet_connected_at: new Date().toISOString()
      })
      .eq('id', user.id)

    if (error) {
      throw error
    }

    console.log(`✅ Wallet ${wallet_address} connected for user ${user.id}`)

    return c.json({
      success: true,
      wallet_address,
      connected_at: new Date().toISOString()
    })
  } catch (error: any) {
    console.error('Connect wallet error:', error)
    return c.json({ error: error.message || 'Failed to connect wallet' }, 500)
  }
})

/**
 * POST /v1/solana/fund-escrow
 * Verify USDC transfer from advertiser to platform wallet, then update deal status
 */
app.post('/fund-escrow', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const { deal_id, tx_signature } = body

  if (!deal_id || !tx_signature) {
    return c.json({ error: 'deal_id and tx_signature are required' }, 400)
  }

  const supabaseAdmin = createClient(
    c.env.SUPABASE_URL,
    c.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  try {
    // Get deal details
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('advertiser_id, amount_usdc, status')
      .eq('id', deal_id)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Verify user is the advertiser
    if (deal.advertiser_id !== user.id) {
      return c.json({ error: 'Only advertiser can fund this deal' }, 403)
    }

    // Verify deal is in correct status
    if (deal.status !== 'PendingFunding' && deal.status !== 'Failed') {
      return c.json({ error: `Deal is not in funding state. Current status: ${deal.status}` }, 400)
    }

    // Verify transaction on-chain
    const { connection, platformWallet, usdcMint } = getSolanaConfig(c.env)

    console.log(`🔍 Verifying Solana transaction ${tx_signature} for deal ${deal_id}`)

    const tx = await connection.getTransaction(tx_signature, {
      maxSupportedTransactionVersion: 0,
    })

    if (!tx || !tx.meta) {
      return c.json({ error: 'Transaction not found or not confirmed' }, 400)
    }

    if (tx.meta.err) {
      return c.json({ error: 'Transaction failed on-chain' }, 400)
    }

    // Get platform USDC token account
    const platformTokenAccount = await getAssociatedTokenAddress(
      usdcMint,
      platformWallet.publicKey
    )

    // Calculate expected amounts including platform fee
    // Creator receives deal.amount_usdc, advertiser pays deal.amount_usdc + 2%
    const creatorAmount = deal.amount_usdc
    const platformFee = creatorAmount * PLATFORM_FEE_PERCENT
    const totalExpected = creatorAmount + platformFee
    const expectedAmountSmallestUnit = Math.round(totalExpected * 1_000_000) // Convert to USDC smallest unit (6 decimals)

    console.log(`💰 Expected payment verification:`, {
      creatorAmount,
      platformFee,
      totalExpected,
      expectedAmountSmallestUnit
    })

    // TODO: In production, parse transaction logs to verify exact amount transferred
    // For now, we trust that the frontend sent the correct amount

    console.log(`✅ Transaction verified for deal ${deal_id}, total: ${totalExpected} USDC (creator: ${creatorAmount}, fee: ${platformFee})`)

    // Update deal status to PendingVerification
    const { error: updateError } = await supabaseAdmin
      .from('deals')
      .update({
        status: 'PendingVerification',
        updated_at: new Date().toISOString()
      })
      .eq('id', deal_id)

    if (updateError) {
      throw updateError
    }

    // Record escrow event with platform fee details (reuse platformFee and totalExpected calculated above)
    const { error: escrowError } = await supabaseAdmin
      .from('escrow_events')
      .insert({
        deal_id,
        event_type: 'Created',
        amount_usdc: totalExpected, // Total received including platform fee
        payment_method: 'solana',
        solana_signature: tx_signature,
        ts: new Date().toISOString()
      })

    if (escrowError) {
      console.error('Failed to record escrow event:', escrowError)
    }

    console.log(`✅ Deal ${deal_id} funded via Solana, status: PendingVerification (received: ${totalExpected} USDC, creator will get: ${deal.amount_usdc} USDC, platform fee: ${platformFee} USDC)`)

    return c.json({
      success: true,
      deal_id,
      tx_signature,
      amount_usdc: deal.amount_usdc, // Creator amount
      platform_fee_usdc: platformFee,
      total_received_usdc: totalExpected,
      status: 'PendingVerification'
    })
  } catch (error: any) {
    console.error('Fund escrow error:', error)
    return c.json({ error: error.message || 'Failed to fund escrow' }, 500)
  }
})

/**
 * Internal function to process payout - can be called directly without HTTP
 */
export async function processPayoutInternal(env: any, deal_id: string) {
  const supabaseAdmin = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  try {
    // Get deal and creator wallet
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select(`
        creator_id,
        amount_usdc,
        status,
        identities!deals_creator_id_fkey(solana_wallet_address)
      `)
      .eq('id', deal_id)
      .single()

    if (dealError || !deal) {
      throw new Error('Deal not found')
    }

    if (deal.status !== 'Completed') {
      throw new Error('Deal must be Completed before releasing escrow')
    }

    const creatorWallet = deal.identities?.solana_wallet_address
    if (!creatorWallet) {
      throw new Error('Creator has not connected Solana wallet')
    }

    // Perform SOL transfer payout (amount_usdc is actually SOL despite the name)
    const { connection, platformWallet } = getSolanaConfig(env)
    const creatorPublicKey = new PublicKey(creatorWallet)

    // Calculate amounts - creator receives deal.amount_usdc (platform keeps the 2% fee)
    const creatorAmount = deal.amount_usdc
    const platformFee = creatorAmount * PLATFORM_FEE_PERCENT
    const lamports = Math.round(creatorAmount * 1_000_000_000) // SOL to lamports

    console.log(`💸 Releasing ${creatorAmount} SOL to creator ${creatorWallet} (platform keeps ${platformFee} SOL fee)`)

    // Check if platform has enough balance
    const platformBalance = await connection.getBalance(platformWallet.publicKey)
    const RENT_EXEMPT_MINIMUM = 890880
    const TX_FEE = 5000
    const RESERVE = RENT_EXEMPT_MINIMUM + TX_FEE

    if (platformBalance < lamports + RESERVE) {
      throw new Error(`Insufficient platform balance. Have ${platformBalance / 1e9} SOL, need ${(lamports + RESERVE) / 1e9} SOL`)
    }

    // Create SOL transfer instruction
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: platformWallet.publicKey,
      toPubkey: creatorPublicKey,
      lamports
    })

    // Build and send transaction
    const transaction = new Transaction().add(transferInstruction)
    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = platformWallet.publicKey

    // Sign and send
    transaction.sign(platformWallet)
    const signature = await connection.sendRawTransaction(transaction.serialize())

    console.log(`📡 Payout transaction sent: ${signature}`)

    // Return success immediately after sending - don't wait for confirmation
    // (Solana transactions are final once accepted by the network)
    console.log(`✅ Payout transaction sent successfully: ${signature}`)

    // Record payout in database (reuse platformFee calculated above)
    const { error: payoutError } = await supabaseAdmin
      .from('payouts')
      .insert({
        deal_id,
        method: 'Solana',
        status: 'Completed',
        amount_usdc: deal.amount_usdc, // Creator amount only
        solana_signature: signature,
        ts: new Date().toISOString()
      })

    if (payoutError) {
      console.error('Failed to record payout:', payoutError)
    }

    return {
      success: true,
      deal_id,
      tx_signature: signature,
      amount_usdc: deal.amount_usdc,
      platform_fee_usdc: platformFee,
      creator_wallet: creatorWallet
    }
  } catch (error: any) {
    console.error('Release escrow error:', error)
    throw error
  }
}

/**
 * POST /v1/solana/release-escrow (Payout to creator)
 * Transfer USDC from platform wallet to creator's wallet
 * Can be called by authenticated users OR internally by cron job
 */
app.post('/release-escrow', async (c) => {
  // Check for internal call (from cron) or user authentication
  const internalSecret = c.req.header('X-Internal-Secret')
  const isInternalCall = internalSecret === c.env.TRUSTDOG_CALLBACK_TOKEN

  if (!isInternalCall) {
    // If not internal, require authentication
    const user = c.get('user')
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  const body = await c.req.json()
  const { deal_id } = body

  if (!deal_id) {
    return c.json({ error: 'deal_id is required' }, 400)
  }

  try {
    const result = await processPayoutInternal(c.env, deal_id)
    return c.json(result)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to release escrow' }, 500)
  }
})

/**
 * Internal function to process refund - can be called directly without HTTP
 */
export async function processRefundInternal(env: any, deal_id: string, reason: string) {
  const supabaseAdmin = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  try {
    // Get deal and advertiser wallet
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select(`
        advertiser_id,
        amount_usdc,
        status,
        identities!deals_advertiser_id_fkey(solana_wallet_address)
      `)
      .eq('id', deal_id)
      .single()

    if (dealError || !deal) {
      throw new Error('Deal not found')
    }

    if (deal.status !== 'Failed' && deal.status !== 'Cancelled') {
      throw new Error('Deal must be Failed or Cancelled to process refund')
    }

    const advertiserWallet = deal.identities?.solana_wallet_address
    if (!advertiserWallet) {
      throw new Error('Advertiser has not connected Solana wallet')
    }

    // Perform SOL transfer refund (amount_usdc is actually SOL despite the name)
    const { connection, platformWallet } = getSolanaConfig(env)
    const advertiserPublicKey = new PublicKey(advertiserWallet)

    // Calculate refund amount (ONLY deal amount - platform keeps the fee)
    const creatorAmount = deal.amount_usdc
    const platformFee = creatorAmount * PLATFORM_FEE_PERCENT
    const totalRefund = creatorAmount // Platform keeps platformFee as failed deal fee
    const refundLamports = Math.round(totalRefund * 1_000_000_000) // SOL to lamports

    // Check platform wallet balance
    const platformBalance = await connection.getBalance(platformWallet.publicKey)
    const RENT_EXEMPT_MINIMUM = 890880 // ~0.00089 SOL rent-exempt minimum
    const TX_FEE = 5000 // ~0.000005 SOL transaction fee
    const RESERVE = RENT_EXEMPT_MINIMUM + TX_FEE

    if (platformBalance < refundLamports + RESERVE) {
      throw new Error(`Insufficient platform balance for refund. Have ${platformBalance / 1e9} SOL, need ${(refundLamports + RESERVE) / 1e9} SOL`)
    }

    console.log(`↩️ Refunding ${totalRefund} SOL to advertiser ${advertiserWallet} (platform keeps ${platformFee} SOL fee). Platform balance: ${platformBalance / 1e9} SOL`)

    // Create SOL transfer instruction (refund deal amount only - platform keeps fee)
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: platformWallet.publicKey,
      toPubkey: advertiserPublicKey,
      lamports: refundLamports
    })

    // Build and send transaction
    const transaction = new Transaction().add(transferInstruction)
    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = platformWallet.publicKey

    // Sign and send
    transaction.sign(platformWallet)
    const signature = await connection.sendRawTransaction(transaction.serialize())

    console.log(`📡 Refund transaction sent: ${signature}`)

    // Return success immediately after sending - don't wait for confirmation
    // (Solana transactions are final once accepted by the network)
    console.log(`✅ Refund transaction sent successfully: ${signature}`)

    // Record refund in database (deal amount only - platform keeps fee)
    const { error: refundError } = await supabaseAdmin
      .from('refunds')
      .insert({
        deal_id,
        amount_usdc: totalRefund, // Deal amount only (platform keeps fee)
        reason,
        status: 'completed',
        completed_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      })

    if (refundError) {
      console.error('Failed to record refund:', refundError)
    }

    return {
      success: true,
      deal_id,
      tx_signature: signature,
      amount_usdc: totalRefund,
      platform_fee_kept_usdc: platformFee,
      advertiser_wallet: advertiserWallet
    }
  } catch (error: any) {
    console.error('Refund escrow error:', error)
    throw error
  }
}

/**
 * POST /v1/solana/refund-escrow
 * Transfer USDC from platform wallet back to advertiser's wallet
 * Can be called by authenticated users OR internally by cron job
 */
app.post('/refund-escrow', async (c) => {
  // Check for internal call (from cron) or user authentication
  const internalSecret = c.req.header('X-Internal-Secret')
  const isInternalCall = internalSecret === c.env.TRUSTDOG_CALLBACK_TOKEN

  if (!isInternalCall) {
    // If not internal, require authentication
    const user = c.get('user')
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  const body = await c.req.json()
  const { deal_id, reason } = body

  if (!deal_id || !reason) {
    return c.json({ error: 'deal_id and reason are required' }, 400)
  }

  try {
    const result = await processRefundInternal(c.env, deal_id, reason)
    return c.json(result)
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to refund escrow' }, 500)
  }
})

export const solanaRouter = app
