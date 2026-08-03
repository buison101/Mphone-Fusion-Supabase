import { jwtVerify } from 'jsr:@panva/jose@6'

const requiredEnv = (name: string) => {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

export const sessionUserUuid = async (req: Request) => {
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

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

