/**
 * TrustDog MVP Cloudflare Worker
 * API edge layer with session auth, rate limiting, and webhook handling
 */

// Polyfill Buffer for Solana web3.js (required in Cloudflare Workers)
import { Buffer } from 'buffer'
globalThis.Buffer = Buffer

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { timing } from 'hono/timing'
import { createClient } from '@supabase/supabase-js'

import { authMiddleware } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rateLimit'
import { validateMiddleware } from './middleware/validation'

import { dealsRouter } from './routes/deals'
import { escrowRouter } from './routes/escrow'
import { verificationRouter } from './routes/verification'
import { contactRouter } from './routes/contact'
import { webhooksRouter } from './routes/webhooks'
import { platformAccountsRouter } from './routes/platform-accounts'
import { adminRouter } from './routes/admin'
import { uploadsRouter } from './routes/uploads'
import hitlRouter from './routes/hitl'
import orchestratorRouter from './routes/orchestrator'
import mediaAnalysisRouter from './routes/media-analysis'
import mediaRouter from './routes/media'
import verificationScheduleRouter from './routes/verification-schedule'
import { stripeConnectRouter } from './routes/stripe-connect'
import { refundsRouter } from './routes/refunds'
import { solanaRouter } from './routes/solana'
import { cronHandler } from './handlers/cron'

// Import shared types
import { type Env, type HonoContext } from './types'

const app = new Hono<HonoContext>()

