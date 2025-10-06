/**
 * Escrow API routes for TrustDog Worker
 * Handle escrow operations and balance queries
 */

import { Hono } from 'hono'
import { authMiddleware, requireAnyRole } from '../middleware/auth'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Get escrow balance for a deal
app.get('/balance/:dealId', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const dealId = c.req.param('dealId')

  try {
    const { data, error } = await supabase.rpc('escrow_rpcs', {
      action: 'get_escrow_balance',
      payload: { deal_id: dealId }
    })

    if (error) throw error

    return c.json({ balance: data.balance })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Get escrow events for a deal
app.get('/events/:dealId', authMiddleware, async (c) => {
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

  const { data: events, error } = await supabase
    .from('escrow_events')
    .select('*')
    .eq('deal_id', dealId)
    .order('ts', { ascending: false })

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(events || [])
})

// Reconcile escrow (admin only)
app.post('/reconcile', authMiddleware, requireAnyRole(['admin']), async (c) => {
  const supabase = c.get('supabase')
  const body = await c.req.json()
  const { deal_ids } = body

  try {
    const { data, error } = await supabase.rpc('escrow_rpcs', {
      action: 'reconcile_escrow',
      payload: { deal_ids }
    })

    if (error) throw error

    return c.json(data)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

export const escrowRouter = app