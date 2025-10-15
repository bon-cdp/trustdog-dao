/**
 * Authentication middleware for TrustDog Worker
 * Handles session cookies and JWT validation
 */

import { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { jwtVerify } from 'jose'
import { createClient } from '@supabase/supabase-js'

export interface AuthContext {
  id: string
  email?: string
  role: string
  exp: number
}

export const authMiddleware = async (c: Context, next: Next) => {
  try {
    // Get session from cookie or Authorization header
    const authHeader = c.req.header('Authorization')
    const sessionToken = getCookie(c, 'session') ||
      (authHeader ? authHeader.replace('Bearer ', '') : null)

    console.log('🔐 Auth middleware debug:', {
      hasCookieSession: !!getCookie(c, 'session'),
      hasAuthHeader: !!authHeader,
      authHeaderValue: authHeader || 'none',
      tokenLength: sessionToken?.length || 0,
      tokenPrefix: sessionToken?.substring(0, 20) || 'none'
    })

    // Check for null, empty, or "null" string tokens
    if (!sessionToken || sessionToken === 'null' || sessionToken === 'undefined' || sessionToken.trim() === '') {
      console.log('🔐 Auth failed: No valid token provided (token was:', sessionToken, ')')
      return c.json({ error: 'Authentication required' }, 401)
    }

    // Create admin client for JWT validation
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

    console.log('🔐 About to verify JWT manually with jose library')

    // Decode JWT header to inspect kid
    const jwtParts = sessionToken.split('.')
    const headerBase64 = jwtParts[0]
    const headerJson = atob(headerBase64.replace(/-/g, '+').replace(/_/g, '/'))
    const header = JSON.parse(headerJson)

    console.log('🔐 JWT Header:', {
      alg: header.alg,
      kid: header.kid,
      typ: header.typ
    })

    let jwtPayload
    try {
      // HS256 tokens use shared secret, not public key verification
      // Try different possible secrets - Supabase JWT secret, anon key, or custom JWT secret
      const possibleSecrets = [
        c.env.SUPABASE_JWT_SECRET,
        c.env.SUPABASE_ANON_KEY,
        c.env.JWT_SECRET
      ].filter(Boolean)

      console.log('🔐 Available secrets:', {
        hasSupabaseJwtSecret: !!c.env.SUPABASE_JWT_SECRET,
        hasSupabaseAnonKey: !!c.env.SUPABASE_ANON_KEY,
        hasJwtSecret: !!c.env.JWT_SECRET,
        secretCount: possibleSecrets.length
      })

      // Use the correct Supabase JWT secret for HS256 verification
      const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET)

      console.log('🔐 Verifying HS256 JWT with secret:', {
        hasJwtSecret: !!c.env.SUPABASE_JWT_SECRET,
        hasAnonKey: !!c.env.SUPABASE_ANON_KEY,
        secretLength: secret.length,
        expectedIssuer: `${c.env.SUPABASE_URL}/auth/v1`,
        supabaseUrl: c.env.SUPABASE_URL
      })

      const { payload } = await import('jose').then(m => m.jwtVerify(sessionToken, secret, {
        issuer: `${c.env.SUPABASE_URL}/auth/v1`,
        audience: 'authenticated'
      }))

      console.log('🔐 JWT verification successful:', {
        sub: payload.sub,
        email: payload.email,
        exp: payload.exp,
        aud: payload.aud,
        iss: payload.iss
      })

      jwtPayload = payload

    } catch (jwtError) {
      console.log('🔐 JWT verification failed:', {
        error: jwtError instanceof Error ? jwtError.message : String(jwtError),
        errorName: jwtError instanceof Error ? jwtError.name : 'Unknown',
        errorStack: jwtError instanceof Error ? jwtError.stack : 'No stack',
        tokenLength: sessionToken.length,
        tokenPrefix: sessionToken.substring(0, 20),
        supabaseUrl: c.env.SUPABASE_URL,
        hasJwtSecret: !!c.env.SUPABASE_JWT_SECRET,
        hasAnonKey: !!c.env.SUPABASE_ANON_KEY
      })
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    // Create user object from JWT payload
    const user = {
      id: jwtPayload.sub as string,
      email: jwtPayload.email as string,
      exp: jwtPayload.exp as number
    }

    // Get user identity from database, create if doesn't exist (using the same admin client)
    let { data: identity } = await supabaseAdmin
      .from('identities')
      .select('*')
      .eq('id', user.id)
      .single()

    if (!identity) {
      // Auto-create identity for authenticated users using service role
      console.log('Creating identity for authenticated user:', user.id, user.email)

      // Use service role client for identity creation (bypasses RLS) - already created above

      // Try to insert only if it doesn't exist
      const { data: newIdentity, error: identityError } = await supabaseAdmin
        .from('identities')
        .insert({
          id: user.id,
          type: 'email',
          email: user.email,
          role: 'advertiser' // Default role for new users
        })
        .select()
        .single()

      if (identityError && identityError.code !== '23505') { // 23505 is unique constraint violation
        console.error('Failed to create identity:', identityError)
        return c.json({ error: 'Failed to create user identity' }, 500)
      }

      if (identityError && identityError.code === '23505') {
        // Identity already exists, fetch it again
        const { data: existingIdentity } = await supabaseAdmin
          .from('identities')
          .select('*')
          .eq('id', user.id)
          .single()
        identity = existingIdentity
      } else {
        identity = newIdentity
      }

      console.log('Identity created/found for user:', user.id, 'with role:', identity?.role)
    }

    // Set user context
    c.set('user', {
      id: user.id,
      email: user.email,
      role: identity.role,
      exp: user.exp || Math.floor(Date.now() / 1000) + 3600
    })

    await next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    return c.json({ error: 'Authentication failed' }, 401)
  }
}

export const requireRole = (requiredRole: string) => {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as AuthContext

    if (!user) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    if (user.role !== requiredRole && user.role !== 'admin') {
      return c.json({ error: 'Insufficient permissions' }, 403)
    }

    await next()
  }
}

export const requireAnyRole = (roles: string[]) => {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as AuthContext

    if (!user) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    if (!roles.includes(user.role) && user.role !== 'admin') {
      return c.json({ error: 'Insufficient permissions' }, 403)
    }

    await next()
  }
}