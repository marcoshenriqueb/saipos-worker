export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function fmtUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-` +
    `${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:` +
    `${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())}`
  );
}

export function trimOrEmpty(v: any): string {
  return v == null ? "" : String(v).trim();
}

export function trimOrNull(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function digitsOnlyOrNull(v: any): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\D/g, "");
  return s ? s : null;
}

export function customerPhoneOrNull(v: any): string | null {
  if (Array.isArray(v)) {
    for (const p of v) {
      const normalized = digitsOnlyOrNull(p);
      if (normalized) return normalized;
    }
    return null;
  }
  return digitsOnlyOrNull(v);
}

export function numberOrNull(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseDateAtUtcMidnight(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date format "${s}". Expected YYYY-MM-DD.`);
  }
  return new Date(`${s}T00:00:00.000Z`);
}

export function toDateOnlyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
