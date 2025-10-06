/**
 * Rate limiting middleware for TrustDog Worker
 * Uses Cloudflare KV for distributed rate limiting
 */

import { Context, Next } from 'hono'
import { type HonoContext } from '../types'

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
  keyGenerator?: (c: Context) => string
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60 * 1000, // 1 minute
}

export const rateLimitMiddleware = (config: Partial<RateLimitConfig> = {}) => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config }

  return async (c: Context<HonoContext>, next: Next) => {
    const rateLimits = c.env.RATE_LIMITS as KVNamespace

    if (!rateLimits) {
      console.warn('Rate limiting disabled: KV namespace not available')
      await next()
      return
    }

    // Generate rate limit key
    const key = finalConfig.keyGenerator
      ? finalConfig.keyGenerator(c)
      : getDefaultKey(c)

    const now = Date.now()
    const windowStart = Math.floor(now / finalConfig.windowMs) * finalConfig.windowMs

    try {
      // Get current count
      const currentCountStr = await rateLimits.get(`${key}:${windowStart}`)
      const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0

      if (currentCount >= finalConfig.maxRequests) {
        return c.json(
          {
            error: 'Too many requests',
            retryAfter: Math.ceil((windowStart + finalConfig.windowMs - now) / 1000),
          },
          429
        )
      }

      // Increment count
      await rateLimits.put(
        `${key}:${windowStart}`,
        String(currentCount + 1),
        {
          expirationTtl: Math.ceil(finalConfig.windowMs / 1000) + 10, // Add buffer
        }
      )

      // Set rate limit headers
      c.header('X-RateLimit-Limit', String(finalConfig.maxRequests))
      c.header('X-RateLimit-Remaining', String(finalConfig.maxRequests - currentCount - 1))
      c.header('X-RateLimit-Reset', String(Math.ceil((windowStart + finalConfig.windowMs) / 1000)))

      await next()
    } catch (error) {
      console.error('Rate limit error:', error)
      // Fail open - don't block requests if rate limiting fails
      await next()
    }
  }
}

const getDefaultKey = (c: Context<HonoContext>): string => {
  // Use IP address from CF-Connecting-IP header, fallback to other headers
  const ip =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0] ||
    c.req.header('X-Real-IP') ||
    'unknown'

  // Include user ID if authenticated for more granular limiting
  const user = c.get('user')
  if (user?.id) {
    return `user:${user.id}`
  }

  return `ip:${ip}`
}

// Stricter rate limiting for expensive operations
export const strictRateLimit = rateLimitMiddleware({
  maxRequests: 10,
  windowMs: 60 * 1000, // 1 minute
})

// More permissive for public endpoints
export const publicRateLimit = rateLimitMiddleware({
  maxRequests: 100,
  windowMs: 60 * 1000, // 1 minute
})