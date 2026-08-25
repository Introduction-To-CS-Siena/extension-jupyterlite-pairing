/**
 * Cloudflare Access JWT verification.
 *
 * Access gates requests at the edge, but the edge is not the only way to reach a
 * Worker: another route, an additional custom domain, or a re-enabled
 * `*.workers.dev` hostname all bypass an Access application scoped to one
 * hostname. Verifying the assertion here means the check lives in version
 * control next to the thing it protects, and cannot be silently removed by a
 * dashboard change.
 *
 * It also yields the caller's identity, which the gate alone does not: admin
 * actions that read student notebooks are logged with the verified email.
 */

const JWT_HEADER_NAME = 'cf-access-jwt-assertion';
const JWT_COOKIE_NAME = 'CF_Authorization';
const JWKS_CACHE_MS = 3600_000;

interface JsonWebKeySet {
  keys: (JsonWebKey & { kid?: string })[];
}

interface AccessTokenHeader {
  alg?: string;
  kid?: string;
}

interface AccessTokenPayload {
  aud?: string | string[];
  iss?: string;
  sub?: string;
  email?: string;
  exp?: number;
  nbf?: number;
}

export interface AccessIdentity {
  email: string;
  subject: string;
}

let jwksCache: { teamDomain: string; fetchedAt: number; keys: CryptoKey[] } | null = null;

/** Strips any scheme and trailing slash so `iss` and the JWKS URL agree. */
export function normalizeTeamDomain(value: string): string {
  return value.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJsonSegment<T>(segment: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
  } catch {
    return null;
  }
}

function readToken(request: Request): string | null {
  const header = request.headers.get(JWT_HEADER_NAME);
  if (header) {
    return header;
  }
  // Direct browser navigations to /admin carry the cookie rather than the header.
  const cookies = request.headers.get('cookie');
  if (!cookies) {
    return null;
  }
  for (const entry of cookies.split(';')) {
    const [name, ...rest] = entry.trim().split('=');
    if (name === JWT_COOKIE_NAME && rest.length) {
      return rest.join('=');
    }
  }
  return null;
}

async function loadKeys(teamDomain: string): Promise<CryptoKey[]> {
  if (
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    Date.now() - jwksCache.fetchedAt < JWKS_CACHE_MS
  ) {
    return jwksCache.keys;
  }

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`Access certificate endpoint returned ${response.status}.`);
  }

  const jwks = (await response.json()) as JsonWebKeySet;
  const keys = await Promise.all(
    (jwks.keys ?? []).map(key =>
      crypto.subtle.importKey(
        'jwk',
        key,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      )
    )
  );

  jwksCache = { teamDomain, fetchedAt: Date.now(), keys };
  return keys;
}

/**
 * Verifies the Access assertion on a request.
 *
 * Returns the caller's identity, or null if no valid assertion is present. The
 * kid is used only to order candidate keys — every key is still tried, so a
 * rotation that outruns the cache does not lock the dashboard out.
 */
export async function verifyAccessJwt(
  request: Request,
  teamDomainRaw: string,
  audience: string
): Promise<AccessIdentity | null> {
  const token = readToken(request);
  if (!token) {
    return null;
  }

  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const header = decodeJsonSegment<AccessTokenHeader>(headerSegment);
  if (header?.alg !== 'RS256') {
    return null;
  }

  const teamDomain = normalizeTeamDomain(teamDomainRaw);
  const signature = base64UrlDecode(signatureSegment);
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);

  let keys: CryptoKey[];
  try {
    keys = await loadKeys(teamDomain);
  } catch (error) {
    console.error('[access] could not load signing keys:', error);
    return null;
  }

  let verified = false;
  for (const key of keys) {
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)) {
      verified = true;
      break;
    }
  }
  if (!verified) {
    return null;
  }

  const payload = decodeJsonSegment<AccessTokenPayload>(payloadSegment);
  if (!payload) {
    return null;
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) {
    return null;
  }
  if (payload.iss !== `https://${teamDomain}`) {
    return null;
  }

  const nowSeconds = Date.now() / 1000;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    return null;
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
    return null;
  }

  return {
    email: payload.email ?? 'unknown',
    subject: payload.sub ?? 'unknown'
  };
}
