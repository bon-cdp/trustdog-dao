/**
 * HITL (Human-in-the-Loop) API Routes
 * Handles review creation, assignment, decisions, and monitoring
 */

import { Hono } from 'hono'
import { authMiddleware, requireRole } from '../middleware/auth'
import { HITLService, CreateReviewRequest, ReviewDecision } from '../hitl'

const app = new Hono()

// Internal route for creating reviews (called by orchestrator or system)
app.post('/internal/hitl/create', async (c) => {
  try {
    const body = await c.req.json() as CreateReviewRequest

    console.log('🔍 HITL create request:', {
      dealId: body.dealId,
      runId: body.runId,
      reason: body.reason,
      severity: body.severity
    })

    // Validate request
    if (!body.runId || !body.dealId || !body.reason) {
      return c.json({ error: 'Missing required fields: runId, dealId, reason' }, 400)
    }

    const hitlService = new HITLService(c.env)
    const result = await hitlService.createReview(body)

    return c.json(result)
  } catch (error: any) {
    console.error('❌ HITL create error:', error)
    return c.json({ error: error.message || 'Failed to create review' }, 500)
  }
})

// Internal route for manual escalation
app.post('/internal/hitl/escalate', async (c) => {
  try {
    const { reviewId, reason } = await c.req.json()

    if (!reviewId) {
      return c.json({ error: 'Missing reviewId' }, 400)
    }

    const hitlService = new HITLService(c.env)
    await hitlService.queueNotification(reviewId, 'ESCALATED', {
      reason: reason || 'manual_escalation',
      escalated_at: new Date().toISOString()
    })

    return c.json({ success: true, message: 'Review escalated' })
  } catch (error: any) {
    console.error('❌ HITL escalate error:', error)
    return c.json({ error: error.message || 'Failed to escalate review' }, 500)
  }
})

// Internal route for test email
app.post('/internal/hitl/test-email', async (c) => {
  try {
    if (c.env.ENVIRONMENT === 'production') {
      return c.json({ error: 'Test email only available in development' }, 403)
    }

    const hitlService = new HITLService(c.env)

    // Create a test notification
    const testPayload = {
      dealId: 'test-deal-123',
      runId: 'test-run-456',
      reason: 'CAPTCHA',
      severity: 'high',
      evidence: [
        { type: 'screenshot', ref: 'https://example.com/test.jpg' }
      ]
    }

    // Queue and process test notification
    await hitlService.queueNotification('test-review-id', 'NOTIFIED', testPayload)

    return c.json({
      success: true,
      message: 'Test email sent (check logs)',
      payload: testPayload
    })
  } catch (error: any) {
    console.error('❌ Test email error:', error)
    return c.json({ error: error.message || 'Failed to send test email' }, 500)
  }
})

// Internal route for stats/monitoring
app.get('/internal/hitl/stats', async (c) => {
  try {
    const hitlService = new HITLService(c.env)
    const stats = await hitlService.getStats()
    return c.json(stats)
  } catch (error: any) {
    console.error('❌ HITL stats error:', error)
    return c.json({ error: error.message || 'Failed to get stats' }, 500)
  }
})

// Public route - List reviews for authenticated reviewer
app.get('/v1/reviews', authMiddleware, requireRole('reviewer'), async (c) => {
  try {
    const user = c.get('user')
    const query = c.req.query()

    const status = query.status || null
    const priority = query.priority || null
    const limit = Math.min(parseInt(query.limit || '20'), 100)
    const offset = parseInt(query.offset || '0')

    const hitlService = new HITLService(c.env)

    let selectQuery = hitlService.supabase
      .from('reviews')
      .select(`
        *,
        deals!inner(
          id,
          platform,
          amount_usdc,
          platform_accounts!inner(account_url)
        ),
        runs!inner(id, status, proof_outcome)
      `)
      .order('opened_at', { ascending: false })
      .range(offset, offset + limit - 1)

    // Apply filters
    if (status) {
      selectQuery = selectQuery.eq('status', status)
    }
    if (priority) {
      selectQuery = selectQuery.eq('priority', priority)
    }

    const { data: reviews, error } = await selectQuery

    if (error) {
      throw new Error(`Failed to fetch reviews: ${error.message}`)
    }

    return c.json({
      reviews: reviews || [],
      pagination: {
        limit,
        offset,
        total: reviews?.length || 0
      }
    })
  } catch (error: any) {
    console.error('❌ List reviews error:', error)
    return c.json({ error: error.message || 'Failed to fetch reviews' }, 500)
  }
})

