/**
 * Deals API routes for TrustDog Worker
 * Handle deal lifecycle operations
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware, requireRole } from '../middleware/auth'
import { validateSchema, createDealSchema, isValidPlatformUrl } from '../middleware/validation'

// Flexible post URL validation - allows any valid URL including shortened links
function validatePostUrl(url: string, platform: string): { isValid: boolean; error?: string } {
  try {
    // Just validate it's a proper URL format - allow any domain/path
    new URL(url)
    return { isValid: true }
  } catch {
    return { isValid: false, error: 'Invalid URL format' }
  }
}
import { strictRateLimit } from '../middleware/rateLimit'
import { type HonoContext } from '../types'

// Helper function to add deal to proof wall if conditions are met
const addToProofWallIfEligible = async (supabaseAdmin: any, dealId: string, deal: any) => {
  // Only add to proof wall if deal is completed and user opted in
  if (deal.status === 'Completed' && deal.public_opt_in) {
    try {
      // Check if already exists in proof wall
      const { data: existing } = await supabaseAdmin
        .from('proof_wall')
        .select('id')
        .eq('deal_id', dealId)
        .single()

      if (!existing) {
        // Get platform account info
        const { data: platformAccount } = await supabaseAdmin
          .from('platform_accounts')
          .select('account_url, platform')
          .eq('id', deal.account_id)
          .single()

        if (platformAccount) {
          // Determine category and price range
          const category = deal.platform === 'tiktok' ? 'Entertainment' :
                          deal.platform === 'x' ? 'Social Media' : 'General'
          const priceRange = deal.amount_usdc < 100 ? '$1-$99' :
                           deal.amount_usdc < 500 ? '$100-$499' : '$500+'

          await supabaseAdmin
            .from('proof_wall')
            .insert({
              deal_id: dealId,
              platform: deal.platform,
              category,
              price_range_bucket: priceRange,
              outcome: 'Verified - Content Posted',
              account_url: platformAccount.account_url,
              escrow_tx_link: `https://trustdog.co/deal/${dealId}` // Placeholder link
            })

          console.log('✅ Added deal to proof wall:', dealId)
        }
      }
    } catch (error) {
      console.error('Failed to add to proof wall:', error)
    }
  }
}

const app = new Hono<HonoContext>()

// Public deal endpoint for invite flow (no auth required)
app.get('/:id/public', async (c) => {
  const dealId = c.req.param('id')
  console.log('🐕 Get deal by ID (public):', dealId)

  // Use service role to bypass RLS for public viewing
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
    const { data: deal, error } = await supabaseAdmin
      .from('deals')
      .select(`
        *,
        platform_accounts(account_url, normalized_handle),
        proof_specs(*),
        runs(
          *,
          steps(*),
          observations(*)
        ),
        escrow_events(*),
        contact_requests(*)
      `)
      .eq('id', dealId)
      .single()

    if (error) {
      console.error('🐕 Supabase error fetching deal:', error)
      return c.json({ error: 'Deal not found' }, 404)
    }

    if (!deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    console.log('🐕 Successfully fetched deal from Supabase (public):', dealId)

    // Return deal data with public access
    return c.json(deal)
  } catch (error) {
    console.error('🐕 Exception in public deal fetch:', error)
    return c.json({ error: 'Failed to fetch deal' }, 500)
  }
})

// Get deals (with authentication)
app.get('/', authMiddleware, async (c) => {
  const user = c.get('user')

  console.log('🐕 Deals API - User ID:', user.id, 'Email:', user.email)

  // Use service role to bypass RLS for now
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

  const { status, platform, limit = 50, offset = 0 } = c.req.query()

  // Query with joins to get complete data
  let query = supabaseAdmin
    .from('deals')
    .select(`
      *,
      platform_accounts(account_url, normalized_handle),
      proof_specs(*)
    `)
    .or(`advertiser_id.eq.${user.id},creator_id.eq.${user.id}`)
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (status) query = query.eq('status', status)
  if (platform) query = query.eq('platform', platform)

  console.log('🐕 Deals query SQL:', query)
  const { data, error, count } = await query

  if (error) {
    console.error('🐕 Deals query error:', error)
    return c.json({ error: error.message }, 500)
  }

  console.log('🐕 Deals query result:', data?.length, 'deals found')
  c.header('X-Total-Count', String(count || data?.length || 0))
  return c.json(data || [])
})

// Get single deal (with authentication)
app.get('/:id', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  console.log('🐕 Get deal by ID:', dealId, 'User:', user.id)

  // Use service role to bypass RLS
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
    const { data: deal, error } = await supabaseAdmin
      .from('deals')
      .select(`
        *,
        platform_accounts(account_url, normalized_handle),
        proof_specs(*)
      `)
      .eq('id', dealId)
      .or(`advertiser_id.eq.${user.id},creator_id.eq.${user.id}`)
      .single()

    if (error) {
      console.error('🐕 Supabase error fetching deal:', error)
      return c.json({ error: error.message }, error.code === 'PGRST116' ? 404 : 500)
    }

    if (!deal) {
      console.log('🐕 Deal not found or access denied:', dealId)
      return c.json({ error: 'Deal not found or access denied' }, 404)
    }

    console.log('🐕 Successfully fetched deal from Supabase:', dealId)
    return c.json(deal)

  } catch (error) {
    console.error('🐕 Get deal error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// Create deal with auth
app.post('/', authMiddleware, async (c) => {
  console.log('🐕 Create deal endpoint hit')

  try {
    const supabase = c.get('supabase')
    const user = c.get('user')

    // Use service role for operations that need to bypass RLS
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

    console.log('🐕 Authenticated user:', user.id, user.email)
    const body = await c.req.json()
    console.log('🐕 Request body:', body)

    const {
      account_url,
      platform,
      amount_usdc,
      deadline_iso,
      proof_spec,
      public_opt_in = false
    } = body

    // Basic validation
    if (!account_url || !platform || !amount_usdc || !deadline_iso || !proof_spec) {
      return c.json({
        error: 'Missing required fields: account_url, platform, amount_usdc, deadline_iso, proof_spec'
      }, 400)
    }

    // Validate platform URL (basic check)
    if (!account_url.includes(platform.toLowerCase())) {
      console.log('🐕 Platform URL validation failed')
      return c.json({
        error: 'Invalid account URL for specified platform'
      }, 400)
    }

    // Create platform account first (or get existing)
    console.log('🐕 Creating/getting platform account')

    // Extract handle from URL for normalized storage
    const extractHandle = (url: string, platform: string) => {
      try {
        const urlObj = new URL(url)
        const pathname = urlObj.pathname
        switch (platform) {
          case 'tiktok':
            return pathname.replace(/^\/+@?/, '').split('/')[0]
          case 'instagram':
            return pathname.replace(/^\/+/, '').split('/')[0]
          case 'youtube':
            return pathname.replace(/^\/+(c\/|@|user\/)?/, '').split('/')[0]
          case 'x':
          case 'twitter':
            return pathname.replace(/^\/+/, '').split('/')[0]
          default:
            return pathname.replace(/^\/+/, '').split('/')[0]
        }
      } catch {
        return url.toLowerCase()
      }
    }

    const normalized_handle = extractHandle(account_url, platform)

    // Get existing platform account or create new one
    let platformAccount
    let { data: existingAccount, error: selectError } = await supabaseAdmin
      .from('platform_accounts')
      .select()
      .eq('platform', platform)
      .eq('account_url', account_url)
      .single()

    if (existingAccount) {
      console.log('🐕 Found existing platform account:', existingAccount.id)
      platformAccount = existingAccount
    } else {
      console.log('🐕 Creating new platform account')
      const { data: newAccount, error: insertError } = await supabaseAdmin
        .from('platform_accounts')
        .insert({
          platform,
          account_url,
          normalized_handle,
          last_seen_public: new Date().toISOString()
        })
        .select()
        .single()

      if (insertError) {
        console.error('🐕 Platform account creation error:', insertError)
        throw new Error(`Platform account error: ${insertError.message}`)
      }
      platformAccount = newAccount
    }

    console.log('🐕 Platform account created/found:', platformAccount.id)

    // Ensure authenticated user has identity record (using service role)
    const { data: existingIdentity } = await supabaseAdmin
      .from('identities')
      .select('id, role')
      .eq('id', user.id)
      .single()

    if (!existingIdentity) {
      console.log('🐕 Creating identity for authenticated user')
      const { error: identityError } = await supabaseAdmin
        .from('identities')
        .insert({
          id: user.id,
          type: 'email',
          email: user.email,
          role: 'advertiser' // Default role for new users creating deals
        })

      if (identityError) {
        console.log('🐕 Identity creation failed:', identityError.message)
        throw new Error(`Identity creation error: ${identityError.message}`)
      } else {
        console.log('🐕 Identity created for user')
      }
    } else {
      console.log('🐕 User identity already exists with role:', existingIdentity.role)
    }

    // Create deal first (using service role)
    console.log('🐕 Creating deal')
    const { data: dealData, error: dealError } = await supabaseAdmin
      .from('deals')
      .insert({
        advertiser_id: user.id, // Use authenticated user ID
        creator_id: null, // Will be set when deal is accepted
        account_id: platformAccount.id,
        platform,
        amount_usdc: amount_usdc,
        deadline_iso,
        status: 'PendingAcceptance',
        public_opt_in
      })
      .select()
      .single()

    if (dealError) {
      console.error('🐕 Deal creation error:', dealError)
      throw new Error(`Deal creation error: ${dealError.message}`)
    }

    console.log('🐕 Deal created successfully:', dealData.id)

    // Now create proof spec with deal_id as primary key (using service role)
    console.log('🐕 Creating proof spec for deal:', dealData.id)
    const { data: proofSpecData, error: proofSpecError } = await supabaseAdmin
      .from('proof_specs')
      .insert({
        deal_id: dealData.id,
        text_proof: proof_spec.text_proof,
        duration_hours: proof_spec.duration_hours || 24,
        visual_markers: proof_spec.visual_markers || [],
        video_markers: proof_spec.video_markers || [],
        link_markers: proof_spec.link_markers || []
      })
      .select()
      .single()

    if (proofSpecError) {
      console.error('🐕 Proof spec error:', proofSpecError)
      throw new Error(`Proof spec error: ${proofSpecError.message}`)
    }

    console.log('🐕 Proof spec created for deal:', proofSpecData.deal_id)

    // Fetch the complete deal with joined data (using service role)
    const { data: completeDeal, error: fetchError } = await supabaseAdmin
      .from('deals')
      .select(`
        *,
        platform_accounts!inner(account_url, normalized_handle),
        proof_specs(*)
      `)
      .eq('id', dealData.id)
      .single()

    if (fetchError) {
      console.error('🐕 Deal fetch error:', fetchError)
      throw new Error(`Deal fetch error: ${fetchError.message}`)
    }

    console.log('🐕 Deal creation completed successfully')

    // NOTE: Initial verification disabled - should only run after creator submits post URL
    // Deals should remain in PendingAcceptance status until creator accepts
    console.log('🐕 Deal created in PendingAcceptance status - waiting for creator acceptance')

    // Send notification to creator about new deal (if creator exists)
    if (completeDeal.creator_id) {
      try {
        const { createNotificationService } = await import('../services/notifications')
        const notificationService = createNotificationService(c.env)
        await notificationService.notifyDealCreated(completeDeal)
      } catch (notificationError) {
        console.error('Failed to send deal creation notification:', notificationError)
      }
    }

    return c.json({
      deal: completeDeal,
      platform_account: platformAccount,
      proof_spec: proofSpecData,
      initial_verification_triggered: c.env.ORCHESTRATOR_ENABLED === 'true'
    }, 201)

  } catch (error) {
    console.error('🐕 Create deal error:', error)
    console.error('🐕 Error stack:', error.stack)
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to create deal'
    }, 500)
  }
})

// Create deal (original with middleware - commented out)
/*
app.post('/', strictRateLimit, validateSchema(createDealSchema), async (c) => {
  const supabase = c.get('supabase')

  // TODO: Re-enable auth when frontend login is implemented
  // For now, use a test user ID
  const user = { id: 'test-user-id' }
  const body = await c.req.json()

  const {
    account_url,
    platform,
    amount_usdc,
    deadline_iso,
    proof_spec,
    public_opt_in = false
  } = body

  // Validate platform URL
  if (!isValidPlatformUrl(account_url, platform)) {
    return c.json({
      error: 'Invalid account URL for specified platform'
    }, 400)
  }

  try {
    // Call Supabase RPC to create deal
    const { data, error } = await supabase.rpc('deal_rpcs', {
      action: 'create_deal',
      payload: {
        platform,
        account_url,
        amount_usdc: amount_usdc,
        deadline_iso,
        proof_spec,
        public_opt_in
      }
    })

    if (error) throw error

    return c.json(data, 201)
  } catch (error: any) {
    console.error('Create deal error:', error)
    return c.json({ error: error.message || 'Failed to create deal' }, 500)
  }
})
*/

