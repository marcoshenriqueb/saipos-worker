import axios from "axios";
import { config } from "./config";

/**
 * Cached token + expiry to avoid reauth on every request.
 */
type TokenCache = { token: string; expEpochMs: number } | null;
let tokenCache: TokenCache = null;

/**
 * Decode the `exp` claim from a JWT and return the epoch in milliseconds.
 * Returns null when decoding fails or `exp` is not present.
 */
function decodeJwtExpMs(jwt: string): number | null {
  try {
    const payloadB64Url = jwt.split(".")[1];
    if (!payloadB64Url) return null;

    // JWT uses base64url (RFC 7515). Convert to base64 and pad.
    const b64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));

    if (typeof json.exp === "number") return json.exp * 1000;
    return null;
  } catch {
    return null;
  }
}

/**
 * Obtain an authentication token from Saipos, with in-memory caching.
 * Reuses the token while it is valid for at least 30 seconds.
 * @returns token string
 */
export async function getToken(): Promise<string> {
  // se temos token e ainda é válido por pelo menos 30s, reutiliza
  if (tokenCache && Date.now() < tokenCache.expEpochMs - 30_000) return tokenCache.token;

  const { data } = await axios.post(
    config.saipos.authUrl,
    {
      idPartner: config.saipos.idPartner,
      secret: config.saipos.secret,
      cod_store: config.saipos.codStore,
    },
    { timeout: 15_000 }
  );

  // Saipos te devolve array [{token: "..."}]
  const token = Array.isArray(data) ? data?.[0]?.token : data?.token;
  if (!token) throw new Error(`Auth did not return token. Response: ${JSON.stringify(data).slice(0, 300)}`);

  const exp = decodeJwtExpMs(token);
  tokenCache = { token, expEpochMs: exp ?? Date.now() + 10 * 60_000 }; // fallback 10 min
  return token;
}

/**
 * Query Saipos API for an order by `orderId` and `storeId`.
 * Handles HTTP errors and Saipos business errors reported in the JSON body.
 * @param orderId - Saipos order identifier
 * @param storeId - store code used by Saipos
 * @returns the response body (parsed JSON)
 */
export async function consultOrder(orderId: string, storeId: string): Promise<any> {
  const url = `${config.saipos.baseUrl}/order`;

  const doRequest = async (token: string) => {
    return axios.get(url, {
      params: { order_id: orderId, cod_store: storeId },
      headers: { Authorization: token },
      timeout: 20_000,
      validateStatus: () => true, // a gente trata manualmente
    });
  };

  let token = await getToken();
  let resp = await doRequest(token);

  // token expirado/invalidado: reauth 1x e tenta de novo
  if (resp.status === 401) {
    tokenCache = null;
    token = await getToken();
    resp = await doRequest(token);
  }

  // pode vir 200 com errorCode no body
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 300)}`);
  }

  const data = resp.data;

  // erro de negócio no JSON
  if (data && typeof data === "object" && "errorCode" in data) {
    const msg = (data as any).errorMessage || JSON.stringify(data).slice(0, 300);
    const code = (data as any).errorCode;
    const err = new Error(`Saipos errorCode=${code}: ${msg}`);
    (err as any).saiposErrorCode = code;
    throw err;
  }

  return data;
}