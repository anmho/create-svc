type AuthConfig = {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwksUrl: string;
};

type JwtHeader = {
  alg?: string;
  kid?: string;
};

type JwtClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  sub?: string;
  client_id?: string;
  scope?: string;
};

type Jwk = JsonWebKey & {
  kid?: string;
};

type Jwks = {
  keys: Jwk[];
};

const encoder = new TextEncoder();
const jwksCache = new Map<string, { expiresAt: number; jwks: Jwks }>();

export function authMiddleware(getConfig = authConfigFromEnv) {
  return async (context: any, next: () => Promise<void>) => {
    const config = getConfig();
    if (!config.enabled) {
      await next();
      return;
    }

    const authorization = context.req.header("authorization") ?? "";
    const token = bearerToken(authorization);
    if (!token) {
      return context.json({ error: "missing bearer token", code: "unauthorized" }, 401);
    }

    try {
      await verifyAccessToken(token, config);
      await next();
    } catch {
      return context.json({ error: "invalid bearer token", code: "unauthorized" }, 401);
    }
  };
}

export function authConfigFromEnv(): AuthConfig {
  return {
    enabled: truthy(Bun.env.AUTH_ENABLED),
    issuer: Bun.env.AUTH_ISSUER ?? "",
    audience: Bun.env.AUTH_AUDIENCE ?? "",
    jwksUrl: Bun.env.AUTH_JWKS_URL ?? "",
  };
}

async function verifyAccessToken(token: string, config: AuthConfig): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !config.issuer || !config.audience || !config.jwksUrl) {
    throw new Error("invalid auth config or token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJSON<JwtHeader>(encodedHeader);
  const claims = decodeJSON<JwtClaims>(encodedPayload);
  const jwks = await fetchJwks(config.jwksUrl);
  const key = selectKey(jwks, header);
  if (!key || !header.alg) {
    throw new Error("matching jwk not found");
  }

  const algorithm = importAlgorithm(header.alg, key);
  const cryptoKey = await crypto.subtle.importKey("jwk", key, algorithm.import, false, ["verify"]);
  const verified = await crypto.subtle.verify(
    algorithm.verify,
    cryptoKey,
    toArrayBuffer(decodeBase64Url(encodedSignature)),
    encoder.encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!verified) {
    throw new Error("bad signature");
  }

  validateClaims(claims, config);
  return claims;
}

async function fetchJwks(jwksUrl: string): Promise<Jwks> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwks;
  }

  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error(`jwks fetch failed: ${response.status}`);
  }
  const jwks = (await response.json()) as Jwks;
  jwksCache.set(jwksUrl, { jwks, expiresAt: Date.now() + 5 * 60 * 1000 });
  return jwks;
}

function selectKey(jwks: Jwks, header: JwtHeader): Jwk | undefined {
  if (header.kid) {
    return jwks.keys.find((key) => key.kid === header.kid);
  }
  return jwks.keys.length === 1 ? jwks.keys[0] : undefined;
}

function importAlgorithm(alg: string, key: JsonWebKey) {
  if (alg === "RS256") {
    return {
      import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      verify: { name: "RSASSA-PKCS1-v1_5" },
    } as const;
  }
  if (alg === "ES256" && key.crv === "P-256") {
    return {
      import: { name: "ECDSA", namedCurve: "P-256" },
      verify: { name: "ECDSA", hash: "SHA-256" },
    } as const;
  }
  if (alg === "EdDSA" && key.crv === "Ed25519") {
    return {
      import: { name: "Ed25519" },
      verify: { name: "Ed25519" },
    } as const;
  }
  throw new Error(`unsupported jwt alg: ${alg}`);
}

function validateClaims(claims: JwtClaims, config: AuthConfig) {
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.issuer) {
    throw new Error("issuer mismatch");
  }
  if (!audienceMatches(claims.aud, config.audience)) {
    throw new Error("audience mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp <= now - 30) {
    throw new Error("token expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) {
    throw new Error("token not active");
  }
}

function audienceMatches(audience: JwtClaims["aud"], expected: string) {
  return Array.isArray(audience) ? audience.includes(expected) : audience === expected;
}

function decodeJSON<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bearerToken(value: string) {
  const [scheme, token] = value.trim().split(/\s+/, 2);
  return /^Bearer$/i.test(scheme) ? token : "";
}

function truthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