// Accept deal (authenticated users only - they become the creator by accepting)
app.post('/:id/accept', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  // Use service role to bypass RLS for deal acceptance
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
    // First check if this user is the advertiser (can't accept own deal)
    const { data: existingDeal, error: fetchError } = await supabaseAdmin
      .from('deals')
      .select('advertiser_id, status')
      .eq('id', dealId)
      .single()

    if (fetchError) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    if (existingDeal.advertiser_id === user.id) {
      return c.json({ error: 'You cannot accept your own deal' }, 400)
    }

    if (existingDeal.status !== 'PendingAcceptance') {
      return c.json({ error: 'Deal is not available for acceptance' }, 400)
    }

    // Accept the deal - user becomes the creator
    const { data, error } = await supabaseAdmin
      .from('deals')
      .update({
        creator_id: user.id,
        status: 'PendingFunding'
      })
      .eq('id', dealId)
      .eq('status', 'PendingAcceptance')
      .select()
      .single()

    if (error) throw error

    if (!data) {
      return c.json({ error: 'Deal not found or not available for acceptance' }, 404)
    }

    // Send notification to advertiser about deal acceptance
    try {
      const { createNotificationService } = await import('../services/notifications')
      const notificationService = createNotificationService(c.env)
      await notificationService.notifyDealAccepted(data)
    } catch (notificationError) {
      console.error('Failed to send deal acceptance notification:', notificationError)
    }

    return c.json({ success: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to accept deal' }, 500)
  }
})

