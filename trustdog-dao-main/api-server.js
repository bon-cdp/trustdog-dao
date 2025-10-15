#!/usr/bin/env node

/**
 * Ultimate Orchestrator API Server
 *
 * Provides /analyze endpoint for TrustDog integration
 * Handles authentication, rate limiting, and webhook callbacks
 */

// Set environment paths for tools
process.env.PATH = `/home/s/.local/bin:${process.env.PATH}`;
process.env.PLAYWRIGHT_BROWSERS_PATH = '/home/s/trustdog/browsers';

import express from 'express';
import cors from 'cors';
import { UltimateOrchestrator } from './ultimate-orchestrator.js';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import { createReadStream, statSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const app = express();
const PORT = process.env.PORT || 3001;

// Durable file-based queue setup
const QUEUE_DIR = join(process.cwd(), '.queue');
const QUEUE_FILE = join(QUEUE_DIR, 'jobs.json');
const PROCESSING_FILE = join(QUEUE_DIR, 'processing.json');

// Ensure queue directory exists
if (!existsSync(QUEUE_DIR)) {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

// Simple durable queue implementation
class DurableQueue {
  constructor() {
    this.processing = false;
    this.loadQueue();
    this.startProcessor();
  }

  loadQueue() {
    // Load existing jobs from disk
    if (existsSync(QUEUE_FILE)) {
      try {
        const data = readFileSync(QUEUE_FILE, 'utf8');
        this.jobs = JSON.parse(data);
      } catch (error) {
        console.log('⚠️ Queue file corrupted, starting fresh');
        this.jobs = [];
      }
    } else {
      this.jobs = [];
    }

    // Check for interrupted processing job
    if (existsSync(PROCESSING_FILE)) {
      try {
        const processingJob = JSON.parse(readFileSync(PROCESSING_FILE, 'utf8'));
        console.log('🔄 Recovered interrupted job, re-queuing...');
        this.jobs.unshift(processingJob); // Put it back at the front
        unlinkSync(PROCESSING_FILE);
      } catch (error) {
        console.log('⚠️ Processing file corrupted, ignoring');
        try { unlinkSync(PROCESSING_FILE); } catch (e) {}
      }
    }

    if (this.jobs.length > 0) {
      console.log(`📋 Loaded ${this.jobs.length} jobs from queue`);
    }
  }

  saveQueue() {
    try {
      writeFileSync(QUEUE_FILE, JSON.stringify(this.jobs, null, 2));
    } catch (error) {
      console.error('❌ Failed to save queue:', error.message);
    }
  }

  enqueue(job) {
    this.jobs.push(job);
    this.saveQueue();
  }

  dequeue() {
    const job = this.jobs.shift();
    this.saveQueue();
    return job;
  }

  isEmpty() {
    return this.jobs.length === 0;
  }

  async startProcessor() {
    setInterval(() => this.processNext(), 3000); // Check every 3 seconds
  }

  async processNext() {
    if (this.processing || this.isEmpty()) {
      return;
    }

    this.processing = true;
    const job = this.dequeue();

    try {
      // Save current job as processing (for crash recovery)
      writeFileSync(PROCESSING_FILE, JSON.stringify(job));

      console.log(`⚡ [${job.dealId}] Processing queued job...`);

      const orchestrator = new UltimateOrchestrator();
      const result = await orchestrator.analyze(job.url, job.options);

      // DEBUG: Log the actual analysis result structure
      console.log(`🔍 [${job.dealId}] Analysis result structure:`, {
        hasAnalysis: !!result.analysis,
        overallScore: result.analysis?.overall_score,
        proofVerification: result.analysis?.proof_verification,
        keys: Object.keys(result)
      });

      // Send results to callback URL (same format as existing code)
      const callbackData = {
        status: 'completed',
        data: {
          deal_id: job.dealId,
          analysis: {
            overall_score: result.analysis?.overall_score || 0,
            ai_analysis: result.analysis?.ai_analysis || '',
            content_analysis: result.analysis?.content_analysis || '',
            proof_verification: {
              overall_confidence: result.analysis?.proof_verification?.overall_confidence || 0,
              requirements_met: result.analysis?.proof_verification?.requirements_met || [],
              requirements_failed: result.analysis?.proof_verification?.requirements_failed || [],
              summary: result.analysis?.proof_verification?.summary || "Analysis completed"
            },
            evidence: {
              captions: result.evidence?.captions || [],
              ocr_blocks: result.evidence?.ocr_blocks || [],
              keyframes: result.evidence?.keyframes || [],
              links: result.evidence?.links || [],
              metadata: result.evidence?.metadata || [],
              audio_transcripts: result.evidence?.audio_transcripts || []
            }
          },
          platform: result.platform || 'unknown',
          url: result.url || job.url,
          extractedCaption: result.extractedCaption || '',
          files: result.files || [],
          totalFiles: result.totalFiles || 0,
          analyses: result.analyses || [],
          transcriptions: result.transcriptions || [],
          timestamp: new Date().toISOString(),
          requestId: result.requestId || job.dealId,
          processingTime: result.processingTime || 0,
          apiVersion: "1.0.0"
        }
      };

      // DEBUG: Log what we're sending in callback
      console.log(`🐛 DEBUG CALLBACK for deal ${job.dealId}:`);
      console.log(`🐛 analyses[0] type:`, typeof callbackData.data.analyses[0]);
      console.log(`🐛 analyses[0] keys:`, callbackData.data.analyses[0] ? Object.keys(callbackData.data.analyses[0]) : 'null');
      console.log(`🐛 analyses[0].analysis length:`, callbackData.data.analyses[0]?.analysis?.length || 'N/A');

      await fetch(job.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer trustdog-callback-secret-token-2024'
        },
        body: JSON.stringify(callbackData)
      });

      console.log(`✅ [${job.dealId}] Job completed and removed from queue`);

      // Remove processing file only after successful completion
      if (existsSync(PROCESSING_FILE)) {
        unlinkSync(PROCESSING_FILE);
      }

    } catch (error) {
      console.error(`❌ [${job.dealId}] Job failed:`, error.message);

      // Send error to callback URL
      try {
        await fetch(job.callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer trustdog-callback-secret-token-2024'
          },
          body: JSON.stringify({
            status: 'error',
            data: {
              deal_id: job.dealId,
              error: error.message,
              timestamp: new Date().toISOString(),
              apiVersion: "1.0.0"
            }
          })
        });
      } catch (callbackError) {
        console.error(`❌ [${job.dealId}] Failed to send error callback:`, callbackError.message);
      }

      // Remove processing file after error handling
      if (existsSync(PROCESSING_FILE)) {
        unlinkSync(PROCESSING_FILE);
      }
    } finally {
      this.processing = false;
    }
  }
}

