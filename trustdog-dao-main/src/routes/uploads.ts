/**
 * Uploads API routes for TrustDog Worker
 * Handle file uploads to Supabase Storage
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Upload file to Supabase Storage
app.post('/file', authMiddleware, async (c) => {
  try {
    console.log("👤 Auth in upload:", c.get("user"))
    console.log("👤 All context keys:", Object.keys(c.var))

    const user = c.get('user')
    if (!user) {
      console.log("❌ No user found in context")
      return c.json({ error: 'Authentication required' }, 401)
    }

    const formData = await c.req.formData()
    const file = formData.get('file') as File
    const dealId = formData.get('deal_id') as string
    const artifactType = formData.get('type') as string || 'image'

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    if (!dealId) {
      return c.json({ error: 'deal_id is required' }, 400)
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm']
    if (!allowedTypes.includes(file.type)) {
      return c.json({ error: 'Invalid file type. Allowed: JPEG, PNG, GIF, MP4, WebM' }, 400)
    }

    // Validate file size (10MB limit)
    const maxSize = 10 * 1024 * 1024 // 10MB
    if (file.size > maxSize) {
      return c.json({ error: 'File too large. Maximum size: 10MB' }, 400)
    }

    // Use service role for all database operations (including deal verification)
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

    // Verify user has access to this deal
    console.log("🔍 Looking for deal:", dealId, "for user:", user.id)

    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('advertiser_id, creator_id')
      .eq('id', dealId)
      .single()

    console.log("🔍 Deal lookup result:", { deal, dealError })

    if (!deal || (deal.advertiser_id !== user.id && deal.creator_id !== user.id)) {
      console.log("❌ Deal access denied. Deal:", deal, "User:", user.id)
      return c.json({ error: 'Access denied' }, 403)
    }

    console.log("✅ Deal access granted for user:", user.id)

    // Generate unique filename
    const timestamp = Date.now()
    const fileExtension = file.name.split('.').pop() || 'bin'
    const fileName = `${dealId}/${timestamp}_${user.id}.${fileExtension}`

    // Convert File to ArrayBuffer for Supabase Storage
    const fileBuffer = await file.arrayBuffer()

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('deal-artifacts')
      .upload(fileName, fileBuffer, {
        contentType: file.type,
        metadata: {
          deal_id: dealId,
          uploaded_by: user.id,
          original_name: file.name
        }
      })

    if (uploadError) {
      console.error('Storage upload error:', uploadError)
      return c.json({ error: 'Failed to upload file' }, 500)
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('deal-artifacts')
      .getPublicUrl(fileName)

    // Store artifact reference in database
    const { data: artifact, error: dbError } = await supabaseAdmin
      .from('artifacts')
      .insert({
        type: artifactType,
        ref: urlData.publicUrl,
        meta: {
          deal_id: dealId,
          uploaded_by: user.id,
          original_name: file.name,
          file_size: file.size,
          content_type: file.type,
          storage_path: fileName
        }
      })
      .select()
      .single()

    if (dbError) {
      console.error('Database artifact error:', dbError)
      // Don't fail the upload, just log the error
    }

    return c.json({
      success: true,
      artifact: {
        id: artifact?.id,
        url: urlData.publicUrl,
        type: artifactType,
        original_name: file.name,
        size: file.size
      }
    })

  } catch (error: any) {
    console.error('Upload error:', error)
    return c.json({ error: error.message || 'Upload failed' }, 500)
  }
})

// Get artifacts for a deal
app.get('/deal/:dealId', authMiddleware, async (c) => {
  const dealId = c.req.param('dealId')
  const user = c.get('user')

  // Use service role for all database operations
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

  // Verify user has access to this deal
  const { data: deal } = await supabaseAdmin
    .from('deals')
    .select('advertiser_id, creator_id')
    .eq('id', dealId)
    .single()

  if (!deal || (deal.advertiser_id !== user.id && deal.creator_id !== user.id)) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Get artifacts for this deal
  const { data: artifacts, error } = await supabaseAdmin
    .from('artifacts')
    .select('*')
    .eq('meta->>deal_id', dealId)
    .order('created_at', { ascending: false })

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(artifacts || [])
})

export const uploadsRouter = app