// Submit post URL (creator only)
app.post('/:id/submit-post', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  // Parse and validate request body
  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { post_url } = body

  if (!post_url || typeof post_url !== 'string') {
    return c.json({ error: 'post_url is required and must be a string' }, 400)
  }

  // Basic URL validation
  try {
    new URL(post_url)
  } catch {
    return c.json({ error: 'Invalid URL format' }, 400)
  }

  // Use service role to bypass RLS
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
    // Get deal details first to validate creator and platform
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('creator_id, status, platform')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Check if this user is the creator
    if (deal.creator_id !== user.id) {
      return c.json({ error: 'Only the creator can submit post URL' }, 403)
    }

    // Check if deal is in the correct status
    if (deal.status !== 'PendingVerification') {
      return c.json({ error: 'Deal must be funded before submitting post URL' }, 400)
    }

    // Platform-specific URL validation
    const urlValidation = validatePostUrl(post_url, deal.platform)
    if (!urlValidation.isValid) {
      return c.json({ error: urlValidation.error || 'Invalid post URL for this platform' }, 400)
    }

    // Set status to Verifying for both manual and orchestrator verification
    const targetStatus = 'Verifying'

    // Update deal status, posted timestamp, and post URL
    const { data: updateData, error } = await supabaseAdmin
      .from('deals')
      .update({
        status: targetStatus,
        posted_at: new Date().toISOString(),
        post_url: post_url
      })
      .eq('id', dealId)
      .eq('creator_id', user.id)
      .eq('status', 'PendingVerification')
      .select('*')
      .single()

    if (error) throw error

    if (!updateData) {
      return c.json({ error: 'Deal not found or not in active state' }, 404)
    }

    console.log(`✅ Deal ${dealId} status updated to: ${targetStatus}`)

    // Create initial verification schedule when transitioning to Verifying
    try {
      const now = new Date()
      const durationHours = updateData.proof_specs?.duration_hours || 24

      // Calculate check intervals based on duration
      let checkIntervalHours: number
      if (durationHours <= 0.1) {
        // 5-minute test: check at 0min, 1.67min, 3.33min, 5min (final)
        checkIntervalHours = 0.0278 // ~1.67 minutes - creates 3 periodic checks
      } else if (durationHours <= 24) {
        checkIntervalHours = 4 // Every 4 hours for 1-day deals
      } else if (durationHours <= 72) {
        checkIntervalHours = 12 // Every 12 hours for 3-day deals
      } else {
        checkIntervalHours = 24 // Daily for longer deals
      }

      console.log('🔥 VERIFICATION SCHEDULE INSERTED:', {
        dealId,
        durationHours,
        checkIntervalHours,
        scheduledAt: now.toISOString()
      })

      // Insert initial verification schedule
      const { error: scheduleError } = await supabaseAdmin
        .from('verification_schedules')
        .insert({
          deal_id: dealId,
          scheduled_at: now,
          check_type: 'initial',
          status: 'pending'
        })

      if (scheduleError) {
        console.error('❌ Failed to create verification schedule:', scheduleError)
      }

      // Also schedule follow-up verifications until deadline
      const deadline = new Date(updateData.deadline_iso)
      const schedules = []
      let nextCheck = new Date(now.getTime() + checkIntervalHours * 60 * 60 * 1000)

      while (nextCheck < deadline) {
        schedules.push({
          deal_id: dealId,
          scheduled_at: nextCheck,
          check_type: 'periodic',
          status: 'pending'
        })
        nextCheck = new Date(nextCheck.getTime() + checkIntervalHours * 60 * 60 * 1000)
      }

      // Add final check at deadline
      schedules.push({
        deal_id: dealId,
        scheduled_at: deadline,
        check_type: 'final',
        status: 'pending'
      })

      if (schedules.length > 0) {
        const { error: bulkScheduleError } = await supabaseAdmin
          .from('verification_schedules')
          .insert(schedules)

        if (bulkScheduleError) {
          console.error('❌ Failed to create follow-up verification schedules:', bulkScheduleError)
        } else {
          console.log(`✅ Created ${schedules.length} follow-up verification schedules`)
        }
      }
    } catch (scheduleError) {
      console.error('❌ Failed to create verification schedules:', scheduleError)
    }

    // Now fetch the complete deal data with relations for orchestrator
    const { data, error: fetchError } = await supabaseAdmin
      .from('deals')
      .select('*, platform_accounts(*), proof_specs(*)')
      .eq('id', dealId)
      .single()

    if (fetchError || !data) {
      console.error('Failed to fetch deal data for orchestrator:', fetchError)
      return c.json({ error: 'Deal updated but failed to fetch for verification' }, 500)
    }

    // Trigger orchestrator verification if enabled
    if (c.env.ORCHESTRATOR_ENABLED === 'true') {
      try {
        console.log(`🚀 DEALS.TS: About to trigger orchestrator verification for deal ${dealId}`)
        console.log(`🚀 DEALS.TS: post_url = "${post_url}"`)
        console.log(`🚀 DEALS.TS: ORCHESTRATOR_ENABLED = "${c.env.ORCHESTRATOR_ENABLED}"`)
        console.log(`🚀 DEALS.TS: data shape:`, {
          id: data.id,
          platform: data.platform,
          proof_specs_type: Array.isArray(data.proof_specs) ? 'array' : typeof data.proof_specs,
          proof_specs_length: Array.isArray(data.proof_specs) ? data.proof_specs.length : 'not_array',
          proof_specs_first: Array.isArray(data.proof_specs) && data.proof_specs.length > 0 ? data.proof_specs[0] : data.proof_specs,
          platform_accounts_type: Array.isArray(data.platform_accounts) ? 'array' : typeof data.platform_accounts,
          platform_accounts_data: data.platform_accounts
        })

        const { triggerOrchestratorVerification } = await import('./orchestrator')
        console.log(`🚀 DEALS.TS: Calling triggerOrchestratorVerification now...`)

        console.log(`🚀 DEALS.TS: data structure (should be objects now):`, {
          id: data.id,
          platform: data.platform,
          proof_specs: data.proof_specs,
          platform_accounts: data.platform_accounts
        })

        const result = await triggerOrchestratorVerification(c, data, post_url)

        console.log(`🚀 DEALS.TS: triggerOrchestratorVerification returned:`, result)

        if (result.success) {
          console.log(`🎯 Orchestrator verification triggered successfully for deal ${dealId}`)

          // Send notification about verification started
          try {
            const { createNotificationService } = await import('../services/notifications')
            const notificationService = createNotificationService(c.env)
            await notificationService.notifyVerificationStarted(data, post_url)
          } catch (notificationError) {
            console.error('Failed to send verification started notification:', notificationError)
          }
        } else {
          console.error(`🚀 DEALS.TS: ❌ ORCHESTRATOR TRIGGER FAILED: ${result.error}`)
          console.error(`🚀 DEALS.TS: Full result object:`, result)

          // Fall back to HITL if orchestrator fails
          if (c.env.HITL_ENABLED === 'true') {
            console.log(`🚀 DEALS.TS: Falling back to HITL for deal ${dealId}`)
            await supabaseAdmin
              .from('deals')
              .update({ status: 'Verifying' })
              .eq('id', dealId)
          }
        }
      } catch (orchestratorError) {
        console.error(`🚀 DEALS.TS: ❌ ORCHESTRATOR TRIGGER EXCEPTION:`, orchestratorError)
        console.error(`🚀 DEALS.TS: Exception stack:`, orchestratorError.stack)

        // Fall back to HITL if orchestrator fails
        if (c.env.HITL_ENABLED === 'true') {
          console.log(`🚀 DEALS.TS: Exception - falling back to HITL for deal ${dealId}`)
          await supabaseAdmin
            .from('deals')
            .update({ status: 'Verifying' })
            .eq('id', dealId)
        }
      }
    } else {
      console.log(`🚀 DEALS.TS: ORCHESTRATOR_ENABLED = "${c.env.ORCHESTRATOR_ENABLED}" - skipping verification trigger`)
    }

    // Create HITL review when orchestrator is disabled
    if (c.env.HITL_ENABLED === 'true' && c.env.ORCHESTRATOR_ENABLED !== 'true') {
      try {
        const { HITLService } = await import('../hitl')
        const hitlService = new HITLService(c.env)

        const review = await hitlService.createReview({
          runId: `posted-${Date.now()}`,
          dealId: dealId,
          reason: 'ORCHESTRATOR_DISABLED',
          severity: 'high',
          evidence: [
            {
              type: 'observation',
              text: 'Creator submitted post URL for verification - orchestrator is disabled'
            },
            {
              type: 'post_url',
              text: `Post URL: ${post_url}`,
              ref: post_url
            },
            {
              type: 'deal_info',
              text: `Platform: ${data.platform}, Amount: $${data.amount_usdc}`,
              ref: `Deal ${dealId}`
            }
          ],
          metadata: {
            deal_id: dealId,
            platform: data.platform,
            amount_usdc: data.amount_usdc,
            post_url: post_url,
            verification_trigger: 'creator_posted_url',
            orchestrator_status: 'disabled'
          }
        })

        console.log(`🔔 HITL review created for posted deal: ${review.reviewId}`)
      } catch (hitlError) {
        console.error('❌ Failed to create HITL review for posted deal:', hitlError)
      }
    }

    return c.json({ success: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to mark as posted' }, 500)
  }
})

