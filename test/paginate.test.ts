import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRowsStrict, IncompleteReadError, paginateStrict } from "../src/saipos/paginate";

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

test("extractRowsStrict accepts array and {data}/{items} envelopes", () => {
  assert.deepEqual(extractRowsStrict([1, 2]), [1, 2]);
  assert.deepEqual(extractRowsStrict({ data: [1] }), [1]);
  assert.deepEqual(extractRowsStrict({ items: [] }), []);
});

test("extractRowsStrict: non-array response is an error, not an empty page", () => {
  for (const bad of [null, undefined, {}, { message: "oops" }, "text", 42, { data: "x" }]) {
    assert.throws(() => extractRowsStrict(bad), IncompleteReadError);
  }
});

test("paginateStrict stops on a short page", async () => {
  const pages = [rows(3), rows(3, 3), rows(1, 6)];
  const r = await paginateStrict(async (offset, limit) => pages[offset / limit], { limit: 3, maxPages: 10 });
  assert.equal(r.rows.length, 7);
  assert.equal(r.pages, 3);
});

test("paginateStrict stops on an empty page", async () => {
  const pages = [rows(3), []];
  const r = await paginateStrict(async (offset, limit) => pages[offset / limit], { limit: 3, maxPages: 10 });
  assert.equal(r.rows.length, 3);
});

test("paginateStrict: hitting maxPages with full pages is an error (no silent truncation)", async () => {
  await assert.rejects(
    paginateStrict(async () => rows(3), { limit: 3, maxPages: 2 }),
    (e: any) => e instanceof IncompleteReadError && /page limit hit/.test(e.message)
  );
});

test("paginateStrict: last allowed page short is complete", async () => {
  const pages = [rows(3), rows(2)];
  const r = await paginateStrict(async (offset, limit) => pages[offset / limit], { limit: 3, maxPages: 2 });
  assert.equal(r.rows.length, 5);
});

test("paginateStrict: non-array page mid-read fails the whole read", async () => {
  const pages: any[] = [rows(3), { error: "PGRST003" }];
  await assert.rejects(
    paginateStrict(async (offset, limit) => pages[offset / limit], { limit: 3, maxPages: 10 }),
    IncompleteReadError
  );
});
