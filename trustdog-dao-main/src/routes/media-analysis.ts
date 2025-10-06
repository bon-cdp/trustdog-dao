/**
 * Media Analysis API routes for TrustDog Worker
 * QwenVL analysis for uploaded images and videos
 */

import { Hono } from 'hono'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Enhanced media analysis for both images and videos using DashScope
app.post('/analyze-media', async (c) => {
  try {
    const formData = await c.req.formData()
    const files = formData.getAll('files') as File[]
    const prompt = formData.get('prompt') as string

    if (!files || files.length === 0 || !prompt) {
      return c.json({ error: 'Missing required fields: files (images/videos), prompt' }, 400)
    }

    // Separate images and videos
    const imageFiles = files.filter(f => f.type.startsWith('image/'))
    const videoFiles = files.filter(f => f.type.startsWith('video/'))
    const unsupportedFiles = files.filter(f => !f.type.startsWith('image/') && !f.type.startsWith('video/'))

    if (unsupportedFiles.length > 0) {
      return c.json({
        error: `Unsupported file types: ${unsupportedFiles.map(f => f.name).join(', ')}. Only images and videos are supported.`
      }, 400)
    }

    // Check file count limits
    if (imageFiles.length > 5) {
      return c.json({
        error: 'Too many images. Maximum 5 images allowed.'
      }, 400)
    }

    if (videoFiles.length > 1) {
      return c.json({
        error: 'Too many videos. Maximum 1 video allowed.'
      }, 400)
    }

    // Check file size limits (10MB for images, 50MB for videos)
    const maxImageSizeBytes = 10 * 1024 * 1024 // 10MB for images
    const maxVideoSizeBytes = 50 * 1024 * 1024 // 50MB for videos

    for (const file of imageFiles) {
      if (file.size > maxImageSizeBytes) {
        const maxSizeMB = Math.round(maxImageSizeBytes / (1024 * 1024))
        return c.json({
          error: `Image "${file.name}" too large. Maximum size is ${maxSizeMB}MB. Your file is ${Math.round(file.size / (1024 * 1024))}MB.`
        }, 400)
      }
    }

    for (const file of videoFiles) {
      if (file.size > maxVideoSizeBytes) {
        const maxSizeMB = Math.round(maxVideoSizeBytes / (1024 * 1024))
        return c.json({
          error: `Video "${file.name}" too large. Maximum size is ${maxSizeMB}MB. Your file is ${Math.round(file.size / (1024 * 1024))}MB.`
        }, 400)
      }
    }

    const analysisResults = []

    // Process images using QwenVL compatible API
    if (imageFiles.length > 0) {
      const imageContents = []
      for (const file of imageFiles) {
        const arrayBuffer = await file.arrayBuffer()
        const uint8Array = new Uint8Array(arrayBuffer)

        // Convert to base64 in chunks to avoid stack overflow
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize)
          binary += String.fromCharCode.apply(null, Array.from(chunk))
        }

        const base64 = btoa(binary)
        const dataUrl = `data:${file.type};base64,${base64}`

        imageContents.push({
          type: 'image_url',
          image_url: {
            url: dataUrl
          }
        })
      }

      console.log('🎯 About to call QwenVL API for images:', {
        image_count: imageFiles.length,
        file_names: imageFiles.map(f => f.name),
        file_sizes: imageFiles.map(f => f.size),
        prompt_length: prompt.length
      })

      // Build message content with text first, then images
      const messageContent = [
        {
          type: 'text',
          text: prompt
        },
        ...imageContents
      ]

      // Call QwenVL API for images
      const qwenResponse = await fetch(`${c.env.QWEN_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.QWEN_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: c.env.QWEN_MODEL || 'qwen-vl-max',
          messages: [
            {
              role: 'user',
              content: messageContent
            }
          ],
          temperature: 0.1,
          max_tokens: 300
        })
      })

      if (!qwenResponse.ok) {
        const errorText = await qwenResponse.text().catch(() => 'Unknown error')
        console.error('🎯 QwenVL API Error:', {
          status: qwenResponse.status,
          statusText: qwenResponse.statusText,
          error: errorText
        })
        throw new Error(`QwenVL API error: ${qwenResponse.status} - ${errorText}`)
      }

      const qwenResult = await qwenResponse.json()
      const imageAnalysis = qwenResult.choices?.[0]?.message?.content || 'No analysis generated'

      analysisResults.push({
        type: 'images',
        count: imageFiles.length,
        analysis: imageAnalysis,
        filenames: imageFiles.map(f => f.name)
      })
    }

    // Process videos using DashScope native API
    if (videoFiles.length > 0) {
      for (const videoFile of videoFiles) {
        console.log('🎯 About to call DashScope API for video:', {
          video_name: videoFile.name,
          video_size: videoFile.size,
          prompt_length: prompt.length
        })

        // For video processing, we need to convert to frames or use external URLs
        // Since we can't directly upload binary video data, we'll simulate analysis
        // In production, you'd upload to storage first and use the URL

        const videoAnalysisPayload = {
          model: c.env.DASHSCOPE_VIDEO_MODEL || 'qwen2.5-vl-72b-instruct',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    video: [
                      // This would be frame URLs in production
                      // For now, we'll use a text-based analysis
                    ],
                    fps: 2
                  },
                  {
                    text: `${prompt} - Video file: ${videoFile.name} (${Math.round(videoFile.size / (1024 * 1024))}MB)`
                  }
                ]
              }
            ]
          }
        }

        // For now, return a placeholder analysis for videos
        // In production, implement proper video frame extraction and upload
        const videoAnalysis = `Video Analysis for ${videoFile.name}:
        File size: ${Math.round(videoFile.size / (1024 * 1024))}MB
        Duration: Estimated based on file size
        Content analysis: ${prompt}

        Note: Full video analysis requires frame extraction and cloud storage integration.`

        analysisResults.push({
          type: 'video',
          count: 1,
          analysis: videoAnalysis,
          filenames: [videoFile.name],
          note: 'Video analysis is a placeholder - requires frame extraction in production'
        })
      }
    }

    // Combine all analyses
    let combinedAnalysis = analysisResults.map(result =>
      `${result.type.toUpperCase()} (${result.count} file${result.count > 1 ? 's' : ''}):\n${result.analysis}`
    ).join('\n\n')

    // Truncate analysis to keep it concise for UI
    if (combinedAnalysis.length > 800) {
      combinedAnalysis = combinedAnalysis.substring(0, 797) + '...'
    }

    console.log('🎯 DashScope Media Analysis Complete:', {
      image_count: imageFiles.length,
      video_count: videoFiles.length,
      file_names: files.map(f => f.name),
      file_sizes: files.map(f => f.size),
      analysis_length: combinedAnalysis.length,
      prompt_length: prompt.length
    })

    return c.json({
      success: true,
      analysis: combinedAnalysis,
      results: analysisResults,
      metadata: {
        image_count: imageFiles.length,
        video_count: videoFiles.length,
        total_files: files.length,
        filenames: files.map(f => f.name),
        total_size: files.reduce((sum, f) => sum + f.size, 0),
        analyzed_at: new Date().toISOString()
      }
    })

  } catch (error: any) {
    console.error('❌ Media analysis error:', error)
    return c.json({
      error: 'Failed to analyze media',
      details: error.message
    }, 500)
  }
})

export default app