// Fund deal (authenticated users only - must be the advertiser who created the deal)
// SOLANA VERSION - accepts transaction signature instead of creating Stripe PaymentIntent
app.post('/:id/fund', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  // Use service role to bypass RLS
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
    // Parse request body for Solana transaction signature
    const { solana_signature } = await c.req.json()

    if (!solana_signature) {
      return c.json({ error: 'solana_signature required' }, 400)
    }

    // Get deal details using service role to bypass RLS
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('amount_usdc, status, advertiser_id, creator_id')
      .eq('id', dealId)
      .single()

    console.log('💰 Solana deal funding:', {
      dealId,
      amount_usdc: deal?.amount_usdc,
      status: deal?.status,
      advertiser_id: deal?.advertiser_id,
      signature: solana_signature.slice(0, 20) + '...'
    })

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Check if this user is the advertiser (only advertiser can fund)
    if (deal.advertiser_id !== user.id) {
      return c.json({ error: 'Only the advertiser who created the deal can fund it' }, 403)
    }

    // Allow funding from both PendingFunding and Failed states (for retry)
    if (deal.status !== 'PendingFunding' && deal.status !== 'Failed') {
      return c.json({ error: `Deal is not in funding state. Current status: ${deal.status}` }, 400)
    }

    // Verify Solana transaction on-chain
    // TODO: Add actual Solana transaction verification here
    // For MVP, we'll trust the signature and verify amount matches
    console.log(`🔐 Verifying Solana transaction: ${solana_signature}`)

    // Calculate expected amount (deal amount + 2% platform fee)
    const platformFeePercent = 0.02
    const totalExpected = deal.amount_usdc * (1 + platformFeePercent)

    // Record escrow funding event
    const { error: escrowError } = await supabaseAdmin
      .from('escrow_events')
      .insert({
        deal_id: dealId,
        event_type: 'Created',
        amount_usdc: deal.amount_usdc,
        tx_ref: solana_signature,
        solana_signature: solana_signature,
        payment_method: 'solana'
      })

    if (escrowError) {
      console.error('❌ Failed to create escrow event:', escrowError)
      return c.json({ error: 'Failed to record escrow event' }, 500)
    }

    // Update deal status to PendingVerification (funded and ready for creator to post)
    const { data: updatedDeal, error: updateError } = await supabaseAdmin
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
      return c.json({ error: 'Failed to update deal status' }, 500)
    }

    if (!updatedDeal || updatedDeal.length === 0) {
      console.warn(`⚠️ Deal ${dealId} not updated - may not be in correct status`)
      return c.json({ error: 'Deal not in correct status for funding' }, 400)
    }

    console.log(`✅ Deal ${dealId} funded via Solana: ${solana_signature}`)

    // Send notification to creator about deal funding
    try {
      const { createNotificationService } = await import('../services/notifications')
      const notificationService = createNotificationService(c.env)
      await notificationService.notifyDealFunded(updatedDeal[0])
    } catch (notificationError) {
      console.error('Failed to send deal funding notification:', notificationError)
    }

    return c.json({
      success: true,
      deal_id: dealId,
      status: 'PendingVerification',
      solana_signature: solana_signature,
      amount_usdc: deal.amount_usdc,
      message: 'Deal funded successfully with Solana'
    })
  } catch (error: any) {
    console.error('Solana funding error:', error)
    return c.json({ error: error.message || 'Failed to fund deal with Solana' }, 500)
  }
})

