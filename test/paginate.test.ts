import { test } from "node:test";
import assert from "node:assert/strict";
import { NullResponseError, extractRowsStrict, IncompleteReadError, paginateStrict } from "../src/saipos/paginate";

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

test("null is a NullResponseError (an IncompleteReadError); objects/strings are not", () => {
  assert.throws(() => extractRowsStrict(null), NullResponseError);
  assert.throws(() => extractRowsStrict({}), (e: any) => e instanceof IncompleteReadError && !(e instanceof NullResponseError));
  assert.throws(() => extractRowsStrict("x"), (e: any) => !(e instanceof NullResponseError));
});

test("paginateStrict nullFirstPageAsEmpty: null first page = empty; null mid-read and objects still fail", async () => {
  const r = await paginateStrict(async () => null, { limit: 3, maxPages: 5, nullFirstPageAsEmpty: true });
  assert.equal(r.rows.length, 0);
  await assert.rejects(paginateStrict(async () => null, { limit: 3, maxPages: 5 }), NullResponseError);
  await assert.rejects(
    paginateStrict(async (o) => (o === 0 ? rows(3) : null), { limit: 3, maxPages: 5, nullFirstPageAsEmpty: true }),
    IncompleteReadError
  );
  await assert.rejects(paginateStrict(async () => ({}), { limit: 3, maxPages: 5, nullFirstPageAsEmpty: true }), IncompleteReadError);
});
