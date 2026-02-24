import axios from "axios";
import { config } from "../config";

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

/**
 * GET /v1/sales
 * Doc: consultar-vendas (Layout definições vendas)
 */
export async function sales(params: {
  p_date_column_filter: "shift_date" | "created_at" | "updated_at" | string;
  p_filter_date_start: string; // "YYYY-MM-DD HH:mm:ss"
  p_filter_date_end: string;   // "YYYY-MM-DD HH:mm:ss"
  p_limit?: number;
  p_offset?: number;
}): Promise<any> {
  const url = `${baseUrl()}/v1/sales`;

  const resp = await axios.get(url, {
    params: {
      ...params,
      p_limit: params.p_limit ?? 300,
      p_offset: params.p_offset ?? 0,
    },
    headers: {
      Authorization: authHeader(),
      accept: "application/json",
    },
    timeout: 30_000,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    throw new Error(`DATA API HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 400)}`);
  }

  return resp.data;
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
  const url = `${baseUrl()}/v1/sales_status_histories`;

  const resp = await axios.get(url, {
    params: {
      ...params,
      p_limit: params.p_limit ?? 300,
      p_offset: params.p_offset ?? 0,
    },
    headers: {
      Authorization: authHeader(),
      accept: "application/json",
    },
    timeout: 30_000,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    throw new Error(`DATA API HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 400)}`);
  }

  return resp.data;
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
  const url = `${baseUrl()}/v1/sales_items`;

  const resp = await axios.get(url, {
    params: {
      ...params,
      p_limit: params.p_limit ?? 300,
      p_offset: params.p_offset ?? 0,
    },
    headers: {
      Authorization: authHeader(),
      accept: "application/json",
    },
    timeout: 30_000,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    throw new Error(`DATA API HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 400)}`);
  }

  return resp.data;
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