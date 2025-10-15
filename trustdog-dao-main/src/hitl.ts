/**
 * HITL (Human-in-the-Loop) Service Module
 * Handles review creation, notifications, and escalation for verification failures
 */

import { createClient } from '@supabase/supabase-js'

export interface HITLEvidence {
  type: 'screenshot' | 'html' | 'observation' | 'log'
  ref: string
  text?: string
}

export interface CreateReviewRequest {
  runId: string
  dealId: string
  reason: 'INFERENCE_AMBIGUOUS' | 'CAPTCHA' | 'PLATFORM_BLOCKED' | 'NO_CANDIDATES' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'ORCHESTRATOR_ERROR' | 'MANUAL_REVIEW_NEEDED'
  severity: 'low' | 'medium' | 'high'
  evidence: HITLEvidence[]
  metadata?: {
    platform?: string
    account_url?: string
    attempts?: number
    orchestrator_score?: number
    verification_status?: string
    [key: string]: any
  }
}

export interface ReviewDecision {
  decision: 'release' | 'refund' | 'manual_fail' | 'escalate'
  notes: string
  reviewerId: string
}

export class HITLService {
  private supabase: any
  private env: any

  constructor(env: any) {
    this.env = env
    this.supabase = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )
  }

  /**
   * Create a new review task and queue notification
   */
  async createReview(request: CreateReviewRequest): Promise<{ reviewId: string; success: boolean }> {
    try {
      console.log('🔍 Creating HITL review:', {
        dealId: request.dealId,
        runId: request.runId,
        reason: request.reason,
        severity: request.severity
      })

      // Create review record
      const { data: review, error: reviewError } = await this.supabase
        .from('reviews')
        .insert({
          deal_id: request.dealId,
          run_id: request.runId,
          reason_code: request.reason,
          priority: request.severity,
          status: 'Open',
          notes: JSON.stringify({
            evidence: request.evidence,
            metadata: request.metadata || {},
            created_reason: request.reason
          })
        })
        .select()
        .single()

      if (reviewError) {
        console.error('❌ Failed to create review:', reviewError)
        throw new Error(`Failed to create review: ${reviewError.message}`)
      }

      console.log('✅ Review created:', review.id)

      // Queue notification
      await this.queueNotification(review.id, 'NOTIFIED', {
        dealId: request.dealId,
        runId: request.runId,
        reason: request.reason,
        severity: request.severity,
        evidence: request.evidence
      })

      return { reviewId: review.id, success: true }
    } catch (error) {
      console.error('❌ HITL createReview error:', error)
      throw error
    }
  }

  /**
   * Queue a notification event
   */
  async queueNotification(reviewId: string, eventType: 'NOTIFIED' | 'REMINDED' | 'ESCALATED', payload: any): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('hitl_events')
        .insert({
          review_id: reviewId,
          event_type: eventType,
          payload,
          delivered: false,
          attempts: 0
        })

      if (error) {
        console.error('❌ Failed to queue notification:', error)
        throw new Error(`Failed to queue notification: ${error.message}`)
      }

      console.log(`📧 Queued ${eventType} notification for review:`, reviewId)

      // If not in test mode, immediately try to send
      if (this.env.TEST_EMAIL_MODE !== 'true') {
        await this.processNotifications()
      }
    } catch (error) {
      console.error('❌ Queue notification error:', error)
      throw error
    }
  }

  /**
   * Process pending notifications with retry logic
   */
  async processNotifications(): Promise<void> {
    try {
      const retryLimit = parseInt(this.env.HITL_RETRY_LIMIT || '3')
      const retryDelay = parseInt(this.env.HITL_RETRY_INITIAL_SECONDS || '300') * 1000

      // Get pending notifications
      const { data: events, error } = await this.supabase
        .from('hitl_events')
        .select(`
          *,
          reviews!inner(
            id,
            deal_id,
            run_id,
            reason_code,
            priority,
            status,
            opened_at,
            deals!inner(
              id,
              platform,
              amount_usdc,
              platform_accounts!inner(account_url)
            )
          )
        `)
        .eq('delivered', false)
        .lt('attempts', retryLimit)
        .or(`last_attempt_at.is.null,last_attempt_at.lt.${new Date(Date.now() - retryDelay).toISOString()}`)

      if (error) {
        console.error('❌ Failed to fetch pending notifications:', error)
        return
      }

      console.log(`📧 Processing ${events?.length || 0} pending notifications`)

      for (const event of events || []) {
        await this.sendNotification(event)
      }
    } catch (error) {
      console.error('❌ Process notifications error:', error)
    }
  }

  /**
   * Send individual notification
   */
  async sendNotification(event: any): Promise<void> {
    try {
      const review = event.reviews
      const deal = review.deals

      if (this.env.TEST_EMAIL_MODE === 'true') {
        // Log email content instead of sending
        console.log('📧 TEST EMAIL MODE - Would send:', {
          to: this.env.HITL_ADMIN_EMAILS,
          subject: `[TrustDog HITL] Review Required — Deal ${deal.id} — ${review.reason_code}`,
          review_id: review.id,
          deal_id: deal.id,
          platform: deal.platform,
          amount: deal.amount_usdc,
          reason: review.reason_code,
          priority: review.priority,
          account_url: deal.platform_accounts.account_url,
          evidence_count: event.payload.evidence?.length || 0
        })

        // Mark as delivered
        await this.markNotificationDelivered(event.id, true)
      } else {
        // Send actual email using Resend API
        try {
          const emailResult = await this.sendEmail({
            to: this.env.HITL_ADMIN_EMAILS,
            subject: `[TrustDog HITL] Review Required — Deal ${deal.id} — ${review.reason_code}`,
            html: this.generateEmailHTML(review, deal, event.payload.evidence || []),
            from: this.env.HITL_EMAIL_FROM
          })

          console.log('📧 Email sent successfully:', emailResult)
          await this.markNotificationDelivered(event.id, true)
        } catch (emailError) {
          console.error('❌ Email sending failed:', emailError)
          await this.markNotificationDelivered(event.id, false, String(emailError))
        }
      }
    } catch (error) {
      console.error('❌ Send notification error:', error)
      await this.markNotificationDelivered(event.id, false)
    }
  }

  // Email sending method using Resend API
  private async sendEmail(emailData: {
    to: string
    subject: string
    html: string
    from: string
  }) {
    if (!this.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY not configured')
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: emailData.from,
        to: emailData.to.split(',').map(email => email.trim()),
        subject: emailData.subject,
        html: emailData.html
      })
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(`Resend API error: ${response.status} - ${JSON.stringify(error)}`)
    }

    return await response.json()
  }

  // Generate HTML email template
  private generateEmailHTML(review: any, deal: any, evidence: any[]) {
    const evidenceHtml = evidence.length > 0 ?
      `<h3>🔍 Evidence (${evidence.length} items)</h3>` +
      evidence.map(item =>
        `<div class="evidence">
          <strong>${item.type.toUpperCase()}:</strong> ${item.text}
          ${item.ref ? `<br><small><a href="${item.ref}" target="_blank">${item.ref}</a></small>` : ''}
        </div>`
      ).join('') : ''

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TrustDog HITL Review Required</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .header { background: #ff6b35; color: white; padding: 20px; text-align: center; }
    .content { padding: 30px; }
    .priority-high { border-left: 4px solid #ff4444; padding-left: 10px; }
    .priority-medium { border-left: 4px solid #ffaa00; padding-left: 10px; }
    .priority-low { border-left: 4px solid #44aa44; padding-left: 10px; }
    .deal-info { background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 15px 0; }
    .evidence { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 4px; margin: 10px 0; }
    .button { display: inline-block; background: #ff6b35; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { background: #f8f9fa; padding: 15px 30px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔔 TrustDog Review Required</h1>
      <p>Human verification needed for deal verification</p>
    </div>
    <div class="content">
      <div class="priority-${review.priority}">
        <h2>Review #${review.id.slice(0, 8)}</h2>
        <p><strong>Reason:</strong> ${review.reason_code}</p>
        <p><strong>Priority:</strong> ${review.priority.toUpperCase()}</p>
        <p><strong>Status:</strong> ${review.status}</p>
      </div>
      <div class="deal-info">
        <h3>📋 Deal Information</h3>
        <p><strong>Deal ID:</strong> ${deal.id}</p>
        <p><strong>Platform:</strong> ${deal.platform.toUpperCase()}</p>
        <p><strong>Amount:</strong> $${deal.amount_usdc}</p>
        <p><strong>Account:</strong> <a href="${deal.platform_accounts.account_url}" target="_blank">${deal.platform_accounts.account_url}</a></p>
        <p><strong>Created:</strong> ${new Date(review.opened_at).toLocaleString()}</p>
      </div>
      ${evidenceHtml}
      <div style="text-align: center;">
        <a href="https://trustdog-mvp-frontend.pages.dev/reviewer/${review.id}" class="button">
          🔍 Review Now
        </a>
      </div>
      <p><strong>Next Steps:</strong></p>
      <ol>
        <li>Click "Review Now" to access the review dashboard</li>
        <li>Examine the evidence and deal details</li>
        <li>Make a decision: Release, Refund, Escalate, or Manual Fail</li>
        <li>The system will process your decision automatically</li>
      </ol>
    </div>
    <div class="footer">
      <p>This is an automated notification from TrustDog HITL system.</p>
      <p>Dashboard: <a href="https://trustdog-mvp-frontend.pages.dev/reviewer">https://trustdog-mvp-frontend.pages.dev/reviewer</a></p>
    </div>
  </div>
</body>
</html>`
  }

  /**
   * Mark notification as delivered or failed
   */
  async markNotificationDelivered(eventId: string, success: boolean): Promise<void> {
    try {
      // First get current attempts count, then update
      const { data: current, error: fetchError } = await this.supabase
        .from('hitl_events')
        .select('attempts')
        .eq('id', eventId)
        .single()

      if (fetchError) {
        console.error('❌ Failed to fetch current notification:', fetchError)
        return
      }

      const { error } = await this.supabase
        .from('hitl_events')
        .update({
          delivered: success,
          attempts: (current?.attempts || 0) + 1,
          last_attempt_at: new Date().toISOString()
        })
        .eq('id', eventId)

      if (error) {
        console.error('❌ Failed to update notification status:', error)
      }
    } catch (error) {
      console.error('❌ Mark notification delivered error:', error)
    }
  }

  /**
   * Assign reviewer to a review
   */
  async assignReviewer(reviewId: string, reviewerId: string, assignedBy: string): Promise<void> {
    try {
      // Update review with assigned reviewer
      const { error: reviewError } = await this.supabase
        .from('reviews')
        .update({
          reviewer_id: reviewerId,
          status: 'Assigned'
        })
        .eq('id', reviewId)

      if (reviewError) {
        throw new Error(`Failed to assign reviewer: ${reviewError.message}`)
      }

      // Create assignment record
      const { error: assignmentError } = await this.supabase
        .from('review_assignments')
        .insert({
          review_id: reviewId,
          reviewer_id: reviewerId,
          assigned_by: assignedBy
        })

      if (assignmentError) {
        console.warn('Failed to create assignment record:', assignmentError)
      }

      console.log('✅ Reviewer assigned:', { reviewId, reviewerId })
    } catch (error) {
      console.error('❌ Assign reviewer error:', error)
      throw error
    }
  }

  /**
   * Process reviewer decision
   */
  async processDecision(reviewId: string, decision: ReviewDecision): Promise<void> {
    try {
      console.log('⚖️ Processing reviewer decision:', { reviewId, decision: decision.decision })

      // Update review with decision
      const { error: reviewError } = await this.supabase
        .from('reviews')
        .update({
          decision: this.mapDecisionToEnum(decision.decision),
          status: 'Closed',
          closed_at: new Date().toISOString(),
          reviewer_id: decision.reviewerId,
          notes: decision.notes
        })
        .eq('id', reviewId)

      if (reviewError) {
        throw new Error(`Failed to update review: ${reviewError.message}`)
      }

      // Handle decision-specific actions
      await this.executeDecisionAction(reviewId, decision)

      console.log('✅ Decision processed:', decision.decision)
    } catch (error) {
      console.error('❌ Process decision error:', error)
      throw error
    }
  }

  /**
   * Map decision to database enum
   */
  private mapDecisionToEnum(decision: string): string {
    switch (decision) {
      case 'release': return 'ManualPass'
      case 'refund': return 'ManualFail'
      case 'manual_fail': return 'ManualFail'
      case 'escalate': return 'Retry'
      default: return 'NeedsInfo'
    }
  }

  /**
   * Execute action based on decision
   */
  private async executeDecisionAction(reviewId: string, decision: ReviewDecision): Promise<void> {
    // Get review and deal details
    const { data: review, error } = await this.supabase
      .from('reviews')
      .select(`
        *,
        deals!inner(id, status, amount_usdc),
        runs!inner(id, deal_id)
      `)
      .eq('id', reviewId)
      .single()

    if (error || !review) {
      console.error('Failed to get review details for action:', error)
      return
    }

    switch (decision.decision) {
      case 'release':
        await this.releaseEscrow(review.deals.id, reviewId)
        break
      case 'refund':
      case 'manual_fail':
        await this.refundEscrow(review.deals.id, reviewId)
        break
      case 'escalate':
        await this.escalateReview(reviewId)
        break
      default:
        console.log('No action required for decision:', decision.decision)
    }
  }

  /**
   * Release escrow (manual pass)
   */
  private async releaseEscrow(dealId: string, reviewId: string): Promise<void> {
    console.log('💰 Releasing escrow for deal:', dealId)
    // TODO: Implement escrow release logic
    // This would integrate with the existing payment/escrow system
  }

  /**
   * Refund escrow (manual fail)
   */
  private async refundEscrow(dealId: string, reviewId: string): Promise<void> {
    console.log('↩️ Refunding escrow for deal:', dealId)
    // TODO: Implement escrow refund logic
    // This would integrate with the existing payment/escrow system
  }

  /**
   * Escalate review to urgent status
   */
  private async escalateReview(reviewId: string): Promise<void> {
    console.log('🚨 Escalating review:', reviewId)
    await this.queueNotification(reviewId, 'ESCALATED', {
      escalated_at: new Date().toISOString(),
      escalated_by: 'system'
    })
  }

  /**
   * Get review statistics for monitoring
   */
  async getStats(): Promise<any> {
    try {
      // Get counts by status
      const { data: statusCounts, error: statusError } = await this.supabase
        .from('reviews')
        .select('status')
        .then((result: any) => {
          if (result.error) throw result.error
          const counts = result.data.reduce((acc: any, review: any) => {
            acc[review.status] = (acc[review.status] || 0) + 1
            return acc
          }, {})
          return { data: counts, error: null }
        })

      if (statusError) throw statusError

      // Get average age of open reviews
      const { data: avgAge, error: ageError } = await this.supabase
        .rpc('get_avg_review_age')
        .single()

      return {
        backlog: statusCounts.Open || 0,
        in_progress: statusCounts.InProgress || 0,
        assigned: statusCounts.Assigned || 0,
        closed_today: statusCounts.Closed || 0,
        avg_age_hours: avgAge?.avg_age_hours || 0
      }
    } catch (error) {
      console.error('❌ Get HITL stats error:', error)
      return {
        backlog: 0,
        in_progress: 0,
        assigned: 0,
        closed_today: 0,
        avg_age_hours: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
}