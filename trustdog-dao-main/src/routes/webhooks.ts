/**
 * Webhooks API routes for TrustDog Worker
 * Handle inbound webhooks from Stripe and other providers
 */

import { Hono } from 'hono'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const app = new Hono()

// Stripe webhook handler - LEGACY (Solana payments are now primary)
// Keep this for backward compatibility with existing Stripe deals
app.post('/stripe', async (c) => {
  console.log('⚠️ Legacy Stripe webhook called - all new deals should use Solana')

  const signature = c.req.header('stripe-signature')
  const body = await c.req.text()

  if (!signature) {
    return c.json({ error: 'Missing Stripe signature' }, 400)
  }

  console.log('🔐 Webhook signature received:', signature?.substring(0, 20) + '...')
  console.log('🔑 Using webhook secret:', c.env.STRIPE_WEBHOOK_SECRET?.substring(0, 15) + '...')
  console.log('📦 Body length:', body.length)

  try {
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    // Verify webhook signature (use async version for Cloudflare Workers)
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    )

    console.log('Legacy Stripe webhook received:', event.type)

    // Use service role for webhook operations to bypass RLS
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

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        const dealId = paymentIntent.metadata.deal_id

        console.log('💳 Payment intent succeeded:', {
          dealId,
          amount: paymentIntent.amount,
          status: paymentIntent.status,
          hasCharges: !!paymentIntent.charges,
          chargesData: paymentIntent.charges?.data?.length
        })

        if (dealId) {
          // Simplified validation - trust Stripe's payment_intent.succeeded event
          // The event only fires when payment is complete, so we don't need to double-check charges
          const isValidPayment = paymentIntent.status === 'succeeded' && !paymentIntent.next_action

          console.log('✓ Payment validation:', {
            status: paymentIntent.status,
            hasNextAction: !!paymentIntent.next_action,
            isValid: isValidPayment
          })

          if (isValidPayment) {
            console.log(`💰 Creating escrow event for deal ${dealId}...`)

            // Record escrow funding event directly
            const { data: escrowData, error: escrowError } = await supabase.from('escrow_events').insert({
              deal_id: dealId,
              event_type: 'Created',
              amount_usdc: paymentIntent.amount / 100, // Convert cents to dollars
              tx_ref: paymentIntent.id
            }).select()

            if (escrowError) {
              console.error(`❌ Failed to create escrow event:`, escrowError)
            } else {
              console.log(`✅ Escrow event created:`, escrowData)
            }

            console.log(`🔄 Updating deal ${dealId} status to PendingVerification...`)

            // Update deal status to PendingVerification (funded and ready for verification)
            // Accept transitions from both PendingFunding and Failed (retry scenario)
            // IMPORTANT: Clear failure_reason on successful retry
            const { data: updatedDeal, error: updateError} = await supabase
              .from('deals')
              .update({
                status: 'PendingVerification',
                failure_reason: null  // Clear any previous payment failure message
              })
              .eq('id', dealId)
              .in('status', ['PendingFunding', 'Failed'])
              .select()

            if (updateError) {
              console.error(`❌ Failed to update deal ${dealId} status:`, updateError)
            } else if (!updatedDeal || updatedDeal.length === 0) {
              console.warn(`⚠️ Deal ${dealId} not updated - may not be in correct status`)
            } else {
              console.log(`✅ Deal ${dealId} funded via Stripe: ${paymentIntent.id}`, updatedDeal)
            }
          } else {
            console.log('🔥 FUNDING FAILED HANDLED:', { dealId, paymentIntentId: paymentIntent.id, reason: 'Payment not fully successful' })

            // Set funding failed status
            await supabase
              .from('deals')
              .update({
                status: 'Failed',
                failure_reason: 'Payment validation failed - charge not paid or requires additional action'
              })
              .eq('id', dealId)
              .eq('status', 'PendingFunding')
          }
        }
        break
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        const dealId = paymentIntent.metadata.deal_id

        if (dealId) {
          console.log('🔥 FUNDING FAILED HANDLED:', { dealId, paymentIntentId: paymentIntent.id, reason: 'Payment failed' })

          // Allow transitions from both PendingFunding and Failed (for retry scenarios)
          const { data: updatedDeal, error: updateError } = await supabase
            .from('deals')
            .update({
              status: 'Failed',
              failure_reason: `Payment failed: ${paymentIntent.last_payment_error?.message || 'Unknown error'}`
            })
            .eq('id', dealId)
            .in('status', ['PendingFunding', 'Failed'])
            .select()

          if (updateError) {
            console.error(`❌ Failed to update deal ${dealId} to Failed:`, updateError)
          } else if (updatedDeal && updatedDeal.length > 0) {
            console.log(`✅ Deal ${dealId} marked as Failed - retry is possible`)
          }
        }
        break
      }

      case 'account.updated': {
        const account = event.data.object as Stripe.Account
        const creatorId = account.metadata?.creator_id

        if (creatorId) {
          const payoutsEnabled = account.capabilities?.transfers === 'active'
          const detailsSubmitted = account.details_submitted || false

          // Update creator's Stripe status
          await supabase
            .from('identities')
            .update({
              stripe_payouts_enabled: payoutsEnabled,
              stripe_details_submitted: detailsSubmitted,
              stripe_onboarding_completed: detailsSubmitted
            })
            .eq('id', creatorId)

          console.log(`✅ Updated Stripe status for creator ${creatorId}:`, {
            payoutsEnabled,
            detailsSubmitted
          })
        }
        break
      }

      case 'transfer.created': {
        const transfer = event.data.object as Stripe.Transfer
        const dealId = transfer.metadata.deal_id

        if (dealId) {
          // Record transfer creation (pending status)
          await supabase.from('payouts').insert({
            deal_id: dealId,
            method: 'stripe',
            status: 'Initiated',
            stripe_transfer_id: transfer.id,
            destination_account_id: transfer.destination as string,
            amount_usdc: transfer.amount / 100, // Convert cents to dollars
            provider_ref: transfer.id
          })

          console.log(`💸 Transfer created for deal ${dealId}: ${transfer.id}`)
        }
        break
      }

      case 'transfer.paid': {
        const transfer = event.data.object as Stripe.Transfer
        const dealId = transfer.metadata.deal_id

        if (dealId) {
          // Update payout status to Paid
          await supabase
            .from('payouts')
            .update({
              status: 'Paid',
              ts: new Date().toISOString()
            })
            .eq('stripe_transfer_id', transfer.id)

          console.log(`✅ Transfer paid for deal ${dealId}: ${transfer.id}`)
        }
        break
      }

      case 'transfer.failed': {
        const transfer = event.data.object as Stripe.Transfer
        const dealId = transfer.metadata.deal_id

        if (dealId) {
          const failureMessage = transfer.failure_message || 'Unknown transfer failure'

          // Update payout status to failed
          await supabase
            .from('payouts')
            .update({
              status: 'failed',
              failure_reason: failureMessage
            })
            .eq('stripe_transfer_id', transfer.id)

          console.error(`❌ Transfer failed for deal ${dealId}: ${failureMessage}`)

          // TODO: Notify admin about failed transfer
        }
        break
      }

      case 'refund.created': {
        const refund = event.data.object as Stripe.Refund
        const paymentIntentId = typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id

        if (paymentIntentId) {
          // Find deal associated with this payment intent
          const { data: escrowEvents } = await supabase
            .from('escrow_events')
            .select('deal_id')
            .eq('tx_ref', paymentIntentId)
            .limit(1)

          if (escrowEvents && escrowEvents.length > 0) {
            const dealId = escrowEvents[0].deal_id

            // Update refund status to processing
            await supabase
              .from('refunds')
              .update({
                status: 'processing',
                stripe_refund_id: refund.id
              })
              .eq('deal_id', dealId)
              .eq('status', 'pending')

            console.log(`🔄 Refund processing for deal ${dealId}: ${refund.id}`)
          }
        }
        break
      }

      case 'charge.refunded': {
        // This event fires when a refund is successfully completed
        const charge = event.data.object as Stripe.Charge
        const paymentIntentId = typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id

        if (paymentIntentId) {
          const { data: escrowEvents } = await supabase
            .from('escrow_events')
            .select('deal_id')
            .eq('tx_ref', paymentIntentId)
            .limit(1)

          if (escrowEvents && escrowEvents.length > 0) {
            const dealId = escrowEvents[0].deal_id

            // Get the latest refund for this charge
            const latestRefund = charge.refunds?.data?.[0]
            if (latestRefund) {
              await supabase
                .from('refunds')
                .update({
                  status: 'completed',
                  completed_at: new Date().toISOString()
                })
                .eq('stripe_refund_id', latestRefund.id)

              console.log(`✅ Refund completed for deal ${dealId}: ${latestRefund.id}`)
            }
          }
        }
        break
      }

      case 'refund.failed': {
        const refund = event.data.object as Stripe.Refund
        const paymentIntentId = typeof refund.payment_intent === 'string'
          ? refund.payment_intent
          : refund.payment_intent?.id

        if (paymentIntentId) {
          const { data: escrowEvents } = await supabase
            .from('escrow_events')
            .select('deal_id')
            .eq('tx_ref', paymentIntentId)
            .limit(1)

          if (escrowEvents && escrowEvents.length > 0) {
            const dealId = escrowEvents[0].deal_id

            await supabase
              .from('refunds')
              .update({
                status: 'failed',
                failure_reason: refund.failure_reason || 'Refund failed'
              })
              .eq('stripe_refund_id', refund.id)

            console.error(`❌ Refund failed for deal ${dealId}: ${refund.failure_reason}`)

            // TODO: Notify admin about failed refund
          }
        }
        break
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute
        console.warn('Stripe dispute created:', dispute.id)

        // Check if this dispute relates to a deal
        const charge = dispute.charge as Stripe.Charge
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id

        if (paymentIntentId) {
          // Find deals with this payment intent
          const { data: deals } = await supabase
            .from('escrow_events')
            .select('deal_id')
            .eq('tx_ref', paymentIntentId)

          if (deals && deals.length > 0) {
            const dealId = deals[0].deal_id
            console.log('🔥 FUNDING FAILED HANDLED:', { dealId, disputeId: dispute.id, reason: 'Charge disputed' })

            await supabase
              .from('deals')
              .update({
                status: 'Failed',
                failure_reason: `Payment disputed: ${dispute.reason}`
              })
              .eq('id', dealId)
              .in('status', ['PendingVerification', 'Verifying']) // Only revert if not yet completed
          }
        }
        break
      }

      default:
        console.log(`Unhandled Stripe event type: ${event.type}`)
    }

    return c.json({ received: true })
  } catch (error: any) {
    console.error('Stripe webhook error:', error)
    return c.json({ error: 'Webhook verification failed' }, 400)
  }
})

