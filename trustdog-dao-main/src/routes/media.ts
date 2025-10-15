/**
 * Media Management API routes for TrustDog Worker
 * Handle file uploads/downloads for deal media
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { authMiddleware } from '../middleware/auth'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Upload media files for a deal (both advertisers and creators)
app.post('/deals/:id/upload', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  try {
    const formData = await c.req.formData()
    const files = formData.getAll('files') as File[]
    const descriptions = formData.getAll('descriptions') as string[]

    if (!files || files.length === 0) {
      return c.json({ error: 'No files provided' }, 400)
    }

    // Validate file count (max 5 files per upload)
    if (files.length > 5) {
      return c.json({ error: 'Maximum 5 files allowed per upload' }, 400)
    }

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

    // Verify user has access to this deal
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('advertiser_id, creator_id, status')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Check if user is either advertiser or creator
    if (deal.advertiser_id !== user.id && deal.creator_id !== user.id) {
      return c.json({ error: 'Access denied' }, 403)
    }

    const uploadResults = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const description = descriptions[i] || ''

      // Validate file size (10MB for images, 50MB for videos)
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')

      if (!isImage && !isVideo) {
        return c.json({
          error: `File "${file.name}" is not supported. Only images and videos are allowed.`
        }, 400)
      }

      const maxSize = isImage ? 10 * 1024 * 1024 : 50 * 1024 * 1024
      if (file.size > maxSize) {
        const maxSizeMB = Math.round(maxSize / (1024 * 1024))
        return c.json({
          error: `File "${file.name}" too large. Maximum size is ${maxSizeMB}MB.`
        }, 400)
      }

      // For MVP, we'll store files as base64 in the database
      // In production, use Cloudflare R2, S3, or Supabase Storage
      const arrayBuffer = await file.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)

      let binary = ''
      const chunkSize = 8192
      for (let j = 0; j < uint8Array.length; j += chunkSize) {
        const chunk = uint8Array.slice(j, j + chunkSize)
        binary += String.fromCharCode.apply(null, Array.from(chunk))
      }

      const base64Data = btoa(binary)
      const dataUrl = `data:${file.type};base64,${base64Data}`

      // Generate unique filename
      const timestamp = Date.now()
      const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')
      const uniqueFileName = `${dealId}_${timestamp}_${sanitizedName}`

      // Store in deal_media table
      const { data: mediaRecord, error: mediaError } = await supabaseAdmin
        .from('deal_media')
        .insert({
          deal_id: dealId,
          uploaded_by: user.id,
          file_name: uniqueFileName,
          original_name: file.name,
          file_type: isImage ? 'image' : 'video',
          file_size: file.size,
          mime_type: file.type,
          storage_url: dataUrl, // Base64 data URL for MVP
          description: description,
          analysis_priority: description.length > 50 ? 'high' : 'medium'
        })
        .select()
        .single()

      if (mediaError) {
        console.error('Media upload error:', mediaError)
        return c.json({
          error: `Failed to save media record for "${file.name}"`
        }, 500)
      }

      uploadResults.push({
        id: mediaRecord.id,
        original_name: file.name,
        file_name: uniqueFileName,
        file_type: mediaRecord.file_type,
        file_size: file.size,
        description: description,
        uploaded_at: mediaRecord.created_at
      })

      console.log(`📁 Media uploaded: ${file.name} (${Math.round(file.size / 1024)}KB) for deal ${dealId}`)
    }

    return c.json({
      success: true,
      uploaded_files: uploadResults,
      total_files: files.length,
      deal_id: dealId
    })

  } catch (error: any) {
    console.error('Media upload error:', error)
    return c.json({
      error: 'Failed to upload media files',
      details: error.message
    }, 500)
  }
})

// Get media files for a deal
app.get('/deals/:id/media', authMiddleware, async (c) => {
  const dealId = c.req.param('id')
  const user = c.get('user')

  try {
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

    // Verify user has access to this deal
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('advertiser_id, creator_id')
      .eq('id', dealId)
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found' }, 404)
    }

    // Check if user is either advertiser or creator
    if (deal.advertiser_id !== user.id && deal.creator_id !== user.id) {
      return c.json({ error: 'Access denied' }, 403)
    }

    // Get all media for this deal
    const { data: mediaFiles, error: mediaError } = await supabaseAdmin
      .from('deal_media')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })

    if (mediaError) {
      console.error('Media fetch error:', mediaError)
      return c.json({ error: 'Failed to fetch media files' }, 500)
    }

    // Return metadata without full base64 data for list view
    const mediaList = mediaFiles.map(media => ({
      id: media.id,
      original_name: media.original_name,
      file_name: media.file_name,
      file_type: media.file_type,
      file_size: media.file_size,
      mime_type: media.mime_type,
      description: media.description,
      analysis_priority: media.analysis_priority,
      uploaded_by: media.uploaded_by,
      uploaded_at: media.created_at,
      download_url: `/v1/media/download/${media.id}`
    }))

    return c.json({
      success: true,
      media_files: mediaList,
      total_files: mediaFiles.length,
      deal_id: dealId
    })

  } catch (error: any) {
    console.error('Media fetch error:', error)
    return c.json({
      error: 'Failed to fetch media files',
      details: error.message
    }, 500)
  }
})

// Download a specific media file
app.get('/download/:mediaId', authMiddleware, async (c) => {
  const mediaId = c.req.param('mediaId')
  const user = c.get('user')

  try {
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

    // Get media file with deal info
    const { data: media, error: mediaError } = await supabaseAdmin
      .from('deal_media')
      .select(`
        *,
        deals!inner(advertiser_id, creator_id)
      `)
      .eq('id', mediaId)
      .single()

    if (mediaError || !media) {
      return c.json({ error: 'Media file not found' }, 404)
    }

    // Check if user has access
    if (media.deals.advertiser_id !== user.id && media.deals.creator_id !== user.id) {
      return c.json({ error: 'Access denied' }, 403)
    }

    // Extract base64 data
    const dataUrl = media.storage_url
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      return c.json({ error: 'Invalid media file' }, 500)
    }

    // Extract mime type and base64 data
    const [header, base64Data] = dataUrl.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || media.mime_type

    // Convert base64 to binary
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    // Set appropriate headers
    c.header('Content-Type', mimeType)
    c.header('Content-Length', bytes.length.toString())
    c.header('Content-Disposition', `attachment; filename="${media.original_name}"`)
    c.header('Cache-Control', 'private, max-age=3600')

    return new Response(bytes, {
      headers: c.res.headers
    })

  } catch (error: any) {
    console.error('Media download error:', error)
    return c.json({
      error: 'Failed to download media file',
      details: error.message
    }, 500)
  }
})

// Delete a media file (uploaded by current user only)
app.delete('/delete/:mediaId', authMiddleware, async (c) => {
  const mediaId = c.req.param('mediaId')
  const user = c.get('user')

  try {
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

    // Verify user uploaded this file
    const { data: media, error: mediaError } = await supabaseAdmin
      .from('deal_media')
      .select('id, original_name, uploaded_by')
      .eq('id', mediaId)
      .eq('uploaded_by', user.id)
      .single()

    if (mediaError || !media) {
      return c.json({ error: 'Media file not found or access denied' }, 404)
    }

    // Delete the record
    const { error: deleteError } = await supabaseAdmin
      .from('deal_media')
      .delete()
      .eq('id', mediaId)
      .eq('uploaded_by', user.id)

    if (deleteError) {
      console.error('Media delete error:', deleteError)
      return c.json({ error: 'Failed to delete media file' }, 500)
    }

    console.log(`🗑️ Media deleted: ${media.original_name} by user ${user.id}`)

    return c.json({
      success: true,
      message: `Media file "${media.original_name}" deleted successfully`
    })

  } catch (error: any) {
    console.error('Media delete error:', error)
    return c.json({
      error: 'Failed to delete media file',
      details: error.message
    }, 500)
  }
})

// Public media endpoint for pending deals (no auth required)
app.get('/deals/:id/media/public', async (c) => {
  const dealId = c.req.param('id')

  try {
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

    // Verify deal is in PendingAcceptance status
    const { data: deal, error: dealError } = await supabaseAdmin
      .from('deals')
      .select('id, status')
      .eq('id', dealId)
      .eq('status', 'PendingAcceptance')
      .single()

    if (dealError || !deal) {
      return c.json({ error: 'Deal not found or not accessible' }, 404)
    }

    // Get media files for this pending deal
    const { data: mediaFiles, error: mediaError } = await supabaseAdmin
      .from('deal_media')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })

    if (mediaError) {
      console.error('Public media fetch error:', mediaError)
      return c.json({ error: 'Failed to fetch media files' }, 500)
    }

    // Return media list (same format as authenticated endpoint)
    const mediaList = mediaFiles.map(media => ({
      id: media.id,
      original_name: media.original_name,
      file_name: media.file_name,
      file_type: media.file_type,
      file_size: media.file_size,
      mime_type: media.mime_type,
      description: media.description,
      analysis_priority: media.analysis_priority,
      uploaded_by: media.uploaded_by,
      uploaded_at: media.created_at,
      download_url: `/v1/media/download/${media.id}/public`
    }))

    console.log(`📁 Public media fetch: ${mediaList.length} files for deal ${dealId}`)

    return c.json({
      success: true,
      media_files: mediaList,
      total_files: mediaFiles.length,
      deal_id: dealId
    })

  } catch (error: any) {
    console.error('Public media fetch error:', error)
    return c.json({
      error: 'Failed to fetch media files',
      details: error.message
    }, 500)
  }
})

// Public media download endpoint for pending deals
app.get('/download/:mediaId/public', async (c) => {
  const mediaId = c.req.param('mediaId')

  try {
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

    // Get media file with deal info - only for pending deals
    const { data: media, error: mediaError } = await supabaseAdmin
      .from('deal_media')
      .select(`
        *,
        deals!inner(id, status)
      `)
      .eq('id', mediaId)
      .eq('deals.status', 'PendingAcceptance')
      .single()

    if (mediaError || !media) {
      return c.json({ error: 'Media file not found or not accessible' }, 404)
    }

    // Extract base64 data
    const dataUrl = media.storage_url
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      return c.json({ error: 'Invalid media file' }, 500)
    }

    // Extract mime type and base64 data
    const [header, base64Data] = dataUrl.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || media.mime_type

    // Convert base64 to binary
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    // Set appropriate headers
    c.header('Content-Type', mimeType)
    c.header('Content-Length', bytes.length.toString())
    c.header('Content-Disposition', `attachment; filename="${media.original_name}"`)
    c.header('Cache-Control', 'private, max-age=3600')

    console.log(`📁 Public media download: ${media.original_name} (${Math.round(bytes.length / 1024)}KB)`)

    return new Response(bytes, {
      headers: c.res.headers
    })

  } catch (error: any) {
    console.error('Public media download error:', error)
    return c.json({
      error: 'Failed to download media file',
      details: error.message
    }, 500)
  }
})

export default app