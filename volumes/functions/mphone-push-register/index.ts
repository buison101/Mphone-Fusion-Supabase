import postgres from 'npm:postgres@3.4.7'
import { isUuid, sessionUserUuid } from '../_shared/mphone-auth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const userUuid = await sessionUserUuid(req)
  if (!userUuid || !isUuid(userUuid)) return jsonResponse({ error: 'Invalid or expired session' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : ''
  const fcmToken = typeof body.fcm_token === 'string' ? body.fcm_token.trim() : ''
  const extensionUuid = body.extension_uuid
  const enabled = body.enabled !== false
  const locale = typeof body.locale === 'string' ? body.locale.slice(0, 16) : 'vi'
  if (!deviceId || deviceId.length > 255 || !fcmToken || fcmToken.length > 4096 || !isUuid(extensionUuid)) {
    return jsonResponse({ error: 'Invalid device registration' }, 400)
  }

  const fusion = postgres(requiredEnv('FUSIONPBX_DATABASE_URL'), { max: 1 })
  const supabase = postgres(requiredEnv('SUPABASE_DB_URL'), { max: 1 })
  try {
    const owned = await fusion`
      select 1
      from v_extension_users
      where user_uuid = ${userUuid}::uuid and extension_uuid = ${extensionUuid}::uuid
      limit 1
    `
    if (owned.length === 0) return jsonResponse({ error: 'Extension is not assigned to user' }, 403)

    await supabase`
      insert into public.mphone_push_devices
        (user_uuid, extension_uuid, device_id, fcm_token, notifications_enabled, locale, updated_at)
      values
        (${userUuid}::uuid, ${extensionUuid}::uuid, ${deviceId}, ${fcmToken}, ${enabled}, ${locale}, now())
      on conflict (extension_uuid, device_id) do update set
        user_uuid = excluded.user_uuid,
        fcm_token = excluded.fcm_token,
        notifications_enabled = excluded.notifications_enabled,
        locale = excluded.locale,
        updated_at = now()
    `
    return jsonResponse({ registered: true, enabled })
  } catch (error) {
    console.error('Push device registration failed', error)
    return jsonResponse({ error: 'Unable to register device' }, 502)
  } finally {
    await Promise.allSettled([fusion.end({ timeout: 1 }), supabase.end({ timeout: 1 })])
  }
})

