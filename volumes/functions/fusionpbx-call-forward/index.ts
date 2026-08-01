import { jwtVerify } from 'jsr:@panva/jose@6'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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

const sessionUserUuid = async (req: Request) => {
  const authorization = req.headers.get('authorization') ?? ''
  const [scheme, token] = authorization.split(' ')
  if (scheme.toLowerCase() !== 'bearer' || !token) return null

  try {
    const secret = new TextEncoder().encode(requiredEnv('JWT_SECRET'))
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'mphone-fusionpbx',
      audience: 'authenticated',
    })
    return typeof payload.user_uuid === 'string' ? payload.user_uuid : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const userUuid = await sessionUserUuid(req)
  if (!userUuid) {
    return jsonResponse({ error: 'Invalid or expired session' }, 401)
  }

  const requestUrl = new URL(req.url)
  const extensionUuid = requestUrl.searchParams.get('extension_uuid')?.trim() ?? ''
  const mode = requestUrl.searchParams.get('mode') === 'advanced' ? 'advanced' : 'basic'
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(extensionUuid)) {
    return jsonResponse({ error: 'Invalid extension_uuid' }, 400)
  }

  const internalUrl = new URL(
    Deno.env.get('FUSIONPBX_CALL_FORWARD_URL') ??
      'http://192.168.1.201/app/mphone_api/call_forward.php',
  )
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Host': 'fusionpbx',
    'X-Mphone-Session': req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
  }
  const serviceSecret = Deno.env.get('MPHONE_API_SECRET') ?? ''
  if (serviceSecret) headers['X-Mphone-Api-Key'] = serviceSecret

  let body: string | undefined
  if (req.method === 'GET') {
    internalUrl.searchParams.set('user_uuid', userUuid)
    internalUrl.searchParams.set('extension_uuid', extensionUuid)
    internalUrl.searchParams.set('mode', mode)
  } else {
    let settings: Record<string, unknown>
    try {
      settings = await req.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    body = JSON.stringify({ ...settings, user_uuid: userUuid, extension_uuid: extensionUuid })
  }

  try {
    const response = await fetch(internalUrl, {
      method: req.method,
      headers,
      body,
    })
    const payload = await response.text()
    return new Response(payload, {
      status: response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('FusionPBX call-forward request failed', error)
    return jsonResponse({ error: 'Unable to reach FusionPBX' }, 502)
  }
})
