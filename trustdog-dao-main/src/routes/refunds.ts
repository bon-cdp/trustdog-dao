/**
 * Refunds API routes for TrustDog Worker
 * Handle refund processing when deals fail or are cancelled
 */

import { Hono } from 'hono'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

/**
 * POST /v1/refunds/process
 * Process refund for a failed or cancelled deal
 *
 * Request body:
 * {
 *   "dealId": "uuid",
 *   "reason": "verification_failed" | "deadline_missed" | "dispute" | "manual",
 *   "initiatedBy": "uuid" (optional - admin who initiated manual refund)
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "refundId": "uuid",
 *   "stripeRefundId": "re_xxx"
 * }
 */
app.post('/process', async (c) => {
  const { dealId, reason, initiatedBy } = await c.req.json()

  if (!dealId || !reason) {
    return c.json({ error: 'dealId and reason are required' }, 400)
  }

  const validReasons = ['verification_failed', 'deadline_missed', 'dispute', 'manual']
  if (!validReasons.includes(reason)) {
    return c.json({ error: `Invalid reason. Must be one of: ${validReasons.join(', ')}` }, 400)
  }

  try {
    // Use service role for refund operations
    const supabase = createClient(
      c.env.SUPABASE_URL,
      c.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    // Get original payment intent from escrow_events
    const { data: escrow, error: escrowError } = await supabase
      .from('escrow_events')
      .select('tx_ref, amount_usdc')
      .eq('deal_id', dealId)
      .eq('event_type', 'Created')
      .single()

    if (escrowError || !escrow) {
      return c.json({ error: 'No payment found for this deal' }, 404)
    }

    // Check if refund already exists
    const { data: existingRefund } = await supabase
      .from('refunds')
      .select('id, status')
      .eq('deal_id', dealId)
      .single()

    if (existingRefund) {
      if (existingRefund.status === 'completed') {
        return c.json({ error: 'Refund already completed for this deal' }, 400)
      }
      if (existingRefund.status === 'processing') {
        return c.json({ error: 'Refund already in progress for this deal' }, 400)
      }
    }

    // Create Stripe refund
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    const refundData: Stripe.RefundCreateParams = {
      payment_intent: escrow.tx_ref,
      reason: reason === 'dispute' ? 'fraudulent' : 'requested_by_customer',
      metadata: {
        deal_id: dealId,
        refund_reason: reason
      }
    }

    const stripeRefund = await stripe.refunds.create(refundData)

    console.log(`💰 Stripe refund created for deal ${dealId}: ${stripeRefund.id}`)

    // Record refund in database
    const { data: refund, error: refundError } = await supabase
      .from('refunds')
      .insert({
        deal_id: dealId,
        amount_usdc: escrow.amount_usdc,
        reason,
        stripe_refund_id: stripeRefund.id,
        status: 'processing',
        initiated_by: initiatedBy || null
      })
      .select()
      .single()

    if (refundError) {
      console.error('Failed to record refund in database:', refundError)
      return c.json({ error: 'Refund created but failed to record' }, 500)
    }

    // Update deal status to indicate refund
    await supabase
      .from('deals')
      .update({
        status: 'Cancelled',
        cancelled_at: new Date().toISOString(),
        failure_reason: `Refund processed: ${reason}`
      })
      .eq('id', dealId)

    // Record escrow refund event
    await supabase.from('escrow_events').insert({
      deal_id: dealId,
      event_type: 'Refunded',
      amount_usdc: escrow.amount_usdc,
      tx_ref: stripeRefund.id
    })

    console.log(`✅ Refund processed for deal ${dealId}: ${reason}`)

    return c.json({
      success: true,
      refundId: refund.id,
      stripeRefundId: stripeRefund.id,
      amount: escrow.amount_usdc,
      status: 'processing'
    })

  } catch (error: any) {
    console.error('Refund processing error:', error)
    return c.json({ error: error.message || 'Failed to process refund' }, 500)
  }
})

/**
 * GET /v1/refunds/status
 * Check refund status for a deal
 *
 * Query params:
 * - dealId: uuid
 *
 * Response:
 * {
 *   "refund": { ... },
 *   "status": "processing" | "completed" | "failed"
 * }
 */
app.get('/status', async (c) => {
  const dealId = c.req.query('dealId')

  if (!dealId) {
    return c.json({ error: 'dealId is required' }, 400)
  }

  try {
    const supabase = createClient(
      c.env.SUPABASE_URL,
      c.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    const { data: refund, error } = await supabase
      .from('refunds')
      .select('*')
      .eq('deal_id', dealId)
      .single()

    if (error || !refund) {
      return c.json({ error: 'No refund found for this deal' }, 404)
    }

    return c.json({
      refund,
      status: refund.status
    })

  } catch (error: any) {
    console.error('Refund status check error:', error)
    return c.json({ error: error.message || 'Failed to check refund status' }, 500)
  }
})

export const refundsRouter = app
