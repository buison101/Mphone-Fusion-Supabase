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
  const eventType = body.event_type === 'ended' ? 'ended' : 'started'
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

  const numberValue = (key: string) => {
    const value = Number(body[key] ?? 0)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  const hangupCause = typeof body.hangup_cause === 'string' ? body.hangup_cause.trim().slice(0, 64) : ''
  const startEpoch = numberValue('start_epoch')
  const answerEpoch = numberValue('answer_epoch')
  const endEpoch = numberValue('end_epoch')
  const duration = numberValue('duration')
  const billsec = numberValue('billsec')
  const status = eventType === 'started' ? 'ringing' : normalizeStatus(hangupCause, billsec, answerEpoch)
  const occurredAt = new Date((eventType === 'ended' && endEpoch > 0 ? endEpoch : startEpoch > 0 ? startEpoch : Math.floor(Date.now() / 1000)) * 1000).toISOString()
  const startedAt = new Date((startEpoch > 0 ? startEpoch : Math.floor(Date.now() / 1000)) * 1000).toISOString()

  const database = postgres(requiredEnv('SUPABASE_DB_URL'), { max: 1 })
  try {
    if (eventType === 'started') {
      await database`
        insert into public.mphone_forward_calls
          (event_id, extension_uuid, extension, caller_number, dialed_number,
           forward_destination, status, started_at, updated_at)
        values
          (${eventId}, ${extensionUuid}::uuid, ${extension}, ${callerNumber}, ${dialedNumber},
           ${forwardDestination}, 'ringing', ${occurredAt}::timestamptz, now())
        on conflict (event_id) do update set
          caller_number = excluded.caller_number,
          dialed_number = excluded.dialed_number,
          forward_destination = excluded.forward_destination,
          updated_at = now()
        where public.mphone_forward_calls.ended_at is null
      `
    } else {
      await database`
        insert into public.mphone_forward_calls
          (event_id, extension_uuid, extension, caller_number, dialed_number,
           forward_destination, status, started_at, answered_at, ended_at,
           duration, billsec, hangup_cause, updated_at)
        values
          (${eventId}, ${extensionUuid}::uuid, ${extension}, ${callerNumber}, ${dialedNumber},
           ${forwardDestination}, ${status},
           ${startEpoch > 0 ? new Date(startEpoch * 1000).toISOString() : occurredAt}::timestamptz,
           ${answerEpoch > 0 ? new Date(answerEpoch * 1000).toISOString() : null}::timestamptz,
           ${occurredAt}::timestamptz, ${duration}, ${billsec}, ${hangupCause}, now())
        on conflict (event_id) do update set
          status = excluded.status,
          answered_at = excluded.answered_at,
          ended_at = excluded.ended_at,
          duration = excluded.duration,
          billsec = excluded.billsec,
          hangup_cause = excluded.hangup_cause,
          updated_at = now()
      `
    }

    const devices = eventType === 'started'
      ? await database<{ fcm_token: string; device_id: string; user_uuid: string }[]>`
          select distinct fcm_token, device_id, user_uuid::text
          from public.mphone_push_devices
          where extension_uuid = ${extensionUuid}::uuid
            and notifications_enabled = true
        `
      : await database<{ fcm_token: string; device_id: string; user_uuid: string }[]>`
          select distinct devices.fcm_token, devices.device_id, recipients.user_uuid::text
          from public.mphone_forward_call_devices recipients
          join public.mphone_push_devices devices
            on devices.extension_uuid = recipients.extension_uuid
           and devices.device_id = recipients.device_id
          where recipients.event_id = ${eventId}
        `
    if (eventType === 'started' && devices.length > 0) {
      for (const device of devices) {
        await database`
          insert into public.mphone_forward_call_devices
            (event_id, device_id, user_uuid, extension_uuid)
          values
            (${eventId}, ${device.device_id}, ${device.user_uuid}::uuid, ${extensionUuid}::uuid)
          on conflict (event_id, device_id) do nothing
        `
      }
    }
    const event = {
      eventType,
      eventId,
      callerNumber,
      dialedNumber,
      extension,
      forwardDestination,
      status,
      occurredAt,
      startedAt,
      duration,
      billsec,
    }
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

function normalizeStatus(hangupCause: string, billsec: number, answerEpoch: number) {
  if (billsec > 0 || answerEpoch > 0) return 'completed'
  switch (hangupCause.toUpperCase()) {
    case 'USER_BUSY': return 'busy'
    case 'NO_ANSWER':
    case 'NO_USER_RESPONSE': return 'no_answer'
    case 'CALL_REJECTED': return 'rejected'
    case 'ORIGINATOR_CANCEL': return 'cancelled'
    case 'NORMAL_CLEARING': return 'cancelled'
    default: return 'failed'
  }
}
