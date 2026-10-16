/**
 * Strict offset pagination helpers (pure: no config/DB/axios imports, so
 * they can be unit tested).
 *
 * The old financial pagination had two silent failure modes:
 *  - a response that is not an array (nor {data: []} / {items: []}) was
 *    treated as an empty page, i.e. "no rows";
 *  - hitting maxPages stopped the loop silently, so a truncated read looked
 *    exactly like a complete one.
 * Both are now explicit errors.
 */

export class IncompleteReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteReadError";
  }
}

/**
 * The Saipos Data API answers `null` (not `[]`) for a window with no rows.
 * Distinct from other non-array values so callers can decide what it means.
 */
export class NullResponseError extends IncompleteReadError {
  constructor() {
    super("unexpected non-array response: null");
    this.name = "NullResponseError";
  }
}

/** Accepts an array or an {data|items: array} envelope; anything else throws. */
export function extractRowsStrict(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.data)) return raw.data;
    if (Array.isArray(raw.items)) return raw.items;
  }
  if (raw === null) throw new NullResponseError();
  let preview: string;
  try {
    preview = JSON.stringify(raw)?.slice(0, 200) ?? String(raw);
  } catch {
    preview = String(raw);
  }
  throw new IncompleteReadError(`unexpected non-array response: ${preview}`);
}

/**
 * Fetches pages until a short/empty page. Throws if every one of maxPages
 * pages came back full (the read may be truncated).
 */
export async function paginateStrict(
  fetchPage: (offset: number, limit: number) => Promise<any>,
  opts: {
    limit: number;
    maxPages: number;
    /** A `null` FIRST page counts as an empty read (regular ingest passes). Later/other non-arrays still throw. */
    nullFirstPageAsEmpty?: boolean;
  }
): Promise<{ rows: any[]; pages: number }> {
  const { limit, maxPages } = opts;
  if (!(limit > 0) || !(maxPages > 0)) throw new Error("paginateStrict: limit and maxPages must be > 0");

  const out: any[] = [];
  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchPage(page * limit, limit);
    if (page === 0 && raw === null && opts.nullFirstPageAsEmpty) return { rows: [], pages: 1 };
    const rows = extractRowsStrict(raw);
    out.push(...rows);
    if (rows.length < limit) return { rows: out, pages: page + 1 };
  }

  throw new IncompleteReadError(
    `page limit hit: ${maxPages} full pages of ${limit} rows; read may be truncated`
  );
}
