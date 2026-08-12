import crypto from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'hengyu-h12-production';
const REPOSITORY = 'SengC-it/hengyu';
const REF = 'refs/heads/main';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/hengyu-h12.yml@${REF}`;

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export async function verifyGitHubActionsOidc(token, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJson(encodedHeader);
    const claims = decodeJson(encodedPayload);
    const nowSeconds = Math.floor(now / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    if (claims.iss !== ISSUER || !audiences.includes(AUDIENCE)) return false;
    if (claims.repository !== REPOSITORY || claims.ref !== REF || claims.workflow_ref !== WORKFLOW_REF) return false;
    if (!['schedule', 'workflow_dispatch'].includes(claims.event_name)) return false;
    if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return false;
    if (claims.iat > nowSeconds + 60 || claims.exp < nowSeconds || claims.exp - claims.iat > 600) return false;
    const response = await fetchImpl(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const jwks = await response.json();
    const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) return false;
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return crypto.verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, 'base64url')
    );
  } catch {
    return false;
  }
}