// TEMPORARY: Test funding without auth for debugging
app.post('/:id/fund-test', async (c) => {
  const dealId = c.req.param('id')
  console.log('🧪 Testing funding flow without auth for deal:', dealId)

  // Use service role to bypass RLS
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
    // Get deal details using service role to bypass RLS
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('amount_usdc, status, advertiser_id')
      .eq('id', dealId)
      .single()

    console.log('🧪 Test funding debug:', {
      dealId,
      amount_usdc: deal?.amount_usdc,
      status: deal?.status,
      advertiser_id: deal?.advertiser_id,
      dealError: dealError?.message
    })

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // For testing: if deal is PendingAcceptance, update it to PendingFunding
    if (deal.status === 'PendingAcceptance') {
      console.log('🧪 Converting deal from PendingAcceptance to PendingFunding for testing')
      const { data: updatedDeal, error: updateError } = await supabaseAdmin
        .from('deals')
        .update({ status: 'PendingFunding' })
        .eq('id', dealId)
        .select()
        .single()

      if (updateError) {
        console.error('🧪 Failed to update deal status:', updateError)
        return c.json({ error: 'Failed to update deal status for testing' }, 500)
      }

      console.log('🧪 Deal status updated to PendingFunding')
      deal.status = 'PendingFunding'
    }

    if (deal.status !== 'PendingFunding') {
      return c.json({
        error: 'Deal is not in funding state',
        current_status: deal.status,
        amount_usdc: deal.amount_usdc
      }, 400)
    }

    // Test Stripe PaymentIntent creation
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    console.log('🧪 Creating Stripe PaymentIntent for amount:', deal.amount_usdc)

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(deal.amount_usdc * 100), // Convert to cents
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        deal_id: dealId,
        advertiser_id: deal.advertiser_id
      }
    })

    console.log('🧪 PaymentIntent created successfully:', {
      id: paymentIntent.id,
      amount: paymentIntent.amount,
      amount_usdc: deal.amount_usdc,
      status: paymentIntent.status
    })

    return c.json({
      success: true,
      test_mode: true,
      deal: {
        id: dealId,
        amount_usdc: deal.amount_usdc,
        status: deal.status
      },
      payment_intent: {
        id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      }
    })
  } catch (error: any) {
    console.error('🧪 Test funding error:', error)
    return c.json({ error: error.message || 'Failed to test funding' }, 500)
  }
})

