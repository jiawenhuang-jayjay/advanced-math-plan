// Run against a local Wrangler dev server with node --test tests/progress.test.mjs.
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

test("two devices share one revisioned store and separate pairing codes stay isolated", async () => {
  const url = process.env.PROGRESS_TEST_URL || "http://127.0.0.1:8794/api/progress";
  const headers = { Authorization: "Bearer " + crypto.randomUUID(), "Content-Type": "application/json" };
  const state = emptyProgress();
  state.logs["2026-11-23"] = log;
  state.weeks["W55–56.5"] = true;
  const put = revision => fetch(url, { headers, method: "PUT", body: JSON.stringify({ state, revision }) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await put(0)).status, 200);
  assert.equal((await put(0)).status, 409);
  const saved = await (await fetch(url, { headers })).json();
  assert.equal(saved.state.logs["2026-11-23"].newQ, 8);
  headers.Authorization = "Bearer " + crypto.randomUUID();
  assert.equal((await (await fetch(url, { headers })).json()).state, null);
});
