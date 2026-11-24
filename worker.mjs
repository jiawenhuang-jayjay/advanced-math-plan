import { DurableObject } from "cloudflare:workers";

const json = (body, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" }
});

const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
function entries(map, check) {
  return record(map) && Object.entries(map).every(([key, value]) =>
    !Object.hasOwn(Object.prototype, key) && check(key, value));
}
function validState(s) {
  return record(s) && ["all", "base"].includes(s.chMode) && count(s.bufferUsed)
    && entries(s.logs, (date, l) => /^\d{4}-\d{2}-\d{2}$/.test(date) && record(l)
      && typeof l.mode === "string" && /^[\w-]+$/.test(l.mode) && !Object.hasOwn(Object.prototype, l.mode)
      && typeof l.chapter === "string" && /^[\w-]+$/.test(l.chapter) && !Object.hasOwn(Object.prototype, l.chapter)
      && count(l.newQ) && count(l.wrongQ) && Number.isFinite(l.hours) && l.hours >= 0
      && (l.note == null || typeof l.note === "string") && (l.shield == null || typeof l.shield === "boolean"))
    && entries(s.weeks, (k, v) => /^W[\d.–-]+$/.test(k) && typeof v === "boolean")
    && entries(s.starred, (k, v) => typeof v === "boolean")
    && entries(s.chOverrides, (k, v) => /^ch\d+$/.test(k) && record(v) && count(v.total) && count(v.init));
}

export class Progress extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY, revision INTEGER, data TEXT)");
  }

  async fetch(request) {
    const row = () => this.sql.exec("SELECT revision, data FROM progress WHERE id=1").toArray()[0];
    if (request.method === "GET") {
      const current = row();
      return json({ revision: current?.revision ?? 0, state: current ? JSON.parse(current.data) : null });
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 512 * 1024) return json(null, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json(null, 400); }
    if (!count(body?.revision) || !validState(body.state)) return json(null, 400);
    // No await between the revision check and write inside this device group's object.
    if (body.revision !== (row()?.revision ?? 0)) return json(null, 409);
    const revision = body.revision + 1;
    this.sql.exec("INSERT OR REPLACE INTO progress VALUES (1, ?, ?)", revision, JSON.stringify(body.state));
    return json({ revision });
  }
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname !== "/api/progress") return env.ASSETS.fetch(request);
    const match = /^Bearer ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(request.headers.get("Authorization") || "");
    if (!match) return json(null, 401);
    if (!["GET", "PUT"].includes(request.method)) return json(null, 405);
    if (Number(request.headers.get("Content-Length")) > 512 * 1024) return json(null, 413);
    return env.PROGRESS.getByName(match[1]).fetch(request);
  }
};
