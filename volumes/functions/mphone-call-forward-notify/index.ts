import postgres from 'npm:postgres@3.4.7'
import { isUuid } from '../_shared/mphone-auth.ts'
import { sendForwardNotification } from '../_shared/firebase.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const requiredEnv = (name: string) => {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}
const internalSecret = () => requiredEnv('MPHONE_PUSH_SECRET')

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  const supplied = req.headers.get('x-mphone-push-secret') ?? ''
  if (!supplied || supplied !== internalSecret()) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  const extensionUuid = body.extension_uuid
  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : ''
  const callerNumber = typeof body.caller_number === 'string' ? body.caller_number.trim() : ''
  const dialedNumber = typeof body.dialed_number === 'string' ? body.dialed_number.trim() : ''
  const extension = typeof body.extension === 'string' ? body.extension.trim() : ''
  const forwardDestination = typeof body.forward_destination === 'string'
    ? body.forward_destination.trim()
    : ''
  if (!isUuid(extensionUuid) || !eventId || !callerNumber || !dialedNumber || !extension || !forwardDestination) {
    return jsonResponse({ error: 'Invalid call-forward event' }, 400)
  }

  const database = postgres(requiredEnv('SUPABASE_DB_URL'), { max: 1 })
  try {
    const devices = await database<{ fcm_token: string }[]>`
      select distinct fcm_token
      from public.mphone_push_devices
      where extension_uuid = ${extensionUuid}::uuid
        and notifications_enabled = true
    `
    const event = { eventId, callerNumber, dialedNumber, extension, forwardDestination }
    const results = await Promise.all(devices.map((device) =>
      sendForwardNotification(device.fcm_token, event)
    ))
    const sent = results.filter((result) => result.ok).length
    const invalidTokens = results.flatMap((result, index) => {
      const status = result.payload?.error?.details?.[0]?.errorCode
      return status === 'UNREGISTERED' ? [devices[index].fcm_token] : []
    })
    for (const invalidToken of invalidTokens) {
      await database`delete from public.mphone_push_devices where fcm_token = ${invalidToken}`
    }
    return jsonResponse({ devices: devices.length, sent })
  } catch (error) {
    console.error('Call-forward push failed', error)
    return jsonResponse({ error: 'Unable to send call-forward push' }, 502)
  } finally {
    await database.end({ timeout: 1 })
  }
})
