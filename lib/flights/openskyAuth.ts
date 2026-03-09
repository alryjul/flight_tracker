const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const TOKEN_REFRESH_MARGIN_MS = 30_000;

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

function getLegacyBasicAuthHeader() {
  const username = process.env.OPENSKY_USERNAME;
  const password = process.env.OPENSKY_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function getOAuthAccessToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`OpenSky token request failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("OpenSky token response did not include an access token");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000
  };

  return tokenCache.accessToken;
}

export async function getOpenSkyAuthorizationHeader() {
  const accessToken = await getOAuthAccessToken();

  if (accessToken) {
    return `Bearer ${accessToken}`;
  }

  return getLegacyBasicAuthHeader();
}

export function hasOpenSkyCredentials() {
  return (
    (process.env.OPENSKY_CLIENT_ID != null && process.env.OPENSKY_CLIENT_SECRET != null) ||
    (process.env.OPENSKY_USERNAME != null && process.env.OPENSKY_PASSWORD != null)
  );
}
