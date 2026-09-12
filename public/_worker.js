// hons.ca - static site on Pages, plus the three things that cannot
// be static: the media library (R2), the contact form, and the on-demand
// WordPress editor. In Pages "advanced mode" this file handles every request,
// so static pages are served explicitly through env.ASSETS.
//
// Editor: WordPress runs only while someone is editing, inside a GitHub Actions
// runner reached through a tunnel at EDIT_HOST. Admin paths are proxied there;
// when no session is up, a page offers to start one.

const ADMIN = /^\/(wp-admin|wp-login\.php|wp-signup\.php|wp-cron\.php|wp-json|wp-includes)(\/|$|\?)/i;

// wp-content is deliberately NOT proxied: theme and uploads are already in the
// published site, and the public pages need them whether or not a session runs.

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1e2430;background:#f6f7f9}
 .box{max-width:560px;margin:16vh auto;padding:34px 38px;background:#fff;border-radius:10px;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
 h1{font-size:21px;margin:0 0 12px}
 p{margin:0 0 18px;color:#48505e}
 button{font:inherit;padding:11px 20px;border:0;border-radius:7px;background:#2b6cb0;color:#fff;cursor:pointer}
 button:hover{background:#245a94}
 .spin{display:inline-block;width:15px;height:15px;border:2px solid #cbd5e0;border-top-color:#2b6cb0;
       border-radius:50%;animation:s .8s linear infinite;vertical-align:-2px;margin-right:8px}
 @keyframes s{to{transform:rotate(360deg)}}
</style>
<div class="box">${body}</div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

// A session costs a runner and puts a login on the internet, so only start one
// for something that looks like a person driving a browser. This is mitigation,
// not authentication - it is why starting requires a POST from the button.
function looksLikeAPerson(request) {
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const accept = request.headers.get("accept") || "";
  if (!ua || !accept.includes("text/html")) return false;
  return !/(bot|crawl|spider|slurp|curl|wget|python|go-http|java|libwww|scan|headless|okhttp)/.test(ua);
}

async function sessionRunning(env) {
  if (!env.GH_TOKEN) return false;
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/runs?per_page=5`;
  const r = await fetch(url, {
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "site-editor",
    },
  });
  if (!r.ok) return false;
  const d = await r.json();
  return (d.workflow_runs || []).some(
    (x) => x.status === "queued" || x.status === "in_progress"
  );
}

async function startSession(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "site-editor",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { tunnel: true, idle_minutes: env.IDLE_MINUTES || "15", export_only: false },
    }),
  });
}

const NOT_RUNNING = `
  <h1><span class="spin"></span>Starting the editor</h1>
  <p>WordPress runs only while you are editing, so it takes a minute to come up.
     The login page will open by itself.</p>
  <form method="POST" action="/__editor-start" id="f">
    <button type="submit">Start the editor</button>
  </form>
  <script>
    // Auto-start, but from JavaScript rather than on the bare GET. A plain GET
    // auto-start was live on two other sites in this estate and was driven by
    // scanners roughly hourly - each probe spent a runner and exposed a login.
    // Requiring script execution stops the crawlers that do not run JS, while a
    // real visitor never sees the button.
    (function(){
      var f=document.getElementById('f');
      if(f){ f.style.display='none'; setTimeout(function(){ f.submit(); }, 250); }
    })();
  </script>`;

const WAITING = `
  <h1><span class="spin"></span>Starting the editor</h1>
  <p>This usually takes a minute or two. The login page will open by itself.</p>
  <script>
    (function poll(){
      fetch('/__editor-status',{cache:'no-store'})
        .then(r=>r.json())
        .then(d=>{ if(d.ready){ location.href='/wp-admin/'; } else { setTimeout(poll,5000); } })
        .catch(()=>setTimeout(poll,5000));
    })();
  </script>`;


const TZ = "America/Vancouver";
function esc(v){return String(v==null?"":v).replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));}
function local(iso){
  try{return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,dateStyle:"medium",timeStyle:"medium"}).format(new Date(iso));}
  catch(e){return iso;}
}

// Every visit to an admin path is recorded, signed in or not. This is how the
// scanner traffic on the other sites in this estate was discovered.
async function logAccess(env, request, url, path) {
  if (!env.LOGS) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const stamp = now.toISOString().slice(11, 23).replace(/[:.]/g, "");
  const cf = request.cf || {};
  const entry = {
    time: now.toISOString(),
    ip: request.headers.get("cf-connecting-ip") || "-",
    country: cf.country || "-",
    city: cf.city || "-",
    asn: cf.asOrganization || "-",
    method: request.method,
    path: path + (url.search || ""),
    ua: request.headers.get("user-agent") || "-",
    ref: request.headers.get("referer") || "-",
  };
  try {
    await env.LOGS.put(`access/${day}/${stamp}-${Math.random().toString(36).slice(2,8)}.json`,
      JSON.stringify(entry), { httpMetadata: { contentType: "application/json" } });
  } catch (e) { /* logging must never break the page */ }
}

async function logPage(request, env, url) {
  if (!env.LOG_KEY || url.searchParams.get("key") !== env.LOG_KEY) {
    return new Response("Not Found", { status: 404 });
  }
  let access = [];
  try {
    const listed = await env.LOGS.list({ prefix: "access/", limit: 1000 });
    const keys = listed.objects.map(o => o.key).sort().reverse().slice(0, 150);
    access = (await Promise.all(keys.map(async k => {
      try { return await (await env.LOGS.get(k)).json(); } catch (e) { return null; }
    }))).filter(Boolean);
  } catch (e) { /* keep rendering */ }
  const running = await sessionRunning(env);
  const tz = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,timeZoneName:"short"})
    .formatToParts(new Date()).find(x=>x.type==="timeZoneName").value;
  const rows = access.map(e => `<tr><td>${esc(local(e.time))}</td><td>${esc(e.ip)}</td>
    <td>${esc(e.country)} ${esc(e.city)}</td><td class="p">${esc(e.method)} ${esc(e.path)}</td>
    <td class="u">${esc((e.ua||"").slice(0,60))}</td><td class="u">${esc((e.asn||"").slice(0,28))}</td></tr>`).join("");
  return new Response(
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Editor log</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
 body{font:14px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#faf9f7;color:#2b2b2b}
 h2{font-weight:600;margin:1.6em 0 .4em}h2:first-child{margin-top:0}
 .n{color:#8a837a;font-size:13px}
 table{border-collapse:collapse;width:100%;margin-top:.6em;background:#fff;
       box-shadow:0 1px 2px rgba(0,0,0,.06);border-radius:6px;overflow:hidden}
 th{text-align:left;font-weight:600;background:#f2efea;padding:7px 10px;white-space:nowrap}
 td{padding:6px 10px;border-top:1px solid #f0ece6;vertical-align:top}
 td.p{font-family:ui-monospace,Menlo,monospace;font-size:12px}
 td.u{color:#8a837a;font-size:12px}
 .wrap{max-width:1100px;margin:auto}
</style></head><body><div class="wrap">
<h2>Editing session</h2>
<p class="n">${running ? "A session is running now." : "No session is running."}</p>
<h2>Visits to the editor address</h2>
<p class="n">Everyone who reached it, whether or not they signed in. Last ${access.length}, newest first. Times ${esc(tz)}.</p>
<table><tr><th>Time</th><th>Address</th><th>Where</th><th>Request</th><th>Browser</th><th>Network</th></tr>
${rows || '<tr><td colspan="6">nothing recorded yet</td></tr>'}</table>
</div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}


// hons.ca contact form (WPForms #1291): First/Last name, Email, Phone, Request,
// plus a "Category" checkbox group handled separately (getAll) below.
const FIELDS = [
  ["first-name", "First name", true],
  ["last-name", "Last name", true],
  ["email", "Email", true],
  ["phone", "Phone", true],
  ["request", "Request", false],
];

const NL = String.fromCharCode(10);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // The apex (hons.ca) now points at Cloudflare too, so it no longer needs the
    // old origin's apex->www redirect. www is canonical: send the apex there.
    // Exempt /.well-known so the Pages custom-domain (cert) challenge can pass.
    if (url.hostname === "hons.ca" && !path.startsWith("/.well-known/")) {
      return Response.redirect("https://www.hons.ca" + path + url.search, 301);
    }

    // The media library is not in this deployment - it is in R2, because it is
    // ~800 MB of video and camera originals that neither the runner nor the
    // export should ever carry. Fall back to the deployed assets so the switch
    // is safe while the one-time upload is still filling the bucket.
    if (path.startsWith("/wp-content/uploads/") && env.MEDIA && request.method === "GET") {
      const obj = await env.MEDIA.get(decodeURIComponent(path.slice(1)));
      if (obj) {
        const h = new Headers();
        obj.writeHttpMetadata(h);
        // Trust the extension over a weak stored type: minified CSS uploaded as
        // text/plain is refused by browsers under nosniff, and this site ships that.
        const stored = (h.get("content-type") || "").split(";")[0].trim();
        const byExt = mediaType(path);
        if (!stored || stored === "text/plain" || stored === "application/octet-stream" || (byExt !== "application/octet-stream" && stored !== byExt && /\.(css|js|svg|webp|woff2?)$/i.test(path))) {
          h.set("content-type", byExt);
        }
        h.set("etag", obj.httpEtag);
        h.set("cache-control", "public, max-age=86400");
        return new Response(obj.body, { headers: h });
      }
    }

    // hons.ca mail is on Microsoft 365, so /webmail belongs to Outlook on the
    // web, not to this site - people have the old bookmark. 302, not 301: a
    // permanent redirect cached in browsers would be very hard to walk back.
    if (/^\/webmail(\/|$)/i.test(path)) {
      return Response.redirect("https://outlook.office.com/mail/", 302);
    }

    if (path === "/contact-send") {
      if (request.method !== "POST") return Response.redirect(`${url.origin}/contact-us/`, 303);
      return handleContact(request, env, url);
    }

    // The careers application form (WPForms #1358) carries a required resume
    // upload, so it posts here rather than to /contact-send.
    if (path === "/apply-send") {
      if (request.method !== "POST") return Response.redirect(`${url.origin}/about/careers/`, 303);
      return handleApplication(request, env, url);
    }

    if (path === "/__editor-log") return logPage(request, env, url);

    // Has WordPress answered yet? Used by the waiting page.
    if (path === "/__editor-status") {
      let ready = false;
      try {
        const probe = await fetch(`https://${env.EDIT_HOST}/wp-login.php`, { method: "HEAD", redirect: "manual" });
        ready = probe.status < 500;
      } catch { ready = false; }
      return new Response(JSON.stringify({ ready }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // The ONLY path that spends a runner, and only on a POST. An unauthenticated
    // GET must never be treated as consent: scanners walk /wp-admin constantly.
    if (path === "/__editor-start") {
      if (request.method !== "POST") return Response.redirect(`${url.origin}/wp-admin/`, 303);
      if (looksLikeAPerson(request) && env.GH_TOKEN) {
        if (!(await sessionRunning(env))) await startSession(env);
      }
      return page("Starting the editor", WAITING);
    }

    // Public assets under /wp-includes/ and /wp-content/ belong to the export.
    // Only when the export has nothing (the HTML fallback comes back) does the
    // request fall through to the editor proxy - otherwise product pages lose
    // their JS whenever no session is running.
    if (/^\/wp-(includes|content)\//i.test(path) && (request.method === "GET" || request.method === "HEAD")) {
      const a = await env.ASSETS.fetch(request);
      const ct = (a.headers.get("content-type") || "").toLowerCase();
      if (a.status === 200 && !ct.startsWith("text/html")) return a;
      if (!/^\/wp-includes\//i.test(path)) return a;
    }

    if (ADMIN.test(path)) {
      ctx.waitUntil(logAccess(env, request, url, path));
      if (!env.EDIT_HOST) return page("Editing is not configured", NOT_RUNNING, 503);
      const target = new URL(request.url);
      target.hostname = env.EDIT_HOST;
      target.protocol = "https:";
      target.port = "";
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-proto", "https");
      let upstream;
      try {
        upstream = await fetch(new Request(target, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual",
        }));
      } catch {
        return page("The editor is not running", NOT_RUNNING, 503);
      }
      if (upstream.status === 530 || upstream.status === 502 || upstream.status === 523) {
        return page("The editor is not running", NOT_RUNNING, 503);
      }
      const out = new Headers(upstream.headers);
      out.delete("content-security-policy");
      out.delete("content-security-policy-report-only");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    // Everything else is the published static site.
    return env.ASSETS.fetch(request);
  },
};

const MEDIA_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
  css: "text/css", js: "application/javascript", woff: "font/woff", woff2: "font/woff2" };
function mediaType(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return MEDIA_TYPES[ext] || "application/octet-stream";
}

async function handleContact(request, env, url) {
  let f;
  try {
    f = await request.formData();
  } catch (e) {
    return contactResult(url, false, "That form could not be read.");
  }

  // Honeypot: hidden from people, irresistible to bots. Accept quietly rather
  // than explaining to a robot what gave it away.
  if ((f.get("website") || "").toString().trim() !== "") return contactResult(url, true, "", true);

  const data = {};
  for (const [name, label, required] of FIELDS) {
    const v = (f.get(name) || "").toString().trim().slice(0, 2000);
    if (required && !v) return contactResult(url, false, `${label} is required.`);
    data[label] = v;
  }
  // "Category" is a checkbox group - a person can tick more than one.
  const cats = f.getAll("category").map((x) => x.toString().trim()).filter(Boolean);
  if (cats.length) data["Category"] = cats.join(", ");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data["Email"])) {
    return contactResult(url, false, "That email address does not look right.");
  }

  const now = new Date();
  data["Submitted"] = now.toISOString();
  data["From address"] = request.headers.get("cf-connecting-ip") || "-";

  // Store first. If Postmark is down or misconfigured the enquiry still exists,
  // rather than being lost the way this estate has lost them before.
  let stored = false;
  const key = `enquiries/${now.toISOString().slice(0, 10)}/${now.getTime()}-${Math.random().toString(36).slice(2, 8)}.json`;
  if (env.DATA) {
    try {
      await env.DATA.put(key, JSON.stringify(data, null, 2),
        { httpMetadata: { contentType: "application/json" } });
      stored = true;
    } catch (e) { /* the email is the backstop */ }
  }

  let mailed = false;
  if (env.POSTMARK_TOKEN && env.FORM_TO && env.FORM_FROM) {
    const lines = Object.entries(data).map(([k, v]) => `${k}: ${v || "-"}`).join(NL);
    try {
      const r = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          From: env.FORM_FROM,
          To: env.FORM_TO,
          ReplyTo: data["Email"],
          Subject: `Contact Form Submission from ${data["First name"]} ${data["Last name"]}`,
          TextBody: `A message was sent from the website contact form.${NL}${NL}${lines}${NL}`,
          MessageStream: "outbound",
        }),
      });
      mailed = r.ok;
      // Record what Postmark said. Without this a failed send is invisible:
      // the enquiry is stored, the visitor sees "thank you", and nobody knows.
      data["_delivery"] = { status: r.status, body: (await r.text()).slice(0, 300) };
    } catch (e) {
      mailed = false;
      data["_delivery"] = { status: 0, body: String(e && e.message || e).slice(0, 300) };
    }
  } else {
    data["_delivery"] = { status: 0, body: "not attempted: " +
      (env.POSTMARK_TOKEN ? "" : "POSTMARK_TOKEN missing ") +
      (env.FORM_TO ? "" : "FORM_TO missing ") + (env.FORM_FROM ? "" : "FORM_FROM missing ") };
  }
  data["_delivery"].mailed = mailed;
  if (stored) {
    try {
      await env.DATA.put(key, JSON.stringify(data, null, 2),
        { httpMetadata: { contentType: "application/json" } });
    } catch (e) { /* the first copy is still there */ }
  }

  // Never tell someone their message went through when nothing kept it.
  if (!stored && !mailed) {
    return contactResult(url, false,
      "We could not deliver that just now. Please email info@hons.ca directly.");
  }
  return contactResult(url, true, "", mailed);
}

