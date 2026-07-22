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

    return inner.fetch(req, env, ctx);
  },
};
