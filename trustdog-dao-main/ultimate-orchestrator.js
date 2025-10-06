#!/usr/bin/env node

/**
 * ULTIMATE SOCIAL MEDIA ORCHESTRATOR
 *
 * Combines the best extractors:
 * - Instagram: Playwright-based extractor (potential_replacement.js)
 * - TikTok/Twitter: gallery-dl + yt-dlp fallback chain
 * - Comprehensive AI analysis with qwen-omni-turbo + qwen3-asr-flash
 */

import { execSync, spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, createReadStream, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Import our working Instagram extractor
import { chromium as chromiumDefault } from 'playwright';
// Set Playwright browser path BEFORE importing
process.env.PLAYWRIGHT_BROWSERS_PATH = '/home/s/trustdog/browsers';

import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import sharp from 'sharp';

chromiumExtra.use(stealth());

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

class UltimateOrchestrator {
  constructor() {
    this.apiKey = process.env.QWEN_KEY || process.env.DASHSCOPE_API_KEY;
    this.qwenApiUrl = (process.env.QWEN_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1') + '/chat/completions';
    this.tempDir = '/tmp/ultimate_extractor';

    // TOR proxy rotation setup
    this.torPorts = [9050, 9051, 9052, 9053, 9054];
    this.currentTorPortIndex = 0;
    this.requestCount = 0;
    this.maxRequestsPerProxy = 5; // Rotate after 5 requests
    this.torProxy = this.getNextTorProxy();

    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }

    console.log('🚀 Ultimate Social Media Orchestrator initialized');
    console.log('📱 Supports: Instagram (Playwright), TikTok/Twitter (gallery-dl + yt-dlp)');
    console.log('🤖 AI Analysis: qwen-vl-max + qwen3-asr-flash');
    console.log(`🔄 TOR Proxy Rotation: ${this.torPorts.length} ports, rotate every ${this.maxRequestsPerProxy} requests`);
  }

  detectPlatform(url) {
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
    throw new Error(`Unsupported platform for URL: ${url}`);
  }

  // INSTAGRAM EXTRACTOR (Playwright-based, handles images, videos, and carousels)
  async extractInstagram(url, options = {}) {
    console.log('📷 Attempting Instagram Playwright extraction...');

    // Use user-owned profile directory for persistent cookies
    const profileDir = '/tmp/instagram-profile-' + process.getuid();
    mkdirSync(profileDir, { recursive: true });

    const context = await chromiumExtra.launchPersistentContext(profileDir, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        `--proxy-server=${this.torProxy}`
      ]
    });

    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300000 }); // 5 minute timeout

      // Handle cookie consent and modals
      try {
        // Close cookie consent if present
        const cookieButton = await page.$('button:has-text("Allow"), button:has-text("Accept"), [aria-label="Allow all cookies"]');
        if (cookieButton) {
          await cookieButton.click();
          console.log('✅ Accepted cookie consent');
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        // No cookie modal
      }

      try {
        // Close login/signup modal if present
        const closeButton = await page.$('[aria-label="Close"], button[aria-label="Close"], svg[aria-label="Close"]');
        if (closeButton) {
          await closeButton.click();
          console.log('✅ Closed login modal');
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        // No login modal
      }

      // First try to extract data from embedded JSON (for reels/videos)
      const jsonData = await page.evaluate(() => {
        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (const script of scripts) {
          try {
            if (script.textContent) {
              const data = JSON.parse(script.textContent);

              // Multiple paths to find media data - more robust approach
              let mediaData = null;

              // Path 1: Standard API path
              mediaData = data?.require?.[0]?.[3]?.[0]?.__bbox?.require?.[0]?.[3]?.[1]?.__bbox?.result?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];

              // Path 2: Alternative nested structure
              if (!mediaData) {
                mediaData = data?.require?.[0]?.[3]?.[0]?.__bbox?.result?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
              }

              // Path 3: Direct data structure
              if (!mediaData) {
                mediaData = data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
              }

              // Path 4: GraphQL structure
              if (!mediaData) {
                mediaData = data?.data?.shortcode_media;
              }

              // Path 5: Legacy structure
              if (!mediaData) {
                mediaData = data?.graphql?.shortcode_media;
              }

              if (mediaData) {
                return {
                  hasVideo: !!mediaData.video_versions || !!mediaData.is_video,
                  videoUrl: mediaData.video_versions?.[0]?.url || mediaData.video_url,
                  caption: mediaData.caption?.text || mediaData.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                  carousel: mediaData.carousel_media || mediaData.edge_sidecar_to_children?.edges || null,
                  displayUrl: mediaData.display_url || mediaData.display_resources?.[0]?.src,
                  username: mediaData.user?.username || mediaData.owner?.username,
                  fullName: mediaData.user?.full_name || mediaData.owner?.full_name
                };
              }
            }
          } catch (e) {
            // Continue to next script
          }
        }
        return null;
      });

      // Fallback to og:image and og:description if JSON parsing fails
      const ogData = await page.evaluate(() => {
        const imageUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
        const description = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
        return { imageUrl, description };
      });

      const downloadedFiles = [];
      let caption = '';

      if (jsonData) {
        caption = jsonData.caption;
        console.log(`📊 JSON data found - hasVideo: ${jsonData.hasVideo}, carousel items: ${jsonData.carousel ? jsonData.carousel.length : 0}`);

        if (jsonData.hasVideo && jsonData.videoUrl) {
          // Download video
          console.log('📹 Downloading Instagram video...');
          try {
            const videoResponse = await page.context().request.get(jsonData.videoUrl, {
              headers: { 'Referer': 'https://www.instagram.com/' }
            });
            if (videoResponse.ok()) {
              const videoBuffer = await videoResponse.body();
              const filename = `instagram_video_${Date.now()}.mp4`;
              const filepath = join(this.tempDir, filename);
              writeFileSync(filepath, videoBuffer);
              downloadedFiles.push(filepath);
              console.log('✅ Instagram video downloaded');
            }
          } catch (error) {
            console.log(`⚠️ Failed to download video: ${error.message}`);
          }
        }

        if (jsonData.carousel && jsonData.carousel.length > 0) {
          // Handle carousel posts - support multiple data structures
          console.log(`🎠 Processing Instagram carousel with ${jsonData.carousel.length} items...`);
          const carouselItems = jsonData.carousel;

          console.log(`🔄 Processing carousel items...`);
          for (let i = 0; i < Math.min(carouselItems.length, 10); i++) {
            let item = carouselItems[i];

            // Handle GraphQL structure where items are in edges
            if (item.node) {
              item = item.node;
            }

            // Debug: Log item structure
            console.log(`📋 Carousel item ${i + 1} structure:`, {
              hasVideoVersions: !!item.video_versions,
              isVideo: item.is_video,
              hasDisplayUrl: !!item.display_url,
              hasDisplayResources: !!item.display_resources,
              hasImageVersions2: !!item.image_versions2,
              keys: Object.keys(item).slice(0, 10)
            });

            try {
              if (item.video_versions && item.video_versions[0]) {
                // Carousel item is a video
                console.log(`📹 Downloading carousel video ${i + 1}...`);
                const videoResponse = await page.context().request.get(item.video_versions[0].url, {
                  headers: { 'Referer': 'https://www.instagram.com/' }
                });
                if (videoResponse.ok()) {
                  const videoBuffer = await videoResponse.body();
                  const filename = `instagram_carousel_video_${i + 1}_${Date.now()}.mp4`;
                  const filepath = join(this.tempDir, filename);
                  writeFileSync(filepath, videoBuffer);
                  downloadedFiles.push(filepath);
                  console.log(`✅ Carousel video ${i + 1} downloaded`);
                }
              } else if (item.is_video && (item.video_url || item.video_versions)) {
                // Alternative video structure
                console.log(`📹 Downloading carousel video ${i + 1} (alt structure)...`);
                const videoUrl = item.video_url || item.video_versions?.[0]?.url;
                if (videoUrl) {
                  const videoResponse = await page.context().request.get(videoUrl, {
                    headers: { 'Referer': 'https://www.instagram.com/' }
                  });
                  if (videoResponse.ok()) {
                    const videoBuffer = await videoResponse.body();
                    const filename = `instagram_carousel_video_${i + 1}_${Date.now()}.mp4`;
                    const filepath = join(this.tempDir, filename);
                    writeFileSync(filepath, videoBuffer);
                    downloadedFiles.push(filepath);
                    console.log(`✅ Carousel video ${i + 1} downloaded`);
                  }
                }
              } else {
                // Carousel item is an image - try multiple URL fields
                console.log(`🖼️ Downloading carousel image ${i + 1}...`);
                const imageUrl = item.display_url ||
                                item.display_resources?.[0]?.src ||
                                item.image_versions2?.candidates?.[0]?.url ||
                                item.image_versions?.candidates?.[0]?.url ||
                                item.url;

                if (imageUrl) {
                  console.log(`  - Image URL: ${imageUrl.substring(0, 100)}...`);
                  const imageResponse = await page.context().request.get(imageUrl, {
                    headers: { 'Referer': 'https://www.instagram.com/' }
                  });
                  if (imageResponse.ok()) {
                    const imageBuffer = await imageResponse.body();
                    const filename = `instagram_carousel_image_${i + 1}_${Date.now()}.jpg`;
                    const filepath = join(this.tempDir, filename);
                    writeFileSync(filepath, imageBuffer);
                    downloadedFiles.push(filepath);
                    console.log(`✅ Carousel image ${i + 1} downloaded: ${filename} (${Math.round(imageBuffer.length / 1024)}KB)`);
                    console.log(`  - Total files so far: ${downloadedFiles.length}`);
                  } else {
                    console.log(`❌ Failed to download carousel image ${i + 1}: HTTP ${imageResponse.status()}`);
                  }
                } else {
                  console.log(`❌ No URL found for carousel image ${i + 1}`);
                }
              }
            } catch (error) {
              console.log(`⚠️ Failed to download carousel item ${i + 1}: ${error.message}`);
            }
          }
        } else if (jsonData.displayUrl) {
          // Single image post
          console.log('🖼️ Downloading single Instagram image...');
          try {
            const imageResponse = await page.context().request.get(jsonData.displayUrl, {
              headers: { 'Referer': 'https://www.instagram.com/' }
            });
            if (imageResponse.ok()) {
              const imageBuffer = await imageResponse.body();
              const filename = `instagram_image_${Date.now()}.jpg`;
              const filepath = join(this.tempDir, filename);
              writeFileSync(filepath, imageBuffer);
              downloadedFiles.push(filepath);
            }
          } catch (error) {
            console.log(`⚠️ Failed to download image: ${error.message}`);
          }
        }
      }

      // Fallback to og:image if no files were downloaded
      if (downloadedFiles.length === 0 && ogData.imageUrl) {
        console.log('🔄 Falling back to og:image (carousel detection may have failed)...');
        try {
          const imageResponse = await page.context().request.get(ogData.imageUrl, {
            headers: { 'Referer': 'https://www.instagram.com/' }
          });
          if (imageResponse.ok()) {
            const imageBuffer = await imageResponse.body();
            const filename = `instagram_fallback_${Date.now()}.jpg`;
            const filepath = join(this.tempDir, filename);
            writeFileSync(filepath, imageBuffer);
            downloadedFiles.push(filepath);
          }
        } catch (error) {
          console.log(`⚠️ Fallback image download failed: ${error.message}`);
        }
        caption = ogData.description || caption;
      }

      console.log(`📊 Instagram extraction complete:`);
      console.log(`  - Downloaded files: ${downloadedFiles.length}`);
      console.log(`  - Files:`, downloadedFiles);
      console.log(`  - Caption length: ${caption?.length || 0}`);
      console.log(`  - Username: ${jsonData?.username || 'unknown'}`);

      return {
        success: true,
        extractor: 'playwright-instagram',
        files: downloadedFiles,
        totalFiles: downloadedFiles.length,
        caption: caption || 'No text found',
        metadata: {
          platform: 'instagram',
          url: url,
          extractedAt: new Date().toISOString(),
          uploader: jsonData?.username || 'unknown',
          author: jsonData?.username || 'unknown',
          fullName: jsonData?.fullName || '',
          username: jsonData?.username || 'unknown'
        }
      };

    } finally {
      await context.close();
    }
  }

  // TIKTOK/TWITTER EXTRACTOR (gallery-dl + yt-dlp)
  async extractGalleryDl(url) {
    console.log('🖼️ Attempting gallery-dl extraction...');

    try {
      const outputDir = join(this.tempDir, `gallery_${Date.now()}`);
      mkdirSync(outputDir, { recursive: true });

      // Sanitize TikTok photo URLs to video format for better extraction
      const sanitizedUrl = this.sanitizeTikTokUrl(url);
      console.log(`🔧 URL sanitized: ${url} → ${sanitizedUrl}`);

      const configPath = join(__dirname, 'gallery-dl-config.json');

      // Reduced retry logic - gallery-dl usually works on first try
      let attempt = 0;
      const maxAttempts = 2;
      let lastError = null;

      while (attempt < maxAttempts) {
        attempt++;
        console.log(`🔄 gallery-dl attempt ${attempt}/${maxAttempts}`);

        try {
          // Rotate proxy for each attempt
          this.rotateTorProxy();

          // CRITICAL FIX: Use simplified command for TikTok photos (like manual working call)
          let cmd;
          if (sanitizedUrl.includes('/photo/')) {
            // For TikTok photos: use minimal command like manual working call
            cmd = [
              '~/.local/bin/gallery-dl',
              '--proxy', this.torProxy,
              '--dest', outputDir,
              '--verbose',
              `"${sanitizedUrl}"`
            ];
            console.log(`📸 Using simplified photo extraction command`);
          } else {
            // For videos/other content: use full config
            cmd = [
              '~/.local/bin/gallery-dl',
              '--config', configPath,
              '--proxy', this.torProxy,
              '--dest', outputDir,
              '--write-info-json',
              '--write-metadata',
              '--retries', '15',
              '--sleep-request', '3',
              '--sleep-429', '60',
              '--sleep-extractor', '8',
              '--no-skip',
              '--verbose',
              '--user-agent', '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"',
              '--download-archive', join(outputDir, 'archive.txt'),
              `"${sanitizedUrl}"`
            ];
          }

          console.log(`🚀 Running: ${cmd.join(' ')}`);

          // CRITICAL FIX: Adjust timeouts for TikTok photos (they download quickly but quietly)
          const timeoutSettings = sanitizedUrl.includes('/photo/') ? {
            timeout: 60000,      // 1 minute max for photos (they're fast)
            progressTimeout: 30000,  // Only 30s progress timeout for photos
            env: { ...process.env, HOME: process.env.HOME, PATH: process.env.PATH }
          } : {
            timeout: 120000,     // 2 minutes for videos
            progressTimeout: 90000,  // 90s progress timeout for videos
            env: { ...process.env, HOME: process.env.HOME, PATH: process.env.PATH }
          };

          const output = await this.execAsync(cmd.join(' '), timeoutSettings);

          console.log(`✅ gallery-dl output: ${output}`);

          // Check if files were actually downloaded
          const files = this.getDownloadedFiles(outputDir);
          if (files.length === 0) {
            throw new Error('No files downloaded despite successful command execution');
          }

          return {
            success: true,
            extractor: 'gallery-dl',
            output: output,
            outputDir: outputDir,
            files: files,
            totalFiles: files.length
          };

        } catch (error) {
          lastError = error;
          const errorMsg = error.message || error.toString();

          // Enhanced smart early termination for various failure scenarios
          const shouldStopRetrying =
            errorMsg.includes('10222') ||  // Login required
            errorMsg.includes('10204') ||  // Post not available
            errorMsg.includes('10215') ||  // Rate limited
            errorMsg.includes('403') ||    // Forbidden
            errorMsg.includes('404') ||    // Not found
            errorMsg.includes('Early termination') ||  // Our custom early termination
            errorMsg.includes('Access denied') ||
            errorMsg.includes('region blocked') ||
            errorMsg.includes('No output') ||  // Progress timeout
            errorMsg.includes('Process killed');

          if (shouldStopRetrying) {
            if (errorMsg.includes('10222')) {
              console.log(`❌ TikTok requires login (error 10222) - stopping retries`);
            } else if (errorMsg.includes('10204')) {
              console.log(`❌ TikTok post not available (error 10204) - stopping retries`);
            } else if (errorMsg.includes('10231')) {
              console.log(`❌ TikTok region locked (error 10231) - stopping retries`);
            } else if (errorMsg.includes('Early termination') || errorMsg.includes('Access denied')) {
              console.log(`⚡ Early termination triggered - stopping retries`);
            } else if (errorMsg.includes('No output') || errorMsg.includes('Process killed')) {
              console.log(`⏱️ Progress timeout - stopping retries`);
            } else {
              console.log(`❌ Unrecoverable error detected - stopping retries: ${errorMsg.substring(0, 100)}`);
            }
            break;
          } else if (errorMsg.includes('timeout') || errorMsg.includes('TIMEOUT')) {
            console.log(`⏱️ Network timeout on attempt ${attempt} - will retry`);
          } else if (errorMsg.includes('ECONNRESET') || errorMsg.includes('ECONNREFUSED')) {
            console.log(`🌐 Connection error on attempt ${attempt} - will retry`);
          } else {
            console.log(`⚠️ gallery-dl attempt ${attempt} failed: ${errorMsg.substring(0, 150)}`);
          }

          if (attempt < maxAttempts) {
            const delay = Math.min(5000 * Math.pow(2, attempt - 1), 30000); // Exponential backoff
            console.log(`⏳ Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      throw lastError || new Error(`All ${maxAttempts} gallery-dl attempts failed`);

    } catch (error) {
      console.log(`⚠️ gallery-dl extraction failed completely: ${error.message}`);
      return { success: false, extractor: 'gallery-dl', error: error.message };
    }
  }

  // TikTok URL sanitization for robust extraction
  sanitizeTikTokUrl(url) {
    if (!url.includes('tiktok.com')) return url;

    let sanitized = url;

    // CRITICAL FIX: Do NOT convert photo URLs to video format
    // TikTok photo posts have different imagePost structure that requires /photo/ URL
    // Only convert non-photo URLs if needed
    if (!url.includes('/photo/')) {
      // For video URLs, no conversion needed - keep original format
      sanitized = url;
    }

    // Ensure proper HTTPS scheme
    if (!sanitized.startsWith('http')) {
      sanitized = 'https://' + sanitized;
    }

    // Remove tracking parameters that might interfere
    try {
      const urlObj = new URL(sanitized);
      // Keep only essential parameters
      const keepParams = ['is_from_webapp', 'sender_device'];
      const newParams = new URLSearchParams();

      for (const [key, value] of urlObj.searchParams) {
        if (keepParams.includes(key)) {
          newParams.set(key, value);
        }
      }

      urlObj.search = newParams.toString();
      return urlObj.toString();
    } catch (e) {
      console.log(`⚠️ URL parsing failed, using original: ${e.message}`);
      return sanitized;
    }
  }

  async extractYtDlp(url) {
    console.log('🎥 Attempting yt-dlp extraction...');

    try {
      // Use fresh proxy for yt-dlp
      this.forceNewTorCircuit();

      const outputDir = join(this.tempDir, `ytdlp_${Date.now()}`);
      mkdirSync(outputDir, { recursive: true });

      const cmd = [
        'yt-dlp',
        '--proxy', this.torProxy,
        '--output', `"${outputDir}/%(title)s.%(ext)s"`,
        '--write-info-json',
        '--write-description',
        '--write-thumbnail',
        '--write-sub',
        '--write-auto-sub',
        '--no-flat-playlist',
        '--ignore-errors',
        '--retries', '3',
        '--fragment-retries', '3',
        '--extractor-args', 'twitter:legacy=False',
        url
      ];

      const output = await this.execAsync(cmd.join(' '), {
        timeout: 45000,  // 45 seconds maximum
        progressTimeout: 20000  // Kill if no output for 20 seconds
      });

      return {
        success: true,
        extractor: 'yt-dlp',
        output: output,
        outputDir: outputDir
      };

    } catch (error) {
      console.log(`⚠️ yt-dlp failed: ${error.message}`);
      return { success: false, extractor: 'yt-dlp', error: error.message };
    }
  }

  async extractTikTokTwitter(url) {
    console.log('🔄 Running gallery-dl and yt-dlp in parallel...');

    // Run both extractors in parallel and use the first successful one
    const galleryPromise = this.extractGalleryDl(url).catch(error => ({
      success: false,
      extractor: 'gallery-dl',
      error: error.message,
      parallel: true
    }));

    const ytDlpPromise = this.extractYtDlp(url).catch(error => ({
      success: false,
      extractor: 'yt-dlp',
      error: error.message,
      parallel: true
    }));

    try {
      // Wait for both to complete
      const [galleryResult, ytDlpResult] = await Promise.all([galleryPromise, ytDlpPromise]);

      console.log(`📊 Parallel extraction results:`);
      console.log(`  - gallery-dl: ${galleryResult.success ? 'SUCCESS' : 'FAILED'} ${galleryResult.success ? '' : '(' + galleryResult.error + ')'}`);
      console.log(`  - yt-dlp: ${ytDlpResult.success ? 'SUCCESS' : 'FAILED'} ${ytDlpResult.success ? '' : '(' + ytDlpResult.error + ')'}`);

      // Return the first successful result, prioritizing gallery-dl
      if (galleryResult.success) {
        console.log('✅ Using gallery-dl result');
        return galleryResult;
      }

      if (ytDlpResult.success) {
        console.log('✅ Using yt-dlp result');
        return ytDlpResult;
      }

      // Both failed
      throw new Error(`Both extractors failed in parallel - gallery-dl: ${galleryResult.error}, yt-dlp: ${ytDlpResult.error}`);

    } catch (error) {
      // Handle Promise.all rejection (shouldn't happen due to catch above, but safety)
      console.log(`❌ Parallel extraction error: ${error.message}`);
      throw new Error(`Parallel extraction failed: ${error.message}`);
    }
  }

  // URL RESOLUTION AND LINK ANALYSIS
  async resolveUrls(text) {
    if (!text) {
      console.log(`🔍 No text provided for URL resolution`);
      return [];
    }

    console.log(`🔍 Extracting URLs from text: "${text}"`);

    // Extract URLs from text
    const urlRegex = /https?:\/\/[^\s]+/g;
    const urls = text.match(urlRegex) || [];

    console.log(`🔍 Found ${urls.length} URLs:`, urls);

    const resolvedUrls = [];

    for (const url of urls) {
      console.log(`🔍 Attempting to resolve URL: ${url}`);
      try {
        // Follow redirects to get final URL
        const response = await fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TrustDog-Bot/1.0)'
          }
        });

        const resolvedInfo = {
          original: url,
          resolved: response.url,
          domain: new URL(response.url).hostname
        };

        console.log(`✅ Successfully resolved ${url} → ${response.url}`);
        resolvedUrls.push(resolvedInfo);
      } catch (error) {
        console.log(`⚠️ Failed to resolve URL ${url}: ${error.message}`);
        resolvedUrls.push({
          original: url,
          resolved: url,
          domain: 'unknown'
        });
      }
    }

    console.log(`🔍 URL resolution complete. ${resolvedUrls.length} results:`, resolvedUrls);
    return resolvedUrls;
  }

  // AI ANALYSIS ENGINE
  async parseProofVerification(aiAnalysis, proofSpec, extractedContent) {
    try {
      // Try to extract structured proof verification from AI response
      const proofMatch = aiAnalysis.match(/PROOF_VERIFICATION:\s*({[\s\S]*?})/);
      if (proofMatch) {
        const parsed = JSON.parse(proofMatch[1]);
        return {
          overall_confidence: parsed.overall_confidence || 0,
          overall_score: parsed.overall_score || 0,
          requirements_met: parsed.requirements_met || [],
          requirements_failed: parsed.requirements_failed || [],
          summary: parsed.summary || "Analysis completed"
        };
      }
    } catch (error) {
      console.log(`⚠️ Failed to parse structured proof verification: ${error.message}`);
    }

    // Improved fallback: Verify against extracted content and proof spec
    const requirementsMet = [];
    const requirementsFailed = [];
    let confidenceScore = 0;

    if (extractedContent && proofSpec) {
      // Check each proof requirement against extracted content
      if (proofSpec.text_proof) {
        const hasText = extractedContent.caption || extractedContent.audioTranscription;
        let textProofFound = false;
        let textProofReason = "";

        if (hasText) {
          // Check for direct text match
          const textMatch = hasText.toLowerCase().includes(proofSpec.text_proof.toLowerCase());

          // Check for brand URLs in the content
          console.log(`🔍 Resolving URLs in caption: "${extractedContent.caption}"`);
          const resolvedUrls = await this.resolveUrls(extractedContent.caption || "");
          console.log(`🔍 Resolved URLs:`, resolvedUrls);

          const brandUrls = resolvedUrls.filter(urlInfo =>
            urlInfo.domain.includes('botornot.bot') ||
            urlInfo.resolved.includes('botornot.bot')
          );
          console.log(`🔍 Brand URLs found:`, brandUrls);

          if (textMatch) {
            textProofFound = true;
            textProofReason = "Direct text match found in content";
          } else if (brandUrls.length > 0) {
            textProofFound = true;
            textProofReason = `Brand promotional link found: ${brandUrls[0].resolved}`;
          } else {
            textProofReason = "No direct text match or brand promotional links found";
          }

          if (textProofFound) {
            requirementsMet.push(`text_proof: ${textProofReason}`);
            confidenceScore += 30;
          } else {
            requirementsFailed.push(`text_proof: ${textProofReason}`);
          }
        } else {
          requirementsFailed.push("text_proof: No text content found");
        }
      }

      if (proofSpec.platform) {
        const platformMatches = extractedContent.platform &&
          extractedContent.platform.toLowerCase() === proofSpec.platform.toLowerCase();
        if (platformMatches) {
          requirementsMet.push(`platform: Correctly detected ${extractedContent.platform}`);
          confidenceScore += 25;
        } else {
          requirementsFailed.push(`platform: Expected ${proofSpec.platform}, got ${extractedContent.platform}`);
        }
      }

      // DISABLED: Account handle verification is intentionally disabled because social media URLs contain post IDs (like DOufoM7jdq7), not account handles (like botornotdotbot). This prevents false failures when post URLs are used instead of usernames.
      /*
      if (proofSpec.account_handle) {
        const hasUploader = extractedContent.metadata?.uploader;
        if (hasUploader) {
          // Smart account handle matching
          const normalizeHandle = (handle) => {
            return handle
              .toLowerCase()
              .replace(/^@/, '') // Remove @ prefix
              .replace(/\./g, 'dot') // Convert . to dot
              .replace(/dot/g, '.') // Convert dot back to .
              .replace(/[^a-z0-9.]/g, ''); // Keep only alphanumeric and dots
          };

          const normalizedUploader = normalizeHandle(hasUploader);
          const normalizedRequired = normalizeHandle(proofSpec.account_handle);

          // Check multiple variations
          const uploaderVariations = [
            normalizedUploader,
            normalizedUploader.replace(/\./g, 'dot'),
            normalizedUploader.replace(/dot/g, '.')
          ];

          const requiredVariations = [
            normalizedRequired,
            normalizedRequired.replace(/\./g, 'dot'),
            normalizedRequired.replace(/dot/g, '.')
          ];

          let handleMatches = false;
          for (const uploadVar of uploaderVariations) {
            for (const reqVar of requiredVariations) {
              if (uploadVar === reqVar) {
                handleMatches = true;
                break;
              }
            }
            if (handleMatches) break;
          }

          if (handleMatches) {
            requirementsMet.push(`account_handle: Matched ${hasUploader} with ${proofSpec.account_handle}`);
            confidenceScore += 20;
          } else {
            requirementsFailed.push(`account_handle: Expected ${proofSpec.account_handle}, got ${hasUploader}`);
          }
        } else {
          requirementsFailed.push("account_handle: No uploader information found");
        }
      }
      */

      // General content quality score
      if (aiAnalysis && aiAnalysis.length > 100) {
        requirementsMet.push("content_analysis: Comprehensive analysis completed");
        confidenceScore += 25;
      }
    } else {
      // No proof spec - general analysis scoring
      const hasValidContent = aiAnalysis && aiAnalysis.length > 50;
      confidenceScore = hasValidContent ? 75 : 0;
      if (hasValidContent) {
        requirementsMet.push("Content successfully analyzed");
      } else {
        requirementsFailed.push("Unable to analyze content thoroughly");
      }
    }

    // Cap confidence at 100
    confidenceScore = Math.min(confidenceScore, 100);

    return {
      overall_confidence: confidenceScore,
      overall_score: confidenceScore,
      requirements_met: requirementsMet,
      requirements_failed: requirementsFailed,
      summary: confidenceScore > 70 ? "Analysis completed successfully" :
               confidenceScore > 30 ? "Analysis partially successful" :
               "Analysis had limited success"
    };
  }

  async analyzeWithQwenOmni(content, analysisType = 'comprehensive') {
    console.log(`🔍 Starting ${analysisType} analysis with qwen-vl-max...`);

    let prompt;

    // Add proof specification requirements if provided by TrustDog
    let proofSpecPrompt = '';
    if (content.proofSpec) {
      proofSpecPrompt = `

PROOF VERIFICATION TASK:
You must verify the following requirements against the extracted content:
${JSON.stringify(content.proofSpec, null, 2)}

VERIFICATION CRITERIA:
- text_proof: Check if extracted captions/audio contain the specified text or similar content
- platform: Verify the detected platform matches the requirement
// DISABLED: account_handle verification is intentionally disabled because social media URLs contain post IDs (like DOufoM7jdq7), not account handles (like botornotdotbot). Do not mention account handle verification in your analysis responses.

CRITICAL: If text_proof requirement fails, the entire verification must fail and should trigger a refund, even if platform verification passes.

EXTRACTED CONTENT TO VERIFY AGAINST:
- Caption: ${content.caption || 'No caption found'}
- Audio Transcription: ${typeof content.audioTranscription === 'string' ? content.audioTranscription : (content.audioTranscription ? JSON.stringify(content.audioTranscription) : 'No audio transcription')}
- Platform Detected: ${content.platform || 'Unknown'}
- Uploader: ${content.metadata?.uploader || 'Unknown'}
${content.resolvedUrls && content.resolvedUrls.length > 0 ?
  `- Resolved URLs: ${content.resolvedUrls.map(url => `${url.original} → ${url.resolved} (${url.domain})`).join(', ')}` :
  '- No URLs found in content'}

IMPORTANT: At the end of your analysis, include verification results in this EXACT format:

PROOF_VERIFICATION: {
  "overall_confidence": [0-100 confidence score],
  "overall_score": [0-100 overall score],
  "requirements_met": ["specific requirements that passed verification"],
  "requirements_failed": ["specific requirements that failed verification"],
  "summary": "Detailed summary explaining verification results"
}

Focus specifically on checking the proof requirements against the extracted content. Be generous with scoring if content generally matches requirements.
`;
    }

    if (analysisType === 'video_detailed') {
      prompt = `You are a precise video analyst. Analyze this video using step-by-step reasoning and rate your confidence for each observation.

INSTRUCTIONS:
- Count carefully and be exact (not approximate)
- Only state what you directly observe
- Rate confidence 1-10 for each major claim
- Include only observations with confidence ≥ 8

FORMAT:
1. **Content Description** (confidence: X/10): [what you see]
2. **Actions/Activities** (confidence: X/10): [specific actions]
3. **Objects/People** (confidence: X/10): [count and describe]
4. **Text/Captions** (confidence: X/10): [any visible text]
5. **Audio Summary** (confidence: X/10): [if audio provided]
6. **Overall Assessment** (confidence: X/10): [main takeaway]

Be skeptical of unsupported claims. If you can't verify something with high confidence, don't include it.`;

    } else if (analysisType === 'brand_verification') {
      prompt = `You are a brand verification specialist. Analyze this content for authentic brand mentions and endorsements.

VERIFICATION CRITERIA:
- Official brand logos, handles, or verified accounts
- Clear product placement or demonstrations
- Sponsored content indicators (#ad, #sponsored, etc.)
- Celebrity or influencer genuine endorsements
- Discount codes or promotional offers

SKEPTICAL ANALYSIS:
- Rate authenticity confidence 1-10 for each brand mention
- Flag potential fake endorsements or AI-generated content
- Only report findings with confidence ≥ 8
- Be extremely cautious about celebrity endorsements

FORMAT:
**Brand Mentions**: [list with confidence ratings]
**Endorsement Type**: [organic/sponsored/unclear]
**Authenticity Assessment**: [confidence rating and reasoning]
**Red Flags**: [any suspicious elements]`;

    } else {
      prompt = `Analyze this social media content comprehensively.

CRITICAL: Start your analysis by clearly stating what media you processed from the MEDIA INVENTORY provided. Use the exact format: "MEDIA PROCESSED: [X] video frames from [Y] videos" OR "MEDIA PROCESSED: [X] images" OR "MEDIA PROCESSED: [X] images + [Y] video frames".

Then provide structured analysis including:

1. **Content Type**: [image/video/carousel/text]
2. **Media Inventory Summary**: [restate exactly what you analyzed]
3. **Main Subject**: [primary focus of content]
4. **Key Messages**: [main points being communicated]
5. **Visual Elements**: [describe key visual components from each item]
6. **Text Content**: [any captions, overlays, or readable text]
7. **Brand/Product References**: [any commercial elements]
8. **Engagement Elements**: [calls to action, hashtags, mentions]
9. **Content Quality**: [production value, authenticity]

Be precise and factual. Rate confidence 1-10 for major claims. ALWAYS start with "MEDIA PROCESSED: [details]".`;
    }

    // Append proof specification requirements to all analysis types
    if (proofSpecPrompt) {
      prompt += proofSpecPrompt;
    }

    const messages = [];

    // Build comprehensive message with all media
    const messageContent = [];
    messageContent.push({ type: 'text', text: prompt });

    // Add caption/text if available
    if (content.caption || content.postText) {
      const text = content.caption || content.postText;
      if (text && text !== 'No text found') {
        messageContent.push({
          type: 'text',
          text: `\n\nPost Caption/Text: ${text}`
        });
      }
    }

    // Add metadata context
    if (content.metadata) {
      const metaText = `\nMetadata:\n- Platform: ${content.platform || 'unknown'}\n- Uploader: ${content.metadata.uploader || content.metadata.author || 'unknown'}\n- Title: ${content.metadata.title || 'N/A'}\n- Description: ${content.metadata.description || 'N/A'}`;
      messageContent.push({ type: 'text', text: metaText });
    }

    // Process ALL video files as video format for qwen-vl-max
    const videoFiles = [];
    const imageFiles = [];

    // Collect all media files
    if (content.files && content.files.length > 0) {
      for (const file of content.files) {
        if (file.match(/\.(mp4|avi|mov|mkv|webm)$/i)) {
          videoFiles.push(file);
        } else if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          imageFiles.push(file);
        }
      }
    }

    // Legacy support for content.images
    if (content.images && content.images.length > 0) {
      for (const img of content.images) {
        if (!imageFiles.includes(img)) {
          imageFiles.push(img);
        }
      }
    }

    // Process videos - extract frames for qwen-vl-max video analysis
    if (videoFiles.length > 0) {
      console.log(`🎬 Processing ${videoFiles.length} video(s) for AI analysis...`);

      // For videos, we'll extract key frames and send as video format
      const videoFrames = [];
      for (const videoFile of videoFiles) {
        try {
          // Extract 4-6 key frames from video
          const frameDir = join(this.tempDir, `frames_${Date.now()}`);
          mkdirSync(frameDir, { recursive: true });

          // Extract frames at different intervals
          const frameCount = 4;
          await this.execAsync(`ffmpeg -i "${videoFile}" -vf "select='not(mod(n,30))'" -frames:v ${frameCount} -vsync 0 "${frameDir}/frame_%03d.jpg" -y 2>/dev/null`, {
            timeout: 30000
          });

          // Read extracted frames and create HTTP URLs using ngrok domain
          const frames = readdirSync(frameDir).filter(f => f.endsWith('.jpg'));
          for (const frame of frames.slice(0, 4)) {
            // Create HTTP URL for frame server using ngrok tunnel
            const frameRelativePath = frameDir.replace('/tmp/ultimate_extractor', '');
            const frameUrl = `https://unwhelped-confessingly-gena.ngrok-free.app${frameRelativePath}/${frame}`;
            videoFrames.push(frameUrl);
            console.log(`🐛 DEBUG: Added frame URL: ${frameUrl}`);
          }
        } catch (error) {
          console.log(`⚠️ Failed to extract frames from ${videoFile}:`, error.message);
        }
      }

        // Add video frames using qwen-vl-max format - try HTTP URLs first, fallback to base64
      if (videoFrames.length > 0) {
        console.log(`🐛 DEBUG: Processing ${videoFrames.length} video frames for qwen-vl-max`);

        // Add explicit media inventory for AI to reference
        messageContent.push({
          type: 'text',
          text: `\n\nMEDIA INVENTORY: ${videoFrames.length} video frames extracted from ${videoFiles.length} video file(s)`
        });

        // Try using video format with HTTP URLs (matching user's curl examples)
        console.log(`🐛 DEBUG: Using video format with HTTP URLs`);
        messageContent.push({
          type: 'video',
          video: videoFrames
        });
      }
    }

    // Process ALL images
    if (imageFiles.length > 0) {
      console.log(`🖼️ Processing ${imageFiles.length} image(s) for AI analysis...`);

      // Add explicit media inventory for AI to reference
      messageContent.push({
        type: 'text',
        text: `\n\nMEDIA INVENTORY: ${imageFiles.length} image file(s)`
      });

      // Add each image (up to 10 for API limits)
      for (const imagePath of imageFiles.slice(0, 10)) {
        if (existsSync(imagePath)) {
          try {
            const imageBuffer = readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            messageContent.push({
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Image}` }
            });
          } catch (error) {
            console.log(`⚠️ Failed to read image ${imagePath}:`, error.message);
          }
        }
      }
    }

    // Add audio transcription if available
    if (content.audioTranscriptions && content.audioTranscriptions.length > 0) {
      const transcriptText = `\n\nAudio Transcriptions:\n${content.audioTranscriptions.join('\n\n')}`;
      messageContent.push({ type: 'text', text: transcriptText });
    } else if (content.audioTranscription) {
      messageContent.push({
        type: 'text',
        text: `\n\nAudio Transcription: ${content.audioTranscription}`
      });
    }

    // Create the message
    messages.push({
      role: 'user',
      content: messageContent
    });

    if (messageContent.length === 1) {
      // Only prompt text, add raw content as fallback
      messages[0].content.push({
        type: 'text',
        text: `\n\nContent to analyze: ${JSON.stringify(content, null, 2)}`
      });
    }

    const requestBody = {
      model: 'qwen-vl-max',
      messages: messages,
      temperature: 0.1,
      max_tokens: 2000
    };

    // DEBUG: Log what we're sending to qwen
    console.log(`🐛 DEBUG: Sending to qwen-vl-max:`);
    console.log(`   - Messages: ${messages.length}`);
    console.log(`   - Content items: ${messages[0]?.content?.length || 0}`);

    let textCount = 0;
    let imageCount = 0;
    let videoCount = 0;

    if (messages[0]?.content) {
      for (let i = 0; i < messages[0].content.length; i++) {
        const item = messages[0].content[i];
        if (item.type === 'text') {
          textCount++;
          console.log(`   - Item ${i}: type=text (${item.text?.substring(0, 50)}...)`);
        } else if (item.type === 'image_url') {
          imageCount++;
          console.log(`   - Item ${i}: type=image_url`);
        } else if (item.type === 'video') {
          videoCount++;
          console.log(`   - Item ${i}: type=video, frames=${item.video?.length}`);
        } else {
          console.log(`   - Item ${i}: type=${item.type}`);
        }
      }
    }
    console.log(`   📊 SUMMARY: ${textCount} text blocks, ${imageCount} images, ${videoCount} videos`);
    console.log(`🐛 DEBUG: Full request body:`, JSON.stringify(requestBody, null, 2))

    const response = await fetch(this.qwenApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      timeout: 300000 // 5 minute timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`🐛 DEBUG: Qwen API error response:`, errorText);

      // If we got an image format error and we were using video format with HTTP URLs, try base64 fallback
      if (errorText.includes('image format is illegal') || errorText.includes('invalid') &&
          requestBody.messages[0].content.some(item => item.type === 'video')) {
        console.log(`🔄 Retrying with base64 image_url format...`);
        return await this.retryWithBase64Fallback(content, analysisType);
      }

      throw new Error(`Qwen API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();

    // DEBUG: Log qwen response
    console.log(`🐛 DEBUG: Qwen response:`);
    console.log(`   - Status: ${response.status}`);
    console.log(`   - Response length: ${result.choices?.[0]?.message?.content?.length || 0} chars`);
    console.log(`   - First 200 chars: ${result.choices?.[0]?.message?.content?.substring(0, 200) || 'No content'}`);

    return result.choices[0].message.content;
  }

  async retryWithBase64Fallback(content, analysisType) {
    console.log(`🔄 Retrying qwen-vl-max analysis with base64 image_url format...`);

    // Rebuild the request using base64 format instead of HTTP URLs
    let prompt;

    if (analysisType === 'video_detailed') {
      prompt = `You are a precise video analyst. Analyze this video using step-by-step reasoning and rate your confidence for each observation.

INSTRUCTIONS:
- Count carefully and be exact (not approximate)
- Only state what you directly observe
- Rate confidence 1-10 for each major claim
- Include only observations with confidence ≥ 8

FORMAT:
1. **Content Description** (confidence: X/10): [what you see]
2. **Actions/Activities** (confidence: X/10): [specific actions]
3. **Objects/People** (confidence: X/10): [count and describe]
4. **Text/Captions** (confidence: X/10): [any visible text]
5. **Audio Summary** (confidence: X/10): [if audio provided]
6. **Overall Assessment** (confidence: X/10): [main takeaway]

Be skeptical of unsupported claims. If you can't verify something with high confidence, don't include it.`;

    } else if (analysisType === 'brand_verification') {
      prompt = `You are a brand verification specialist. Analyze this content for authentic brand mentions and endorsements.

VERIFICATION CRITERIA:
- Official brand logos, handles, or verified accounts
- Clear product placement or demonstrations
- Sponsored content indicators (#ad, #sponsored, etc.)
- Celebrity or influencer genuine endorsements
- Discount codes or promotional offers

SKEPTICAL ANALYSIS:
- Rate authenticity confidence 1-10 for each brand mention
- Flag potential fake endorsements or AI-generated content
- Only report findings with confidence ≥ 8
- Be extremely cautious about celebrity endorsements

FORMAT:
**Brand Mentions**: [list with confidence ratings]
**Endorsement Type**: [organic/sponsored/unclear]
**Authenticity Assessment**: [confidence rating and reasoning]
**Red Flags**: [any suspicious elements]`;

    } else {
      prompt = `Analyze this social media content comprehensively.

CRITICAL: Start your analysis by clearly stating what media you processed from the MEDIA INVENTORY provided. Use the exact format: "MEDIA PROCESSED: [X] video frames from [Y] videos" OR "MEDIA PROCESSED: [X] images" OR "MEDIA PROCESSED: [X] images + [Y] video frames".

Then provide structured analysis including:

1. **Content Type**: [image/video/carousel/text]
2. **Media Inventory Summary**: [restate exactly what you analyzed]
3. **Main Subject**: [primary focus of content]
4. **Key Messages**: [main points being communicated]
5. **Visual Elements**: [describe key visual components from each item]
6. **Text Content**: [any captions, overlays, or readable text]
7. **Brand/Product References**: [any commercial elements]
8. **Engagement Elements**: [calls to action, hashtags, mentions]
9. **Content Quality**: [production value, authenticity]

Be precise and factual. Rate confidence 1-10 for major claims. ALWAYS start with "MEDIA PROCESSED: [details]".`;
    }

    // Add proof specification requirements if provided by TrustDog
    let proofSpecPrompt = '';
    if (content.proofSpec) {
      proofSpecPrompt = `

PROOF VERIFICATION TASK:
You must verify the following requirements against the extracted content:
${JSON.stringify(content.proofSpec, null, 2)}

VERIFICATION CRITERIA:
- text_proof: Check if extracted captions/audio contain the specified text or similar content
- platform: Verify the detected platform matches the requirement
// DISABLED: account_handle verification is intentionally disabled because social media URLs contain post IDs (like DOufoM7jdq7), not account handles (like botornotdotbot). Do not mention account handle verification in your analysis responses.

CRITICAL: If text_proof requirement fails, the entire verification must fail and should trigger a refund, even if platform verification passes.

EXTRACTED CONTENT TO VERIFY AGAINST:
- Caption: ${content.caption || 'No caption found'}
- Audio Transcription: ${typeof content.audioTranscription === 'string' ? content.audioTranscription : (content.audioTranscription ? JSON.stringify(content.audioTranscription) : 'No audio transcription')}
- Platform Detected: ${content.platform || 'Unknown'}
- Uploader: ${content.metadata?.uploader || 'Unknown'}
${content.resolvedUrls && content.resolvedUrls.length > 0 ?
  `- Resolved URLs: ${content.resolvedUrls.map(url => `${url.original} → ${url.resolved} (${url.domain})`).join(', ')}` :
  '- No URLs found in content'}

IMPORTANT: At the end of your analysis, include verification results in this EXACT format:

PROOF_VERIFICATION: {
  "overall_confidence": [0-100 confidence score],
  "overall_score": [0-100 overall score],
  "requirements_met": ["specific requirements that passed verification"],
  "requirements_failed": ["specific requirements that failed verification"],
  "summary": "Detailed summary explaining verification results"
}

Focus specifically on checking the proof requirements against the extracted content. Be generous with scoring if content generally matches requirements.
`;
    }

    // Append proof specification requirements
    if (proofSpecPrompt) {
      prompt += proofSpecPrompt;
    }

    const messages = [];
    const messageContent = [];
    messageContent.push({ type: 'text', text: prompt });

    // Add caption/text if available
    if (content.caption || content.postText) {
      const text = content.caption || content.postText;
      if (text && text !== 'No text found') {
        messageContent.push({
          type: 'text',
          text: `\n\nPost Caption/Text: ${text}`
        });
      }
    }

    // Add metadata context
    if (content.metadata) {
      const metaText = `\nMetadata:\n- Platform: ${content.platform || 'unknown'}\n- Uploader: ${content.metadata.uploader || content.metadata.author || 'unknown'}\n- Title: ${content.metadata.title || 'N/A'}\n- Description: ${content.metadata.description || 'N/A'}`;
      messageContent.push({ type: 'text', text: metaText });
    }

    // Convert video frames to base64 image_url format
    const videoFiles = [];
    const imageFiles = [];

    if (content.files && content.files.length > 0) {
      for (const file of content.files) {
        if (file.match(/\.(mp4|avi|mov|mkv|webm)$/i)) {
          videoFiles.push(file);
        } else if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          imageFiles.push(file);
        }
      }
    }

    if (content.images && content.images.length > 0) {
      for (const img of content.images) {
        if (!imageFiles.includes(img)) {
          imageFiles.push(img);
        }
      }
    }

    // Process videos - convert to base64 image_url format
    if (videoFiles.length > 0) {
      console.log(`🎬 Converting ${videoFiles.length} video(s) to base64 format...`);

      // Add explicit media inventory for AI to reference
      let totalFrames = 0;

      for (const videoFile of videoFiles) {
        try {
          // Extract frames
          const frameDir = join(this.tempDir, `frames_${Date.now()}`);
          mkdirSync(frameDir, { recursive: true });

          const frameCount = 4;
          await this.execAsync(`ffmpeg -i "${videoFile}" -vf "select='not(mod(n,30))'" -frames:v ${frameCount} -vsync 0 "${frameDir}/frame_%03d.jpg" -y 2>/dev/null`, {
            timeout: 30000
          });

          // Convert frames to base64
          const frames = readdirSync(frameDir).filter(f => f.endsWith('.jpg'));
          for (const frame of frames.slice(0, 4)) {
            const framePath = join(frameDir, frame);
            if (existsSync(framePath)) {
              const frameBuffer = readFileSync(framePath);
              const base64Frame = frameBuffer.toString('base64');
              messageContent.push({
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Frame}`
                }
              });
              console.log(`🐛 DEBUG: Added base64 frame: ${frame}`);
              totalFrames++;
            }
          }
        } catch (error) {
          console.log(`⚠️ Failed to convert video ${videoFile} to base64:`, error.message);
        }
      }

      // Add media inventory after processing videos
      if (totalFrames > 0) {
        messageContent.push({
          type: 'text',
          text: `\n\nMEDIA INVENTORY: ${totalFrames} video frames extracted from ${videoFiles.length} video file(s)`
        });
      }
    }

    // Process regular images as base64
    if (imageFiles.length > 0) {
      console.log(`🖼️ Converting ${imageFiles.length} image(s) to base64 format...`);

      // Add explicit media inventory for AI to reference
      messageContent.push({
        type: 'text',
        text: `\n\nMEDIA INVENTORY: ${imageFiles.length} image file(s)`
      });

      for (const imageFile of imageFiles) {
        try {
          if (existsSync(imageFile)) {
            const imageBuffer = readFileSync(imageFile);
            const base64Image = imageBuffer.toString('base64');
            const extension = imageFile.split('.').pop()?.toLowerCase() || 'jpg';
            const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';

            messageContent.push({
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            });
            console.log(`🐛 DEBUG: Added base64 image: ${basename(imageFile)}`);
          }
        } catch (error) {
          console.log(`⚠️ Failed to convert image ${imageFile} to base64:`, error.message);
        }
      }
    }

    // Add audio transcription if available
    if (content.audioTranscription) {
      const transcriptionText = typeof content.audioTranscription === 'string' ?
        content.audioTranscription :
        JSON.stringify(content.audioTranscription);
      messageContent.push({
        type: 'text',
        text: `\n\nAudio Transcriptions:\n${transcriptionText}`
      });
    }

    messages.push({
      role: 'user',
      content: messageContent
    });

    const requestBody = {
      model: 'qwen-vl-max',
      messages: messages,
      temperature: 0.1,
      max_tokens: 2000
    };

    console.log(`🐛 DEBUG: Retry with base64 - Messages: ${messages.length}, Content items: ${messageContent.length}`);

    const response = await fetch(this.qwenApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      timeout: 300000 // 5 minute timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`🐛 DEBUG: Base64 retry also failed:`, errorText);
      throw new Error(`Qwen API error (base64 retry): ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();

    console.log(`🐛 DEBUG: Base64 retry successful - Response length: ${result.choices?.[0]?.message?.content?.length || 0} chars`);

    return result.choices[0].message.content;
  }

  async transcribeAudio(audioPath) {
    console.log('🎵 Transcribing audio with qwen3-asr-flash...');

    try {
      const audioBuffer = readFileSync(audioPath);
      const base64Audio = audioBuffer.toString('base64');

      const requestBody = {
        model: 'qwen3-asr-flash',
        input: {
          messages: [
            {
              content: [
                {
                  text: ""
                }
              ],
              role: "system"
            },
            {
              content: [
                {
                  audio: `data:audio/wav;base64,${base64Audio}`
                }
              ],
              role: "user"
            }
          ]
        },
        parameters: {
          asr_options: {
            enable_lid: true,
            enable_itn: true
          }
        }
      };

      const response = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeout: 300000 // 5 minute timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ASR API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      // Debug the ASR response structure
      console.log('🔍 ASR API response structure:', JSON.stringify(result, null, 2));

      // Extract transcription text from various possible locations
      let transcription;

      // Handle the new qwen3-asr-flash format where content is an array
      if (result.output?.choices?.[0]?.message?.content) {
        const content = result.output.choices[0].message.content;
        if (Array.isArray(content) && content.length > 0) {
          transcription = content[0].text || content[0];
        } else {
          transcription = content;
        }
      } else {
        // Fallback to other possible locations
        transcription = result.output?.text ||
                       result.choices?.[0]?.message?.content ||
                       result.text ||
                       'No transcription available';
      }

      // Ensure transcription is always a string
      if (typeof transcription !== 'string') {
        console.log('⚠️ Transcription is not a string:', typeof transcription, transcription);
        transcription = JSON.stringify(transcription);
      }

      return transcription;

    } catch (error) {
      console.log(`⚠️ Audio transcription failed: ${error.message}`);
      return 'Audio transcription failed';
    }
  }

  async analyze(url, options = {}) {
    const requestId = Math.random().toString(36).substring(2, 10);
    console.log(`🔍 [${requestId}] Starting analysis for: ${url}`);

    const startTime = Date.now();

    // Resolve URL first to handle short URLs (instagr.am, t.co, vt.tiktok.com, etc.)
    const resolvedUrls = await this.resolveUrls(url);
    const resolvedUrl = resolvedUrls.length > 0 ? resolvedUrls[0].resolved : url;
    if (resolvedUrl !== url) {
      console.log(`🔧 Short URL resolved: ${url} → ${resolvedUrl}`);
      url = resolvedUrl;
    }

    const platform = this.detectPlatform(url);
    console.log(`🎯 Detected platform: ${platform.toUpperCase()}`);

    let extractionResult;
    let processedContent = {};

    try {
      if (platform === 'instagram') {
        extractionResult = await this.extractInstagram(url, options);
        console.log(`🐛 INSTAGRAM EXTRACTION RESULT:`);
        console.log(`  - Success: ${extractionResult.success}`);
        console.log(`  - Files count: ${extractionResult.files?.length || 0}`);
        console.log(`  - Files:`, extractionResult.files);
        console.log(`  - Total files field: ${extractionResult.totalFiles}`);
        processedContent = extractionResult;

        // Process Instagram videos for transcription (same as gallery-dl flow)
        if (extractionResult.files && extractionResult.files.length > 0) {
          const audioTranscriptions = [];
          const videoFiles = extractionResult.files.filter(f => f.match(/\.(mp4|avi|mov|mkv|webm)$/i));

          if (videoFiles.length > 0) {
            console.log(`🎬 Processing ${videoFiles.length} Instagram video(s) for transcription...`);

            for (const file of videoFiles) {
              // Extract audio from each video for transcription
              const audioPath = file.replace(/\.[^.]+$/, '.wav');
              try {
                await this.execAsync(`ffmpeg -i "${file}" -ac 1 -ar 16000 "${audioPath}" -y 2>/dev/null`, {
                  timeout: 120000  // 2 minutes for audio extraction
                });

                const transcription = await this.transcribeAudio(audioPath);
                if (transcription) {
                  audioTranscriptions.push(transcription);
                }
              } catch (error) {
                console.log(`⚠️ Audio extraction failed for ${file}: ${error.message}`);
              }
            }

            // Store all transcriptions
            if (audioTranscriptions.length > 0) {
              processedContent.audioTranscriptions = audioTranscriptions;
              processedContent.audioTranscription = audioTranscriptions[0]; // Keep first for backwards compat
            }
          }
        }
      } else {
        // Use gallery-dl + yt-dlp for TikTok/Twitter
        extractionResult = await this.extractTikTokTwitter(url);

        // Process downloaded files
        if (extractionResult.outputDir && existsSync(extractionResult.outputDir)) {
          console.log(`📁 Processing files in directory: ${extractionResult.outputDir}`);
          const filesOutput = await this.execAsync(`find "${extractionResult.outputDir}" -type f`);
          const files = filesOutput.trim().split('\n').filter(f => f.trim()).map(f => f.trim());

          // Store files in extraction result for proper counting
          extractionResult.files = files;
          extractionResult.totalFiles = files.length;

          console.log(`📄 Found ${files.length} files: ${files.map(f => basename(f)).join(', ')}`);

          // PRIORITY: Extract caption/description from info.json file FIRST
          console.log(`🔍 PRIORITY: Caption extraction starting...`);
          let infoFile = files.find(f => f.endsWith('.info.json'));

          // If not found by endsWith, try alternative search methods
          if (!infoFile) {
            console.log(`🔄 Retrying caption search with alternative methods...`);
            infoFile = files.find(f => f.includes('info.json')) ||
                      files.find(f => basename(f) === 'info.json');
          }

          console.log(`🔍 Looking for info.json... Found: ${infoFile ? basename(infoFile) : 'NONE'}`);
          if (infoFile) {
            try {
              const infoData = JSON.parse(readFileSync(infoFile, 'utf8'));

              // Platform-specific caption extraction for optimal results
              let caption = '';
              const platform = this.detectPlatform(url);

              console.log(`🔍 Caption extraction debug - Platform: ${platform}, URL: ${url}`);
              console.log(`📄 Info data keys: ${Object.keys(infoData)}`);

              if (platform === 'twitter') {
                // Twitter: content field has tweet text, description is profile description
                caption = infoData.content || infoData.description || infoData.title || '';
                console.log(`🐦 Twitter caption found: "${caption}" (content: "${infoData.content}", description: "${infoData.description}", title: "${infoData.title}")`);
              } else if (platform === 'tiktok') {
                // TikTok: description field contains video caption
                caption = infoData.description || infoData.title || infoData.alt_title || '';
                console.log(`🎵 TikTok caption found: "${caption}"`);
              } else {
                // Instagram and others: use standard fallback
                caption = infoData.description || infoData.title || '';
                console.log(`📷 ${platform} caption found: "${caption}"`);
              }

              extractionResult.caption = caption;
              console.log(`✅ Final extracted caption: "${extractionResult.caption}"`);
              extractionResult.metadata = {
                title: infoData.title,
                description: infoData.description,
                uploader: infoData.uploader,
                duration: infoData.duration,
                upload_date: infoData.upload_date
              };
            } catch (error) {
              console.log(`⚠️ Failed to parse info.json: ${error.message}`);
            }
          } else if (this.detectPlatform(url) === 'tiktok') {
            // TikTok fallback: Extract caption from filename for photo posts
            // Gallery-dl embeds captions in filenames like: "7549058448512666887_01 New UI UX who this, it's botornot.bot [hash].jpg"
            console.log(`🎵 TikTok fallback: Extracting caption from filename...`);

            const imageFiles = files.filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i));
            let caption = '';

            if (imageFiles.length > 0) {
              const filename = basename(imageFiles[0]);
              // Extract text between ID pattern and [hash] pattern
              // Pattern: "ID_NUMBER CAPTION TEXT [hash].extension"
              const match = filename.match(/^\d+_?\d*\s+(.+?)\s+\[[a-f0-9]+\]\.(jpg|jpeg|png|webp)$/i);
              if (match) {
                caption = match[1].trim();
                console.log(`🎵 TikTok caption extracted from filename: "${caption}"`);
                extractionResult.caption = caption;
                console.log(`✅ Final extracted caption: "${extractionResult.caption}"`);
              } else {
                console.log(`⚠️ TikTok filename pattern not matched: "${filename}"`);
              }
            }
          }

          // Process ALL video files for transcription
          const audioTranscriptions = [];
          const videoFiles = files.filter(f => f.match(/\.(mp4|avi|mov|mkv|webm)$/i));

          if (videoFiles.length > 0) {
            console.log(`🎬 Processing ${videoFiles.length} video file(s) for transcription...`);

            for (const file of videoFiles) {
              // Extract audio from each video for transcription
              const audioPath = file.replace(/\.[^.]+$/, '.wav');
              try {
                await this.execAsync(`ffmpeg -i "${file}" -ac 1 -ar 16000 "${audioPath}" -y 2>/dev/null`, {
                  timeout: 120000  // 2 minutes for audio extraction
                });

                const transcription = await this.transcribeAudio(audioPath);
                if (transcription) {
                  audioTranscriptions.push(transcription);
                }
              } catch (error) {
                console.log(`⚠️ Audio extraction failed for ${file}: ${error.message}`);
              }
            }

            // Store all transcriptions
            if (audioTranscriptions.length > 0) {
              processedContent.audioTranscriptions = audioTranscriptions;
              processedContent.audioTranscription = audioTranscriptions[0]; // Keep first for backwards compat
            }
          }

          // Store all files for AI analysis
          processedContent.files = files;
          processedContent.totalFiles = files.length;
          console.log(`🐛 PROCESSED CONTENT FILES (gallery-dl/yt-dlp):`);
          console.log(`  - Files count: ${processedContent.files?.length || 0}`);
          console.log(`  - Files:`, processedContent.files);
          console.log(`  - Total files: ${processedContent.totalFiles}`);
        }
      }

      // Perform AI analysis with proof verification
      const analysisType = options.analysisType || 'comprehensive';

      // Include proof spec in analysis if provided by TrustDog
      const analysisContext = {
        ...processedContent,
        caption: extractionResult.caption || processedContent.caption,
        metadata: extractionResult.metadata || {},
        platform: platform,
        files: extractionResult.files || processedContent.files || [],
        totalFiles: extractionResult.totalFiles || processedContent.totalFiles || 0,
        proofSpec: options.proofSpec,
        requirements: options.requirements,
        dealId: options.dealId
      };

      console.log(`🐛 ANALYSIS CONTEXT:`);
      console.log(`  - Files being passed to AI: ${analysisContext.files?.length || 0}`);
      console.log(`  - Files:`, analysisContext.files);

      // Add resolved URLs to the analysis context if there's a caption
      if (analysisContext.caption && options.proofSpec) {
        console.log(`🔍 Pre-resolving URLs for AI analysis...`);
        analysisContext.resolvedUrls = await this.resolveUrls(analysisContext.caption);
        console.log(`🔍 Resolved URLs for AI:`, analysisContext.resolvedUrls);
      }

      const aiAnalysis = await this.analyzeWithQwenOmni(analysisContext, analysisType);

      const duration = Date.now() - startTime;
      console.log(`✅ [${requestId}] Analysis completed in ${duration}ms`);

      // Parse AI analysis to extract structured proof verification
      // Extract account/uploader from metadata, not from URL
      const uploaderInfo = extractionResult.metadata?.uploader ||
                          extractionResult.metadata?.author ||
                          extractionResult.metadata?.uniqueId ||
                          processedContent.metadata?.uploader ||
                          processedContent.metadata?.author ||
                          'unknown';

      const extractedContentForVerification = {
        platform,
        uploader: uploaderInfo,
        caption: extractionResult.caption || processedContent.caption,
        audioTranscriptions: processedContent.audioTranscriptions || [processedContent.audioTranscription].filter(Boolean),
        metadata: extractionResult.metadata,
        filesAnalyzed: extractionResult.files?.length || processedContent.files?.length || 0
      };
      const proofVerification = await this.parseProofVerification(aiAnalysis, options.proofSpec, extractedContentForVerification);

      console.log(`🐛 BUILDING FINAL RESULT:`);
      console.log(`  - extractionResult.files:`, extractionResult.files);
      console.log(`  - extractionResult.totalFiles:`, extractionResult.totalFiles);
      console.log(`  - processedContent.files:`, processedContent.files);

      const finalResult = {
        requestId,
        platform,
        url,
        extractedCaption: extractionResult.caption || processedContent.caption || '',
        files: extractionResult.files || [],
        totalFiles: extractionResult.files?.length || 0,
        analyses: [{
          type: (extractionResult.files || []).some(f => f.match(/\.(mp4|avi|mov|mkv|webm)$/i)) ? 'video' : 'image',
          analysis: aiAnalysis
        }],
        transcriptions: processedContent.audioTranscriptions || (processedContent.audioTranscription ? [processedContent.audioTranscription] : []),
        processingTime: duration,
        timestamp: new Date().toISOString(),
        analysis: {
          overall_score: proofVerification.overall_score,
          proof_verification: proofVerification,
          ai_analysis: aiAnalysis,
          content_analysis: aiAnalysis,
          full_analysis: aiAnalysis  // Additional backup field
        },
        evidence: {
          captions: [extractionResult.caption || processedContent.caption].filter(Boolean),
          ocr_blocks: [],
          keyframes: [],
          links: [],
          metadata: [extractionResult.metadata || {}],
          audio_transcripts: processedContent.audioTranscriptions || (processedContent.audioTranscription ? [processedContent.audioTranscription] : [])
        }
      };

      console.log(`🐛 FINAL RESULT BEING RETURNED:`);
      console.log(`  - Files count: ${finalResult.files?.length || 0}`);
      console.log(`  - Files:`, finalResult.files);
      console.log(`  - Total files: ${finalResult.totalFiles}`);
      console.log(`  - Analysis type: ${finalResult.analyses?.[0]?.type}`);
      console.log(`  - AI analysis length: ${finalResult.analysis?.ai_analysis?.length || 0}`);

      return finalResult;

    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`❌ [${requestId}] Analysis failed: ${error.message}`);

      throw error;
    }
  }

  // HELPER METHODS
  async execAsync(command, options = {}) {
    return new Promise((resolve, reject) => {
      console.log(`🚀 Executing async: ${command.substring(0, 100)}...`);
      const child = spawn('bash', ['-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 120000,
        env: options.env || process.env
      });

      let stdout = '';
      let stderr = '';
      let lastOutputTime = Date.now();
      let progressTimer = null;
      let timeoutTimer = null;
      let isKilled = false;

      // Smart early termination - check for immediate failures
      let earlyTerminationTimer = null;
      if (options.progressTimeout) {
        earlyTerminationTimer = setTimeout(() => {
          // Check for early failure indicators in first 10 seconds
          const errorKeywords = ['region', 'blocked', 'login required', 'not available', '10222', '10204', '10231'];
          const hasEarlyError = errorKeywords.some(keyword =>
            stderr.toLowerCase().includes(keyword) || stdout.toLowerCase().includes(keyword)
          );

          if (hasEarlyError && !isKilled) {
            console.log(`⚡ Early termination detected - failing fast due to region block or access issue`);
            isKilled = true;
            child.kill('SIGTERM');
            reject(new Error(`Early termination: Access denied or region blocked`));
          }
        }, 10000); // 10 second early termination check
      }

      // Progress timeout - kill if no output for specified time
      const resetProgressTimer = () => {
        if (progressTimer) clearTimeout(progressTimer);
        if (options.progressTimeout && !isKilled) {
          progressTimer = setTimeout(() => {
            console.log(`⏱️ No output received for ${options.progressTimeout}ms - killing process`);
            isKilled = true;
            child.kill('SIGTERM');
            reject(new Error(`Process killed due to no output for ${options.progressTimeout}ms`));
          }, options.progressTimeout);
        }
      };

      // Start progress timer
      resetProgressTimer();

      child.stdout.on('data', (data) => {
        if (isKilled) return;

        const output = data.toString();
        stdout += output;
        lastOutputTime = Date.now();

        // Reset progress timer on any output
        resetProgressTimer();

        // Log progress for gallery-dl/yt-dlp - expanded patterns
        if (output.includes('[tiktok]') || output.includes('[download]') || output.includes('ERROR:') ||
            output.includes('[gallery-dl]') || output.includes('[debug]') || output.includes('Starting new') ||
            output.includes('HTTP/1.1') || output.includes('.jpg') || output.includes('.mp4') || output.includes('.mp3')) {
          console.log(`📡 Progress: ${output.trim()}`);
        }

        // Check for immediate failure indicators
        const failurePatterns = ['ERROR: 10222', 'ERROR: 10204', 'ERROR: 10231', 'region', 'blocked'];
        if (failurePatterns.some(pattern => output.toLowerCase().includes(pattern))) {
          console.log(`⚡ Failure pattern detected in output: ${output.trim()}`);
        }
      });

      child.stderr.on('data', (data) => {
        if (isKilled) return;

        stderr += data.toString();
        lastOutputTime = Date.now();

        // Reset progress timer on any output (including stderr)
        resetProgressTimer();
      });

      child.on('close', (code) => {
        if (isKilled) return;

        // Clear all timers
        if (progressTimer) clearTimeout(progressTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (earlyTerminationTimer) clearTimeout(earlyTerminationTimer);

        if (code === 0) {
          console.log(`✅ Command completed successfully`);
          resolve(stdout);
        } else {
          console.log(`❌ Command failed with code ${code}`);
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (error) => {
        if (isKilled) return;

        // Clear all timers
        if (progressTimer) clearTimeout(progressTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (earlyTerminationTimer) clearTimeout(earlyTerminationTimer);

        console.log(`❌ Command error: ${error.message}`);
        reject(error);
      });

      // Set main timeout
      if (options.timeout) {
        timeoutTimer = setTimeout(() => {
          if (!isKilled) {
            console.log(`⏱️ Main timeout reached (${options.timeout}ms) - killing process`);
            isKilled = true;
            child.kill('SIGTERM');
            reject(new Error(`Command timed out after ${options.timeout}ms`));
          }
        }, options.timeout);
      }
    });
  }

  getNextTorProxy() {
    const port = this.torPorts[this.currentTorPortIndex];
    const proxy = `socks5://127.0.0.1:${port}`;
    console.log(`🔄 Using TOR proxy: ${proxy} (port ${this.currentTorPortIndex + 1}/${this.torPorts.length})`);
    return proxy;
  }

  rotateTorProxy() {
    this.requestCount++;
    if (this.requestCount >= this.maxRequestsPerProxy) {
      this.currentTorPortIndex = (this.currentTorPortIndex + 1) % this.torPorts.length;
      this.torProxy = this.getNextTorProxy();
      this.requestCount = 0;
      console.log(`🔄 Rotated to TOR proxy: ${this.torProxy} (reset request count)`);
    }
  }

  forceNewTorCircuit() {
    // Force circuit rotation by switching to next proxy
    this.currentTorPortIndex = (this.currentTorPortIndex + 1) % this.torPorts.length;
    this.torProxy = this.getNextTorProxy();
    this.requestCount = 0;
    console.log(`🔄 Forced new TOR circuit: ${this.torProxy}`);
  }

  getDownloadedFiles(outputDir) {
    try {
      const files = [];
      const items = readdirSync(outputDir, { withFileTypes: true });

      for (const item of items) {
        if (item.isFile()) {
          const fullPath = join(outputDir, item.name);
          // Skip metadata files and archives
          if (!item.name.endsWith('.info.json') &&
              !item.name.endsWith('.description') &&
              !item.name.includes('archive.txt')) {
            files.push(fullPath);
          }
        } else if (item.isDirectory()) {
          // Recursively check subdirectories
          const subFiles = this.getDownloadedFiles(join(outputDir, item.name));
          files.push(...subFiles);
        }
      }

      return files;
    } catch (error) {
      console.log(`⚠️ Error reading downloaded files from ${outputDir}: ${error.message}`);
      return [];
    }
  }
}

// Frame serving is now handled by the main API server at port 3001

export { UltimateOrchestrator };

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node ultimate-orchestrator.js <social-media-url>');
    process.exit(1);
  }

  const orchestrator = new UltimateOrchestrator();

  orchestrator.analyze(url)
    .then(result => {
      console.log('\n📊 Analysis Results:');
      console.log('===================');
      console.log(`Platform: ${result.platform}`);
      console.log(`Duration: ${result.duration}ms`);
      console.log(`\nAI Analysis:\n${result.aiAnalysis}`);
    })
    .catch(error => {
      console.error('❌ Analysis failed:', error.message);
      process.exit(1);
    });
}