// Initialize durable queue
const durableQueue = new DurableQueue();

// Maintain the original simple queue for synchronous requests (backward compatibility)
let requestQueue = Promise.resolve();

// Middleware with robust JSON parsing
app.use((req, res, next) => {
  if (req.headers['content-type']?.includes('application/json')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        req.body = body ? JSON.parse(body) : {};
        next();
      } catch (err) {
        console.log('⚠️ JSON parse error, attempting cleanup:', err.message);
        try {
          const cleaned = body.replace(/\\!/g, '!').replace(/\\"/g, '"');
          req.body = JSON.parse(cleaned);
          next();
        } catch (err2) {
          console.log('❌ JSON parse failed completely:', err2.message);
          req.body = {};
          next();
        }
      }
    });
  } else {
    next();
  }
});
app.use(cors());

// Authentication middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const expectedKey = process.env.ORCHESTRATOR_API_KEY;

  if (!expectedKey) {
    console.log('⚠️ ORCHESTRATOR_API_KEY not set - allowing all requests');
    return next();
  }

  console.log('🔍 Request debug:', {
    url: req.url,
    method: req.method,
    auth: req.headers.authorization ? `Bearer ${req.headers.authorization.substring(7,27)}...` : 'NONE',
    bodyKeys: Object.keys(req.body || {})
  });

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid API key required'
    });
  }

  next();
};

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Main analysis endpoint
app.post('/analyze', authenticate, async (req, res) => {
  const requestId = createHash('md5').update(Date.now().toString()).digest('hex').substring(0, 8);

  try {
    const { url, options = {}, callbackUrl, requestId: clientRequestId, metadata = {} } = req.body;

    if (!url) {
      return res.status(400).json({
        status: 'error',
        error: 'URL is required'
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        status: 'error',
        error: 'Invalid URL format'
      });
    }

    // Check if URL is from supported platforms
    const supportedPlatforms = ['instagram.com', 'tiktok.com', 'twitter.com', 'x.com'];
    const isSupported = supportedPlatforms.some(platform => url.includes(platform));

    if (!isSupported) {
      return res.status(400).json({
        status: 'error',
        error: 'Unsupported URL',
        message: 'URL must be from Instagram, TikTok, Twitter, or X'
      });
    }

    console.log(`🔍 [${requestId}] Starting analysis for: ${url}`);

    const orchestrator = new UltimateOrchestrator();

    // Handle async processing with callback - now using durable queue
    if (callbackUrl) {
      const dealId = metadata.deal_id || clientRequestId || requestId;

      // Pass proof spec and requirements from TrustDog
      const analysisOptions = {
        ...options,
        proofSpec: metadata.proof_spec || metadata.proofSpec,
        requirements: metadata.requirements,
        dealId: dealId
      };

      // Enqueue job for durable processing
      const job = {
        url: url,
        options: analysisOptions,
        callbackUrl: callbackUrl,
        dealId: dealId,
        enqueuedAt: new Date().toISOString(),
        requestId: clientRequestId || requestId
      };

      durableQueue.enqueue(job);
      console.log(`📥 [${dealId}] Job queued for durable processing`);

      return res.json({
        status: 'processing',
        requestId: clientRequestId || requestId,
        message: 'Analysis started, results will be sent to callback URL'
      });
    }

    // Synchronous processing with queue
    console.log(`⚡ [${requestId}] Processing synchronously`);
    const result = await (requestQueue = requestQueue.then(() => orchestrator.analyze(url, options)));

    res.json({
      status: 'completed',
      data: result
    });

  } catch (error) {
    console.error(`❌ [${requestId}] Analysis error:`, error.message);

    res.status(500).json({
      status: 'error',
      error: error.message,
      requestId
    });
  }
});

