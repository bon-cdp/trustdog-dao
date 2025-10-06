/**
 * Verification API routes for TrustDog Worker
 * Handle verification runs, steps, and observations
 */

import { Hono } from 'hono'
import { authMiddleware, requireAnyRole } from '../middleware/auth'

const app = new Hono()

// Get verification runs for a deal
app.get('/deals/:dealId/runs', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const dealId = c.req.param('dealId')
  const user = c.get('user')

  // Verify user has access to this deal
  const { data: deal } = await supabase
    .from('deals')
    .select('advertiser_id, creator_id')
    .eq('id', dealId)
    .single()

  if (!deal || (deal.advertiser_id !== user.id && deal.creator_id !== user.id)) {
    return c.json({ error: 'Access denied' }, 403)
  }

  const { data: runs, error } = await supabase
    .from('runs')
    .select(`
      *,
      steps(*),
      observations(*)
    `)
    .eq('deal_id', dealId)
    .order('started_at', { ascending: false })

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(runs || [])
})

// Get specific run details
app.get('/runs/:runId', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const runId = c.req.param('runId')
  const user = c.get('user')

  const { data: run, error } = await supabase
    .from('runs')
    .select(`
      *,
      deals!inner(advertiser_id, creator_id),
      steps(*),
      observations(*)
    `)
    .eq('id', runId)
    .single()

  if (error) {
    return c.json({ error: error.message }, error.code === 'PGRST116' ? 404 : 500)
  }

  // Check access
  if (run.deals.advertiser_id !== user.id && run.deals.creator_id !== user.id) {
    return c.json({ error: 'Access denied' }, 403)
  }

  return c.json(run)
})

// Get candidates for a deal
app.get('/deals/:dealId/candidates', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const dealId = c.req.param('dealId')
  const user = c.get('user')

  // Verify user has access to this deal
  const { data: deal } = await supabase
    .from('deals')
    .select('advertiser_id, creator_id')
    .eq('id', dealId)
    .single()

  if (!deal || (deal.advertiser_id !== user.id && deal.creator_id !== user.id)) {
    return c.json({ error: 'Access denied' }, 403)
  }

  const { data: candidates, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('deal_id', dealId)
    .order('first_seen_at', { ascending: false })

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(candidates || [])
})

// Manual verification trigger (admin/reviewer only)
app.post('/deals/:dealId/trigger', authMiddleware, requireAnyRole(['admin', 'reviewer']), async (c) => {
  const supabase = c.get('supabase')
  const dealId = c.req.param('dealId')

  try {
    // Create new verification run
    const { data: run, error } = await supabase.rpc('verification_rpcs', {
      action: 'create_run',
      payload: {
        deal_id: dealId,
        model_versions: { qwen: '2.5-VL' },
        prompt_template_sha: 'manual_trigger_v1'
      }
    })

    if (error) throw error

    // TODO: Enqueue actual verification job
    console.log(`Manual verification triggered for deal ${dealId}, run ${run.id}`)

    return c.json({ run_id: run.id, message: 'Verification triggered' })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

export const verificationRouter = app