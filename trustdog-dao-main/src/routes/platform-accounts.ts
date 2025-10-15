/**
 * Platform Accounts API routes for TrustDog Worker
 * Handle platform account registration and validation
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { validateSchema, isValidPlatformUrl } from '../middleware/validation'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Public endpoint: Get creators who have completed deals (for discovery)
// MUST be before authMiddleware routes
app.get('/creators', async (c) => {
  // Use service role to bypass RLS for public creators directory
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

  const { platform, search, limit = 50, offset = 0 } = c.req.query()

  try {
    // Get platform_accounts that have at least one completed deal
    let query = supabaseAdmin
      .from('platform_accounts')
      .select(`
        id,
        platform,
        account_url,
        normalized_handle,
        created_at,
        deals!inner(id, status)
      `)
      .eq('deals.status', 'Completed')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    // Filter by platform if specified
    if (platform) {
      query = query.eq('platform', platform)
    }

    // Search by handle if specified
    if (search) {
      query = query.ilike('normalized_handle', `%${search.toLowerCase()}%`)
    }

    const { data, error, count } = await query

    if (error) {
      console.error('Creators query error:', error)
      return c.json({ error: error.message }, 500)
    }

    // Deduplicate and format response (one creator per platform account, even if multiple deals)
    const creatorsMap = new Map()
    data?.forEach(item => {
      if (!creatorsMap.has(item.id)) {
        creatorsMap.set(item.id, {
          id: item.id,
          platform: item.platform,
          account_url: item.account_url,
          normalized_handle: item.normalized_handle,
          created_at: item.created_at,
          deals_count: 1
        })
      } else {
        creatorsMap.get(item.id).deals_count++
      }
    })

    const creators = Array.from(creatorsMap.values())

    c.header('X-Total-Count', String(creators.length))
    return c.json(creators)
  } catch (error: any) {
    console.error('Creators endpoint error:', error)
    return c.json({ error: error.message || 'Failed to fetch creators' }, 500)
  }
})

// Create/register platform account
app.post('/', authMiddleware, validateSchema({
  platform: {
    type: 'string',
    required: true,
    enum: ['tiktok', 'instagram', 'youtube', 'x', 'twitter', 'twitch', 'kick', 'facebook', 'linkedin', 'reddit'],
  },
  account_url: {
    type: 'string',
    required: true,
    minLength: 10,
    maxLength: 500,
    pattern: /^https?:\/\/.+/,
  }
}), async (c) => {
  const supabase = c.get('supabase')
  const { platform, account_url } = await c.req.json()

  // Validate platform URL
  if (!isValidPlatformUrl(account_url, platform)) {
    return c.json({
      error: 'Invalid account URL for specified platform'
    }, 400)
  }

  try {
    // Use the RPC to create the platform account (which includes normalization)
    const { data, error } = await supabase
      .from('platform_accounts')
      .upsert({
        platform,
        account_url,
        normalized_handle: extractHandleFromUrl(account_url, platform),
        last_seen_public: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    return c.json(data, 201)
  } catch (error: any) {
    console.error('Platform account creation error:', error)
    return c.json({ error: error.message || 'Failed to create platform account' }, 500)
  }
}
)
// Helper function to extract handle from URL
// Helper function to extract handle from URL
function extractHandleFromUrl(url: string, platform: string) {
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
      case 'facebook':
        return pathname.replace(/^\/+/, '').split('/')[0]
      case 'linkedin':
        return pathname.replace(/^\/+in\//, '').split('/')[0]
      case 'reddit':
        return pathname.replace(/^\/+(u|user)\//, '').split('/')[0]
      default:
        return pathname.replace(/^\/+/, '').split('/')[0]
    }
  } catch {
    return url.toLowerCase()
  }
}


// Get platform account by ID
app.get('/:id', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const accountId = c.req.param('id')

  const { data, error } = await supabase
    .from('platform_accounts')
    .select('*')
    .eq('id', accountId)
    .single()

  if (error) {
    return c.json({ error: error.message }, error.code === 'PGRST116' ? 404 : 500)
  }

  return c.json(data)
})

// Search platform accounts
app.get('/', authMiddleware, async (c) => {
  const supabase = c.get('supabase')
  const { platform, handle, limit = 50, offset = 0 } = c.req.query()

  let query = supabase
    .from('platform_accounts')
    .select('*')
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1)

  if (platform) query = query.eq('platform', platform)
  if (handle) query = query.ilike('normalized_handle', `%${handle.toLowerCase()}%`)

  const { data, error, count } = await query

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  c.header('X-Total-Count', String(count || data?.length || 0))
  return c.json(data || [])
})

export const platformAccountsRouter = app