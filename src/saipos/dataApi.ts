import axios from "axios";
import { config } from "../config";
import { sleep } from "../utils/common";

/**
 * Saipos Data API client
 * - Auth: Authorization: Bearer <token>
 * - Base: config.saipos.dataApiUrl (ex: https://data.saipos.io)
 */

function baseUrl(): string {
  return config.saipos.dataApiUrl.replace(/\/+$/, "");
}

function authHeader(): string {
  return `Bearer ${config.saipos.dataToken}`;
}

async function getWithRetry(url: string, params: Record<string, any>): Promise<any> {
  const maxAttempts = 4;
  let lastStatus = 0;
  let lastData: any;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 1000); // 1s, 2s, 4s

    const resp = await axios.get(url, {
      params,
      headers: { Authorization: authHeader(), accept: "application/json" },
      timeout: 30_000,
      validateStatus: () => true,
    });

    lastStatus = resp.status;
    lastData = resp.data;

    if (resp.status < 500) {
      if (resp.status >= 400) throw new Error(`DATA API HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 400)}`);
      return resp.data;
    }
  }

  throw new Error(`DATA API HTTP ${lastStatus}: ${JSON.stringify(lastData).slice(0, 400)}`);
}

/**
 * GET /v1/search_sales
 * Doc: consultar-vendas (Layout definições vendas)
 */
export async function sales(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string; // "YYYY-MM-DD HH:mm:ss"
  p_filter_date_end: string;   // "YYYY-MM-DD HH:mm:ss"
  p_limit?: number;
  p_offset?: number;
}): Promise<any> {
  return getWithRetry(`${baseUrl()}/v1/search_sales`, {
    ...params,
    p_limit: params.p_limit ?? 300,
    p_offset: params.p_offset ?? 0,
  });
}

/**
 * Paginação automática (offset/limit)
 * Retorna lista plana de registros.
 */
export async function salesAll(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string;
  p_filter_date_end: string;
  p_limit?: number;   // default 300
  maxPages?: number;  // default 50
}): Promise<any[]> {
  const limit = params.p_limit ?? 300;
  const maxPages = params.maxPages ?? 50;

  const out: any[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;

    const raw = await sales({
      p_date_column_filter: params.p_date_column_filter,
      p_filter_date_start: params.p_filter_date_start,
      p_filter_date_end: params.p_filter_date_end,
      p_limit: limit,
      p_offset: offset,
    });

    const rows: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.items)
          ? raw.items
          : [];

    if (!rows.length) break;

    out.push(...rows);
    if (rows.length < limit) break;
  }

  return out;
}

/**
 * GET /v1/sales_status_histories
 * Doc: consultar-historico-status-vendas
 */
export async function salesStatusHistories(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string; // "YYYY-MM-DD HH:mm:ss"
  p_filter_date_end: string;   // "YYYY-MM-DD HH:mm:ss"
  p_limit?: number;
  p_offset?: number;
}): Promise<any> {
  return getWithRetry(`${baseUrl()}/v1/sales_status_histories`, {
    ...params,
    p_limit: params.p_limit ?? 300,
    p_offset: params.p_offset ?? 0,
  });
}

/**
 * Paginação automática (offset/limit) para /v1/sales_status_histories
 * Retorna lista plana de registros.
 */
export async function salesStatusHistoriesAll(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string;
  p_filter_date_end: string;
  p_limit?: number;   // default 300
  maxPages?: number;  // default 50
}): Promise<any[]> {
  const limit = params.p_limit ?? 300;
  const maxPages = params.maxPages ?? 50;

  const out: any[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;

    const raw = await salesStatusHistories({
      p_date_column_filter: params.p_date_column_filter,
      p_filter_date_start: params.p_filter_date_start,
      p_filter_date_end: params.p_filter_date_end,
      p_limit: limit,
      p_offset: offset,
    });

    const rows: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.items)
          ? raw.items
          : [];

    if (!rows.length) break;

    out.push(...rows);
    if (rows.length < limit) break;
  }

  return out;
}

/**
 * GET /v1/sales_items
 * Doc: consultar-itens-venda
 */
export async function salesItems(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string; // "YYYY-MM-DD HH:mm:ss"
  p_filter_date_end: string;   // "YYYY-MM-DD HH:mm:ss"
  p_limit?: number;
  p_offset?: number;
}): Promise<any> {
  return getWithRetry(`${baseUrl()}/v1/sales_items`, {
    ...params,
    p_limit: params.p_limit ?? 300,
    p_offset: params.p_offset ?? 0,
  });
}

/**
 * Paginação automática (offset/limit) para /v1/sales_items
 * Retorna lista plana de registros.
 */
export async function salesItemsAll(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string;
  p_filter_date_end: string;
  p_limit?: number;   // default 300
  maxPages?: number;  // default 50
}): Promise<any[]> {
  const limit = params.p_limit ?? 300;
  const maxPages = params.maxPages ?? 50;

  const out: any[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;

    const raw = await salesItems({
      p_date_column_filter: params.p_date_column_filter,
      p_filter_date_start: params.p_filter_date_start,
      p_filter_date_end: params.p_filter_date_end,
      p_limit: limit,
      p_offset: offset,
    });

    const rows: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.items)
          ? raw.items
          : [];

    if (!rows.length) break;

    out.push(...rows);
    if (rows.length < limit) break;
  }

  return out;
}