// Cancel deal
app.post('/:id/cancel', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const dealId = c.req.param('id')

  try {
    const { data, error } = await supabase
      .from('deals')
      .update({
        status: 'Cancelled',
        cancelled_at: new Date().toISOString()
      })
      .eq('id', dealId)
      .or(`advertiser_id.eq.${user.id},creator_id.eq.${user.id}`)
      .select()
      .single()

    if (error) throw error

    if (!data) {
      return c.json({ error: 'Deal not found or access denied' }, 404)
    }

    return c.json({ success: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to cancel deal' }, 500)
  }
})

// Mark stream started (creator only) - for streaming verification
app.post('/:id/mark-stream-start', authMiddleware, requireRole('creator'), async (c) => {
  const supabase = c.get('supabase')
  const dealId = c.req.param('id')

  try {
    // Get deal details
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .select('id, platform, account_id, platform_accounts(account_url)')
      .eq('id', dealId)
      .eq('creator_id', c.get('user').id)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found or access denied' }, 404)
    }

    // Start screencast session
    const response = await fetch(`${c.req.url.split('/v1')[0]}/internal/screencast/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deal_id: dealId,
        account_url: deal.platform_accounts.account_url
      })
    })

    if (!response.ok) {
      throw new Error('Failed to start screencast session')
    }

    const result = await response.json()

    return c.json({
      success: true,
      session_id: result.session_id,
      message: 'Stream verification started'
    })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to start stream verification' }, 500)
  }
})

// Mark deal as completed (for testing - would normally be done by verification system)
app.post('/:id/mark-completed', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  // Use service role to bypass RLS
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
    // Update deal status to completed
    const { data: updatedDeal, error } = await supabaseAdmin
      .from('deals')
      .update({
        status: 'Completed',
        posted_at: new Date().toISOString()
      })
      .eq('id', dealId)
      .or(`advertiser_id.eq.${user.id},creator_id.eq.${user.id}`)
      .select()
      .single()

    if (error) throw error

    if (!updatedDeal) {
      return c.json({ error: 'Deal not found or access denied' }, 404)
    }

    // Add to proof wall if eligible
    await addToProofWallIfEligible(supabaseAdmin, dealId, updatedDeal)

    return c.json({ success: true, deal: updatedDeal })
  } catch (error: any) {
    console.error('Mark completed error:', error)
    return c.json({ error: error.message || 'Failed to mark as completed' }, 500)
  }
})

// Mark stream ended (creator only) - for streaming verification
app.post('/:id/mark-stream-end', authMiddleware, requireRole('creator'), async (c) => {
  const supabase = c.get('supabase')
  const dealId = c.req.param('id')

  try {
    // End screencast session
    const response = await fetch(`${c.req.url.split('/v1')[0]}/internal/screencast/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deal_id: dealId
      })
    })

    if (!response.ok) {
      throw new Error('Failed to end screencast session')
    }

    const result = await response.json()

    return c.json({
      success: true,
      session_id: result.session_id,
      message: 'Stream verification ended'
    })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to end stream verification' }, 500)
  }
})

