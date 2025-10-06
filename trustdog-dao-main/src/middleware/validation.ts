/**
 * Input validation middleware for TrustDog Worker
 * Validates request payloads against schemas
 */

import { Context, Next } from 'hono'

export interface ValidationSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array'
    required?: boolean
    minLength?: number
    maxLength?: number
    min?: number
    max?: number
    pattern?: RegExp
    enum?: (string | number)[]
  }
}

export const validateSchema = (schema: ValidationSchema) => {
  return async (c: Context, next: Next) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const errors: string[] = []

      // Validate each field in the schema
      for (const [field, rules] of Object.entries(schema)) {
        const value = body[field]

        // Check required fields
        if (rules.required && (value === undefined || value === null || value === '')) {
          errors.push(`${field} is required`)
          continue
        }

        // Skip validation if field is not required and not provided
        if (!rules.required && (value === undefined || value === null)) {
          continue
        }

        // Type validation
        if (rules.type === 'string' && typeof value !== 'string') {
          errors.push(`${field} must be a string`)
          continue
        }

        if (rules.type === 'number' && typeof value !== 'number') {
          errors.push(`${field} must be a number`)
          continue
        }

        if (rules.type === 'boolean' && typeof value !== 'boolean') {
          errors.push(`${field} must be a boolean`)
          continue
        }

        if (rules.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
          errors.push(`${field} must be an object`)
          continue
        }

        if (rules.type === 'array' && !Array.isArray(value)) {
          errors.push(`${field} must be an array`)
          continue
        }

        // String validations
        if (rules.type === 'string' && typeof value === 'string') {
          if (rules.minLength && value.length < rules.minLength) {
            errors.push(`${field} must be at least ${rules.minLength} characters`)
          }

          if (rules.maxLength && value.length > rules.maxLength) {
            errors.push(`${field} must be no more than ${rules.maxLength} characters`)
          }

          if (rules.pattern && !rules.pattern.test(value)) {
            errors.push(`${field} format is invalid`)
          }

          if (rules.enum && !rules.enum.includes(value)) {
            errors.push(`${field} must be one of: ${rules.enum.join(', ')}`)
          }
        }

        // Number validations
        if (rules.type === 'number' && typeof value === 'number') {
          if (rules.min !== undefined && value < rules.min) {
            errors.push(`${field} must be at least ${rules.min}`)
          }

          if (rules.max !== undefined && value > rules.max) {
            errors.push(`${field} must be no more than ${rules.max}`)
          }

          if (rules.enum && !rules.enum.includes(value)) {
            errors.push(`${field} must be one of: ${rules.enum.join(', ')}`)
          }
        }
      }

      if (errors.length > 0) {
        return c.json({ error: 'Validation failed', details: errors }, 400)
      }

      await next()
    } catch (error) {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }
  }
}

// Common validation schemas
export const createDealSchema: ValidationSchema = {
  account_url: {
    type: 'string',
    required: true,
    minLength: 10,
    maxLength: 500,
    pattern: /^https?:\/\/.+/,
  },
  platform: {
    type: 'string',
    required: true,
    enum: ['tiktok', 'instagram', 'youtube', 'x', 'twitter', 'twitch', 'kick', 'facebook', 'linkedin', 'reddit'],
  },
  amount_usd: {
    type: 'number',
    required: true,
    min: 5,
    max: 10000,
  },
  deadline_iso: {
    type: 'string',
    required: true,
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,
  },
  proof_spec: {
    type: 'object',
    required: true,
  },
  public_opt_in: {
    type: 'boolean',
    required: false,
  },
}

export const contactMessageSchema: ValidationSchema = {
  to_account_url: {
    type: 'string',
    required: true,
    minLength: 10,
    maxLength: 500,
  },
  subject: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 200,
  },
  message: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 2000,
  },
  deal_id: {
    type: 'string',
    required: false,
  },
}

// Simple validation middleware for common cases
export const validateMiddleware = validateSchema({
  // Default empty schema - specific routes will use their own
})

// URL validation helper
export const isValidUrl = (url: string): boolean => {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

// Platform URL validation
export const isValidPlatformUrl = (url: string, platform: string): boolean => {
  if (!isValidUrl(url)) return false

  try {
    const domain = new URL(url).hostname.toLowerCase()

    switch (platform) {
      case 'tiktok':
        return domain.includes('tiktok.com')
      case 'instagram':
        return domain.includes('instagram.com')
      case 'youtube':
        return domain.includes('youtube.com') || domain.includes('youtu.be')
      case 'x':
      case 'twitter':
        return domain.includes('twitter.com') || domain.includes('x.com')
      case 'twitch':
        return domain.includes('twitch.tv')
      case 'kick':
        return domain.includes('kick.com')
      case 'facebook':
        return domain.includes('facebook.com') || domain.includes('fb.com')
      case 'linkedin':
        return domain.includes('linkedin.com')
      case 'reddit':
        return domain.includes('reddit.com')
      default:
        return false
    }
  } catch {
    return false
  }
}