import postgres from 'npm:postgres@3.4.7'
import { sessionUserUuid } from '../_shared/mphone-auth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
}
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
const requiredEnv = (name: string) => {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const userUuid = await sessionUserUuid(req)
  if (!userUuid) return jsonResponse({ error: 'Invalid or expired session' }, 401)

  const url = new URL(req.url)
  const deviceId = url.searchParams.get('device_id')?.trim() ?? ''
  if (!deviceId || deviceId.length > 255) return jsonResponse({ error: 'Invalid device' }, 400)

  const requestedLimit = Number(url.searchParams.get('limit') ?? 100)
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100, 200))
  const supabase = postgres(requiredEnv('SUPABASE_DB_URL'), { max: 1 })
  try {
    if (req.method === 'DELETE') {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400)
      }
      const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : ''
      const deleteAll = body.all === true
      if (!deleteAll && (!eventId || eventId.length > 255)) {
        return jsonResponse({ error: 'Invalid event' }, 400)
      }
      const result = deleteAll
        ? await supabase`
            update public.mphone_forward_call_devices
            set deleted_at = now()
            where device_id = ${deviceId}
              and user_uuid = ${userUuid}::uuid
              and deleted_at is null
            returning event_id
          `
        : await supabase`
            update public.mphone_forward_call_devices
            set deleted_at = now()
            where event_id = ${eventId}
              and device_id = ${deviceId}
              and user_uuid = ${userUuid}::uuid
              and deleted_at is null
            returning event_id
          `
      return jsonResponse({ deleted: result.length > 0 })
    }

    const calls = await supabase`
      select calls.event_id, calls.extension_uuid::text, calls.extension,
             calls.caller_number, calls.dialed_number, calls.forward_destination,
             calls.status, calls.started_at, calls.answered_at, calls.ended_at,
             calls.duration, calls.billsec, calls.hangup_cause
      from public.mphone_forward_calls calls
      join public.mphone_forward_call_devices recipients
        on recipients.event_id = calls.event_id
      where recipients.user_uuid = ${userUuid}::uuid
        and recipients.device_id = ${deviceId}
        and recipients.deleted_at is null
      order by calls.started_at desc
      limit ${limit}
    `
    return jsonResponse({ calls })
  } catch (error) {
    console.error('Forward call history failed', error)
    return jsonResponse({ error: 'Unable to load forward call history' }, 502)
  } finally {
    await supabase.end({ timeout: 1 })
  }
})