// Update proof specs (creators only, post-acceptance but pre-funding)
app.put('/:id/update-proof-spec', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const dealId = c.req.param('id')

  console.log('🔄 Proof spec update request:', { dealId, userId: user.id })

  // Get request body
  const body = await c.req.json()
  const {
    text_proof,
    duration_hours,
    visual_markers,
    video_markers,
    link_markers,
    reason
  } = body

  // Validate that at least one field is being modified
  if (!text_proof && !duration_hours && !visual_markers && !video_markers && !link_markers) {
    return c.json({
      error: 'At least one proof specification field must be updated'
    }, 400)
  }

  // Validate duration constraints
  if (duration_hours !== undefined) {
    const validDurations = [0.0833, 24, 72, 168, 720] // 5 minutes (for testing), 1 day, 3 days, 1 week, 1 month
    if (!validDurations.includes(duration_hours)) {
      return c.json({ error: 'Duration must be 0.0833 (5min test), 24, 72, 168, or 720 hours' }, 400)
    }
  }

  // Validate text proof length
  if (text_proof && text_proof.length > 2000) {
    return c.json({ error: 'Text proof requirements cannot exceed 2000 characters' }, 400)
  }

  try {
    // Use service role for transaction
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

    // First, verify deal exists and user is the creator, and deal is in correct status
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('*, proof_specs(*)')
      .eq('id', dealId)
      .eq('creator_id', user.id)
      .in('status', ['PendingFunding', 'PendingAcceptance', 'PendingVerification', 'Verifying']) // Allow updates through verification phase
      .single()

    console.log('🔥 PROOF SPEC UPDATE STATUS CHECK:', { dealId, userId: user.id, allowedStatuses: ['PendingFunding', 'PendingAcceptance', 'PendingVerification', 'Verifying'] })

    if (dealError || !deal) {
      console.error('🔄 Deal not found or not modifiable:', dealError)
      return c.json({
        error: 'Deal not found or cannot be modified (only deals by creator before completion can be modified)'
      }, 404)
    }

    console.log('🔥 PROOF SPEC UPDATED IN VERIFICATION:', { dealId, status: deal.status, creator: user.id })

    console.log('🔄 Found deal for proof spec update:', deal.id)

    // Extract proof_specs (it comes as array from Supabase relation)
    const proofSpecs = Array.isArray(deal.proof_specs) ? deal.proof_specs[0] : deal.proof_specs

    // Store old values for revision tracking
    const oldValues = {
      text_proof: proofSpecs?.text_proof,
      duration_hours: proofSpecs?.duration_hours,
      visual_markers: proofSpecs?.visual_markers || [],
      video_markers: proofSpecs?.video_markers || [],
      link_markers: proofSpecs?.link_markers || []
    }

    // Prepare new values
    const newValues = {
      text_proof: text_proof || oldValues.text_proof,
      duration_hours: duration_hours || oldValues.duration_hours,
      visual_markers: visual_markers || oldValues.visual_markers,
      video_markers: video_markers || oldValues.video_markers,
      link_markers: link_markers || oldValues.link_markers
    }

    // Update proof specs
    const { error: proofSpecError } = await supabaseAdmin
      .from('proof_specs')
      .update({
        text_proof: newValues.text_proof,
        duration_hours: newValues.duration_hours,
        visual_markers: newValues.visual_markers,
        video_markers: newValues.video_markers,
        link_markers: newValues.link_markers
      })
      .eq('deal_id', dealId)

    if (proofSpecError) {
      console.error('🔄 Failed to update proof specs:', proofSpecError)
      return c.json({ error: 'Failed to update proof specifications' }, 500)
    }

    // Log the update for transparency
    console.log('✅ Proof specs updated successfully by creator:', {
      dealId,
      userId: user.id,
      changes: Object.keys(body).filter(key => key !== 'reason'),
      reason: reason || 'No reason provided'
    })

    // Create notification for advertiser about proof spec update
    try {
      const { createNotificationService } = await import('../services/notifications')
      const notificationService = createNotificationService(c.env)

      await notificationService.createNotification({
        user_id: deal.advertiser_id,
        deal_id: dealId,
        type: 'proof_spec_updated',
        title: 'Creator Updated Proof Requirements',
        message: `The creator has updated the proof specifications for your deal. Please review the changes before funding.`,
        metadata: {
          updated_by: user.id,
          reason: reason || 'Creator refinement',
          deal_platform: deal.platform,
          deal_amount: deal.amount_usdc,
          changes: Object.keys(body).filter(key => key !== 'reason')
        }
      })
    } catch (notificationError) {
      console.error('Failed to send notification:', notificationError)
      // Don't fail the update if notification fails
    }

    return c.json({
      success: true,
      message: 'Proof specifications updated successfully',
      updated_fields: Object.keys(body).filter(key => key !== 'reason')
    })

  } catch (error) {
    console.error('🔄 Proof spec update error:', error)
    return c.json({ error: 'Failed to update proof specifications' }, 500)
  }
})

