/**
 * Orchestrator integration routes for TrustDog Worker
 * Handles verification requests and callbacks from orchestrator
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Orchestrator interfaces - Updated to match exact API specification
interface OrchestratorRequest {
  url: string
  callbackUrl: string
  requestId: string
  metadata: {
    deal_id: string
    proof_spec: {
      text_proof?: string
      account_handle?: string
      platform: string
    }
    requirements: {
      text_proof?: string
      account_handle?: string
      platform: string
    }
  }
  options: {
    analysisType: string
    proofSpec?: {
      text_proof?: string
      account_handle?: string
      platform: string
    }
  }
}

// Orchestrator callback response interface - Updated to match exact API specification
interface OrchestratorCallback {
  status: 'completed' | 'error'
  data: {
    deal_id: string
    analysis: {
      overall_score: number
      ai_analysis: string
      content_analysis?: string
      proof_verification: {
        overall_confidence: number
        requirements_met: string[]
        requirements_failed: string[]
        summary: string
      }
      evidence: {
        captions: string[]
        ocr_blocks: any[]
        keyframes: any[]
        links: any[]
        metadata: any[]
        audio_transcripts: string[]
      }
    }
    platform: string
    url: string
    extractedCaption?: string
    files?: string[]
    totalFiles?: number
    analyses?: {
      type: string
      analysis: string
    }[]
    transcriptions?: string[]
    timestamp: string
    requestId: string
    processingTime: number
    apiVersion: string
  }
  error?: string
}

// Helper function to trigger orchestrator verification
export async function triggerOrchestratorVerification(
  c: HonoContext,
  deal: any,
  postUrl: string
): Promise<{ success: boolean; error?: string }> {

  if (c.env.ORCHESTRATOR_ENABLED !== 'true') {
    return { success: false, error: 'Orchestrator is disabled' }
  }

  // Strip query parameters from URL to avoid orchestrator extraction failures
  try {
    const url = new URL(postUrl)
    postUrl = `${url.origin}${url.pathname}`
    console.log(`🧹 Cleaned URL (removed query params): ${postUrl}`)
  } catch (urlError) {
    console.warn(`⚠️ Failed to parse URL for cleaning: ${postUrl}`, urlError)
    // Continue with original URL if parsing fails
  }

  try {
    // Get media descriptions for enhanced verification
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

    // Fetch uploaded media for this deal
    const { data: mediaFiles } = await supabaseAdmin
      .from('deal_media')
      .select('file_type, description, original_name, analysis_priority')
      .eq('deal_id', deal.id)
      .order('analysis_priority', { ascending: false }) // High priority first

    // Build enhanced text proof with media context - FIXED to handle both arrays and objects
    let enhancedTextProof = ''

    // Handle proof_specs as array (from database with joins) vs single object
    if (Array.isArray(deal.proof_specs) && deal.proof_specs.length > 0) {
      enhancedTextProof = deal.proof_specs[0].text_proof || ''
    } else if (deal.proof_specs && typeof deal.proof_specs === 'object') {
      enhancedTextProof = deal.proof_specs.text_proof || ''
    }

    // Fallback to direct text_proof field
    if (!enhancedTextProof) {
      enhancedTextProof = deal.text_proof || ''
    }

    // If we still don't have text proof, use a generic validation message
    if (!enhancedTextProof) {
      enhancedTextProof = 'Verify that the submitted content meets the specified requirements and aligns with the deal terms.'
    }

    console.log(`🔍 Using proof spec text: "${enhancedTextProof}" for deal ${deal.id}`)

    if (mediaFiles && mediaFiles.length > 0) {
      const mediaDescriptions = mediaFiles
        .filter(media => media.description && media.description.trim() !== '')
        .map(media => `${media.file_type.toUpperCase()}: ${media.description} (${media.original_name})`)

      if (mediaDescriptions.length > 0) {
        enhancedTextProof += `\n\nUPLOADED MEDIA REFERENCES:\n${mediaDescriptions.join('\n')}\n\nVerify these media elements appear in the post content.`

        console.log(`📁 Enhanced proof spec with ${mediaDescriptions.length} media descriptions for deal ${deal.id}`)
      }
    }

    // Format request according to orchestrator's expected schema
    const proofSpec = {
      text_proof: enhancedTextProof,
      platform: deal.platform || 'tiktok',
      account_handle: (() => {
        // Try to extract handle from post URL first (for test deals)
        try {
          const url = new URL(postUrl)
          if (url.hostname.includes('tiktok.com')) {
            const pathParts = url.pathname.split('/')
            const userIndex = pathParts.findIndex(part => part.startsWith('@'))
            if (userIndex !== -1) return pathParts[userIndex]
          }
        } catch {}

        // Fall back to account URL from deal
        try {
          if (deal.platform_accounts?.account_url) {
            const url = new URL(deal.platform_accounts.account_url)
            const pathParts = url.pathname.split('/')
            const handle = pathParts.find(part => part.startsWith('@')) || pathParts.pop()
            return handle || '@unknown'
          }
        } catch {}

        return '@unknown'
      })(),
      // Add media metadata for orchestrator context
      media_context: mediaFiles ? {
        total_files: mediaFiles.length,
        file_types: mediaFiles.map(m => m.file_type),
        has_descriptions: mediaFiles.some(m => m.description && m.description.trim() !== ''),
        high_priority_count: mediaFiles.filter(m => m.analysis_priority === 'high').length
      } : null
    }

    const verificationRequest: OrchestratorRequest = {
      url: postUrl,
      callbackUrl: `${c.env.WORKER_BASE_URL || 'https://trustdog-worker.shakil-jiwa1.workers.dev'}/v1/orchestrator/callback`,
      requestId: deal.id,
      metadata: {
        deal_id: deal.id,
        proof_spec: proofSpec,
        requirements: proofSpec
      },
      options: {
        analysisType: "comprehensive",
        proofSpec: proofSpec
      }
    }

    console.log('🎯 Triggering orchestrator verification:', {
      deal_id: deal.id,
      post_url: postUrl,
      platform: deal.platform
    })

    // Construct orchestrator URL - check if it already includes /analyze
    const orchestratorUrl = c.env.ORCHESTRATOR_URL.endsWith('/analyze')
      ? c.env.ORCHESTRATOR_URL
      : `${c.env.ORCHESTRATOR_URL}/analyze`

    const headers = {
      'Content-Type': 'application/json',
      ...(c.env.ORCHESTRATOR_API_KEY && {
        'x-api-key': c.env.ORCHESTRATOR_API_KEY,
        'Authorization': `Bearer ${c.env.ORCHESTRATOR_API_KEY}`
      })
    }

    console.log('🔧 URL:', orchestratorUrl)
    console.log('🔧 API Key:', c.env.ORCHESTRATOR_API_KEY)
    console.log('🔧 Auth Header:', headers.Authorization)
    console.log('🔧 Proof Spec:', JSON.stringify(verificationRequest.metadata.proof_spec))
    console.log('🔧 Body:', JSON.stringify(verificationRequest))

    const response = await fetch(orchestratorUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(verificationRequest),
      signal: AbortSignal.timeout(600000) // 10 minute timeout
    })

    if (!response.ok) {
      throw new Error(`Orchestrator responded with ${response.status}: ${response.statusText}`)
    }

    const result = await response.json()
    console.log('✅ Orchestrator verification triggered successfully:', result)

    return { success: true }
  } catch (error: any) {
    console.error('❌ Failed to trigger orchestrator verification:', error)
    return {
      success: false,
      error: error.message || 'Failed to trigger orchestrator verification'
    }
  }
}

// Callback endpoint for orchestrator results
app.post('/callback', async (c) => {
  // Validate callback authentication - using hardcoded token per API specification
  const authHeader = c.req.header('Authorization')
  const expectedAuth = `Bearer trustdog-callback-secret-token-2024`

  if (!authHeader || authHeader !== expectedAuth) {
    console.error('❌ Invalid orchestrator callback authentication', { received: authHeader, expected: expectedAuth })
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let requestBody: any
  try {
    requestBody = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  console.log('🔔 Received orchestrator verification result:', requestBody)

  // Debug the exact structure for score parsing per API contract
  console.log('🔍 Debug orchestrator response structure:', {
    has_data: !!requestBody.data,
    has_analysis: !!requestBody.data?.analysis,
    analysis_overall_score: requestBody.data?.analysis?.overall_score,
    analysis_proof_verification: !!requestBody.data?.analysis?.proof_verification,
    proof_verification_overall_confidence: requestBody.data?.analysis?.proof_verification?.overall_confidence,
    proof_verification_overall_score: requestBody.data?.analysis?.proof_verification?.overall_score,
    analyses_array_length: requestBody.data?.analyses?.length || 0
  })

  // Handle different orchestrator callback formats
  let dealId: string | null = null
  let verificationStatus: string = 'error'
  let overallScore: number = 0

  // New orchestrator format: { status: "completed", data: { deal_id: "...", analyses: [...] } }
  if (requestBody.data && requestBody.data.deal_id) {
    dealId = requestBody.data.deal_id
    verificationStatus = requestBody.status === 'completed' ? 'completed' : 'failed'

    // Use exact API specification - overall_score is in data.analysis.overall_score
    overallScore = requestBody.data?.analysis?.overall_score || 0
  }
  // Legacy format: { deal_id: "...", verification_status: "...", overall_score: 0 }
  else if (requestBody.deal_id) {
    dealId = requestBody.deal_id
    verificationStatus = requestBody.verification_status || 'error'
    overallScore = requestBody.overall_score || 0
  }

  if (!dealId) {
    console.error('❌ No deal_id found in orchestrator callback')
    return c.json({ error: 'Missing deal_id in callback' }, 400)
  }

  console.log('🔔 Parsed callback data:', {
    deal_id: dealId,
    status: verificationStatus,
    score: overallScore
  })

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
    // Check if this is a test deal (starts with 'test-deal-')
    const isTestDeal = dealId.startsWith('test-deal-')

    if (isTestDeal) {
      // For test deals, store the result in KV storage for frontend retrieval
      console.log('🧪 Processing test deal callback:', dealId)

      // Create comprehensive verification results even for error cases
      let enrichedResult = requestBody.data || {}

      // If this is an error response, create structured analysis for user display
      if (verificationStatus === 'error' || verificationStatus === 'failed') {
        const errorMessage = requestBody.data?.error || requestBody.error || 'Unknown verification error'

        // Create structured analysis that matches frontend expectations
        enrichedResult = {
          ...enrichedResult,
          url: requestBody.data?.url || 'N/A',
          platform: requestBody.data?.platform || 'unknown',
          processingTime: requestBody.data?.processingTime || 0,
          analyses: [{
            type: 'error',
            analysis: `VERIFICATION ERROR:\n\n❌ Issue: ${errorMessage}\n\n📋 Summary:\nThe verification process encountered an error while analyzing your content. This could be due to:\n\n• Content accessibility issues (private/deleted content)\n• Platform restrictions or rate limiting\n• Video download or processing failures\n• Network connectivity problems\n\n🔧 Next Steps:\n• Verify the URL is correct and publicly accessible\n• Try again in a few minutes\n• Contact handler@trustdog.co if issues persist\n\n📞 Support: handler@trustdog.co`
          }],
          analysis: {
            overall_score: 0,
            proof_verification: {
              overall_confidence: 0,
              requirements_met: [],
              requirements_failed: ['Verification could not be completed due to technical error'],
              summary: `Verification failed: ${errorMessage}`
            },
            evidence: {
              captions: [],
              audio_transcripts: [],
              metadata: [],
              ocr_blocks: [],
              keyframes: [],
              links: []
            }
          },
          files: [],
          totalFiles: 0,
          transcriptions: [],
          extractedCaption: null
        }
      }

      // Store the orchestrator result for the test deal
      const testResult = {
        status: verificationStatus,
        data: enrichedResult,
        timestamp: new Date().toISOString(),
        overall_score: overallScore
      }

      // Debug: Log what we're storing for analysis troubleshooting
      console.log('🔍 Debug - Test result analyses:', {
        has_analyses: !!(enrichedResult.analyses),
        analyses_length: enrichedResult.analyses?.length || 0,
        first_analysis: enrichedResult.analyses?.[0] ? 'present' : 'missing',
        is_error_case: verificationStatus === 'error' || verificationStatus === 'failed'
      })

      // Store in KV for 1 hour (3600 seconds)
      if (c.env.TEST_RESULTS_KV) {
        await c.env.TEST_RESULTS_KV.put(dealId, JSON.stringify(testResult), {
          expirationTtl: 3600
        })
      }

      console.log('✅ Test deal result stored in KV:', dealId)
      return c.json({
        success: true,
        test_deal: true,
        deal_id: dealId,
        verification_score: overallScore,
        status: verificationStatus
      })
    }

    // Get current deal to validate (only for real deals)
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      console.error('❌ Deal not found for orchestrator callback:', dealId)
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Determine final status based on verification result
    let finalStatus: string
    let failureReason: string | null = null
    let shouldCreateHITLReview = false

    if (verificationStatus === 'error') {
      // Technical error - route to HITL for manual review
      finalStatus = 'Verifying'
      failureReason = `Orchestrator error: ${requestBody.error_details?.error_message || 'Unknown error'}`
      shouldCreateHITLReview = true
    } else if (verificationStatus === 'failed') {
      // Verification failed - auto-reject
      finalStatus = 'Failed'
      failureReason = `Verification failed - Score: ${overallScore}/100`
    } else {
      // Verification completed - check requirements first, then score
      const score = overallScore
      const confidence = requestBody.data?.analysis?.proof_verification?.overall_confidence || score
      const requirementsFailed = requestBody.data?.analysis?.proof_verification?.requirements_failed || []

      // CRITICAL: If ANY requirement failed (text_proof, platform, etc.), immediately fail the deal
      if (requirementsFailed.length > 0) {
        finalStatus = 'Failed'
        failureReason = `Verification requirements not met: ${requirementsFailed.join(', ')}`
        console.log(`🔥 ORCHESTRATOR CALLBACK: FAILED - Requirements not met: ${requirementsFailed.join(', ')} (score: ${score}%)`)
      } else if (score >= 80) {
        // All requirements met AND high score - keep in Verifying until duration completes
        finalStatus = 'Verifying'
        console.log(`🔥 ORCHESTRATOR CALLBACK: Verification PASSED (${score}%) but keeping in Verifying until duration completes`)
      } else if (score >= 60 || confidence < 70) {
        // Requirements met but low score - route to HITL for manual review
        finalStatus = 'Verifying'
        shouldCreateHITLReview = true
        console.log(`🔥 ORCHESTRATOR CALLBACK: Low score (${score}%) - routing to HITL for manual review`)
      } else {
        // Low score - auto-reject
        finalStatus = 'Failed'
        failureReason = `Low verification confidence: ${score}/100`
        console.log(`🔥 ORCHESTRATOR CALLBACK: FAILED - Low score: ${score}%`)
      }
    }

    // Create enriched orchestrator result for user display (similar to test deals)
    let enrichedOrchestratorResult = requestBody

    // For error cases or failures without proper analysis data, create user-friendly results
    if ((verificationStatus === 'error' || verificationStatus === 'failed' || overallScore === 0) &&
        (!requestBody.data?.analyses || requestBody.data.analyses.length === 0)) {

      const errorMessage = requestBody.data?.error || requestBody.error || failureReason || 'Verification could not be completed'

      // Create structured analysis for display
      enrichedOrchestratorResult = {
        ...requestBody,
        data: {
          ...requestBody.data,
          url: requestBody.data?.url || deal.post_url || 'N/A',
          platform: requestBody.data?.platform || deal.platform || 'unknown',
          processingTime: requestBody.data?.processingTime || 0,
          analyses: [{
            type: 'verification_result',
            analysis: `VERIFICATION RESULT:\n\n${overallScore >= 80 ? '✅' : overallScore >= 60 ? '⚠️' : '❌'} Overall Score: ${overallScore}%\n\n📋 Analysis Summary:\n${
              overallScore >= 80 ? 'Content successfully verified and meets all requirements.' :
              overallScore >= 60 ? 'Content partially verified. Manual review required for final decision.' :
              overallScore > 0 ? 'Content verification found issues with requirements compliance.' :
              `Verification Error: ${errorMessage}`
            }\n\n${overallScore > 0 ? '🔍 Detailed Analysis:\n• Proof requirements checked against submitted content\n• AI analysis completed for visual and audio elements\n• Compliance verification performed\n\n' : ''}${
              overallScore < 80 ? '📞 Support: For questions about this result, contact handler@trustdog.co' : '🎉 Congratulations! Your content has been verified successfully.'
            }`
          }],
          analysis: {
            overall_score: overallScore,
            proof_verification: {
              overall_confidence: overallScore,
              requirements_met: overallScore >= 80 ? ['Content verified successfully'] : [],
              requirements_failed: overallScore < 80 ? [overallScore === 0 ? 'Technical verification error' : 'Some requirements not fully met'] : [],
              summary: overallScore >= 80 ? 'All verification requirements met' :
                      overallScore >= 60 ? 'Partial compliance - manual review needed' :
                      overallScore > 0 ? 'Requirements not met' : `Technical error: ${errorMessage}`
            },
            evidence: requestBody.data?.analysis?.evidence || {
              captions: [],
              audio_transcripts: [],
              metadata: [],
              ocr_blocks: [],
              keyframes: [],
              links: []
            }
          },
          files: requestBody.data?.files || [],
          totalFiles: requestBody.data?.totalFiles || 0,
          transcriptions: requestBody.data?.transcriptions || []
        }
      }
    }

    // Ensure orchestrator_result is properly serializable for JSON storage
    let serializedOrchestratorResult: any = null
    try {
      // Test JSON serialization and parse to ensure it's clean
      const jsonString = JSON.stringify(enrichedOrchestratorResult)
      serializedOrchestratorResult = JSON.parse(jsonString)
      console.log(`🔥 ORCHESTRATOR CALLBACK: Successfully serialized orchestrator_result (${jsonString.length} chars)`)
    } catch (serializationError) {
      console.error(`🔥 ORCHESTRATOR CALLBACK: ❌ JSON serialization failed:`, serializationError)
      // Fallback to a minimal result structure if serialization fails
      serializedOrchestratorResult = {
        status: verificationStatus,
        error: 'Serialization failed',
        fallback_data: {
          overall_score: overallScore,
          timestamp: new Date().toISOString(),
          platform: requestBody.data?.platform || 'unknown'
        }
      }
    }

    // Update deal status (gracefully handle missing columns)
    const updateData = {
      status: finalStatus,
      ...(finalStatus === 'Failed' && { failure_reason: failureReason }),
      // Store the properly serialized orchestrator verification details for display
      orchestrator_result: serializedOrchestratorResult,
      last_verification_at: new Date().toISOString(),
      // CRITICAL: Store verification score for duration completion logic
      verification_score: overallScore
    }

    console.log(`🔥 ORCHESTRATOR CALLBACK: About to persist orchestrator_result to DB for deal ${dealId}`)
    console.log(`🔥 ORCHESTRATOR CALLBACK: updateData.orchestrator_result size:`, JSON.stringify(updateData.orchestrator_result).length, 'characters')
    console.log(`🔥 ORCHESTRATOR CALLBACK: updateData:`, {
      status: updateData.status,
      has_orchestrator_result: !!updateData.orchestrator_result,
      orchestrator_result_keys: updateData.orchestrator_result ? Object.keys(updateData.orchestrator_result) : null,
      last_verification_at: updateData.last_verification_at
    })

    const { data: updatedDeal, error: updateError } = await supabaseAdmin
      .from('deals')
      .update(updateData)
      .eq('id', dealId)
      .select()
      .single()

    if (updateError) {
      console.error(`🔥 ORCHESTRATOR CALLBACK: ❌ DATABASE UPDATE FAILED for deal ${dealId}:`, {
        message: updateError.message,
        code: updateError.code,
        details: updateError.details,
        hint: updateError.hint,
        supabase_code: updateError.code,
        postgres_code: updateError.details,
        full_error_object: JSON.stringify(updateError, null, 2)
      })
      throw updateError
    }

    console.log(`🔥 ORCHESTRATOR CALLBACK: ✅ Deal ${dealId} status updated to: ${finalStatus}`)
    console.log(`🔥 ORCHESTRATOR CALLBACK: ✅ orchestrator_result persisted to database successfully`)

    // Update verification schedules - handle both running and pending (for initial verification)
    console.log(`🔥 ORCHESTRATOR CALLBACK: Looking for schedules to update for deal ${dealId}`)
    const { data: schedulesToUpdate, error: schedulesFetchError } = await supabaseAdmin
      .from('verification_schedules')
      .select('id, status, check_type, scheduled_at')
      .eq('deal_id', dealId)
      .in('status', ['running', 'pending'])
      .order('scheduled_at', { ascending: true })
      .limit(1)

    console.log(`🔥 ORCHESTRATOR CALLBACK: Found ${schedulesToUpdate?.length || 0} schedules to update`, { schedulesToUpdate, schedulesFetchError })

    if (schedulesToUpdate && schedulesToUpdate.length > 0) {
      const schedule = schedulesToUpdate[0]
      const { error: updateError } = await supabaseAdmin
        .from('verification_schedules')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          orchestrator_request_id: requestBody.requestId,
          confidence_score: overallScore,
          result: requestBody.data
        })
        .eq('id', schedule.id)

      if (updateError) {
        console.error(`🔥 ORCHESTRATOR CALLBACK: Failed to update schedule ${schedule.id}:`, updateError)
      } else {
        console.log(`🔥 ORCHESTRATOR CALLBACK: ✅ Updated ${schedule.check_type} schedule (${schedule.status} → completed) with score ${overallScore}`)
      }
    } else {
      console.log(`🔥 ORCHESTRATOR CALLBACK: ⚠️ No pending/running schedules found to update for deal ${dealId}`)
    }

    // Create HITL review if needed for low-confidence or error cases
    if (shouldCreateHITLReview) {
      try {
        const reviewReason = verificationStatus === 'error' ? 'ORCHESTRATOR_ERROR' : 'INFERENCE_AMBIGUOUS'
        const confidence = requestBody.data?.analysis?.proof_verification?.overall_confidence || overallScore

        console.log('🔥 HITL REVIEW CREATED:', { dealId, reason: reviewReason, confidence, score: overallScore })

        // Insert review record
        const { data: review, error: reviewError } = await supabaseAdmin
          .from('reviews')
          .insert({
            deal_id: dealId,
            opened_at: new Date().toISOString(),
            priority: confidence < 50 ? 'high' : 'medium',
            status: 'Open',
            notes: `Orchestrator callback - Score: ${overallScore}, Confidence: ${confidence}%`
          })
          .select()
          .single()

        if (reviewError) {
          console.error('❌ Failed to create HITL review:', reviewError)
        } else {
          // Create notification for HITL team
          const { createNotificationService } = await import('../services/notifications')
          const notificationService = createNotificationService(c.env)

          await notificationService.createNotification({
            user_id: deal.creator_id || deal.advertiser_id, // Notify relevant user
            deal_id: dealId,
            type: 'hitl_review_created',
            title: 'Verification Under Review',
            message: `Deal verification requires manual review (Score: ${overallScore}%)`,
            metadata: { review_id: review.id, confidence, score: overallScore }
          })
        }
      } catch (hitlError) {
        console.error('❌ Failed to create HITL review:', hitlError)
      }
    }

    // TODO: Add completed deals to proof wall automatically (will be handled by separate system)

    // Process automatic refund for failed verifications
    if (finalStatus === 'Failed') {
      try {
        await processAutomaticRefund(supabaseAdmin, c.env, updatedDeal, failureReason)
        console.log(`💰 Automatic refund processed for failed deal: ${dealId}`)
      } catch (refundError) {
        console.error('Failed to process automatic refund:', refundError)
        // Send urgent notification to handler about refund failure
        try {
          const { createNotificationService } = await import('../services/notifications')
          const notificationService = createNotificationService(c.env)
          await notificationService.notifyRefundFailure(updatedDeal, refundError.message)
        } catch (notificationError) {
          console.error('Failed to send refund failure notification:', notificationError)
        }
      }
    }

    // Send notification about verification completion
    try {
      const { createNotificationService } = await import('../services/notifications')
      const notificationService = createNotificationService(c.env)
      await notificationService.notifyVerificationCompleted(updatedDeal, requestBody.data?.analysis || {})
    } catch (notificationError) {
      console.error('Failed to send verification completion notification:', notificationError)
    }

    // Create HITL review if needed (score 60-79 or error cases)
    if (finalStatus === 'Verifying' && c.env.HITL_ENABLED === 'true') {
      try {
        const { HITLService } = await import('../hitl')
        const hitlService = new HITLService(c.env)

        const evidence = [
          {
            type: 'orchestrator_result',
            text: `Orchestrator verification: ${verificationStatus}, Score: ${overallScore}/100`,
            ref: requestBody.data?.post_url || deal.post_url
          },
          {
            type: 'post_url',
            text: `Post URL: ${requestBody.data?.post_url || deal.post_url}`,
            ref: requestBody.data?.post_url || deal.post_url
          }
        ]

        // Add extracted evidence from new format
        const analysis = requestBody.data?.analysis
        if (analysis?.transcription) {
          evidence.push({
            type: 'transcription',
            text: `Audio/Video transcription: ${analysis.transcription}`,
            ref: 'orchestrator_transcription'
          })
        }

        if (analysis?.extracted_text) {
          evidence.push({
            type: 'extracted_text',
            text: `Extracted text: ${analysis.extracted_text}`,
            ref: 'orchestrator_ocr'
          })
        }

        const review = await hitlService.createReview({
          runId: `orchestrator-${Date.now()}`,
          dealId: dealId,
          reason: verificationStatus === 'error' ? 'ORCHESTRATOR_ERROR' : 'MANUAL_REVIEW_NEEDED',
          severity: overallScore < 60 ? 'high' : 'medium',
          evidence,
          metadata: {
            deal_id: dealId,
            orchestrator_score: overallScore,
            verification_status: verificationStatus,
            post_url: requestBody.data?.post_url || deal.post_url,
            processing_time_ms: requestBody.data?.processingTime || 0
          }
        })

        console.log(`🔔 HITL review created for orchestrator result: ${review.reviewId}`)
      } catch (hitlError) {
        console.error('❌ Failed to create HITL review for orchestrator result:', hitlError)
      }
    }

    return c.json({
      success: true,
      deal_status: finalStatus,
      verification_score: overallScore
    })

  } catch (error: any) {
    console.error('❌ Failed to process orchestrator callback:', error)
    return c.json({ error: error.message || 'Failed to process verification result' }, 500)
  }
})

// Polling endpoint for orchestrator to fetch pending verifications
app.get('/pending', async (c) => {
  // Validate orchestrator authentication
  const authHeader = c.req.header('Authorization')
  const expectedAuth = `Bearer ${c.env.ORCHESTRATOR_API_KEY}`

  if (!authHeader || authHeader !== expectedAuth) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

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
    // Find deals waiting for orchestrator verification
    const { data: pendingDeals, error } = await supabaseAdmin
      .from('deals')
      .select(`
        *,
        proof_specs(*),
        platform_accounts(account_url)
      `)
      .eq('status', 'VerifyingWithOrchestrator')
      .order('posted_at', { ascending: true })
      .limit(10) // Process in batches

    if (error) {
      throw error
    }

    // Convert to proper orchestrator request format
    const verificationRequests: OrchestratorRequest[] = pendingDeals.map(deal => {
      const proofSpec = {
        text_proof: deal.proof_specs?.text_proof,
        platform: deal.platform || 'unknown',
        account_handle: (() => {
          try {
            if (deal.platform_accounts?.account_url) {
              const url = new URL(deal.platform_accounts.account_url)
              const pathParts = url.pathname.split('/')
              const handle = pathParts.find(part => part.startsWith('@')) || pathParts.pop()
              return handle || '@unknown'
            }
          } catch {}
          return '@unknown'
        })()
      }

      return {
        url: deal.post_url || '',
        callbackUrl: `${c.env.WORKER_BASE_URL || 'https://trustdog-worker.shakil-jiwa1.workers.dev'}/v1/orchestrator/callback`,
        requestId: deal.id,
        metadata: {
          deal_id: deal.id,
          proof_spec: proofSpec,
          requirements: proofSpec
        },
        options: {
          analysisType: "comprehensive",
          proofSpec: proofSpec
        }
      }
    })

    console.log(`📊 Returning ${verificationRequests.length} pending verifications to orchestrator`)

    return c.json({
      pending_verifications: verificationRequests,
      count: verificationRequests.length,
      format_version: "2025-01-15"
    })

  } catch (error: any) {
    console.error('❌ Failed to fetch pending verifications:', error)
    return c.json({ error: error.message || 'Failed to fetch pending verifications' }, 500)
  }
})

// Test endpoint to trigger orchestrator directly
app.post('/test', async (c) => {
  let requestBody: any = {}

  try {
    requestBody = await c.req.json()
  } catch (e) {
    // Handle case where no body is provided (existing test)
  }

  const { triggerOrchestratorVerification } = await import('./orchestrator')

  // Get URL and proof requirements from request body or use defaults
  const postUrl = requestBody.postUrl || requestBody.post_url || 'https://www.tiktok.com/@botornotdotbot/video/7549745130224274696'
  const proofRequirements = requestBody.proofRequirements || requestBody.proof_requirements || {}

  // Generate a unique test deal ID
  const testDealId = `test-deal-${Date.now()}`

  // Detect platform and account from URL
  let detectedPlatform = 'unknown'
  let detectedAccountUrl = ''
  let detectedAccount = ''

  try {
    const url = new URL(postUrl)
    const hostname = url.hostname.toLowerCase()

    if (hostname.includes('tiktok.com')) {
      detectedPlatform = 'tiktok'
      const pathParts = url.pathname.split('/')
      const userIndex = pathParts.findIndex(part => part.startsWith('@'))
      if (userIndex !== -1) {
        detectedAccount = pathParts[userIndex]
        detectedAccountUrl = `https://www.tiktok.com/${detectedAccount}`
      }
    } else if (hostname.includes('instagram.com')) {
      detectedPlatform = 'instagram'
      const pathParts = url.pathname.split('/')
      const userIndex = pathParts.findIndex((part, idx) => idx > 0 && part && !part.includes('p'))
      if (userIndex !== -1) {
        detectedAccount = `@${pathParts[userIndex]}`
        detectedAccountUrl = `https://www.instagram.com/${pathParts[userIndex]}`
      }
    } else if (hostname.includes('x.com') || hostname.includes('twitter.com')) {
      detectedPlatform = 'twitter'
      const pathParts = url.pathname.split('/')
      if (pathParts[1]) {
        detectedAccount = `@${pathParts[1]}`
        detectedAccountUrl = `https://x.com/${pathParts[1]}`
      }
    }
  } catch (error) {
    console.log('⚠️ Could not parse URL for platform detection:', error)
  }

  // Mock deal object for testing
  const mockDeal = {
    id: testDealId,
    platform: detectedPlatform,
    proof_specs: {
      text_proof: proofRequirements.text_proof || 'Test proof text',
      duration_hours: proofRequirements.duration_hours || 24,
      visual_markers: proofRequirements.visual_markers || [],
      link_markers: proofRequirements.link_markers || []
    },
    platform_accounts: {
      account_url: detectedAccountUrl || postUrl
    },
    amount_usdc: 50,
    deadline_iso: new Date().toISOString()
  }

  console.log('🧪 Testing orchestrator with:', { postUrl, proofRequirements })

  const result = await triggerOrchestratorVerification(c, mockDeal, postUrl)

  return c.json({
    test: 'orchestrator-trigger',
    result,
    test_deal_id: testDealId,  // Frontend can use this to poll for results
    postUrl,
    proofRequirements,
    timestamp: new Date().toISOString()
  })
})

// Get test results endpoint for frontend polling
app.get('/test-result/:dealId', async (c) => {
  const dealId = c.req.param('dealId')

  if (!dealId.startsWith('test-deal-')) {
    return c.json({ error: 'Invalid test deal ID' }, 400)
  }

  try {
    // Retrieve test result from KV storage
    if (!c.env.TEST_RESULTS_KV) {
      return c.json({ error: 'Test results storage not configured' }, 500)
    }

    const resultData = await c.env.TEST_RESULTS_KV.get(dealId)

    if (!resultData) {
      return c.json({
        status: 'pending',
        message: 'Test verification still in progress or result expired'
      })
    }

    const testResult = JSON.parse(resultData)

    return c.json({
      status: 'completed',
      orchestrator_result: testResult,
      deal_id: dealId
    })

  } catch (error: any) {
    console.error('❌ Failed to retrieve test result:', error)
    return c.json({ error: 'Failed to retrieve test result' }, 500)
  }
})

// Health check endpoint
app.get('/health', async (c) => {
  return c.json({
    status: 'healthy',
    orchestrator_enabled: c.env.ORCHESTRATOR_ENABLED === 'true',
    timestamp: new Date().toISOString()
  })
})

// Helper function to process automatic refunds for failed verifications
async function processAutomaticRefund(supabaseAdmin: any, env: any, deal: any, failureReason: string): Promise<void> {
  console.log(`💰 Processing automatic refund for deal ${deal.id} - Reason: ${failureReason}`)

  try {
    // First, check if we have a PaymentIntent associated with this deal
    // For production, this would query the actual payment records

    // Check which payment method was used to determine refund method
    const { data: escrowEvent } = await supabaseAdmin
      .from('escrow_events')
      .select('payment_method')
      .eq('deal_id', deal.id)
      .eq('event_type', 'Created')
      .single()

    const paymentMethod = escrowEvent?.payment_method || 'stripe'

    // Trigger automatic refund via the appropriate endpoint
    try {
      console.log(`🔄 Processing automatic ${paymentMethod} refund for deal ${deal.id}`)

      if (paymentMethod === 'solana') {
        // Call internal refund function directly (no HTTP fetch)
        console.log(`🔄 Processing Solana refund internally for deal ${deal.id}`)

        const { processRefundInternal } = await import('./solana')
        const result = await processRefundInternal(env, deal.id, 'verification_failed')

        console.log(`✅ Solana refund completed for deal ${deal.id}:`, result)
      } else {
        // For Stripe, the cron job will handle it (since funds need to settle first)
        console.log(`⏰ Stripe refund will be processed by cron job once funds are available`)
      }

    } catch (refundError: any) {
      console.error(`❌ Automatic refund processing failed for deal ${deal.id}:`, {
        error: refundError.message,
        stack: refundError.stack
      })

      // Don't throw - we'll let the cron job retry later
      // Just update the deal with failure reason
      await supabaseAdmin
        .from('deals')
        .update({
          failure_reason: `${failureReason} (refund pending: ${refundError.message})`
        })
        .eq('id', deal.id)
    }

    console.log(`✅ Automatic refund processed successfully for deal ${deal.id}`)

  } catch (error) {
    console.error('Automatic refund processing failed:', error)
    throw error
  }
}

export default app