/**
 * Admin API routes for TrustDog Worker
 * Handle admin operations like seeding demo accounts
 */

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { type HonoContext } from '../types'

const app = new Hono<HonoContext>()

// Seed demo accounts (for development/demo)
app.post('/seed-demo-accounts', async (c) => {
  try {
    // Use service role to create demo users
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

    console.log('🌱 Seeding demo accounts...')

    const demoAccounts = [
      {
        email: 'advertiser@demo.com',
        password: 'demo123',
        role: 'advertiser',
        id: '11111111-1111-1111-1111-111111111111'
      },
      {
        email: 'creator@demo.com',
        password: 'demo123',
        role: 'creator',
        id: '22222222-2222-2222-2222-222222222222'
      }
    ]

    const results = []

    for (const account of demoAccounts) {
      try {
        // Create auth user
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email: account.email,
          password: account.password,
          email_confirm: true, // Skip email confirmation
          user_metadata: {
            role: account.role
          }
        })

        if (authError) {
          console.error(`Failed to create auth user ${account.email}:`, authError)
          results.push({ email: account.email, status: 'auth_failed', error: authError.message })
          continue
        }

        // Create identity record
        const { data: identity, error: identityError } = await supabaseAdmin
          .from('identities')
          .upsert({
            id: authUser.user.id,
            type: 'email',
            email: account.email,
            role: account.role
          })
          .select()
          .single()

        if (identityError) {
          console.error(`Failed to create identity ${account.email}:`, identityError)
          results.push({ email: account.email, status: 'identity_failed', error: identityError.message })
        } else {
          console.log(`✅ Created demo account: ${account.email}`)
          results.push({
            email: account.email,
            status: 'success',
            user_id: authUser.user.id,
            identity_id: identity.id
          })
        }

      } catch (error) {
        console.error(`Error creating demo account ${account.email}:`, error)
        results.push({
          email: account.email,
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return c.json({
      success: true,
      message: 'Demo account seeding completed',
      results
    })

  } catch (error) {
    console.error('🌱 Demo seeding error:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to seed demo accounts'
    }, 500)
  }
})

// Health check for admin endpoints
app.get('/health', (c) => {
  return c.json({ status: 'admin_healthy', timestamp: new Date().toISOString() })
})

export const adminRouter = app