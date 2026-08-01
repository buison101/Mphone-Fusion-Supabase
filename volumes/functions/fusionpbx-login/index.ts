import bcryptjs from 'https://esm.sh/bcryptjs@2.4.3?target=deno'
import { SignJWT } from 'jsr:@panva/jose@6'
import postgres from 'npm:postgres@3.4.7'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type LoginRequest = {
  username?: unknown
  password?: unknown
}

type FusionUser = {
  user_uuid: string
  username: string
  password_hash: string
  user_email: string | null
  user_enabled: string | null
}

type FusionExtension = {
  extension_uuid: string
  extension: string
  sip_password: string
  domain: string
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })

const getRequiredEnv = (name: string) => {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Missing environment variable ${name}`)
  }

  return value
}

const createFusionClient = () =>
  postgres(getRequiredEnv('FUSIONPBX_DATABASE_URL'), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 2,
  })

const createSessionToken = async (user: FusionUser) => {
  const secret = new TextEncoder().encode(getRequiredEnv('JWT_SECRET'))
  return await new SignJWT({
    role: 'authenticated',
    user_uuid: user.user_uuid,
    username: user.username,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('mphone-fusionpbx')
    .setAudience('authenticated')
    .setSubject(user.user_uuid)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret)
}

const parseLoginRequest = async (req: Request) => {
  let body: LoginRequest

  try {
    body = await req.json()
  } catch {
    return null
  }

  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    return null
  }

  const username = body.username.trim()

  if (!username || !body.password) {
    return null
  }

  return {
    username,
    password: body.password,
  }
}

const normalizeBcryptHash = (hash: string) => {
  if (hash.startsWith('$2y$')) {
    return `$2b$${hash.slice(4)}`
  }

  return hash
}

const isEnabled = (value: string | null) => value?.toLowerCase() === 'true'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const login = await parseLoginRequest(req)

  if (!login) {
    return jsonResponse({ error: 'Missing username or password' }, 400)
  }

  console.info(`FusionPBX login attempt for username: ${login.username}`)

  let fusionClient: ReturnType<typeof postgres> | null = null

  try {
    fusionClient = createFusionClient()

    const users = await fusionClient<FusionUser[]>`
        select
          user_uuid::text as user_uuid,
          username,
          password as password_hash,
          user_email,
          user_enabled::text as user_enabled
        from v_users
        where username = ${login.username}
        limit 1
      `

    const user = users[0]

    if (!user || !isEnabled(user.user_enabled)) {
      console.warn(`FusionPBX login rejected for username: ${login.username}`)
      return jsonResponse({ error: 'Invalid username or password' }, 401)
    }

    const passwordMatches = bcryptjs.compareSync(
      login.password,
      normalizeBcryptHash(user.password_hash)
    )

    if (!passwordMatches) {
      console.warn(`FusionPBX login rejected for user_uuid: ${user.user_uuid}`)
      return jsonResponse({ error: 'Invalid username or password' }, 401)
    }

    const extensions = await fusionClient<FusionExtension[]>`
        select
          e.extension_uuid::text as extension_uuid,
          e.extension,
          e.password as sip_password,
          d.domain_name as domain
        from v_users u
        join v_extension_users eu
          on eu.user_uuid = u.user_uuid
        join v_extensions e
          on e.extension_uuid = eu.extension_uuid
        join v_domains d
          on d.domain_uuid = e.domain_uuid
        where u.user_uuid = ${user.user_uuid}
          and e.enabled::text = 'true'
        order by e.extension
      `

    console.info(
      `FusionPBX login succeeded for user_uuid: ${user.user_uuid}, extensions: ${extensions.length}`
    )

    const accessToken = await createSessionToken(user)

    return jsonResponse({
      access_token: accessToken,
      expires_in: 86400,
      user: {
        user_uuid: user.user_uuid,
        username: user.username,
        email: user.user_email ?? '',
      },
      extensions: extensions.map((extension) => ({
        extension_uuid: extension.extension_uuid,
        extension: extension.extension,
        sip_password: extension.sip_password,
        domain: extension.domain,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown FusionPBX login error'
    console.error(`FusionPBX login failed: ${message}`)

    return jsonResponse({ error: 'Unable to process FusionPBX login' }, 502)
  } finally {
    try {
      await fusionClient?.end({ timeout: 1 })
    } catch {
      // Keep the original response if closing the connection fails.
    }
  }
})
