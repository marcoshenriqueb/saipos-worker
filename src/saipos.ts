import axios from "axios";
import { config } from "./config";

type TokenCache = { token: string; expEpochMs: number } | null;
let tokenCache: TokenCache = null;

function decodeJwtExpMs(jwt: string): number | null {
  // exp é em segundos; se falhar, retorna null
  try {
    const payload = jwt.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (typeof json.exp === "number") return json.exp * 1000;
    return null;
  } catch {
    return null;
  }
}

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

export async function consultOrder(orderId: string, storeId: string): Promise<any> {
  const token = await getToken();

  const url = `${config.saipos.baseUrl}/order`;
  const resp = await axios.get(url, {
    params: { order_id: orderId, cod_store: storeId },
    headers: { Authorization: token },
    timeout: 20_000,
    validateStatus: () => true, // a gente trata manualmente
  });

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