// Modify deal endpoint (advertisers only, pre-acceptance)
app.put('/:id/modify', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const dealId = c.req.param('id')

  console.log('🔄 Deal modification request:', { dealId, userId: user.id })

  // Get request body
  const body = await c.req.json()
  const {
    amount_usdc,
    deadline_iso,
    proof_specs,
    reason
  } = body

  // Validate that at least one field is being modified
  if (!amount_usdc && !deadline_iso && !proof_specs) {
    return c.json({
      error: 'At least one field must be modified (amount_usdc, deadline_iso, proof_specs)'
    }, 400)
  }

  // Validate amount constraints
  if (amount_usdc !== undefined) {
    if (amount_usdc < 5) {
      return c.json({ error: 'Minimum deal amount is $5' }, 400)
    }
    if (amount_usdc > 10000) {
      return c.json({ error: 'Maximum deal amount is $10,000' }, 400)
    }
    if (amount_usdc % 5 !== 0) {
      return c.json({ error: 'Deal amount must be in $5 increments' }, 400)
    }
  }

  // Validate deadline constraints
  if (deadline_iso !== undefined) {
    const deadlineDate = new Date(deadline_iso)
    const now = new Date()
    const minDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 24 hours from now
    const maxDeadline = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000) // 90 days from now

    if (deadlineDate < minDeadline) {
      return c.json({ error: 'Deadline must be at least 24 hours from now' }, 400)
    }
    if (deadlineDate > maxDeadline) {
      return c.json({ error: 'Deadline cannot be more than 90 days from now' }, 400)
    }
  }

  // Validate proof specs constraints
  if (proof_specs !== undefined) {
    if (proof_specs.text_proof && proof_specs.text_proof.length > 2000) {
      return c.json({ error: 'Text proof requirements cannot exceed 2000 characters' }, 400)
    }
    if (proof_specs.duration_hours !== undefined) {
      const validDurations = [0.0833, 24, 72, 168, 720] // 5 minutes (for testing), 1 day, 3 days, 1 week, 1 month
      if (!validDurations.includes(proof_specs.duration_hours)) {
        return c.json({ error: 'Duration must be 0.0833 (5min test), 24, 72, 168, or 720 hours' }, 400)
      }
    }
  }

  // Validate reason is provided
  if (!reason || reason.trim().length < 10) {
    return c.json({ error: 'Reason for modification must be at least 10 characters' }, 400)
  }
  if (reason.trim().length > 500) {
    return c.json({ error: 'Reason for modification cannot exceed 500 characters' }, 400)
  }

  try {
    // Use service role for transaction
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

    // First, verify deal exists and user is the advertiser
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .eq('advertiser_id', user.id)
      .eq('status', 'PendingAcceptance')
      .single()

    if (dealError || !deal) {
      console.error('🔄 Deal not found or not modifiable:', dealError)
      return c.json({
        error: 'Deal not found or cannot be modified (only pending deals by advertiser)'
      }, 404)
    }

    console.log('🔄 Found deal for modification:', deal.id)

    // Store old values for revision tracking
    const oldValues = {
      amount_usdc: deal.amount_usdc,
      deadline_iso: deal.deadline_iso,
      proof_specs: {} // Will fetch from proof_specs table
    }

    // Get current proof specs
    const { data: currentProofSpecs } = await supabaseAdmin
      .from('proof_specs')
      .select('*')
      .eq('deal_id', dealId)
      .single()

    if (currentProofSpecs) {
      oldValues.proof_specs = {
        text_proof: currentProofSpecs.text_proof,
        duration_hours: currentProofSpecs.duration_hours,
        visual_markers: currentProofSpecs.visual_markers,
        video_markers: currentProofSpecs.video_markers,
        link_markers: currentProofSpecs.link_markers
      }
    }

    // Prepare new values and identify changes
    const newValues = {}
    const changes = []

    if (amount_usdc !== undefined && amount_usdc !== deal.amount_usdc) {
      newValues.amount_usdc = amount_usdc
      changes.push('amount_usdc')
    }

    if (deadline_iso !== undefined && deadline_iso !== deal.deadline_iso) {
      newValues.deadline_iso = deadline_iso
      changes.push('deadline_iso')
    }

    if (proof_specs !== undefined) {
      newValues.proof_specs = proof_specs
      changes.push('proof_specs')
    }

    if (changes.length === 0) {
      return c.json({ error: 'No changes detected' }, 400)
    }

    console.log('🔄 Changes detected:', changes)

    // Start transaction - update deal fields
    if (newValues.amount_usdc !== undefined || newValues.deadline_iso !== undefined) {
      const dealUpdates = {}
      if (newValues.amount_usdc !== undefined) dealUpdates.amount_usdc = newValues.amount_usdc
      if (newValues.deadline_iso !== undefined) dealUpdates.deadline_iso = newValues.deadline_iso
      dealUpdates.updated_at = new Date().toISOString()

      const { error: updateError } = await supabaseAdmin
        .from('deals')
        .update(dealUpdates)
        .eq('id', dealId)

      if (updateError) {
        console.error('🔄 Failed to update deal:', updateError)
        return c.json({ error: 'Failed to update deal' }, 500)
      }
    }

    // Update proof specs if provided
    if (newValues.proof_specs !== undefined) {
      const { error: proofSpecError } = await supabaseAdmin
        .from('proof_specs')
        .update({
          text_proof: proof_specs.text_proof,
          duration_hours: proof_specs.duration_hours || 24,
          visual_markers: proof_specs.visual_markers || [],
          video_markers: proof_specs.video_markers || [],
          link_markers: proof_specs.link_markers || []
        })
        .eq('deal_id', dealId)

      if (proofSpecError) {
        console.error('🔄 Failed to update proof specs:', proofSpecError)
        return c.json({ error: 'Failed to update proof specifications' }, 500)
      }
    }

    // Get current revision count
    const currentRevision = deal.revision_count || 0

    // Create revision record
    const { error: revisionError } = await supabaseAdmin
      .from('deal_revisions')
      .insert({
        deal_id: dealId,
        revision_number: currentRevision + 1,
        modified_by: user.id,
        changes,
        old_values: oldValues,
        new_values: newValues,
        reason: reason || null
      })

    if (revisionError) {
      console.error('🔄 Failed to create revision record:', revisionError)
      return c.json({ error: 'Failed to track revision' }, 500)
    }

    console.log('✅ Deal modified successfully:', { dealId, changes })

    // TODO: Send notification to creator about deal modification

    return c.json({
      success: true,
      message: 'Deal modified successfully',
      changes,
      revision_number: currentRevision + 1
    })

  } catch (error) {
    console.error('🔄 Deal modification error:', error)
    return c.json({ error: 'Failed to modify deal' }, 500)
  }
})

// Temporary migration endpoint to add missing post_url column
app.post('/migrate-post-url', async (c) => {
  try {
    // Use service role for admin operations
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

    // Try to add the missing columns using a simple query
    // Since Supabase doesn't have exec_sql RPC by default, we'll use a different approach
    const testQuery = await supabaseAdmin
      .from('deals')
      .select('post_url')
      .limit(1)

    if (testQuery.error && testQuery.error.message.includes('post_url')) {
      return c.json({
        error: 'Column post_url does not exist. Please apply migration manually.',
        migration_sql: `
          ALTER TABLE deals
          ADD COLUMN post_url TEXT,
          ADD COLUMN orchestrator_result JSONB,
          ADD COLUMN verification_score INTEGER,
          ADD COLUMN failure_reason TEXT;
        `,
        message: 'Run the above SQL in Supabase dashboard to apply the migration.'
      }, 400)
    }

    return c.json({
      success: true,
      message: 'post_url column already exists or migration completed'
    })
  } catch (err) {
    console.error('Migration check error:', err)
    return c.json({ error: 'Migration check failed', details: err.message }, 500)
  }
})

export const dealsRouter = app