function contactResult(url, ok, error, backPath) {
  const back = backPath || "/contact-us/";
  const body = ok
    ? `<h2>Thank you &mdash; we have your message</h2>
       <p>Someone will get back to you shortly.</p>`
    : `<h2>That did not go through</h2><p>${error}</p>`;
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${ok ? "Message received" : "Something went wrong"}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
 body{font:16px/1.65 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;
      display:flex;align-items:center;justify-content:center;background:#f6f6f4;color:#232323;padding:24px}
 main{max-width:32em;text-align:center;background:#fff;padding:38px 34px;border-radius:8px;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
 h2{font-weight:600;margin:0 0 .6em} a{color:#b3282d}
</style></head><body><main>${body}
<p style="margin-top:2em"><a href="${url.origin}${back}">Back to the site</a></p></main></body></html>`,
    { status: ok ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Base64-encode an ArrayBuffer in chunks (btoa on a huge string overflows).
function toBase64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

const APPLY_FIELDS = [
  ["first-name", "First name", true],
  ["last-name", "Last name", true],
  ["email", "Email", true],
  ["phone", "Phone", true],
];
const RESUME_MAX = 8 * 1024 * 1024; // 8 MB - Postmark caps a message at 10 MB
const RESUME_OK = /\.(pdf|docx?|rtf|odt|txt|pages)$/i;
const APPLY_BACK = "/about/careers/";

// The careers application: like the contact form, but with a required resume
// file. The file is stored in R2 (kept, in case email delivery fails) and also
// sent to HR as a Postmark attachment, replacing the WordPress upload handler.
async function handleApplication(request, env, url) {
  let f;
  try {
    f = await request.formData();
  } catch (e) {
    return contactResult(url, false, "That form could not be read.", APPLY_BACK);
  }
  if ((f.get("website") || "").toString().trim() !== "") return contactResult(url, true, "", APPLY_BACK);

  const data = {};
  for (const [name, label, required] of APPLY_FIELDS) {
    const v = (f.get(name) || "").toString().trim().slice(0, 2000);
    if (required && !v) return contactResult(url, false, `${label} is required.`, APPLY_BACK);
    data[label] = v;
  }
  const positions = f.getAll("position").map((x) => x.toString().trim()).filter(Boolean);
  if (positions.length) data["Position"] = positions.join(", ");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data["Email"])) {
    return contactResult(url, false, "That email address does not look right.", APPLY_BACK);
  }

  const file = f.get("resume");
  if (!file || typeof file === "string" || !file.size) {
    return contactResult(url, false, "Please attach your resume.", APPLY_BACK);
  }
  if (!RESUME_OK.test(file.name || "")) {
    return contactResult(url, false, "Please upload a PDF, Word, RTF or text document.", APPLY_BACK);
  }
  if (file.size > RESUME_MAX) {
    return contactResult(url, false, "That file is too large - please keep it under 8 MB.", APPLY_BACK);
  }

  const now = new Date();
  data["Submitted"] = now.toISOString();
  data["From address"] = request.headers.get("cf-connecting-ip") || "-";

  const buf = await file.arrayBuffer();
  const safe = (file.name || "resume").replace(/[^A-Za-z0-9._-]/g, "_").slice(-90);
  const ct = file.type || "application/octet-stream";
  const rkey = `resumes/${now.toISOString().slice(0, 10)}/${now.getTime()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;

  // Store the resume first, so a Postmark failure never loses an application.
  let stored = false;
  if (env.RESUMES) {
    try {
      await env.RESUMES.put(rkey, buf, { httpMetadata: { contentType: ct } });
      stored = true;
    } catch (e) { /* the email attachment is the backstop */ }
  }
  data["Resume"] = stored ? `${file.name} (${Math.round(file.size / 1024)} KB) -> R2:${rkey}` : `${file.name} (not stored)`;

  const to = env.APPLY_TO || env.FORM_TO;
  let mailed = false;
  if (env.POSTMARK_TOKEN && to && env.FORM_FROM) {
    const lines = Object.entries(data).map(([k, v]) => `${k}: ${v || "-"}`).join(NL);
    try {
      const r = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": env.POSTMARK_TOKEN,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          From: env.FORM_FROM,
          To: to,
          ReplyTo: data["Email"],
          Subject: `Job Application from ${data["First name"]} ${data["Last name"]}`,
          TextBody: `A job application was submitted on the website.${NL}${NL}${lines}${NL}`,
          Attachments: [{ Name: file.name || "resume", Content: toBase64(buf), ContentType: ct }],
          MessageStream: "outbound",
        }),
      });
      mailed = r.ok;
      data["_delivery"] = { status: r.status, body: (await r.text()).slice(0, 300) };
    } catch (e) {
      data["_delivery"] = { status: 0, body: String((e && e.message) || e).slice(0, 300) };
    }
  } else {
    data["_delivery"] = { status: 0, body: "not attempted: " +
      (env.POSTMARK_TOKEN ? "" : "POSTMARK_TOKEN missing ") +
      (to ? "" : "APPLY_TO/FORM_TO missing ") + (env.FORM_FROM ? "" : "FORM_FROM missing ") };
  }
  data["_delivery"].mailed = mailed;

  // A JSON record of every application, alongside the enquiries.
  if (env.DATA) {
    try {
      const jkey = `applications/${now.toISOString().slice(0, 10)}/${now.getTime()}-${Math.random().toString(36).slice(2, 8)}.json`;
      await env.DATA.put(jkey, JSON.stringify(data, null, 2), { httpMetadata: { contentType: "application/json" } });
    } catch (e) { /* the resume + email are the record */ }
  }

  if (!stored && !mailed) {
    return contactResult(url, false,
      "We could not submit that just now. Please email your resume to hr@hons.ca directly.", APPLY_BACK);
  }
  return contactResult(url, true, "", APPLY_BACK);
}
