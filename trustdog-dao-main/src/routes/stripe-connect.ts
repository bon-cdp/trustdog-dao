/**
 * Stripe Connect API routes for TrustDog Worker
 * Handle creator onboarding and payout account management
 */

import { Hono } from 'hono'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'

const app = new Hono()

// Apply auth middleware to all Stripe Connect routes
app.use('*', authMiddleware)

/**
 * POST /v1/stripe-connect/onboarding-link
 * Generate Stripe Connect onboarding link for creator
 *
 * Request body:
 * {
 *   "creatorId": "uuid" // Identity ID of the creator
 * }
 *
 * Response:
 * {
 *   "url": "https://connect.stripe.com/setup/...",
 *   "accountId": "acct_xxx"
 * }
 */
app.post('/onboarding-link', async (c) => {
  try {
    // Get authenticated user from context (set by auth middleware)
    const user = c.get('user')
    if (!user || !user.id) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const creatorId = user.id

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    // Use service role to update identities table
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

    // Get creator identity
    const { data: creator, error: fetchError } = await supabase
      .from('identities')
      .select('id, email, stripe_connect_account_id')
      .eq('id', creatorId)
      .single()

    if (fetchError || !creator) {
      return c.json({ error: 'Creator not found' }, 404)
    }

    let accountId = creator.stripe_connect_account_id

    // Create Stripe Connect account if doesn't exist
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'CA', // Canada - supports both card_payments and transfers
        email: creator.email,
        capabilities: {
          card_payments: { requested: true }, // Required for transfers
          transfers: { requested: true }
        },
        metadata: {
          creator_id: creatorId
        }
      })

      accountId = account.id

      // Store account ID in database
      const { error: updateError } = await supabase
        .from('identities')
        .update({
          stripe_connect_account_id: accountId
        })
        .eq('id', creatorId)

      if (updateError) {
        console.error('Failed to store Stripe account ID:', updateError)
        return c.json({ error: 'Failed to save account information' }, 500)
      }

      console.log(`✅ Created Stripe Connect account for creator ${creatorId}: ${accountId}`)
    }

    // Generate account onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `https://trustdog.co/settings?connect=refresh`,
      return_url: `https://trustdog.co/settings?connect=success`,
      type: 'account_onboarding'
    })

    console.log(`🔗 Generated onboarding link for creator ${creatorId}`)

    return c.json({
      url: accountLink.url,
      accountId
    })

  } catch (error: any) {
    console.error('Stripe Connect onboarding error:', error)
    return c.json({ error: error.message || 'Failed to create onboarding link' }, 500)
  }
})

/**
 * GET /v1/stripe-connect/account-status
 * Check creator's Stripe Connect account status
 *
 * Query params:
 * - creatorId: uuid
 *
 * Response:
 * {
 *   "connected": true,
 *   "payoutsEnabled": true,
 *   "detailsSubmitted": true,
 *   "accountId": "acct_xxx"
 * }
 */
app.get('/account-status', async (c) => {
  try {
    // Get authenticated user from context
    const user = c.get('user')
    if (!user || !user.id) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const creatorId = user.id

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

    // Get creator with Stripe info
    const { data: creator, error: fetchError } = await supabase
      .from('identities')
      .select('stripe_connect_account_id, stripe_onboarding_completed, stripe_payouts_enabled, stripe_details_submitted')
      .eq('id', creatorId)
      .single()

    if (fetchError || !creator) {
      return c.json({ error: 'Creator not found' }, 404)
    }

    if (!creator.stripe_connect_account_id) {
      return c.json({
        connected: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        accountId: null
      })
    }

    // Fetch fresh status from Stripe
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
    const account = await stripe.accounts.retrieve(creator.stripe_connect_account_id)

    const payoutsEnabled = account.capabilities?.transfers === 'active'
    const detailsSubmitted = account.details_submitted || false

    // Update database with fresh status
    await supabase
      .from('identities')
      .update({
        stripe_payouts_enabled: payoutsEnabled,
        stripe_details_submitted: detailsSubmitted,
        stripe_onboarding_completed: detailsSubmitted
      })
      .eq('id', creatorId)

    return c.json({
      connected: true,
      payoutsEnabled,
      detailsSubmitted,
      accountId: creator.stripe_connect_account_id
    })

  } catch (error: any) {
    console.error('Stripe account status check error:', error)
    return c.json({ error: error.message || 'Failed to check account status' }, 500)
  }
})