// Batch analysis endpoint
app.post('/analyze/batch', authenticate, async (req, res) => {
  try {
    const { urls, options = {} } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        status: 'error',
        error: 'URLs array is required'
      });
    }

    if (urls.length > 10) {
      return res.status(400).json({
        status: 'error',
        error: 'Maximum 10 URLs per batch'
      });
    }

    const orchestrator = new UltimateOrchestrator();
    const results = [];

    for (const url of urls) {
      try {
        const result = await (requestQueue = requestQueue.then(() => orchestrator.analyze(url, options)));
        results.push({
          url,
          status: 'completed',
          data: result
        });
      } catch (error) {
        results.push({
          url,
          status: 'error',
          error: error.message
        });
      }
    }

    res.json({
      status: 'completed',
      results
    });

  } catch (error) {
    console.error('❌ Batch analysis error:', error.message);

    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});


// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);

  res.status(500).json({
    status: 'error',
    error: 'Internal server error'
  });
});

// Frame serving endpoint for qwen-vl-max
app.get('/frames*', (req, res) => {
  try {
    const filePath = `/tmp/ultimate_extractor${req.url}`;
    const stat = statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(404).json({
      status: 'error',
      error: 'Frame not found'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 Ultimate Orchestrator API Server running on port', PORT);
  console.log('📊 Health check: http://localhost:' + PORT + '/health');
  console.log('🔍 Analysis endpoint: http://localhost:' + PORT + '/analyze');
  console.log('📦 Batch endpoint: http://localhost:' + PORT + '/analyze/batch');
  console.log('');
  console.log('📋 Configuration:');
  console.log('   API Key Required:', process.env.ORCHESTRATOR_API_KEY ? 'Yes' : 'No');
  console.log('   TOR Proxy: socks5://127.0.0.1:9050');
  console.log('   Qwen API:', process.env.QWEN_KEY || process.env.DASHSCOPE_API_KEY ? 'Configured' : 'Missing');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  process.exit(0);
});