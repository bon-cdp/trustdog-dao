/**
 * Contact Relay API routes for TrustDog Worker
 * Handle secure advertiser-creator messaging
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { validateSchema, contactMessageSchema } from '../middleware/validation'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Create contact request
app.post('/requests', authMiddleware, validateSchema(contactMessageSchema), async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const body = await c.req.json()

  try {
    const { data, error } = await supabase.rpc('contact_rpcs', {
      action: 'create_contact_request',
      payload: {
        ...body,
        from_advertiser_id: user.id
      }
    })

    if (error) throw error

    return c.json(data, 201)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Get contact requests (inbox/outbox)
app.get('/requests', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const { folder = 'all', status, limit = 50, offset = 0 } = c.req.query()

  let query = supabase
    .from('contact_requests')
    .select(`
      *,
      contact_messages(count)
    `)
    .order('updated_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  // Apply folder filter
  if (folder === 'inbox') {
    query = query.eq('to_creator_id', user.id)
  } else if (folder === 'outbox') {
    query = query.eq('from_advertiser_id', user.id)
  } else {
    query = query.or(`from_advertiser_id.eq.${user.id},to_creator_id.eq.${user.id}`)
  }

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(data || [])
})

// Get specific contact request
app.get('/requests/:requestId', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const requestId = c.req.param('requestId')

  const { data: request, error } = await supabase
    .from('contact_requests')
    .select('*')
    .eq('id', requestId)
    .or(`from_advertiser_id.eq.${user.id},to_creator_id.eq.${user.id}`)
    .single()

  if (error) {
    return c.json({ error: error.message }, error.code === 'PGRST116' ? 404 : 500)
  }

  return c.json(request)
})

// Send message in a contact request
app.post('/requests/:requestId/messages', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const requestId = c.req.param('requestId')
  const body = await c.req.json()

  try {
    const { data, error } = await supabase.rpc('contact_rpcs', {
      action: 'send_message',
      payload: {
        request_id: requestId,
        message: body.message
      }
    })

    if (error) throw error

    return c.json(data)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Get messages for a contact request
app.get('/requests/:requestId/messages', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const requestId = c.req.param('requestId')

  try {
    const { data, error } = await supabase.rpc('contact_rpcs', {
      action: 'get_messages',
      payload: { request_id: requestId }
    })

    if (error) throw error

    return c.json(data.messages || [])
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Close contact request
app.post('/requests/:requestId/close', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const requestId = c.req.param('requestId')

  const { error } = await supabase
    .from('contact_requests')
    .update({
      status: 'Closed',
      updated_at: new Date().toISOString()
    })
    .eq('id', requestId)
    .or(`from_advertiser_id.eq.${user.id},to_creator_id.eq.${user.id}`)

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json({ success: true })
})

// Report contact request
app.post('/requests/:requestId/report', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const requestId = c.req.param('requestId')
  const body = await c.req.json()

  // In real implementation, would create a report record and notify moderators
  console.log(`Contact request ${requestId} reported by user ${user.id}:`, body)

  // For MVP, just close the request and mark as blocked
  const { error } = await supabase
    .from('contact_requests')
    .update({
      status: 'Blocked',
      updated_at: new Date().toISOString()
    })
    .eq('id', requestId)

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json({ success: true, message: 'Request has been reported and blocked' })
})

// Get/update contact settings
app.get('/settings', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')

  const { data: settings, error } = await supabase
    .from('contact_settings')
    .select('*')
    .eq('creator_id', user.id)
    .single()

  if (error && error.code !== 'PGRST116') {
    return c.json({ error: error.message }, 500)
  }

  return c.json(settings || {
    creator_id: user.id,
    inbound_allowed: true,
    prefer_email: false,
    relay_email: null
  })
})

app.post('/settings', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const body = await c.req.json()

  try {
    const { data, error } = await supabase.rpc('contact_rpcs', {
      action: 'update_contact_settings',
      payload: {
        creator_id: user.id,
        ...body
      }
    })

    if (error) throw error

    return c.json(data)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Contact via proof wall (public endpoint with deal-specific access)
app.post('/proof-wall/:dealId', async (c) => {
  const dealId = c.req.param('dealId')

  try {
    const body = await c.req.json()
    const { from_email, from_name, subject, message } = body

    // Validate required fields
    if (!from_email || !from_name || !subject || !message) {
      return c.json({
        error: 'Missing required fields: from_email, from_name, subject, message'
      }, 400)
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(from_email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }

    // Use service role to access deal data
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

    // Get deal details and check if it's on proof wall
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select(`
        id,
        advertiser_id,
        creator_id,
        status,
        public_opt_in,
        platform,
        amount_usdc,
        platform_accounts!inner(account_url, normalized_handle)
      `)
      .eq('id', dealId)
      .eq('status', 'Completed')
      .eq('public_opt_in', true)
      .single()

    if (dealError || !deal) {
      return c.json({
        error: 'Deal not found or not available for contact'
      }, 404)
    }

    // Get user emails from auth.users
    const { data: users, error: usersError } = await supabaseAdmin
      .from('auth.users')
      .select('id, email')
      .in('id', [deal.advertiser_id, deal.creator_id])

    if (usersError || !users || users.length < 2) {
      return c.json({
        error: 'Unable to process contact request - user data unavailable'
      }, 500)
    }

    const advertiser = users.find(u => u.id === deal.advertiser_id)
    const creator = users.find(u => u.id === deal.creator_id)

    if (!advertiser || !creator) {
      return c.json({
        error: 'Unable to process contact request - user data incomplete'
      }, 500)
    }

    // Create contact request record
    const { data: contactRequest, error: contactError } = await supabaseAdmin
      .from('contact_requests')
      .insert({
        deal_id: dealId,
        from_user_id: null, // External contact (not authenticated user)
        to_user_id: creator.id, // Default to contacting creator
        from_email: from_email,
        subject: subject,
        message: `Contact via Proof Wall from ${from_name} (${from_email}):\n\n${message}\n\n---\nRegarding deal: ${deal.platform} @${deal.platform_accounts.normalized_handle} - $${deal.amount_usdc}`,
        status: 'pending'
      })
      .select()
      .single()

    if (contactError) {
      console.error('Contact request creation error:', contactError)
      return c.json({
        error: 'Failed to create contact request'
      }, 500)
    }

    // Send email using Supabase Edge Function (or store for later processing)
    try {
      // Create notification for the creator
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: creator.id,
          deal_id: dealId,
          type: 'contact_request',
          title: `New Contact Request: ${subject}`,
          message: `You have received a contact request from ${from_name} regarding your completed deal on ${deal.platform}.`,
          metadata: {
            contact_request_id: contactRequest.id,
            from_email: from_email,
            from_name: from_name,
            deal_platform: deal.platform,
            deal_amount: deal.amount_usdc
          }
        })

      console.log(`📧 Contact request created: ${contactRequest.id} from ${from_email} to ${creator.email}`)

      // In production, trigger Supabase Edge Function to send email
      // For MVP, log the email that would be sent
      console.log(`📧 Email would be sent to ${creator.email}:`)
      console.log(`Subject: New TrustDog Contact Request - ${subject}`)
      console.log(`From: ${from_name} <${from_email}>`)
      console.log(`Message: ${message}`)
      console.log(`Deal: ${deal.platform} @${deal.platform_accounts.normalized_handle} - $${deal.amount_usdc}`)

    } catch (emailError) {
      console.error('Email notification error:', emailError)
      // Don't fail the contact request if email fails
    }

    return c.json({
      success: true,
      message: 'Contact request sent successfully',
      contact_request_id: contactRequest.id
    })

  } catch (error: any) {
    console.error('Proof wall contact error:', error)
    return c.json({
      error: 'Failed to process contact request',
      details: error.message
    }, 500)
  }
})

// Get deal info for proof wall contact form (public endpoint)
app.get('/proof-wall/:dealId/info', async (c) => {
  const dealId = c.req.param('dealId')

  try {
    // Use service role to access deal data
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

    // Get minimal deal info for public display
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select(`
        id,
        platform,
        amount_usdc,
        status,
        public_opt_in,
        platform_accounts!inner(account_url, normalized_handle)
      `)
      .eq('id', dealId)
      .eq('status', 'Completed')
      .eq('public_opt_in', true)
      .single()

    if (dealError || !deal) {
      return c.json({
        error: 'Deal not found or not available for contact'
      }, 404)
    }

    return c.json({
      deal_id: deal.id,
      platform: deal.platform,
      amount_usdc: deal.amount_usdc,
      account_handle: deal.platform_accounts.normalized_handle,
      account_url: deal.platform_accounts.account_url,
      contact_available: true
    })

  } catch (error: any) {
    console.error('Proof wall deal info error:', error)
    return c.json({
      error: 'Failed to fetch deal information'
    }, 500)
  }
})

export const contactRouter = app