// Public route - Get review details
app.get('/v1/reviews/:id', authMiddleware, requireRole('reviewer'), async (c) => {
  try {
    const reviewId = c.req.param('id')
    const hitlService = new HITLService(c.env)

    const { data: review, error } = await hitlService.supabase
      .from('reviews')
      .select(`
        *,
        deals!inner(
          id,
          platform,
          amount_usdc,
          deadline_iso,
          status as deal_status,
          platform_accounts!inner(account_url)
        ),
        runs!inner(
          id,
          status,
          proof_outcome,
          started_at,
          completed_at,
          notes,
          steps(id, action, status, ts),
          observations(id, modality, description, confidence, matched_value)
        )
      `)
      .eq('id', reviewId)
      .single()

    if (error || !review) {
      return c.json({ error: 'Review not found' }, 404)
    }

    // Parse notes to extract evidence and metadata
    let parsedNotes = {}
    try {
      parsedNotes = JSON.parse(review.notes || '{}')
    } catch (e) {
      parsedNotes = { notes: review.notes }
    }

    return c.json({
      ...review,
      parsed_notes: parsedNotes
    })
  } catch (error: any) {
    console.error('❌ Get review error:', error)
    return c.json({ error: error.message || 'Failed to fetch review' }, 500)
  }
})

// Public route - Assign reviewer (admin only)
app.post('/v1/reviews/:id/assign', authMiddleware, requireRole('admin'), async (c) => {
  try {
    const reviewId = c.req.param('id')
    const { reviewerId } = await c.req.json()
    const user = c.get('user')

    if (!reviewerId) {
      return c.json({ error: 'Missing reviewerId' }, 400)
    }

    const hitlService = new HITLService(c.env)
    await hitlService.assignReviewer(reviewId, reviewerId, user.id)

    return c.json({ success: true, message: 'Reviewer assigned' })
  } catch (error: any) {
    console.error('❌ Assign reviewer error:', error)
    return c.json({ error: error.message || 'Failed to assign reviewer' }, 500)
  }
})

// Public route - Self-assign review (claim)
app.post('/v1/reviews/:id/claim', authMiddleware, requireRole('reviewer'), async (c) => {
  try {
    const reviewId = c.req.param('id')
    const user = c.get('user')

    const hitlService = new HITLService(c.env)

    // Check if review is available for claiming
    const { data: review, error: checkError } = await hitlService.supabase
      .from('reviews')
      .select('id, status, reviewer_id')
      .eq('id', reviewId)
      .single()

    if (checkError || !review) {
      return c.json({ error: 'Review not found' }, 404)
    }

    if (review.status !== 'Open') {
      return c.json({ error: 'Review is not available for claiming' }, 400)
    }

    // Assign to self and change status
    await hitlService.supabase
      .from('reviews')
      .update({
        reviewer_id: user.id,
        status: 'InProgress'
      })
      .eq('id', reviewId)

    return c.json({ success: true, message: 'Review claimed' })
  } catch (error: any) {
    console.error('❌ Claim review error:', error)
    return c.json({ error: error.message || 'Failed to claim review' }, 500)
  }
})

// Public route - Submit reviewer decision
app.post('/v1/reviews/:id/decision', authMiddleware, requireRole('reviewer'), async (c) => {
  try {
    const reviewId = c.req.param('id')
    const user = c.get('user')
    const body = await c.req.json()

    const { decision, notes } = body

    if (!decision || !notes) {
      return c.json({ error: 'Missing decision or notes' }, 400)
    }

    if (!['release', 'refund', 'manual_fail', 'escalate'].includes(decision)) {
      return c.json({ error: 'Invalid decision type' }, 400)
    }

    const hitlService = new HITLService(c.env)

    // Verify reviewer owns this review or is admin
    const { data: review, error: checkError } = await hitlService.supabase
      .from('reviews')
      .select('id, reviewer_id, status')
      .eq('id', reviewId)
      .single()

    if (checkError || !review) {
      return c.json({ error: 'Review not found' }, 404)
    }

    if (review.reviewer_id !== user.id && user.role !== 'admin') {
      return c.json({ error: 'Not authorized to decide this review' }, 403)
    }

    if (review.status === 'Closed') {
      return c.json({ error: 'Review is already closed' }, 400)
    }

    const reviewDecision: ReviewDecision = {
      decision,
      notes,
      reviewerId: user.id
    }

    await hitlService.processDecision(reviewId, reviewDecision)

    return c.json({ success: true, message: 'Decision processed' })
  } catch (error: any) {
    console.error('❌ Review decision error:', error)
    return c.json({ error: error.message || 'Failed to process decision' }, 500)
  }
})

export default app