/**
 * Verification Schedule API routes for TrustDog Worker
 * Handle verification scheduling and status display
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Get verification schedule for a deal
app.get('/deals/:id/schedule', authMiddleware, async (c) => {
  const dealId = c.req.param('id')

  try {
    // Get REAL deal data from database
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

    // Get deal with all necessary data (using same pattern as working endpoints)
    const user = c.get('user')
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('id, status, deadline_iso, posted_at, proof_specs(*), advertiser_id, creator_id')
      .eq('id', dealId)
      .or(`advertiser_id.eq.${user.id},creator_id.eq.${user.id}`)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Get existing verification schedules with detailed tracking
    const { data: schedules, error: scheduleError } = await supabaseAdmin
      .from('verification_schedules')
      .select('*')
      .eq('deal_id', dealId)
      .order('scheduled_at', { ascending: true })

    const existingSchedules = schedules || []

    // Calculate duration progress
    const now = new Date()
    const postedAt = new Date(deal.posted_at || deal.created_at)
    const durationHours = deal.proof_specs?.duration_hours || 24
    const durationMs = durationHours * 60 * 60 * 1000
    const completionTime = new Date(postedAt.getTime() + durationMs)
    const elapsedMs = now.getTime() - postedAt.getTime()
    const progressPercentage = Math.min(100, Math.max(0, (elapsedMs / durationMs) * 100))

    // Enhanced schedule summary
    const schedulesSummary = {
      total: existingSchedules.length,
      completed: existingSchedules.filter(s => s.status === 'completed').length,
      running: existingSchedules.filter(s => s.status === 'running').length,
      pending: existingSchedules.filter(s => s.status === 'pending').length,
      failed: existingSchedules.filter(s => s.status === 'failed').length,
      expired: existingSchedules.filter(s => s.status === 'expired').length
    }

    return c.json({
      success: true,
      deal_id: dealId,
      deal_status: deal.status,
      schedules: existingSchedules,
      schedules_summary: schedulesSummary,
      duration_tracking: {
        duration_hours: durationHours,
        posted_at: deal.posted_at,
        completion_time: completionTime.toISOString(),
        progress_percentage: Math.round(progressPercentage),
        time_remaining_hours: Math.max(0, Math.ceil((completionTime.getTime() - now.getTime()) / (1000 * 60 * 60))),
        is_duration_completed: now >= completionTime
      },
      next_verification: calculateNextVerification(deal, existingSchedules),
      current_time: now.toISOString()
    })

  } catch (error: any) {
    console.error('Verification schedule error:', error)
    return c.json({ error: 'Failed to fetch verification schedule' }, 500)
  }
})

// Get verification status and running indicators
app.get('/deals/:id/status', authMiddleware, async (c) => {
  const dealId = c.req.param('id')

  try {
    // Get REAL deal data from database
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

    // Get deal with orchestrator_result and schedule data
    const user = c.get('user')
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select(`
        id, status, orchestrator_result, verification_score, last_verification_at,
        failure_reason, advertiser_id, creator_id, posted_at, deadline_iso,
        proof_specs(duration_hours)
      `)
      .eq('id', dealId)
      .or(`advertiser_id.eq.${user.id},creator_id.eq.${user.id}`)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Get verification schedules for this deal
    const { data: schedules } = await supabaseAdmin
      .from('verification_schedules')
      .select('*')
      .eq('deal_id', dealId)
      .order('scheduled_at', { ascending: true })

    const isRunning = deal.status === 'Verifying' && !deal.orchestrator_result
    const statusDisplay = getStatusDisplay(deal.status, isRunning)

    // Create latest_result with fallback logic for completed deals without orchestrator_result
    let latestResult = null
    if (deal.orchestrator_result) {
      latestResult = {
        score: deal.orchestrator_result.data?.analysis?.overall_score || deal.verification_score || 0,
        timestamp: deal.orchestrator_result.data?.timestamp || deal.last_verification_at
      }
    } else if (deal.status === 'Completed' && deal.verification_score && deal.last_verification_at) {
      // Fallback for completed deals without orchestrator_result
      console.log('🔥 DEAL FALLBACK RESULT USED:', { dealId, verification_score: deal.verification_score, last_verification_at: deal.last_verification_at })
      latestResult = {
        score: deal.verification_score,
        timestamp: deal.last_verification_at
      }
    }

    // Calculate verification progress and timing
    const now = new Date()
    const schedulesSummary = schedules ? {
      total: schedules.length,
      completed: schedules.filter(s => s.status === 'completed').length,
      running: schedules.filter(s => s.status === 'running').length,
      pending: schedules.filter(s => s.status === 'pending').length,
      failed: schedules.filter(s => s.status === 'failed').length
    } : null

    // Duration tracking
    const durationHours = deal.proof_specs?.duration_hours || 24
    let durationTracking = null
    if (deal.posted_at) {
      const postedAt = new Date(deal.posted_at)
      const durationMs = durationHours * 60 * 60 * 1000
      const completionTime = new Date(postedAt.getTime() + durationMs)
      const elapsedMs = now.getTime() - postedAt.getTime()
      const progressPercentage = Math.min(100, Math.max(0, (elapsedMs / durationMs) * 100))

      durationTracking = {
        duration_hours: durationHours,
        posted_at: deal.posted_at,
        completion_time: completionTime.toISOString(),
        progress_percentage: Math.round(progressPercentage),
        time_remaining_hours: Math.max(0, Math.ceil((completionTime.getTime() - now.getTime()) / (1000 * 60 * 60))),
        is_duration_completed: now >= completionTime
      }
    }

    return c.json({
      success: true,
      deal_id: dealId,
      status: deal.status,
      status_display: statusDisplay,
      is_running: isRunning,
      verification_notes: deal.failure_reason || null,
      last_verification_at: deal.last_verification_at,
      next_verification_at: isRunning ? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() : null,
      latest_result: latestResult,
      orchestrator_result: deal.orchestrator_result, // REAL orchestrator result, not hardcoded
      verification_schedules: schedules || [],
      schedules_summary: schedulesSummary,
      duration_tracking: durationTracking,
      support_contact: (isRunning || deal.status === 'Failed') ? 'handler@trustdog.co' : null
    })

  } catch (error: any) {
    console.error('Verification status error:', error)
    return c.json({ error: 'Failed to fetch verification status' }, 500)
  }
})

// Helper function to calculate next verification time
function calculateNextVerification(deal: any, existingSchedules: any[]): any {
  const now = new Date()
  const deadline = new Date(deal.deadline_iso)
  const durationHours = deal.proof_specs?.duration_hours || 24

  // If deal is not active yet, no verification scheduled
  if (!['PendingVerification', 'Verifying', 'Completed'].includes(deal.status)) {
    return null
  }

  // If already completed or failed, no more verifications
  if (['Completed', 'Failed', 'Cancelled'].includes(deal.status)) {
    return null
  }

  // Calculate verification intervals based on duration
  let checkInterval: number // in hours
  if (durationHours <= 24) {
    checkInterval = 4 // Every 4 hours for 1-day deals
  } else if (durationHours <= 72) {
    checkInterval = 12 // Every 12 hours for 3-day deals
  } else {
    checkInterval = 24 // Daily for longer deals
  }

  // Find the next scheduled verification
  const futureSchedules = existingSchedules.filter(s =>
    new Date(s.scheduled_at) > now && s.status === 'pending'
  )

  if (futureSchedules.length > 0) {
    return {
      scheduled_at: futureSchedules[0].scheduled_at,
      check_type: futureSchedules[0].check_type,
      interval_hours: checkInterval,
      message: `Next verification check in ${Math.ceil((new Date(futureSchedules[0].scheduled_at).getTime() - now.getTime()) / (1000 * 60 * 60))} hours`
    }
  }

  // Calculate next verification based on last check or posting time
  const postedAt = deal.posted_at ? new Date(deal.posted_at) : now
  const lastCheckTime = existingSchedules.length > 0 ?
    new Date(Math.max(...existingSchedules.map(s => new Date(s.scheduled_at).getTime()))) :
    postedAt

  const nextCheckTime = new Date(lastCheckTime.getTime() + (checkInterval * 60 * 60 * 1000))

  // Don't schedule checks past the deadline
  if (nextCheckTime > deadline) {
    return {
      scheduled_at: deadline.toISOString(),
      check_type: 'final',
      interval_hours: checkInterval,
      message: 'Final verification at deal deadline'
    }
  }

  return {
    scheduled_at: nextCheckTime.toISOString(),
    check_type: 'periodic',
    interval_hours: checkInterval,
    message: `Next periodic check in ${Math.ceil((nextCheckTime.getTime() - now.getTime()) / (1000 * 60 * 60))} hours`
  }
}

// Helper function to get user-friendly status display
function getStatusDisplay(status: string, isRunning: boolean): any {
  const baseStatuses = {
    'PendingAcceptance': {
      text: 'Waiting for Creator',
      description: 'Deal is waiting for creator to accept',
      color: 'yellow',
      icon: '⏳'
    },
    'PendingFunding': {
      text: 'Waiting for Payment',
      description: 'Deal accepted, waiting for advertiser to fund escrow',
      color: 'blue',
      icon: '💳'
    },
    'PendingVerification': {
      text: 'Ready for Content',
      description: 'Deal is funded, waiting for creator to submit content',
      color: 'blue',
      icon: '📝'
    },
    'InitialVerification': {
      text: 'Initial Check Running',
      description: 'Running initial account verification',
      color: 'purple',
      icon: '🔍'
    },
    'Verifying': {
      text: isRunning ? 'Verification Running' : 'AI Verification Complete',
      description: isRunning ? 'AI verification in progress...' : 'AI verification completed, processing results',
      color: 'orange',
      icon: isRunning ? '🔄' : '🤖'
    },
    'Completed': {
      text: 'Completed Successfully',
      description: 'Content verified and payment released',
      color: 'green',
      icon: '✅'
    },
    'Failed': {
      text: 'Verification Failed',
      description: 'Content did not meet requirements - automatic refund initiated',
      color: 'red',
      icon: '❌'
    },
    'Cancelled': {
      text: 'Deal Cancelled',
      description: 'Deal was cancelled by user',
      color: 'gray',
      icon: '🚫'
    }
  }

  return baseStatuses[status] || {
    text: status,
    description: 'Unknown status',
    color: 'gray',
    icon: '❓'
  }
}

export default app