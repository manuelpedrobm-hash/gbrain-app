// claude-shim.js — the part of `window.claude` that the two artifact pages of
// the Misiones tab use, backed by the panel's /api/artdb/<page> (lib/artdb.ts).
// The server injects it into cola.html and mapa.html; the pages are unchanged.
//
//   claude.use("db")     → db.collection(name) / db.doc("col/id"):
//                          .doc(id?) .add() .get() .set() .update() .delete()
//                          .onSnapshot(cb, errCb) (polling every 3 s)
//   claude.use("user")   → { can() → true }: __NOMBRE__ is the only user here
//   claude.use("sample") → Cola only: rewrite a draft with claude -p (server side)
//
// Errors carry `.code` like the claude.ai runtime: "unavailable" (no
// connection, the page retries), "revoked" (session expired), "quota_exceeded",
// "not_found", "failed_precondition", "cancelled", "rate_limited".
// Every POST sends X-Panel: 1 and JSON (the panel's CSRF rule).
(function () {
  "use strict";
  var m = /\/artifacts\/([a-z]+)\.html$/.exec(location.pathname);
  var PAGE = m ? m[1] : "";
  var BASE = "/api/artdb/" + PAGE;
  var POLL_MS = 3000;

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function codeFor(status, serverCode) {
    if (status === 401 || status === 403) return "revoked";
    if (status === 413 || serverCode === "quota_exceeded") return "quota_exceeded";
    if (status === 404) return "not_found";
    if (status === 429 || status === 409) return "rate_limited";
    if (status === 499) return "cancelled";
    if (status >= 500) return "unavailable";
    return "failed_precondition"; // not "invalid_argument": the pages read that as «solo lectura»
  }

  async function call(path, body, signal) {
    var init = { method: body ? "POST" : "GET", credentials: "same-origin", headers: { Accept: "application/json" }, signal: signal };
    if (body) { init.headers["X-Panel"] = "1"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    var res;
    try { res = await fetch(path, init); }
    catch (e) { if (signal && signal.aborted) throw err("cancelled"); throw err("unavailable", "Sin conexión con el panel"); }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var c = data && data.error && data.error.code;
      throw err(codeFor(res.status, c), (data && data.error && data.error.message_es) || ("Error " + res.status));
    }
    return data;
  }

  // ------------------------------------------------------------ store + poll
  var state = { rev: -1, cols: null };
  var listeners = [];          // { kind: "col"|"doc", col, id, cb, errCb }
  var inflight = 0, writeSeq = 0, timer = null, polling = null;

  function emit(l) {
    if (!state.cols) return;
    var docs = state.cols[l.col] || {};
    try {
      if (l.kind === "col") {
        var list = Object.keys(docs).map(function (id) { return docSnap(l.col, id, docs[id]); });
        l.cb({ docs: list, size: list.length, empty: list.length === 0, forEach: function (f) { list.forEach(f); } });
      } else {
        l.cb(docSnap(l.col, l.id, Object.prototype.hasOwnProperty.call(docs, l.id) ? docs[l.id] : undefined));
      }
    } catch (e) { console.error(e); }
  }
  function docSnap(col, id, v) {
    return { id: id, exists: v !== undefined, ref: docRef(col, id), data: function () { return v === undefined ? undefined : clone(v); } };
  }

  async function refresh() {
    if (polling) return polling;
    var seqAtStart = writeSeq;
    polling = (async function () {
      try {
        var r = await call(BASE + (state.cols ? "?since=" + state.rev : ""));
        // A write started meanwhile: this answer may be older than it. Ask again after.
        if (inflight > 0 || writeSeq !== seqAtStart) return;
        if (r.unchanged) return;
        state.rev = r.rev; state.cols = r.collections || {};
        listeners.slice().forEach(emit);
      } catch (e) {
        if (e.code === "revoked") listeners.slice().forEach(function (l) { if (l.errCb) try { l.errCb(e); } catch (x) {} });
      } finally { polling = null; }
    })();
    return polling;
  }
  function schedule() {
    if (timer || !listeners.length) return;
    timer = setInterval(function () { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && listeners.length) refresh(); });

  async function write(op, col, id, data) {
    inflight++; writeSeq++;
    try {
      var r = await call(BASE + "/write", { op: op, collection: col, id: id, data: data });
      // Apply locally so readers see it at once; the next poll brings the rest.
      if (state.cols) {
        var docs = state.cols[col] = Object.assign({}, state.cols[col]);
        if (op === "delete") delete docs[r.id];
        else if (op === "update") docs[r.id] = Object.assign({}, docs[r.id], clone(data));
        else docs[r.id] = clone(data);
      }
      return r;
    } finally {
      inflight--;
      // Force a full re-read once any poll that was already running has finished.
      if (inflight === 0) { state.rev = -2; setTimeout(function () { (polling || Promise.resolve()).then(refresh); }, 0); }
    }
  }

  function subscribe(l) {
    listeners.push(l);
    if (state.cols) setTimeout(function () { emit(l); }, 0); else refresh();
    schedule();
    return function () {
      var i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
      if (!listeners.length && timer) { clearInterval(timer); timer = null; }
    };
  }

  // -------------------------------------------------------------- references
  var AUTO = "abcdefghijklmnopqrstuvwxyz0123456789";
  function autoId() {
    var a = new Uint8Array(20); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return AUTO[b % AUTO.length]; }).join("");
  }

  function docRef(col, id) {
    return {
      id: id, path: col + "/" + id,
      get: async function () {
        if (!state.cols) await refresh();
        var docs = (state.cols && state.cols[col]) || {};
        return docSnap(col, id, Object.prototype.hasOwnProperty.call(docs, id) ? docs[id] : undefined);
      },
      set: function (data) { return write("set", col, id, data).then(function () {}); },
      update: function (data) { return write("update", col, id, data).then(function () {}); },
      delete: function () { return write("delete", col, id).then(function () {}); },
      onSnapshot: function (cb, errCb) { return subscribe({ kind: "doc", col: col, id: id, cb: cb, errCb: errCb }); },
    };
  }
  function colRef(name) {
    return {
      id: name, path: name,
      doc: function (id) { return docRef(name, id == null ? autoId() : String(id)); },
      add: function (data) { return write("add", name, null, data).then(function (r) { return docRef(name, r.id); }); },
      get: async function () {
        await refresh();
        var docs = (state.cols && state.cols[name]) || {};
        var list = Object.keys(docs).map(function (id) { return docSnap(name, id, docs[id]); });
        return { docs: list, size: list.length, empty: !list.length, forEach: function (f) { list.forEach(f); } };
      },
      onSnapshot: function (cb, errCb) { return subscribe({ kind: "col", col: name, cb: cb, errCb: errCb }); },
    };
  }
  var db = {
    collection: colRef,
    doc: function (path) {
      var p = String(path).split("/");
      if (p.length !== 2) throw err("failed_precondition", "Ruta de documento no válida: " + path);
      return docRef(p[0], p[1]);
    },
  };

  // ------------------------------------------------------------------ sample
  async function sample(prompt, opts) {
    opts = opts || {};
    var r = await call(BASE + "/sample", { prompt: String(prompt) }, opts.signal);
    if (typeof opts.onText === "function") { try { opts.onText({ text: r.text }); } catch (e) {} }
    return { text: r.text, truncated: !!r.truncated };
  }

  var user = { id: "local", name: "__NOMBRE__", can: function () { return true; } };

  window.claude = {
    local: true,
    use: function (name) {
      if (!PAGE) return Promise.resolve(null);
      if (name === "db") return Promise.resolve(db);
      if (name === "user") return Promise.resolve(user);
      if (name === "sample") return Promise.resolve(PAGE === "cola" ? sample : null);
      return Promise.resolve(null);
    },
  };
})();
