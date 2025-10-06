/**
 * Cron handler for TrustDog Worker
 * Schedules and manages verification jobs + HITL notifications
 */

import { Context } from 'hono'
import { HITLService } from '../hitl'

export const cronHandler = async (c: Context) => {
  try {
    console.log('Cron job triggered at:', new Date().toISOString())

    // Process HITL notifications
    if (c.env.HITL_ENABLED === 'true') {
      try {
        console.log('Processing HITL notifications...')
        const hitlService = new HITLService(c.env)
        await hitlService.processNotifications()
        console.log('✅ HITL notifications processed')
      } catch (hitlError) {
        console.error('❌ HITL notification processing failed:', hitlError)
      }
    } else {
      console.log('HITL processing disabled')
    }

    return c.json({
      success: true,
      hitl_processed: c.env.HITL_ENABLED === 'true',
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    console.error('Cron job error:', error)
    return c.json({
      error: error.message || 'Cron job failed',
      timestamp: new Date().toISOString()
    }, 500)
  }
}