/**
 * POST /v1/stripe-connect/refresh-link
 * Generate new onboarding link if incomplete
 *
 * Request body:
 * {
 *   "creatorId": "uuid"
 * }
 *
 * Response:
 * {
 *   "url": "https://connect.stripe.com/setup/..."
 * }
 */
app.post('/refresh-link', async (c) => {
  try {
    // Get authenticated user from context
    const user = c.get('user')
    if (!user || !user.id) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const creatorId = user.id

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

    const { data: creator, error: fetchError } = await supabase
      .from('identities')
      .select('stripe_connect_account_id')
      .eq('id', creatorId)
      .single()

    if (fetchError || !creator || !creator.stripe_connect_account_id) {
      return c.json({ error: 'No Stripe account found. Please start onboarding first.' }, 404)
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    // Generate fresh account link
    const accountLink = await stripe.accountLinks.create({
      account: creator.stripe_connect_account_id,
      refresh_url: `https://trustdog.co/settings?connect=refresh`,
      return_url: `https://trustdog.co/settings?connect=success`,
      type: 'account_onboarding'
    })

    console.log(`🔄 Generated refresh link for creator ${creatorId}`)

    return c.json({
      url: accountLink.url
    })

  } catch (error: any) {
    console.error('Stripe Connect refresh link error:', error)
    return c.json({ error: error.message || 'Failed to create refresh link' }, 500)
  }
})

/**
 * POST /v1/stripe-connect/dashboard-link
 * Generate link to Stripe Express Dashboard for connected account
 *
 * Request body: (empty)
 *
 * Response:
 * {
 *   "url": "https://connect.stripe.com/express/..."
 * }
 */
app.post('/dashboard-link', async (c) => {
  try {
    // Get authenticated user from context
    const user = c.get('user')
    if (!user || !user.id) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const creatorId = user.id

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

    const { data: creator, error: fetchError } = await supabase
      .from('identities')
      .select('stripe_connect_account_id')
      .eq('id', creatorId)
      .single()

    if (fetchError || !creator || !creator.stripe_connect_account_id) {
      return c.json({ error: 'No Stripe account found. Please connect first.' }, 404)
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    // Generate login link to Stripe Express Dashboard
    const loginLink = await stripe.accounts.createLoginLink(creator.stripe_connect_account_id)

    console.log(`📊 Generated dashboard link for creator ${creatorId}`)

    return c.json({
      url: loginLink.url
    })

  } catch (error: any) {
    console.error('Stripe dashboard link error:', error)
    return c.json({ error: error.message || 'Failed to create dashboard link' }, 500)
  }
})

/**
 * DELETE /v1/stripe-connect/disconnect
 * Disconnect Stripe account (optional - for creator to remove connection)
 *
 * Request body:
 * {
 *   "creatorId": "uuid"
 * }
 *
 * Response:
 * {
 *   "success": true
 * }
 */
app.delete('/disconnect', async (c) => {
  try {
    // Get authenticated user from context
    const user = c.get('user')
    if (!user || !user.id) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const creatorId = user.id

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

    // Clear Stripe Connect data from database
    const { error: updateError } = await supabase
      .from('identities')
      .update({
        stripe_connect_account_id: null,
        stripe_onboarding_completed: false,
        stripe_payouts_enabled: false,
        stripe_details_submitted: false
      })
      .eq('id', creatorId)

    if (updateError) {
      console.error('Failed to disconnect Stripe account:', updateError)
      return c.json({ error: 'Failed to disconnect account' }, 500)
    }

    console.log(`🔌 Disconnected Stripe account for creator ${creatorId}`)

    return c.json({ success: true })

  } catch (error: any) {
    console.error('Stripe Connect disconnect error:', error)
    return c.json({ error: error.message || 'Failed to disconnect account' }, 500)
  }
})

export const stripeConnectRouter = app
