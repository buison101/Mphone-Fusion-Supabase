import { importPKCS8, SignJWT } from 'jsr:@panva/jose@6'

type ServiceAccount = {
  project_id: string
  client_email: string
  private_key: string
  token_uri: string
}

let cachedServiceAccount: ServiceAccount | null = null
let cachedAccessToken = ''
let accessTokenExpiresAt = 0

const serviceAccount = async () => {
  if (cachedServiceAccount) return cachedServiceAccount
  const raw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON')
  const parsed = JSON.parse(raw) as ServiceAccount
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key || !parsed.token_uri) {
    throw new Error('Invalid Firebase service account')
  }
  cachedServiceAccount = parsed
  return parsed
}

const accessToken = async () => {
  const now = Math.floor(Date.now() / 1000)
  if (cachedAccessToken && accessTokenExpiresAt > now + 60) return cachedAccessToken

  const account = await serviceAccount()
  const key = await importPKCS8(account.private_key, 'RS256')
  const assertion = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setAudience(account.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key)

  const response = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const payload = await response.json()
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new Error(`Unable to obtain Firebase access token (${response.status})`)
  }
  cachedAccessToken = payload.access_token
  accessTokenExpiresAt = now + Number(payload.expires_in ?? 3600)
  return cachedAccessToken
}

export type ForwardNotification = {
  eventType: 'started' | 'ended'
  eventId: string
  callerNumber: string
  dialedNumber: string
  extension: string
  forwardDestination: string
  status: string
  occurredAt: string
  startedAt: string
  duration: number
  billsec: number
}

export const sendForwardNotification = async (token: string, event: ForwardNotification) => {
  const account = await serviceAccount()
  const authorization = await accessToken()
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authorization}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          data: {
            mphone_event: event.eventType === 'ended' ? 'call_forward_ended' : 'call_forward_started',
            event_type: event.eventType,
            event_id: event.eventId,
            caller_number: event.callerNumber,
            dialed_number: event.dialedNumber,
            extension: event.extension,
            forward_destination: event.forwardDestination,
            status: event.status,
            occurred_at: event.occurredAt,
            started_at: event.startedAt,
            duration: String(event.duration),
            billsec: String(event.billsec),
          },
          android: {
            priority: 'high',
            collapse_key: event.eventId,
            ttl: event.eventType === 'ended' ? '3600s' : '120s',
          },
        },
      }),
    },
  )
  const payload = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, payload }
}