// Browserless callback webhook (for scraper results)
app.post('/browserless', async (c) => {
  const body = await c.req.json()
  const { deal_id, run_id, status, artifacts, candidates, error } = body

  console.log('Browserless callback received:', { deal_id, run_id, status })

  try {
    // Use service role for webhook operations to bypass RLS
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

    if (status === 'completed') {
      // Process candidates
      if (candidates) {
        for (const candidate of candidates) {
          await supabase.rpc('verification_rpcs', {
            action: 'upsert_candidate',
            payload: {
              deal_id,
              platform: candidate.platform,
              platform_post_id: candidate.platform_post_id,
              seen_at: candidate.seen_at
            }
          })
        }
      }

      // Store artifacts
      if (artifacts) {
        for (const artifact of artifacts) {
          await supabase.from('artifacts').insert({
            type: artifact.type,
            ref: artifact.ref,
            sha256: artifact.sha256,
            meta: artifact.meta
          })
        }
      }

      // Trigger inference if we have candidates
      if (candidates && candidates.length > 0) {
        // This would normally trigger Qwen API call
        console.log(`Triggering inference for deal ${deal_id} with ${candidates.length} candidates`)
      }
    } else if (status === 'failed') {
      console.error('Browserless job failed:', error)

      // Update run status
      await supabase
        .from('runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          notes: error
        })
        .eq('id', run_id)
    }

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Browserless callback error:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Qwen API callback webhook (for inference results)
app.post('/qwen', async (c) => {
  const body = await c.req.json()
  const { run_id, observations, proof_outcome, confidence_scores } = body

  console.log('Qwen callback received:', { run_id, proof_outcome })

  try {
    // Use service role for webhook operations to bypass RLS
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

    // Insert observations
    if (observations) {
      await supabase.rpc('verification_rpcs', {
        action: 'insert_observations',
        payload: {
          run_id,
          observations
        }
      })
    }

    // Complete run with outcome
    await supabase.rpc('verification_rpcs', {
      action: 'complete_run',
      payload: {
        run_id,
        proof_outcome,
        notes: `Confidence scores: ${JSON.stringify(confidence_scores)}`
      }
    })

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Qwen callback error:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Manual payment completion endpoint for MVP testing
app.post('/manual-complete-payment', async (c) => {
  const { dealId, paymentIntentId, amount } = await c.req.json()

  console.log('Manual payment completion:', { dealId, paymentIntentId, amount })

  try {
    // Use service role for manual operations
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

    // Record escrow funding event
    await supabase.from('escrow_events').insert({
      deal_id: dealId,
      event_type: 'Created',
      amount_usdc: amount,
      tx_ref: paymentIntentId || `manual-${Date.now()}`
    })

    // Update deal status to PendingVerification
    const { data, error } = await supabase
      .from('deals')
      .update({
        status: 'PendingVerification'
      })
      .eq('id', dealId)
      .eq('status', 'PendingFunding')
      .select()

    if (error) {
      console.error('Manual payment completion error:', error)
      return c.json({ error: error.message }, 500)
    }

    if (!data || data.length === 0) {
      return c.json({ error: 'Deal not found or not in PendingFunding status' }, 404)
    }

    console.log(`Deal ${dealId} manually marked as funded`)
    return c.json({ success: true, updated: data[0] })
  } catch (error: any) {
    console.error('Manual payment completion error:', error)
    return c.json({ error: error.message }, 500)
  }
})

export const webhooksRouter = app