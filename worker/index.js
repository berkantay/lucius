// lucius worker entry — wraps the vendored tdoc bundle with an access-control
// layer (invites / private docs). The bundle stays untouched; this file owns:
//   * KV ACLs:      acl:<slug> = {visibility: "link"|"private", members: [gh logins]}
//   * /api/acl      GET/POST, upload-token auth — the app's Share modal talks here
//   * gating        /d/<slug>/… and slug-scoped comment/reaction routes
//   * a branded sign-in gate page for private docs (GitHub device flow,
//     reusing the bundle's own /api/auth endpoints)
import inner, { CommentsStore } from "./_worker.bundled.js";
export { CommentsStore };

const JSON_HEADERS = { "content-type": "application/json" };
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

const hasUploadToken = (env, req) =>
  (req.headers.get("authorization") || "") === `Bearer ${env.TDOC_UPLOAD_TOKEN}`;

async function sessionLogin(env, req) {
  const m = (req.headers.get("cookie") || "").match(/tdoc_sid=([a-f0-9]+)/);
  if (!m) return null;
  const raw = await env.META.get(`session:${m[1]}`);
  if (!raw) return null;
  try {
    return (JSON.parse(raw).login || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

async function getAcl(env, slug) {
  const raw = await env.META.get(`acl:${slug}`);
  if (!raw) return { visibility: "link", members: [] };
  try {
    const a = JSON.parse(raw);
    return {
      visibility: a.visibility === "private" ? "private" : "link",
      members: Array.isArray(a.members) ? a.members : [],
    };
  } catch {
    return { visibility: "link", members: [] };
  }
}

function slugFromRequest(url, body) {
  const doc = url.pathname.match(/^\/d\/([^/]+)/);
  if (doc) return decodeURIComponent(doc[1]);
  const q = url.searchParams.get("slug");
  if (q) return q;
  if (body && typeof body.slug === "string") return body.slug;
  return null;
}

const gatePage = (slug) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>lucius — private doc</title>
<style>
  body{margin:0;background:#f7f5ef;color:#1d1b17;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #e7e1d4;border-radius:18px;padding:34px 38px;max-width:420px;
        box-shadow:0 1px 0 rgba(0,0,0,.02);text-align:center}
  .mark{font-weight:700;letter-spacing:-.01em;font-size:15px;margin-bottom:18px}
  h1{font-size:20px;margin:0 0 8px;letter-spacing:-.01em}
  p{font-size:14px;color:#6f685c;line-height:1.55;margin:0 0 18px}
  button{font:600 13px system-ui;padding:9px 18px;border-radius:8px;cursor:pointer;
         background:#1d1b17;color:#fff;border:1px solid #1d1b17}
  button:hover{background:#fff;color:#1d1b17}
  #code{font:600 22px ui-monospace,Menlo,monospace;letter-spacing:4px;margin:10px 0}
  #hint{font-size:12.5px;color:#6f685c}
  a{color:#c2410c}
</style></head><body>
<div class="card">
  <div class="mark">lucius</div>
  <h1>This doc is private</h1>
  <p>“${slug}” is limited to invited members. Sign in with GitHub — if the owner invited your username, the doc opens right after.</p>
  <div id="flow"><button id="go">Sign in with GitHub</button></div>
</div>
<script>
document.getElementById("go").onclick = async () => {
  const flow = document.getElementById("flow");
  const r = await fetch("/api/auth/device/start", { method: "POST" });
  const d = await r.json();
  if (!d.user_code) { flow.innerHTML = "<p>Sign-in unavailable — try again later.</p>"; return; }
  flow.innerHTML = '<div id="code">' + d.user_code + '</div>' +
    '<p id="hint">Enter this code at <a href="' + d.verification_uri + '" target="_blank" rel="noopener">' + d.verification_uri + "</a></p>";
  const poll = setInterval(async () => {
    const p = await fetch("/api/auth/device/poll", { method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({ device_code: d.device_code }) });
    const j = await p.json().catch(() => ({}));
    if (j.ok) { clearInterval(poll); location.reload(); }
  }, (d.interval || 5) * 1000);
};
</script>
</body></html>`;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- ACL management (Share modal / CLI; upload-token auth) ----
    if (p === "/api/acl") {
      if (!hasUploadToken(env, req)) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) return json({ error: "slug required" }, 400);
        return json(await getAcl(env, slug));
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.slug) return json({ error: "body must be {slug, visibility?, members?}" }, 400);
        const acl = {
          visibility: body.visibility === "private" ? "private" : "link",
          members: (Array.isArray(body.members) ? body.members : [])
            .map((s) => String(s).trim().toLowerCase().replace(/^@/, ""))
            .filter(Boolean),
        };
        await env.META.put(`acl:${body.slug}`, JSON.stringify(acl));
        return json({ ok: true, slug: body.slug, ...acl });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ---- session status: live activity orb, mirrored from the app ----
    if (p === "/api/status") {
      if (req.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (!slug) return json({ error: "slug required" }, 400);
        const raw = await env.META.get(`status:${slug}`);
        return json(raw ? JSON.parse(raw) : { state: "idle", detail: "" });
      }
      if (req.method === "POST") {
        if (!hasUploadToken(env, req)) return json({ error: "unauthorized" }, 401);
        const body = await req.json().catch(() => null);
        if (!body || !body.slug || !body.state)
          return json({ error: "body must be {slug, state, detail?}" }, 400);
        if (body.state === "idle") {
          await env.META.delete(`status:${body.slug}`);
        } else {
          // 10-minute TTL so a crashed agent can't leave a doc "working" forever
          await env.META.put(
            `status:${body.slug}`,
            JSON.stringify({ state: body.state, detail: body.detail || "", ts: Date.now() }),
            { expirationTtl: 600 },
          );
        }
        return json({ ok: true });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ---- gate slug-scoped reads/mutations for private docs ----
    // Token-authed and auth/upload routes pass straight through to the bundle.
    const gated =
      p.startsWith("/d/") || p === "/api/comments" || p === "/api/reactions";
    if (gated && !hasUploadToken(env, req)) {
      let body = null;
      if (req.method !== "GET" && (req.headers.get("content-type") || "").includes("json")) {
        body = await req.clone().json().catch(() => null);
      }
      const slug = slugFromRequest(url, body);
      if (slug) {
        const acl = await getAcl(env, slug);
        if (acl.visibility === "private") {
          const login = await sessionLogin(env, req);
          const owner = (env.TDOC_OWNER || "").toLowerCase();
          const allowed =
            login && (login === owner || acl.members.includes(login));
          if (!allowed) {
            if (p.startsWith("/d/")) {
              return new Response(gatePage(slug), {
                status: 403,
                headers: { "content-type": "text/html; charset=utf-8" },
              });
            }
            return json({ error: "private doc — invite required" }, 403);
          }
        }
      }
    }

    const res = await inner.fetch(req, env, ctx);

    // Inject the live-activity orb into served doc pages so teammates see
    // when an agent is actively working the session behind this doc.
    const docPage = url.pathname.match(/^\/d\/([^/]+)\/v\/\d+\/?$/);
    if (docPage && res.status === 200 && (res.headers.get("content-type") || "").includes("text/html")) {
      const slug = decodeURIComponent(docPage[1]);
      let text = await res.text();
      // Defensive: docs with global element CSS (svg{width:100%}) inflate the
      // overlay's UI SVGs (bar mark, sign-in logo) to page width. Cap them.
      const GUARD =
        '<style>[class*="tdoc-"] svg,[id^="tdoc-"] svg{max-width:64px;max-height:64px}' +
        '.tdoc-bar svg{max-height:22px;max-width:90px}</style>';
      text = text.replace("</body>", `${GUARD}${STATUS_WIDGET(slug)}</body>`);
      const h = new Headers(res.headers);
      h.delete("content-length");
      return new Response(text, { status: 200, headers: h });
    }
    return res;
  },
};

// Vanilla dotted "working" orb — the published-page cousin of the app's
// thinking-orbs indicator. Polls /api/status every 12s; hidden when idle.
const STATUS_WIDGET = (slug) => `<script>(function(){
  var el=document.createElement("div");
  el.style.cssText="position:fixed;right:16px;bottom:16px;z-index:2147482000;display:none;align-items:center;gap:8px;background:#1d1b17;color:#fff;border-radius:999px;padding:6px 14px 6px 8px;font:500 12px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.25)";
  var cv=document.createElement("canvas");cv.width=44;cv.height=44;cv.style.cssText="width:22px;height:22px;display:block";
  var lbl=document.createElement("span");
  el.appendChild(cv);el.appendChild(lbl);document.body.appendChild(el);
  var ctx=cv.getContext("2d"),t0=performance.now(),cur=null,raf=null;
  var reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
  function draw(now){
    var t=(now-t0)/1000;ctx.clearRect(0,0,44,44);
    for(var i=0;i<12;i++){
      var a=t*1.6+i*Math.PI/6,r=14+Math.sin(t*2.2+i*1.7)*3.5;
      var x=22+Math.cos(a)*r,y=22+Math.sin(a)*r*0.62;
      ctx.beginPath();ctx.arc(x,y,1.8,0,7);
      ctx.fillStyle="rgba(255,255,255,"+(0.35+0.65*Math.abs(Math.sin(t+i)))+")";ctx.fill();
    }
    if(!reduced)raf=requestAnimationFrame(draw);
  }
  function apply(s){
    if(!s||s.state==="idle"||!s.state){el.style.display="none";if(raf)cancelAnimationFrame(raf);raf=null;return;}
    lbl.textContent=s.state+(s.detail?" \\u00b7 "+s.detail:"");
    if(el.style.display!=="flex"){el.style.display="flex";if(!raf)raf=requestAnimationFrame(draw);}
    if(reduced)draw(performance.now());
  }
  function poll(){
    fetch("/api/status?slug=${slug}").then(function(r){return r.json()}).then(apply).catch(function(){});
  }
  poll();setInterval(poll,12000);
})()</script>`;
