/**
 * Teswatch — all-in-one setup helper (Cloudflare Worker)
 *
 * One file. No Android Studio, no curl, no PowerShell needed by the end user.
 * Deploy: Cloudflare dashboard -> Workers -> "Create" -> "Start with Hello World!"
 * (a script-based Worker, NOT "Upload static files") -> paste this whole file in
 * the editor -> Deploy. Then:
 *   1. Settings -> Bindings -> Add binding -> KV namespace -> create one called
 *      "STORE" (any name is fine, but the binding name in your Worker must be STORE).
 *   2. Settings -> Variables -> add SETUP_PIN (any password you choose) as a
 *      normal (or "Encrypt") variable. This protects the /setup page.
 *   3. Open https://<your-worker>.workers.dev/setup and enter that PIN.
 *
 * Routes:
 *   GET  /                                  - simple info page
 *   GET  /callback                          - Tesla OAuth callback page
 *   PUT  /api/code/:sid     GET /api/code/:sid       - OAuth code relay (watch <-> phone)
 *   PUT  /api/pubkey/:sid   GET /api/pubkey/:sid     - Public key relay (watch -> phone)
 *   PUT  /api/clientid/:sid GET /api/clientid/:sid   - Client ID relay (phone -> watch)
 *   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem  - hosted public key
 *   GET  /setup                             - admin page (enter PIN to use)
 *   POST /setup/save-key                    - store the currently-hosted public key
 *   POST /setup/register                    - do the Tesla partner_accounts registration
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...extra } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

const PAGE_STYLE = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0f14;color:#e7f3ee;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
  .card{max-width:520px;width:100%;background:#131a21;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
  h1{font-size:20px;margin:0 0 12px;color:#87e8ce}
  p{line-height:1.6;font-size:15px;color:#cdd9d4}
  label{display:block;font-size:13px;color:#9caeba;margin:14px 0 4px}
  input,textarea{width:100%;box-sizing:border-box;background:#0e141a;border:1px solid #223029;border-radius:8px;
    color:#e7f3ee;padding:10px;font-size:14px;font-family:monospace}
  button{margin-top:16px;width:100%;padding:12px;border:none;border-radius:10px;background:#87e8ce;color:#0b0f14;
    font-weight:600;font-size:15px;cursor:pointer}
  button:active{opacity:.8}
  .code-box{margin-top:16px;background:#0e141a;border:1px solid #223029;border-radius:10px;padding:14px;
    word-break:break-all;font-family:monospace;font-size:13px;color:#87e8ce;white-space:pre-wrap}
  .err{color:#ff8a8a} .ok{color:#87e8ce;font-weight:600}
`;

async function handleSetupPage(req, env) {
  const url = new URL(req.url);
  const pin = url.searchParams.get("pin") || "";
  if (!env.SETUP_PIN || pin !== env.SETUP_PIN) {
    return html(`<!DOCTYPE html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head>
      <body><div class="card"><h1>Teswatch Setup</h1>
      <form method=get>
        <label>PIN (set as SETUP_PIN in Worker Variables)</label>
        <input name=pin type=password autofocus>
        <button>Enter</button>
      </form></div></body></html>`);
  }
  const savedKey = (await env.STORE.get("hosted_pubkey")) || "(none yet)";
  const cfg = JSON.parse((await env.STORE.get("config")) || "{}");
  return html(`<!DOCTYPE html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head>
  <body><div class="card">
    <h1>Teswatch Setup</h1>
    <p>1. Send the Client ID from developer.tesla.com to your watch (instead of typing it there). On the watch, open <b>Tesla API setup</b>, enter the domain, then on the Client ID step tap <b>Get from phone</b> to see a 6-digit code, then enter it below along with the Client ID.</p>
    <form id=cid>
      <label>Code from watch</label>
      <input name=code maxlength=6 placeholder="123456">
      <label>Client ID</label>
      <input name=clientId value="${cfg.clientId||""}">
      <button type=submit>Send to watch</button>
    </form>
    <div id=cidResult class="code-box" style="display:none"></div>

    <p style="margin-top:28px">2. On the watch, open <b>Tesla API setup &gt; View public key</b> and enter the 6-digit code it shows below.</p>
    <form id=pk>
      <label>Code from watch</label>
      <input name=code maxlength=6 placeholder="123456">
      <button type=submit>Fetch key from watch</button>
    </form>
    <div id=pkResult class="code-box">Current hosted key:\n${savedKey}</div>

    <p style="margin-top:28px">3. Fill in what Tesla gave you on developer.tesla.com, then register.</p>
    <form id=reg>
      <label>Client ID</label><input name=clientId value="${cfg.clientId||""}">
      <label>Client Secret</label><input name=clientSecret type=password>
      <label>Domain (exactly as registered, e.g. yourname.workers.dev)</label><input name=domain value="${cfg.domain||""}">
      <label>Region</label>
      <select name=region><option value=na ${cfg.region!=="eu"?"selected":""}>North America / Asia-Pacific (na)</option><option value=eu ${cfg.region==="eu"?"selected":""}>Europe / Middle East / Africa (eu)</option></select>
      <button type=submit>Register with Tesla</button>
    </form>
    <div id=regResult class="code-box" style="display:none"></div>
  </div>
  <script>
    const pin = ${JSON.stringify(pin)};
    document.getElementById('pk').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value.trim();
      const box = document.getElementById('pkResult');
      box.textContent = 'Fetching...';
      try {
        const r = await fetch('/api/pubkey/' + encodeURIComponent(code));
        if (!r.ok) { box.textContent = 'Not found or expired. Open the screen on the watch again for a fresh code.'; box.className='code-box err'; return; }
        const key = await r.text();
        const save = await fetch('/setup/save-key?pin=' + encodeURIComponent(pin), { method: 'POST', body: key });
        const savedText = await save.text();
        box.textContent = 'Saved as the hosted public key:\\n' + savedText;
        box.className = 'code-box ok';
      } catch (err) { box.textContent = 'Error: ' + err; box.className = 'code-box err'; }
    });
    document.getElementById('cid').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value.trim();
      const clientId = e.target.clientId.value.trim();
      const box = document.getElementById('cidResult');
      box.style.display = 'block'; box.className = 'code-box';
      if (!code || !clientId) { box.textContent = 'Enter both the code from the watch and the Client ID.'; box.className = 'code-box err'; return; }
      box.textContent = 'Sending...';
      try {
        const r = await fetch('/api/clientid/' + encodeURIComponent(code), { method: 'PUT', body: clientId });
        if (!r.ok) { box.textContent = 'Failed to send. Get a fresh code on the watch and try again.'; box.className = 'code-box err'; return; }
        box.textContent = 'Sent! Check the watch screen.';
        box.className = 'code-box ok';
      } catch (err) { box.textContent = 'Error: ' + err; box.className = 'code-box err'; }
    });
    document.getElementById('reg').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { clientId: f.clientId.value.trim(), clientSecret: f.clientSecret.value.trim(), domain: f.domain.value.trim(), region: f.region.value };
      const box = document.getElementById('regResult');
      box.style.display = 'block'; box.textContent = 'Registering...'; box.className = 'code-box';
      try {
        const r = await fetch('/setup/register?pin=' + encodeURIComponent(pin), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const out = await r.json();
        box.textContent = JSON.stringify(out, null, 2);
        box.className = r.ok ? 'code-box ok' : 'code-box err';
      } catch (err) { box.textContent = 'Error: ' + err; box.className = 'code-box err'; }
    });
  </script>
  </body></html>`);
}

async function handleSaveKey(req, env) {
  const url = new URL(req.url);
  if (!env.SETUP_PIN || url.searchParams.get("pin") !== env.SETUP_PIN) return text("forbidden", 403);
  const key = (await req.text()).trim();
  if (!key.includes("BEGIN PUBLIC KEY")) return text("that doesn't look like a PEM public key", 400);
  await env.STORE.put("hosted_pubkey", key);
  return text(key);
}

async function handleRegister(req, env) {
  const url = new URL(req.url);
  if (!env.SETUP_PIN || url.searchParams.get("pin") !== env.SETUP_PIN) return json({ error: "forbidden" }, 403);
  const { clientId, clientSecret, domain, region } = await req.json();
  if (!clientId || !clientSecret || !domain) return json({ error: "clientId, clientSecret and domain are required" }, 400);
  await env.STORE.put("config", JSON.stringify({ clientId, domain, region }));

  const tokenResp = await fetch("https://auth.tesla.com/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "openid vehicle_device_data vehicle_cmds vehicle_charging_cmds",
      audience: region === "eu"
        ? "https://fleet-api.prd.eu.vn.cloud.tesla.com"
        : "https://fleet-api.prd.na.vn.cloud.tesla.com",
    }),
  });
  const tokenJson = await tokenResp.json();
  if (!tokenResp.ok) return json({ step: "token", ...tokenJson }, tokenResp.status);

  const apiBase = region === "eu"
    ? "https://fleet-api.prd.eu.vn.cloud.tesla.com"
    : "https://fleet-api.prd.na.vn.cloud.tesla.com";
  const partnerResp = await fetch(`${apiBase}/api/1/partner_accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenJson.access_token}` },
    body: JSON.stringify({ domain }),
  });
  const partnerJson = await partnerResp.json();
  return json({ step: "partner_accounts", status: partnerResp.status, ...partnerJson }, partnerResp.ok ? 200 : partnerResp.status);
}

async function handleCallback() {
  return html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Teswatch - Tesla sign-in complete</title>
<style>${PAGE_STYLE}
.spinner{width:28px;height:28px;margin:8px auto 0;border:3px solid #223029;border-top-color:#87e8ce;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="card"><h1>Teswatch - Tesla sign-in</h1>
<div id="content"><p>Checking your sign-in...</p></div></div>
<script>
(function(){
  var params=new URLSearchParams(window.location.search);
  var code=params.get("code"), state=params.get("state"), error=params.get("error");
  var content=document.getElementById("content");
  function showManualCopy(introHtml){
    content.innerHTML = "<p>"+introHtml+"</p>"+
      '<div class="code-box">'+(code||"(no code)")+'</div>'+
      '<button onclick="navigator.clipboard&&navigator.clipboard.writeText(\\''+(code||"")+'\\')">Copy code</button>';
  }
  if(error){ content.innerHTML='<p class="err">Tesla sign-in failed: '+error+'</p>'; return; }
  if(!code){ content.innerHTML='<p class="err">No authorization code in the URL.</p>'; return; }
  if(!state){ showManualCopy("Signed in. Copy this code into the watch app."); return; }
  content.innerHTML='<p>Signed in. Sending it to your watch...</p><div class="spinner"></div>';
  fetch("/api/code/"+encodeURIComponent(state), { method:"PUT", body: code })
    .then(function(r){ if(!r.ok) throw new Error("relay failed: "+r.status);
      content.innerHTML='<p class="ok">Done! Go back to your watch.</p>'; })
    .catch(function(){ showManualCopy("Signed in. (Automatic hand-off failed, but you can still continue manually.)"); });
})();
</script></body></html>`);
}

async function handleHome() {
  return html(`<!DOCTYPE html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>${PAGE_STYLE}</style></head>
  <body><div class="card"><h1>Teswatch</h1><p>This site supports the Teswatch app's Tesla API connection.
  There's nothing to see here directly — open the <b>Tesla API setup</b> screen in the watch app instead.</p></div></body></html>`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (pathname === "/" ) return handleHome();
    if (pathname === "/callback") return handleCallback();
    if (pathname === "/setup" && req.method === "GET") return handleSetupPage(req, env);
    if (pathname === "/setup/save-key" && req.method === "POST") return handleSaveKey(req, env);
    if (pathname === "/setup/register" && req.method === "POST") return handleRegister(req, env);

    if (pathname === "/.well-known/appspecific/com.tesla.3p.public-key.pem") {
      const key = await env.STORE.get("hosted_pubkey");
      if (!key) return text("not set up yet", 404);
      return text(key, 200, { "Access-Control-Allow-Origin": "*" });
    }

    let m = pathname.match(/^\/api\/code\/([^/]+)$/);
    if (m) {
      const key = "code:" + m[1];
      if (req.method === "PUT") { await env.STORE.put(key, await req.text(), { expirationTtl: 300 }); return text("ok", 200, CORS); }
      if (req.method === "GET") { const v = await env.STORE.get(key); return v ? text(v, 200, CORS) : new Response(null, { status: 204, headers: CORS }); }
    }
    m = pathname.match(/^\/api\/pubkey\/([^/]+)$/);
    if (m) {
      const key = "pubkey:" + m[1];
      if (req.method === "PUT") { await env.STORE.put(key, await req.text(), { expirationTtl: 300 }); return text("ok", 200, CORS); }
      if (req.method === "GET") { const v = await env.STORE.get(key); return v ? text(v, 200, CORS) : new Response(null, { status: 204, headers: CORS }); }
    }
    m = pathname.match(/^\/api\/clientid\/([^/]+)$/);
    if (m) {
      const key = "clientid:" + m[1];
      if (req.method === "PUT") { await env.STORE.put(key, await req.text(), { expirationTtl: 300 }); return text("ok", 200, CORS); }
      if (req.method === "GET") { const v = await env.STORE.get(key); return v ? text(v, 200, CORS) : new Response(null, { status: 204, headers: CORS }); }
    }

    return text("not found", 404);
  },
};