// Ultra-minimal test endpoint before any middleware
app.post('/v1/raw-test', async (c) => {
  console.log('🔬 Raw test endpoint - before all middleware')
  console.log('🔬 Context keys:', Object.keys(c))
  console.log('🔬 c.json type:', typeof c.json)

  try {
    return c.json({ success: true, test: 'raw-endpoint' }, 201)
  } catch (error) {
    console.error('🔬 Raw test error:', error)
    return new Response(JSON.stringify({ error: 'raw test failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

// Global middleware
app.use('*', timing())

// Test after timing middleware
app.post('/v1/test-after-timing', async (c) => {
  try {
    return c.json({ success: true, test: 'after-timing' }, 201)
  } catch (error) {
    console.error('🔬 After timing error:', error)
    return new Response(JSON.stringify({ error: 'timing test failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

app.use('*', logger())

// Test after logger middleware
app.post('/v1/test-after-logger', async (c) => {
  try {
    return c.json({ success: true, test: 'after-logger' }, 201)
  } catch (error) {
    console.error('🔬 After logger error:', error)
    return new Response(JSON.stringify({ error: 'logger test failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

app.use(
  '*',
  cors({
    origin: (origin) => {
      // Debug logging
      console.log('🌐 CORS Origin Check:', { origin })

      // In development, allow any origin. In production, check against allowed origins
      const allowedOrigins = [
        'https://trustdog-mvp-frontend.pages.dev',
        'https://trustdog-worker.shakil-jiwa1.workers.dev',
        'https://trustdog.co'
      ]

      const isAllowed = !origin || // No origin (same-origin requests)
                       origin.includes('localhost') ||
                       origin.includes('127.0.0.1') ||
                       allowedOrigins.includes(origin)

      console.log('🌐 CORS Decision:', { origin, isAllowed })

      // CRITICAL: Return the actual origin string, not "true" - per requirements
      if (isAllowed) {
        return origin || '*'
      } else {
        return false
      }
    },
    allowHeaders: ['Content-Type', 'Authorization', 'X-Client-Info', 'apikey', 'X-Internal-Secret'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Total-Count'],
    credentials: true,
  })
)

// Test after CORS middleware
app.post('/v1/test-after-cors', async (c) => {
  try {
    return c.json({ success: true, test: 'after-cors' }, 201)
  } catch (error) {
    console.error('🔬 After CORS error:', error)
    return new Response(JSON.stringify({ error: 'cors test failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

// Initialize Supabase client middleware
app.use('*', async (c, next) => {
  const supabase = createClient(
    c.env.SUPABASE_URL,
    c.env.SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
  c.set('supabase', supabase)
  await next()
})

// Test after Supabase middleware
app.post('/v1/test-after-supabase', async (c) => {
  try {
    return c.json({ success: true, test: 'after-supabase' }, 201)
  } catch (error) {
    console.error('🔬 After Supabase error:', error)
    return new Response(JSON.stringify({ error: 'supabase test failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

// Debug middleware for API routes
app.use('/v1/*', async (c, next) => {
  const startTime = Date.now()

  console.log('🐕 TrustDog API Request START:', {
    method: c.req.method,
    url: c.req.url,
    path: c.req.path,
    origin: c.req.header('origin'),
    userAgent: c.req.header('user-agent'),
    authorization: c.req.header('authorization') ? 'present' : 'none',
    contentType: c.req.header('content-type'),
    headers: Object.fromEntries(c.req.raw.headers.entries())
  })

  try {
    await next()

    console.log('🐕 TrustDog API Request COMPLETE:', {
      method: c.req.method,
      path: c.req.path,
      duration: Date.now() - startTime + 'ms'
    })
  } catch (error) {
    console.error('🚨 TrustDog API Request ERROR:', {
      method: c.req.method,
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: Date.now() - startTime + 'ms'
    })
    throw error
  }
})

// Apply rate limiting to API routes (disabled - needs context fix)
// app.use('/v1/*', rateLimitMiddleware)

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT,
  })
})

// Debug test endpoint
app.post('/debug/test', async (c) => {
  console.log('🧪 Debug Test Endpoint Hit')
  try {
    const body = await c.req.text()
    console.log('🧪 Debug Test Body:', body)
    return c.json({
      success: true,
      message: 'Debug test successful',
      receivedBody: body,
      headers: Object.fromEntries(c.req.raw.headers.entries())
    })
  } catch (error) {
    console.error('🧪 Debug Test Error:', error)
    return c.json({ error: 'Debug test failed' }, 500)
  }
})

// Test deals endpoint directly on main app (bypass router)
app.post('/v1/test-deal', async (c) => {
  console.log('🧪 Test Deal Endpoint Hit')
  console.log('🧪 Context type:', typeof c)
  console.log('🧪 Context properties:', Object.keys(c))
  console.log('🧪 Response object:', typeof c.res, c.res)

  try {
    const body = await c.req.json()
    console.log('🧪 Test Deal Body:', body)

    // Test if c.json works
    const response = c.json({
      success: true,
      message: 'Direct test deal endpoint working',
      receivedData: body
    }, 201)

    console.log('🧪 c.json response:', response)
    return response
  } catch (error) {
    console.error('🧪 Test Deal Error:', error)
    console.error('🧪 Error stack:', error.stack)
    return c.json({ error: 'Test deal failed' }, 500)
  }
})

// API routes
app.route('/v1/deals', dealsRouter)
app.route('/v1/escrow', escrowRouter)
app.route('/v1/verification', verificationRouter)
app.route('/v1/contact', contactRouter)
app.route('/v1/platform-accounts', platformAccountsRouter)
app.route('/v1/uploads', uploadsRouter)
app.route('/v1/stripe-connect', stripeConnectRouter)
app.route('/v1/refunds', refundsRouter)
app.route('/v1/solana', solanaRouter)

// HITL routes (includes both public /v1/reviews and internal /internal/hitl)
app.route('/', hitlRouter)

// Admin routes (for development/demo setup)
app.route('/admin', adminRouter)

// Webhooks (no auth required, but signature validation)
app.route('/webhooks', webhooksRouter)

// Orchestrator integration routes
app.route('/v1/orchestrator', orchestratorRouter)

// Media upload/download routes (for deal files)
app.route('/v1/media', mediaRouter)
// Media analysis routes (for QwenVL) - separate path to avoid conflict
app.route('/v1/media-analysis', mediaAnalysisRouter)
// Verification schedule and status routes
app.route('/v1/verification-schedule', verificationScheduleRouter)

// Public endpoints
app.get('/v1/proof-wall', async (c) => {
  // Use service role to bypass RLS for public proof wall
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

  const { platform, category, limit = 50, offset = 0 } = c.req.query()

  let query = supabaseAdmin
    .from('proof_wall')
    .select('*')
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (platform) query = query.eq('platform', platform)
  if (category) query = query.eq('category', category)

  const { data, error, count } = await query

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  c.header('X-Total-Count', String(count || data?.length || 0))
  return c.json(data || [])
})

// Authentication endpoints
app.post('/v1/auth/login', validateMiddleware, async (c) => {
  const { email, password } = await c.req.json()
  const supabase = c.get('supabase')

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // Set session cookie
  c.header(
    'Set-Cookie',
    `session=${data.session?.access_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`
  )

  return c.json({ user: data.user, session: data.session })
})

app.post('/v1/auth/logout', authMiddleware, async (c) => {
  // Clear session cookie
  c.header('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  return c.json({ success: true })
})

app.get('/v1/auth/me', authMiddleware, async (c) => {
  const user = c.get('user')
  return c.json({ user })
})

// Cron handler
app.get('/cron', cronHandler)

// Test endpoint to manually trigger verification processing
// Manual trigger for testing payout retry
app.get('/test-payout-retry', async (c) => {
  try {
    console.log('🧪 Manual trigger of payout retry processing...')

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

    const results = await retryPendingPayouts(supabaseAdmin, c.env)

    return c.json({
      message: 'Payout retry processing complete',
      ...results
    })

  } catch (error: any) {
    console.error('❌ Manual payout retry failed:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Manual trigger to process a specific deal's payout
app.get('/test-payout/:dealId', async (c) => {
  try {
    const dealId = c.req.param('dealId')
    console.log(`🧪 Manual payout trigger for deal ${dealId}...`)

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

    await processCreatorPayout(supabaseAdmin, c.env, dealId)

    return c.json({
      message: `Payout processed for deal ${dealId}`,
      success: true
    })

  } catch (error: any) {
    console.error(`❌ Manual payout failed for deal:`, error)
    return c.json({ error: error.message }, 500)
  }
})

app.get('/test-verification-cron', async (c) => {
  try {
    console.log('🧪 Manual trigger of verification schedule processing...')

    // Execute the same logic as scheduled() but directly
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

    const now = new Date()
    const scheduleWindow = new Date(now.getTime() + 5 * 60 * 1000)

    //  Find pending verification schedules that are due now
    const { data: dueSchedules, error: scheduleError } = await supabaseAdmin
      .from('verification_schedules')
      .select(`
        *,
        deals!inner(
          id,
          post_url,
          platform,
          status,
          posted_at,
          deadline_iso,
          proof_specs(*),
          platform_accounts(account_url, normalized_handle)
        )
      `)
      .eq('status', 'pending')
      .lte('scheduled_at', scheduleWindow.toISOString())
      .eq('deals.status', 'Verifying')
      .not('deals.post_url', 'is', null)
      .limit(20)

    console.log(`📅 Found ${dueSchedules?.length || 0} due verification schedules`)

    if (scheduleError) {
      return c.json({ error: scheduleError.message }, 500)
    }

    const results = []
    for (const schedule of dueSchedules || []) {
      try {
        const deal = schedule.deals

        // Trigger verification
        const { triggerOrchestratorVerification } = await import('./routes/orchestrator')
        const mockContext = {
          env: c.env,
          get: () => null,
        } as any

        const result = await triggerOrchestratorVerification(mockContext, deal, deal.post_url)

        if (result.success) {
          await supabaseAdmin
            .from('verification_schedules')
            .update({
              status: 'running',
              orchestrator_request_id: result.requestId || `test-${schedule.id}`
            })
            .eq('id', schedule.id)

          results.push({ schedule_id: schedule.id, deal_id: deal.id, status: 'triggered' })
        } else {
          results.push({ schedule_id: schedule.id, deal_id: deal.id, status: 'failed', error: result.error })
        }
      } catch (err: any) {
        results.push({ schedule_id: schedule.id, error: err.message })
      }
    }

    // Also check for completion
    const completionResult = await processVerificationCompletion(supabaseAdmin, now, c.env)

    return c.json({
      success: true,
      processed: results.length,
      results,
      completion: completionResult,
      timestamp: now.toISOString()
    })
  } catch (error: any) {
    console.error('❌ Test verification cron error:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Manual payout trigger endpoint for completed deals
app.post('/trigger-payout/:dealId', async (c) => {
  try {
    const dealId = c.req.param('dealId')
    console.log(`💰 Manual payout trigger requested for deal ${dealId}`)

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

    // Check if deal exists and is completed
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('id, status, verification_score, amount_usdc')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    if (deal.status !== 'Completed') {
      return c.json({ error: `Deal status is ${deal.status}, must be Completed` }, 400)
    }

    // Check if payout already exists
    const { data: existingPayouts } = await supabaseAdmin
      .from('payouts')
      .select('*')
      .eq('deal_id', dealId)

    // Delete any old failed/pending payouts to allow retry
    if (existingPayouts && existingPayouts.length > 0) {
      console.log(`🗑️ Deleting ${existingPayouts.length} existing payout(s) for deal ${dealId}`)
      await supabaseAdmin
        .from('payouts')
        .delete()
        .eq('deal_id', dealId)
    }

    // Trigger payout
    await processCreatorPayout(supabaseAdmin, c.env, dealId)

    // Fetch the created payout
    const { data: createdPayout } = await supabaseAdmin
      .from('payouts')
      .select('*')
      .eq('deal_id', dealId)
      .order('ts', { ascending: false })
      .limit(1)
      .single()

    return c.json({
      success: true,
      message: 'Payout triggered successfully',
      payout: createdPayout
    })
  } catch (error: any) {
    console.error('❌ Manual payout trigger error:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Internal routes for orchestrator integration
app.post('/internal/schedule/verification', async (c) => {
  const supabase = c.get('supabase')

  try {
    // Find deals in Verifying status that need verification runs
    const { data: deals, error } = await supabase
      .from('deals')
      .select('id, platform, account_id, posted_at, platform_accounts(account_url)')
      .eq('status', 'Verifying')
      .not('posted_at', 'is', null)
      .limit(20)

    if (error) throw error

    const scheduled = []
    for (const deal of deals || []) {
      // Check if already has a running verification
      const { data: existingRuns } = await supabase
        .from('runs')
        .select('id')
        .eq('deal_id', deal.id)
        .in('status', ['pending', 'running'])

      if (!existingRuns || existingRuns.length === 0) {
        // Create new verification run
        const { data: run, error: runError } = await supabase.rpc('verification_rpcs', {
          action: 'create_run',
          payload: {
            deal_id: deal.id,
            model_versions: { qwen: '2.5-VL' },
            prompt_template_sha: 'default_v1'
          }
        })

        if (!runError) {
          scheduled.push({ deal_id: deal.id, run_id: run.id })
        }
      }
    }

    return c.json({
      success: true,
      scheduled_count: scheduled.length,
      scheduled_jobs: scheduled
    })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/internal/scrape', async (c) => {
  const { deal_id, account_url, job_type, hints } = await c.req.json()

  try {
    const isOrchestratorEnabled = c.env.ORCHESTRATOR_ENABLED === 'true'
    const orchestratorUrl = c.env.ORCHESTRATOR_URL

    if (isOrchestratorEnabled && orchestratorUrl) {
      // Call real orchestrator
      console.log('🤖 Calling real orchestrator for scraping:', { deal_id, account_url })

      const response = await fetch(`${orchestratorUrl}/scrape`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.ORCHESTRATOR_API_KEY}`,
        },
        body: JSON.stringify({
          deal_id,
          account_url,
          job_type,
          hints,
          callback_url: `${c.req.url.split('/internal')[0]}/webhooks/browserless`
        })
      })

      if (!response.ok) {
        throw new Error(`Orchestrator request failed: ${response.status}`)
      }

      const result = await response.json()
      return c.json(result)
    } else {
      // Orchestrator disabled - create HITL review for manual handling
      console.log('🤖 Orchestrator disabled for deal:', deal_id)

      if (c.env.HITL_ENABLED === 'true') {
        const { HITLService } = await import('./hitl')
        const hitlService = new HITLService(c.env)

        try {
          const review = await hitlService.createReview({
            runId: `manual-${Date.now()}`,
            dealId: deal_id,
            reason: 'ORCHESTRATOR_DISABLED',
            severity: 'high',
            evidence: [
              {
                type: 'observation',
                text: `Verification requested for ${job_type} but orchestrator is disabled in development mode`
              },
              {
                type: 'deal_info',
                text: `Deal requires verification: ${account_url}`,
                ref: account_url
              }
            ],
            metadata: {
              job_type,
              account_url,
              hints: hints || {},
              orchestrator_status: 'disabled'
            }
          })

          console.log(`🔔 HITL review created for disabled orchestrator: ${review.reviewId}`)
        } catch (hitlError) {
          console.error('❌ Failed to create HITL review for disabled orchestrator:', hitlError)
        }
      }

      // Return mock response
      const jobId = `scrape_${Date.now()}_${deal_id}`
      return c.json({
        success: true,
        job_id: jobId,
        status: 'queued',
        estimated_completion: new Date(Date.now() + 30000).toISOString(),
        mock: true,
        hitl_created: c.env.HITL_ENABLED === 'true'
      })
    }
  } catch (error: any) {
    console.error('🤖 Scrape orchestration error:', error)
    return c.json({ error: error.message }, 500)
  }
})

app.post('/internal/infer', async (c) => {
  const { deal_id, model, inputs } = await c.req.json()

  try {
    const isOrchestratorEnabled = c.env.ORCHESTRATOR_ENABLED === 'true'
    const orchestratorUrl = c.env.ORCHESTRATOR_URL

    if (isOrchestratorEnabled && orchestratorUrl) {
      // Call real orchestrator for inference
      console.log('🤖 Calling real orchestrator for inference:', { deal_id, model })

      const response = await fetch(`${orchestratorUrl}/infer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.ORCHESTRATOR_API_KEY}`,
        },
        body: JSON.stringify({
          deal_id,
          model,
          inputs,
          callback_url: `${c.req.url.split('/internal')[0]}/webhooks/qwen`
        })
      })

      if (!response.ok) {
        throw new Error(`Orchestrator inference request failed: ${response.status}`)
      }

      const result = await response.json()
      return c.json(result)
    } else {
      // Mock response for development
      console.log('🤖 Mock orchestrator response for inference:', deal_id)
      const infer_id = `infer_${Date.now()}_${deal_id}`

      return c.json({
        success: true,
        infer_id,
        status: 'queued',
        estimated_completion: new Date(Date.now() + 10000).toISOString(),
        mock: true
      })
    }
  } catch (error: any) {
    console.error('🤖 Inference orchestration error:', error)
    return c.json({ error: error.message }, 500)
  }
})

app.post('/internal/callbacks/scrape', async (c) => {
  const { deal_id, run_id, status, artifacts, candidates, error } = await c.req.json()
  const supabase = c.get('supabase')

  try {
    if (status === 'completed' && candidates) {
      // Process candidates
      for (const candidate of candidates) {
        await supabase.rpc('verification_rpcs', {
          action: 'upsert_candidate',
          payload: {
            deal_id,
            platform: candidate.platform,
            platform_post_id: candidate.platform_post_id,
            seen_at: candidate.seen_at || new Date().toISOString()
          }
        })
      }

      // Store artifacts if provided
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

      // Trigger inference with Qwen
      if (candidates.length > 0) {
        console.log(`Triggering inference for deal ${deal_id} with ${candidates.length} candidates`)
        // Would normally call /internal/infer here
      }
    } else if (status === 'failed') {
      // Update run as failed
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
    return c.json({ error: error.message }, 500)
  }
})

app.post('/internal/screencast/start', async (c) => {
  const { deal_id, account_url } = await c.req.json()

  try {
    // This would normally start a Browserless screencast session
    // For MVP, return a mock session ID
    const sessionId = `screencast_${Date.now()}_${deal_id}`

    // Emit stream.started event
    console.log(`Stream started for deal ${deal_id}`)

    return c.json({
      success: true,
      session_id: sessionId,
      status: 'recording',
      started_at: new Date().toISOString()
    })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/internal/screencast/end', async (c) => {
  const { deal_id } = await c.req.json()

  try {
    // This would normally end the Browserless screencast session
    // For MVP, return success
    const sessionId = `screencast_${Date.now()}_${deal_id}`

    // Emit stream.ended event
    console.log(`Stream ended for deal ${deal_id}`)

    return c.json({
      success: true,
      session_id: sessionId,
      status: 'completed',
      ended_at: new Date().toISOString()
    })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Worker error:', err)

  return c.json(
    {
      error: 'Internal Server Error',
      message: c.env.ENVIRONMENT === 'development' ? err.message : undefined,
    },
    500
  )
})

// Export the scheduled handler for cron jobs
export async function scheduled(event: any, env: any, ctx: any) {
  try {
    console.log('🕒 Scheduled event triggered:', event.cron)

    // Process HITL notifications
    if (env.HITL_ENABLED === 'true') {
      try {
        console.log('Processing HITL notifications...')
        const { HITLService } = await import('./hitl')
        const hitlService = new HITLService(env)
        await hitlService.processNotifications()
        console.log('✅ HITL notifications processed')
      } catch (hitlError) {
        console.error('❌ HITL notification processing failed:', hitlError)
      }
    } else {
      console.log('HITL processing disabled')
    }

    // Process scheduled verification checks using verification_schedules table
    if (env.ORCHESTRATOR_ENABLED === 'true') {
      try {
        console.log('⏰ Processing scheduled verification checks...')

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

        const now = new Date()
        // Add 5 minute buffer to catch schedules that are slightly overdue
        const scheduleWindow = new Date(now.getTime() + 5 * 60 * 1000)

        // Find pending verification schedules that are due now
        const { data: dueSchedules, error: scheduleError } = await supabaseAdmin
          .from('verification_schedules')
          .select(`
            *,
            deals!inner(
              id,
              post_url,
              platform,
              status,
              posted_at,
              deadline_iso,
              proof_specs(*),
              platform_accounts(account_url, normalized_handle)
            )
          `)
          .eq('status', 'pending')
          .lte('scheduled_at', scheduleWindow.toISOString())
          .eq('deals.status', 'Verifying') // Only process deals still in verification
          .not('deals.post_url', 'is', null) // Ensure post_url exists
          .limit(20) // Process max 20 schedules per cron run

        if (scheduleError) {
          console.error('❌ Failed to fetch due verification schedules:', scheduleError)
        } else if (dueSchedules && dueSchedules.length > 0) {
          console.log(`📅 Found ${dueSchedules.length} due verification schedules`)

          for (const schedule of dueSchedules) {
            try {
              const deal = schedule.deals

              // Check if deal is still within deadline
              const deadline = new Date(deal.deadline_iso)
              if (now > deadline) {
                console.log(`⏰ Deal ${deal.id} past deadline, marking schedule as expired`)
                await supabaseAdmin
                  .from('verification_schedules')
                  .update({
                    status: 'expired',
                    executed_at: now.toISOString(),
                    notes: 'Deal past deadline'
                  })
                  .eq('id', schedule.id)
                continue
              }

              // Validate post_url
              let isValidPostUrl = false
              try {
                if (deal.post_url && deal.post_url.trim() !== '') {
                  new URL(deal.post_url)
                  isValidPostUrl = true
                }
              } catch {
                isValidPostUrl = false
              }

              if (!isValidPostUrl) {
                console.log(`⚠️ Skipping schedule ${schedule.id} - invalid post URL: ${deal.post_url}`)
                await supabaseAdmin
                  .from('verification_schedules')
                  .update({
                    status: 'failed',
                    executed_at: now.toISOString(),
                    notes: `Invalid post URL: ${deal.post_url}`
                  })
                  .eq('id', schedule.id)
                continue
              }

              // Mark schedule as running
              console.log(`🔄 Executing ${schedule.check_type} verification for deal ${deal.id}`)
              await supabaseAdmin
                .from('verification_schedules')
                .update({
                  status: 'running',
                  executed_at: now.toISOString()
                })
                .eq('id', schedule.id)

              // Trigger verification
              const { triggerOrchestratorVerification } = await import('./routes/orchestrator')
              const mockContext = {
                env,
                get: () => null,
              } as any

              const result = await triggerOrchestratorVerification(mockContext, deal, deal.post_url)

              if (result.success) {
                console.log(`✅ ${schedule.check_type} verification triggered for deal ${deal.id}`)
                await supabaseAdmin
                  .from('verification_schedules')
                  .update({
                    status: 'running',
                    orchestrator_request_id: result.requestId || `cron-${schedule.id}`
                  })
                  .eq('id', schedule.id)
              } else {
                console.error(`❌ Failed to trigger verification for deal ${deal.id}: ${result.error}`)
                await supabaseAdmin
                  .from('verification_schedules')
                  .update({
                    status: 'failed',
                    completed_at: now.toISOString()
                  })
                  .eq('id', schedule.id)
              }

            } catch (scheduleProcessError) {
              console.error(`❌ Error processing schedule ${schedule.id}:`, scheduleProcessError)
              await supabaseAdmin
                .from('verification_schedules')
                .update({
                  status: 'failed',
                  completed_at: now.toISOString()
                })
                .eq('id', schedule.id)
            }
          }
        } else {
          console.log('📅 No due verification schedules found')
        }

        // Check for deals that need final completion logic
        await processVerificationCompletion(supabaseAdmin, now, env)

      } catch (verificationError) {
        console.error('❌ Scheduled verification processing failed:', verificationError)
      }
    } else {
      console.log('⏰ Orchestrator disabled, skipping scheduled verification')
    }

  } catch (error: any) {
    console.error('❌ Scheduled handler error:', error)
  }
}

// Helper function to process verification completion with duration checking
async function processVerificationCompletion(supabaseAdmin: any, now: Date, env: any): Promise<any> {
  const diagnostics = { candidates: 0, completed: [], failed: [], skipped: [] }
  try {
    console.log('🏁 Checking for deals needing completion processing...')

    // Find deals that have verification success but haven't completed duration
    const { data: completionCandidates, error } = await supabaseAdmin
      .from('deals')
      .select(`
        id,
        status,
        posted_at,
        last_verification_at,
        verification_score,
        orchestrator_result,
        deadline_iso,
        proof_specs(duration_hours)
      `)
      .eq('status', 'Verifying')
      .not('last_verification_at', 'is', null)
      .not('posted_at', 'is', null)

    if (error) {
      console.error('❌ Failed to fetch completion candidates:', error)
      diagnostics.error = error.message
      return diagnostics
    }

    diagnostics.candidates = completionCandidates?.length || 0

    if (!completionCandidates || completionCandidates.length === 0) {
      console.log('🏁 No deals needing completion processing')
      return diagnostics
    }

    console.log(`🏁 Found ${completionCandidates.length} deals to check for completion`)

    for (const deal of completionCandidates) {
      try {
        const postedAt = new Date(deal.posted_at)
        // Handle proof_specs as array (Supabase relation returns array)
        const proofSpecs = Array.isArray(deal.proof_specs) ? deal.proof_specs[0] : deal.proof_specs
        const durationHours = proofSpecs?.duration_hours || 24
        const durationMs = durationHours * 60 * 60 * 1000
        const completionTime = new Date(postedAt.getTime() + durationMs)

        const dealDiagnostic = {
          deal_id: deal.id,
          posted_at: deal.posted_at,
          duration_hours: durationHours,
          completion_time: completionTime.toISOString(),
          now: now.toISOString(),
          duration_met: now >= completionTime,
          verification_score: deal.verification_score,
          has_success: false,
          action: 'none'
        }

        // Check if duration has completed
        if (now >= completionTime) {
          // Check if we have a successful verification
          const hasVerificationSuccess = deal.verification_score >= 80 ||
            (deal.orchestrator_result?.data?.analysis?.overall_score >= 80)

          dealDiagnostic.has_success = hasVerificationSuccess

          if (hasVerificationSuccess) {
            dealDiagnostic.action = 'complete'
            console.log(`🎉 Deal ${deal.id} completed: verification passed AND duration completed (${durationHours}h)`)

            // Update deal to completed
            const { data: updateResult, error: updateError } = await supabaseAdmin
              .from('deals')
              .update({
                status: 'Completed',
                updated_at: now.toISOString()
              })
              .eq('id', deal.id)
              .select()

            if (updateError) {
              dealDiagnostic.update_error = updateError.message
              console.error(`❌ Failed to update deal ${deal.id} to Completed:`, updateError)
            } else {
              dealDiagnostic.updated = true
              console.log(`✅ Deal ${deal.id} status updated to Completed`)
            }

            // Mark all remaining verification schedules as completed
            await supabaseAdmin
              .from('verification_schedules')
              .update({
                status: 'completed',
                notes: 'Deal completed - duration requirement met'
              })
              .eq('deal_id', deal.id)
              .eq('status', 'pending')

            // 🔥 TRIGGER PAYOUT TO CREATOR
            try {
              await processCreatorPayout(supabaseAdmin, env, deal.id)
              diagnostics.completed.push(dealDiagnostic)
            } catch (payoutError) {
              console.error(`❌ Failed to process payout for deal ${deal.id}:`, payoutError)
              dealDiagnostic.payout_error = payoutError.message
              diagnostics.completed.push(dealDiagnostic)
              // Don't fail the entire completion process if payout fails
              // Payout can be retried manually or via webhook
            }

          } else {
            dealDiagnostic.action = 'fail'
            console.log(`❌ Deal ${deal.id} failed: duration completed but no successful verification`)

            // Update deal to failed
            await supabaseAdmin
              .from('deals')
              .update({
                status: 'Failed',
                failure_reason: `Duration completed (${durationHours}h) without successful verification`,
                updated_at: now.toISOString()
              })
              .eq('id', deal.id)

            // Mark all remaining verification schedules as cancelled
            await supabaseAdmin
              .from('verification_schedules')
              .update({
                status: 'cancelled',
                notes: 'Deal failed - duration completed without successful verification'
              })
              .eq('deal_id', deal.id)
              .eq('status', 'pending')

            // 🔥 TRIGGER REFUND TO ADVERTISER
            try {
              await processRefund(supabaseAdmin, env, deal.id, 'verification_failed')
              diagnostics.failed.push(dealDiagnostic)
            } catch (refundError) {
              console.error(`❌ Failed to process refund for deal ${deal.id}:`, refundError)
              dealDiagnostic.refund_error = refundError.message
              diagnostics.failed.push(dealDiagnostic)
              // Don't fail the entire process if refund fails
              // Refund can be retried manually
            }
          }
        } else {
          dealDiagnostic.action = 'skip_not_due'
          const hoursRemaining = Math.ceil((completionTime.getTime() - now.getTime()) / (1000 * 60 * 60))
          console.log(`⏳ Deal ${deal.id} still has ${hoursRemaining}h remaining in ${durationHours}h duration`)
          diagnostics.skipped.push(dealDiagnostic)
        }

      } catch (dealError) {
        console.error(`❌ Error processing completion for deal ${deal.id}:`, dealError)
        diagnostics.skipped.push({ deal_id: deal.id, error: dealError.message })
      }
    }

    return diagnostics

  } catch (error) {
    console.error('❌ Verification completion processing failed:', error)
    diagnostics.error = error.message
    return diagnostics
  }
}

// Helper function to retry pending payouts for creators who have now connected Stripe
async function retryPendingPayouts(supabaseAdmin: any, env: any): Promise<{ retried: number; succeeded: number; failed: number; errors: any[] }> {
  try {
    console.log('🔄 Checking for pending payouts to retry...')

    // Find all payouts with status 'awaiting_connection' where creator now has Stripe connected
    const { data: pendingPayouts, error: payoutError } = await supabaseAdmin
      .from('payouts')
      .select(`
        id,
        deal_id,
        amount_usdc,
        deals!inner(
          id,
          creator_id,
          status,
          identities!deals_creator_id_fkey(
            id,
            email,
            stripe_connect_account_id,
            stripe_payouts_enabled
          )
        )
      `)
      .eq('status', 'awaiting_connection')
      .limit(50)

    if (payoutError) {
      console.error('❌ Error fetching pending payouts:', payoutError)
      return { retried: 0, succeeded: 0, failed: 0, errors: [payoutError] }
    }

    const eligible = (pendingPayouts || []).filter((payout: any) => {
      const creator = payout.deals?.identities
      return creator?.stripe_connect_account_id && creator?.stripe_payouts_enabled === true
    })

    console.log(`📊 Found ${pendingPayouts?.length || 0} awaiting_connection payouts, ${eligible.length} eligible for retry`)

    if (eligible.length === 0) {
      return { retried: 0, succeeded: 0, failed: 0, errors: [] }
    }

    const results = { retried: eligible.length, succeeded: 0, failed: 0, errors: [] }

    for (const payout of eligible) {
      try {
        const dealId = payout.deal_id
        const creator = payout.deals.identities

        console.log(`🔄 Retrying payout for deal ${dealId} (creator ${creator.email} now connected)...`)

        // Delete the old awaiting_connection payout record
        await supabaseAdmin
          .from('payouts')
          .delete()
          .eq('id', payout.id)

        // Re-run the payout process (will now succeed because creator is connected)
        await processCreatorPayout(supabaseAdmin, env, dealId)

        results.succeeded++
        console.log(`✅ Payout retry succeeded for deal ${dealId}`)

      } catch (retryError: any) {
        results.failed++
        results.errors.push({ deal_id: payout.deal_id, error: retryError.message })
        console.error(`❌ Payout retry failed for deal ${payout.deal_id}:`, retryError)
      }
    }

    console.log(`✅ Payout retry complete: ${results.succeeded} succeeded, ${results.failed} failed`)
    return results

  } catch (error: any) {
    console.error('❌ Payout retry processing failed:', error)
    return { retried: 0, succeeded: 0, failed: 0, errors: [error] }
  }
}

// Helper function to trigger payout to creator after verification succeeds
async function processCreatorPayout(supabaseAdmin: any, env: any, dealId: string): Promise<void> {
  try {
    console.log(`💰 Processing payout for deal ${dealId}...`)

    // Get deal with creator info and payment method
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select(`
        id,
        amount_usdc,
        creator_id,
        identities!deals_creator_id_fkey(
          id,
          email,
          stripe_connect_account_id,
          solana_wallet_address
        )
      `)
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      throw new Error(`Deal not found: ${dealError?.message}`)
    }

    const creator = deal.identities

    // Check which payment method was used by looking at escrow_events
    const { data: escrowEvent } = await supabaseAdmin
      .from('escrow_events')
      .select('payment_method')
      .eq('deal_id', dealId)
      .eq('event_type', 'Created')
      .single()

    const paymentMethod = escrowEvent?.payment_method || 'stripe'

    // Handle Solana instant payout
    if (paymentMethod === 'solana') {
      if (!creator?.solana_wallet_address) {
        throw new Error('Creator Solana wallet not connected')
      }

      console.log(`💰 SOLANA PAYOUT: Triggering instant payout for ${deal.amount_usdc} USD`)

      // Call internal payout function directly (no HTTP fetch)
      const { processPayoutInternal } = await import('./routes/solana')
      const result = await processPayoutInternal(env, dealId)

      console.log(`✅ Solana payout completed: ${result.tx_signature}`)
      return
    }

    // Handle Stripe payout (legacy - mark as pending settlement)
    if (!creator?.stripe_connect_account_id) {
      throw new Error('Creator Stripe account not found')
    }

    const creatorAmount = deal.amount_usdc
    console.log(`💰 STRIPE PAYOUT: Marking as pending settlement for $${creatorAmount} USD (funds settling in platform balance)`)

    // Record payout as pending_settlement - admin will manually transfer once funds are available
    await supabaseAdmin.from('payouts').insert({
      deal_id: dealId,
      method: 'stripe',
      status: 'pending_settlement',
      destination_account_id: creator.stripe_connect_account_id,
      amount_usdc: creatorAmount
    })

    console.log(`✅ Stripe payout marked pending settlement: $${creatorAmount} USD to creator ${creator.email}`)

  } catch (error: any) {
    console.error(`❌ Payout error for deal ${dealId}:`, error)
    throw error
  }
}

// Helper function to process refund (supports both Stripe and Solana)
async function processRefund(
  supabaseAdmin: any,
  env: any,
  dealId: string,
  reason: 'verification_failed' | 'deadline_missed' | 'dispute' | 'manual'
): Promise<void> {
  try {
    console.log(`💰 Processing refund for deal ${dealId} - reason: ${reason}`)

    // Get original payment from escrow_events
    const { data: escrow, error: escrowError } = await supabaseAdmin
      .from('escrow_events')
      .select('tx_ref, amount_usdc, payment_method, event_type')
      .eq('deal_id', dealId)
      .eq('event_type', 'FundEscrow')
      .single()

    if (escrowError || !escrow) {
      console.warn(`⚠️ No payment found for deal ${dealId} - skipping refund`)
      return
    }

    // Check if refund already exists
    const { data: existingRefund } = await supabaseAdmin
      .from('refunds')
      .select('id, status')
      .eq('deal_id', dealId)
      .single()

    if (existingRefund) {
      if (existingRefund.status === 'completed') {
        console.log(`✅ Refund already completed for deal ${dealId}`)
        return
      }
      if (existingRefund.status === 'processing') {
        console.log(`🔄 Refund already in progress for deal ${dealId}`)
        return
      }
    }

    const paymentMethod = escrow.payment_method || 'stripe'

    // Handle Solana refund
    if (paymentMethod === 'solana') {
      console.log(`💰 SOLANA REFUND: Triggering instant refund for ${dealId}`)

      const response = await fetch(`${env.WORKER_BASE_URL}/v1/solana/refund-escrow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': env.TRUSTDOG_CALLBACK_TOKEN
        },
        body: JSON.stringify({ deal_id: dealId, reason })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(`Solana refund failed: ${error.error || 'Unknown error'}`)
      }

      const result = await response.json()
      console.log(`✅ Solana refund completed: ${result.tx_signature}`)
      return
    }

    // Handle Stripe refund (legacy)
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

    const stripeRefund = await stripe.refunds.create({
      payment_intent: escrow.tx_ref,
      reason: reason === 'dispute' ? 'fraudulent' : 'requested_by_customer',
      metadata: {
        deal_id: dealId,
        refund_reason: reason
      }
    })

    console.log(`✅ Stripe refund created for deal ${dealId}: ${stripeRefund.id}`)

    // Record refund in database
    await supabaseAdmin.from('refunds').insert({
      deal_id: dealId,
      amount_usdc: escrow.amount_usdc,
      reason,
      stripe_refund_id: stripeRefund.id,
      status: 'processing',
      initiated_by: null
    })

    // Record escrow refund event
    await supabaseAdmin.from('escrow_events').insert({
      deal_id: dealId,
      event_type: 'Refunded',
      amount_usdc: escrow.amount_usdc,
      tx_ref: stripeRefund.id
    })

    console.log(`💸 Stripe refund initiated for deal ${dealId} - ${escrow.amount_usdc} USD to advertiser`)

  } catch (error: any) {
    console.error(`❌ Refund processing error for deal ${dealId}:`, error)
    throw error
  }
}

export default {
  fetch: app.fetch,
  scheduled
}