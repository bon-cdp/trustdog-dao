/**
 * Notification Service for TrustDog Worker
 * Handle email and in-app notifications using Supabase
 */

import { createClient } from '@supabase/supabase-js'
import { type HonoContext } from '../types'

export interface NotificationTemplate {
  subject: string
  html: string
  text: string
}

export interface NotificationData {
  user_id: string
  deal_id?: string
  type: string
  title: string
  message: string
  email?: string
  metadata?: any
}

export class NotificationService {
  private supabaseAdmin: any

  constructor(private env: any) {
    this.supabaseAdmin = createClient(
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

  // Email templates for different notification types
  private getEmailTemplate(type: string, data: any): NotificationTemplate {
    const baseUrl = 'https://trustdog.co'
    const dealUrl = data.deal_id ? `${baseUrl}/deal/${data.deal_id}` : baseUrl

    switch (type) {
      case 'deal_created':
        return {
          subject: `New TrustDog Deal Created - $${data.amount_usdc}`,
          html: `
            <h2>New Deal Created!</h2>
            <p>A new deal has been created for your ${data.platform} account.</p>
            <ul>
              <li><strong>Platform:</strong> ${data.platform}</li>
              <li><strong>Account:</strong> ${data.account_handle}</li>
              <li><strong>Amount:</strong> $${data.amount_usdc}</li>
              <li><strong>Deadline:</strong> ${new Date(data.deadline_iso).toLocaleDateString()}</li>
            </ul>
            <p><a href="${dealUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Deal Details</a></p>
            <p>Please review and accept or decline this deal in your TrustDog dashboard.</p>
            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `New Deal Created!\n\nA new deal has been created for your ${data.platform} account.\nPlatform: ${data.platform}\nAccount: ${data.account_handle}\nAmount: $${data.amount_usdc}\nDeadline: ${new Date(data.deadline_iso).toLocaleDateString()}\n\nView deal: ${dealUrl}\n\nPlease review and accept or decline this deal in your TrustDog dashboard.`
        }

      case 'deal_accepted':
        return {
          subject: `Deal Accepted - Payment Required ($${data.amount_usdc})`,
          html: `
            <h2>Deal Accepted!</h2>
            <p>Great news! Your deal has been accepted by the creator.</p>
            <ul>
              <li><strong>Platform:</strong> ${data.platform}</li>
              <li><strong>Creator:</strong> ${data.creator_handle}</li>
              <li><strong>Amount:</strong> $${data.amount_usdc}</li>
            </ul>
            <p><strong>Next Step:</strong> Fund the escrow to activate verification and allow the creator to start working.</p>
            <p><a href="${dealUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Fund Escrow Now</a></p>
            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `Deal Accepted!\n\nGreat news! Your deal has been accepted by the creator.\nPlatform: ${data.platform}\nCreator: ${data.creator_handle}\nAmount: $${data.amount_usdc}\n\nNext Step: Fund the escrow to activate verification.\nView deal: ${dealUrl}`
        }

      case 'deal_funded':
        return {
          subject: `Deal Funded - Ready for Content Creation`,
          html: `
            <h2>Deal Funded Successfully!</h2>
            <p>The escrow has been funded and your deal is now active.</p>
            <ul>
              <li><strong>Platform:</strong> ${data.platform}</li>
              <li><strong>Amount:</strong> $${data.amount_usdc}</li>
              <li><strong>Deadline:</strong> ${new Date(data.deadline_iso).toLocaleDateString()}</li>
            </ul>
            <p><strong>You can now:</strong></p>
            <ul>
              <li>Create and submit your content</li>
              <li>Upload reference materials via the deal dashboard</li>
              <li>Submit your post URL for verification</li>
            </ul>
            <p><a href="${dealUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Go to Deal Dashboard</a></p>
            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `Deal Funded Successfully!\n\nThe escrow has been funded and your deal is now active.\nPlatform: ${data.platform}\nAmount: $${data.amount_usdc}\nDeadline: ${new Date(data.deadline_iso).toLocaleDateString()}\n\nYou can now create and submit your content.\nView deal: ${dealUrl}`
        }

      case 'verification_started':
        return {
          subject: `Verification Started - ${data.platform} Content`,
          html: `
            <h2>Content Verification Started</h2>
            <p>We've begun verifying your submitted content.</p>
            <ul>
              <li><strong>Deal:</strong> ${data.platform} - $${data.amount_usdc}</li>
              <li><strong>Post URL:</strong> <a href="${data.post_url}">${data.post_url}</a></li>
            </ul>
            <p>Our AI-powered verification system is analyzing your content. This typically takes 5-15 minutes.</p>
            <p><a href="${dealUrl}" style="background: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Track Progress</a></p>
            <p><strong>Tip:</strong> Feel free to close this tab and come back later - we'll email you when verification is complete!</p>
            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `Content Verification Started\n\nWe've begun verifying your submitted content.\nDeal: ${data.platform} - $${data.amount_usdc}\nPost URL: ${data.post_url}\n\nVerification typically takes 5-15 minutes.\nTrack progress: ${dealUrl}`
        }

      case 'verification_completed':
        return {
          subject: `Verification Complete - ${data.confidence_score >= 80 ? 'APPROVED' : data.confidence_score >= 60 ? 'UNDER REVIEW' : 'REJECTED'}`,
          html: `
            <h2>Verification Complete!</h2>
            <p>Your content verification has finished with a confidence score of <strong>${data.confidence_score}%</strong>.</p>

            ${data.confidence_score >= 80 ? `
              <div style="background: #dcfce7; border: 1px solid #16a34a; padding: 16px; border-radius: 8px; margin: 16px 0;">
                <h3 style="color: #16a34a; margin: 0 0 8px 0;">✅ APPROVED</h3>
                <p style="margin: 0;">Your content has been automatically approved! Payment will be released shortly.</p>
              </div>
            ` : data.confidence_score >= 60 ? `
              <div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 16px; border-radius: 8px; margin: 16px 0;">
                <h3 style="color: #f59e0b; margin: 0 0 8px 0;">👁️ UNDER REVIEW</h3>
                <p style="margin: 0;">Your content requires human review. Our team will review it within 24 hours.</p>
              </div>
            ` : `
              <div style="background: #fee2e2; border: 1px solid #dc2626; padding: 16px; border-radius: 8px; margin: 16px 0;">
                <h3 style="color: #dc2626; margin: 0 0 8px 0;">❌ REJECTED</h3>
                <p style="margin: 0;">Your content did not meet the verification requirements. Please review and resubmit.</p>
              </div>
            `}

            <p><strong>Requirements Status:</strong></p>
            <ul>
              ${data.requirements_met?.map((req: string) => `<li style="color: #16a34a;">✅ ${req}</li>`).join('') || ''}
              ${data.requirements_failed?.map((req: string) => `<li style="color: #dc2626;">❌ ${req}</li>`).join('') || ''}
            </ul>

            <p><a href="${dealUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Full Results</a></p>

            ${data.confidence_score < 80 ? '<p>Questions? Contact our support team at handler@trustdog.co for quick resolution.</p>' : ''}

            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `Verification Complete!\n\nConfidence Score: ${data.confidence_score}%\nStatus: ${data.confidence_score >= 80 ? 'APPROVED' : data.confidence_score >= 60 ? 'UNDER REVIEW' : 'REJECTED'}\n\nView full results: ${dealUrl}\n\n${data.confidence_score < 80 ? 'Questions? Contact handler@trustdog.co' : ''}`
        }

      case 'contact_request':
        return {
          subject: `New Contact Request - ${data.subject || 'TrustDog Deal'}`,
          html: `
            <h2>New Contact Request</h2>
            <p>You have received a new contact request regarding your completed deal.</p>
            <ul>
              <li><strong>From:</strong> ${data.from_name} (${data.from_email})</li>
              <li><strong>Subject:</strong> ${data.subject}</li>
              <li><strong>Deal:</strong> ${data.deal_platform} - $${data.deal_amount}</li>
            </ul>
            <div style="background: #f9fafb; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0;">
              <p><strong>Message:</strong></p>
              <p>${data.message}</p>
            </div>
            <p><a href="${dealUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Respond via Dashboard</a></p>
            <p><em>You can reply to this contact request through your TrustDog dashboard.</em></p>
            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `New Contact Request\n\nFrom: ${data.from_name} (${data.from_email})\nSubject: ${data.subject}\nDeal: ${data.deal_platform} - $${data.deal_amount}\n\nMessage:\n${data.message}\n\nRespond via dashboard: ${dealUrl}`
        }

      default:
        return {
          subject: 'TrustDog Notification',
          html: `
            <h2>TrustDog Notification</h2>
            <p>${data.message}</p>
            <p><a href="${baseUrl}" style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Visit TrustDog</a></p>
            <hr>
            <p style="color: #666; font-size: 14px;">TrustDog - Evidence-based creator ad verification</p>
          `,
          text: `TrustDog Notification\n\n${data.message}\n\nVisit: ${baseUrl}`
        }
    }
  }

  // Create notification (in-app and email)
  async createNotification(data: NotificationData): Promise<{ success: boolean; notification_id?: string; error?: string }> {
    try {
      // Get user email if not provided
      let userEmail = data.email
      if (!userEmail) {
        const { data: userData, error: userError } = await this.supabaseAdmin.auth.admin.getUserById(data.user_id)
        if (userError || !userData.user?.email) {
          console.error('Failed to get user email for notification:', userError)
          userEmail = null
        } else {
          userEmail = userData.user.email
        }
      }

      // Create in-app notification
      const { data: notification, error: notificationError } = await this.supabaseAdmin
        .from('notifications')
        .insert({
          user_id: data.user_id,
          deal_id: data.deal_id,
          type: data.type,
          title: data.title,
          message: data.message,
          metadata: data.metadata || {}
        })
        .select()
        .single()

      if (notificationError) {
        console.error('Failed to create notification:', notificationError)
        return { success: false, error: notificationError.message }
      }

      // Send email if user email is available
      if (userEmail) {
        try {
          const template = this.getEmailTemplate(data.type, data.metadata || {})

          // Send actual email via Resend API
          let emailResult = null
          let deliveryStatus = 'sent'
          let errorMessage = null

          try {
            if (this.env.RESEND_API_KEY) {
              emailResult = await this.sendResendEmail({
                to: userEmail,
                subject: template.subject,
                html: template.html,
                from: this.env.RESEND_FROM_EMAIL || 'notifications@trustdog.co'
              })
              console.log(`📧 Resend email sent successfully to ${userEmail}: ${emailResult?.id}`)
            } else {
              console.log(`📧 Email notification for ${data.type} (RESEND_API_KEY not configured):`)
              console.log(`To: ${userEmail}`)
              console.log(`Subject: ${template.subject}`)
              deliveryStatus = 'logged'
            }
          } catch (emailError) {
            console.error('Resend email sending failed:', emailError)
            deliveryStatus = 'failed'
            errorMessage = emailError instanceof Error ? emailError.message : 'Unknown error'
          }

          // Always send copy to handler@trustdog.co for critical events
          if (this.env.RESEND_API_KEY && this.shouldNotifyHandler(data.type)) {
            try {
              const handlerResult = await this.sendResendEmail({
                to: 'handler@trustdog.co',
                subject: `[TrustDog Alert] ${template.subject}`,
                html: `<p><strong>User:</strong> ${userEmail}</p><p><strong>Deal ID:</strong> ${data.deal_id || 'N/A'}</p><hr>${template.html}`,
                from: this.env.RESEND_FROM_EMAIL || 'notifications@trustdog.co'
              })
              console.log(`📧 Handler notification sent successfully: ${handlerResult?.id}`)
            } catch (handlerError) {
              console.error('Handler notification failed:', handlerError)
            }
          }

          // Create email notification record
          await this.supabaseAdmin
            .from('email_notifications')
            .insert({
              notification_id: notification.id,
              recipient_email: userEmail,
              template_name: data.type,
              subject: template.subject,
              delivery_status: deliveryStatus,
              resend_id: emailResult?.id || null,
              error_message: errorMessage
            })

          console.log(`✅ Email notification processed for user ${data.user_id} (${deliveryStatus})`)

        } catch (emailError) {
          console.error('Email notification error:', emailError)
          // Don't fail notification creation if email fails
        }
      }

      return {
        success: true,
        notification_id: notification.id
      }

    } catch (error: any) {
      console.error('Notification creation error:', error)
      return {
        success: false,
        error: error.message
      }
    }
  }

  // Resend API integration
  private async sendResendEmail(emailData: {
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
        to: [emailData.to],
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

  // Determine if handler should be notified for this event type
  private shouldNotifyHandler(type: string): boolean {
    const handlerNotifyTypes = [
      'verification_completed',
      'verification_started',
      'deal_funded',
      'contact_request'
    ]
    return handlerNotifyTypes.includes(type)
  }

  // Create deal lifecycle notifications
  async notifyDealCreated(dealData: any): Promise<void> {
    // Notify creator about new deal
    if (dealData.creator_id) {
      await this.createNotification({
        user_id: dealData.creator_id,
        deal_id: dealData.id,
        type: 'deal_created',
        title: `New Deal: $${dealData.amount_usdc} - ${dealData.platform}`,
        message: `A new deal has been created for your ${dealData.platform} account. Please review and accept or decline.`,
        metadata: {
          platform: dealData.platform,
          amount_usdc: dealData.amount_usdc,
          deadline_iso: dealData.deadline_iso,
          account_handle: dealData.platform_accounts?.normalized_handle || '@unknown'
        }
      })
    }
  }

  async notifyDealAccepted(dealData: any): Promise<void> {
    // Notify advertiser that deal was accepted
    if (dealData.advertiser_id) {
      await this.createNotification({
        user_id: dealData.advertiser_id,
        deal_id: dealData.id,
        type: 'deal_accepted',
        title: `Deal Accepted - Payment Required`,
        message: `Your deal has been accepted! Please fund the escrow to activate verification.`,
        metadata: {
          platform: dealData.platform,
          amount_usdc: dealData.amount_usdc,
          creator_handle: dealData.platform_accounts?.normalized_handle || '@unknown'
        }
      })
    }
  }

  async notifyDealFunded(dealData: any): Promise<void> {
    // Notify creator that deal is funded and ready
    if (dealData.creator_id) {
      await this.createNotification({
        user_id: dealData.creator_id,
        deal_id: dealData.id,
        type: 'deal_funded',
        title: `Deal Funded - Ready to Create Content`,
        message: `The deal has been funded! You can now create and submit your content.`,
        metadata: {
          platform: dealData.platform,
          amount_usdc: dealData.amount_usdc,
          deadline_iso: dealData.deadline_iso
        }
      })
    }
  }

  async notifyVerificationStarted(dealData: any, postUrl: string): Promise<void> {
    // Notify both advertiser and creator
    const users = [dealData.advertiser_id, dealData.creator_id].filter(Boolean)

    for (const userId of users) {
      await this.createNotification({
        user_id: userId,
        deal_id: dealData.id,
        type: 'verification_started',
        title: `Verification Started`,
        message: `Content verification has begun. This typically takes 5-15 minutes.`,
        metadata: {
          platform: dealData.platform,
          amount_usdc: dealData.amount_usdc,
          post_url: postUrl
        }
      })
    }
  }

  async notifyVerificationCompleted(dealData: any, verificationResult: any): Promise<void> {
    // Notify both advertiser and creator
    const users = [dealData.advertiser_id, dealData.creator_id].filter(Boolean)
    const confidenceScore = verificationResult.overall_score || 0

    const statusText = confidenceScore >= 80 ? 'APPROVED' :
                      confidenceScore >= 60 ? 'UNDER REVIEW' : 'REJECTED'

    for (const userId of users) {
      await this.createNotification({
        user_id: userId,
        deal_id: dealData.id,
        type: 'verification_completed',
        title: `Verification Complete - ${statusText}`,
        message: `Content verification finished with ${confidenceScore}% confidence. ${statusText}.`,
        metadata: {
          platform: dealData.platform,
          amount_usdc: dealData.amount_usdc,
          confidence_score: confidenceScore,
          requirements_met: verificationResult.proof_verification?.requirements_met || [],
          requirements_failed: verificationResult.proof_verification?.requirements_failed || []
        }
      })
    }
  }

  async notifyRefundFailure(dealData: any, errorMessage: string): Promise<void> {
    // Always notify handler@trustdog.co about refund failures
    if (this.env.RESEND_API_KEY) {
      try {
        await this.sendResendEmail({
          to: 'handler@trustdog.co',
          subject: `[URGENT] Refund Failure - Deal ${dealData.id}`,
          html: `
            <h2 style="color: #dc2626;">🚨 Automatic Refund Failed</h2>
            <p><strong>Deal ID:</strong> ${dealData.id}</p>
            <p><strong>Amount:</strong> $${dealData.amount_usdc}</p>
            <p><strong>Platform:</strong> ${dealData.platform}</p>
            <p><strong>Error:</strong> ${errorMessage}</p>
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
            <hr>
            <p><strong>Action Required:</strong> Manual refund processing needed</p>
            <p><a href="https://trustdog.co/deal/${dealData.id}" style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Deal</a></p>
          `,
          from: this.env.RESEND_FROM_EMAIL || 'notifications@trustdog.co'
        })
        console.log(`📧 Refund failure notification sent to handler@trustdog.co`)
      } catch (emailError) {
        console.error('Failed to send refund failure notification:', emailError)
      }
    }
  }
}

// Helper function to create notification service
export function createNotificationService(env: any): NotificationService {
  return new NotificationService(env)
}