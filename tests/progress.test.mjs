// Start both entry points before running node --test tests/progress.test.mjs:
// npx wrangler dev --config wrangler.worker.jsonc --name math-progress-local --port 8794
// npx wrangler pages dev --service PROGRESS_API=math-progress-local --port 8795
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const src = readFileSync(new URL("../V1/progress.js", import.meta.url), "utf8");
const { emptyProgress, mergeProgress } = runInNewContext(src + "\n;({emptyProgress, mergeProgress})");
const fail = () => assert.fail("unexpected conflict");
const log = { mode: "1a_normal", chapter: "ch2", newQ: 8, wrongQ: 0, hours: 2.5, note: "" };

test("ordinary 1A day reaches the over-target tier at 8 new questions", () => {
  const html = readFileSync(new URL("../V1/index.html", import.meta.url), "utf8");
  const modes = html.slice(html.indexOf("const MODES ="), html.indexOf("const CHAPTERS ="));
  const scoring = html.slice(html.indexOf("function evalLog("), html.indexOf("function computeStats("));
  const evaluate = runInNewContext(modes + scoring + "evalLog");
  assert.equal(evaluate({ ...log, newQ: 7 }).tier, "should");
  assert.equal(evaluate(log).tier, "over");
  assert.equal(evaluate(log).excess, 1);
});

test("merge offline edits by date, propagate deletion and surface same-day conflicts", () => {
  const base = emptyProgress();
  base.logs["2026-11-22"] = log;
  const local = structuredClone(base);
  delete local.logs["2026-11-22"];
  const remote = structuredClone(base);
  remote.logs["2026-11-23"] = log;
  const merged = mergeProgress(base, local, remote, fail);
  assert.deepEqual(Object.keys(merged.logs), ["2026-11-23"]);
  local.logs["2026-11-23"] = { ...log, newQ: 7 };
  assert.equal(mergeProgress(base, local, remote, (date, here, there) => {
    assert.equal(date, "2026-11-23");
    return there;
  }).logs["2026-11-23"].newQ, 8);
});

test("Pages and Workers read and write the same paired progress", async () => {
  const worker = process.env.PROGRESS_TEST_URL || "http://127.0.0.1:8794/api/progress";
  const pages = process.env.PAGES_TEST_URL || "http://127.0.0.1:8795/api/progress";
  const headers = { Authorization: "Bearer " + crypto.randomUUID(), "Content-Type": "application/json" };
  const state = emptyProgress();
  state.logs["2026-11-23"] = log;
  state.weeks["W55–56.5"] = true;
  const put = (url, revision) => fetch(url, { headers, method: "PUT", body: JSON.stringify({ state, revision }) });
  for (const url of [worker, pages]) assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await (await put(worker, 0)).json(), { revision: 1 });
  const saved = await (await fetch(pages, { headers })).json();
  assert.equal(saved.state.logs["2026-11-23"].newQ, 8);
  assert.equal((await put(pages, 0)).status, 409);
  state.logs["2026-11-24"] = { ...log, newQ: 7 };
  assert.deepEqual(await (await put(pages, saved.revision)).json(), { revision: 2 });
  assert.equal((await (await fetch(worker, { headers })).json()).state.logs["2026-11-24"].newQ, 7);
  headers.Authorization = "Bearer " + crypto.randomUUID();
  assert.equal((await (await fetch(pages, { headers })).json()).state, null);
});

test("a static HTML response never acknowledges a local edit", async () => {
  for (const missing of ["GET", "PUT"]) {
    const button = {};
    const sandbox = {
      document: { getElementById: () => button },
      fetch: async (_, init) => (init.method || "GET") === missing
        ? new Response("<html></html>", { headers: { "Content-Type": "text/html" } })
        : Response.json({ revision: 0, state: null })
    };
    await runInNewContext(src + `
      const state = emptyProgress();
      state.weeks.W1 = true;
      const pairing = { key: "test", base: emptyProgress() };
      syncProgress();
    `, sandbox);
    assert.match(button.textContent, missing === "GET" ? /未提供同步接口/ : /未确认写入/);
    assert.equal(runInNewContext("pairing.base.weeks.W1", sandbox), undefined);
    assert.equal(runInNewContext("state.weeks.W1", sandbox), true);
  }
});
