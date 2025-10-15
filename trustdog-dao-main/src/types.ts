/**
 * Shared type definitions for TrustDog Worker
 */

import { createClient } from '@supabase/supabase-js'
import { AuthContext } from './middleware/auth'

// Environment interface
export interface Env {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  SUPABASE_JWT_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  QWEN_API_KEY: string
  QWEN_URL: string
  QWEN_MODEL: string
  DASHSCOPE_API_KEY: string
  DASHSCOPE_URL: string
  DASHSCOPE_VIDEO_MODEL: string
  BROWSERLESS_TOKEN: string
  JWT_SECRET: string
  SESSIONS: KVNamespace
  RATE_LIMITS: KVNamespace
  TEST_RESULTS_KV: KVNamespace
  ENVIRONMENT: string
  CORS_ORIGIN: string
  ORCHESTRATOR_ENABLED: string
  ORCHESTRATOR_URL: string
  ORCHESTRATOR_API_KEY: string
  TRUSTDOG_CALLBACK_TOKEN: string
  WORKER_BASE_URL: string
  HITL_ENABLED: string
  HITL_EMAIL_FROM: string
  HITL_ADMIN_EMAILS: string
  RESEND_API_KEY: string
}

// Hono context type that all apps and routers should use
export type HonoContext = {
  Bindings: Env
  Variables: {
    supabase: ReturnType<typeof createClient>
    user?: AuthContext
  }
}