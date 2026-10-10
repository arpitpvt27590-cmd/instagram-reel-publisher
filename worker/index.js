const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "";
  if (origin && allowed && origin === allowed) {
    return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Authorization,Content-Type", "vary": "Origin" };
  }
  return {};
}
function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const [k,v] of Object.entries(corsHeaders(request, env))) h.set(k,v);
  return new Response(response.body, {status:response.status, headers:h});
}
function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  return !!env.DASHBOARD_PASSWORD && provided.length > 0 && provided === env.DASHBOARD_PASSWORD;
}
function getAccounts(env) {
  let accounts;
  try { accounts = JSON.parse(env.META_ACCOUNTS_JSON || "[]"); } catch { throw new Error("META_ACCOUNTS_JSON is not valid JSON."); }
  if (!Array.isArray(accounts)) throw new Error("META_ACCOUNTS_JSON must be a JSON array.");
  return accounts;
}
async function graph(url, params) {
  const response = await fetch(url, {method:"POST", body:params});
  const data = await response.json().catch(()=>({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Meta API returned HTTP ${response.status}`);
  return data;
}
async function publishToAccount(account, videoUrl, caption, coverUrl) {
  if (!account.igUserId || !account.accessToken || !account.graphVersion) throw new Error("Account configuration is incomplete.");
  const base = `https://graph.facebook.com/${account.graphVersion}/${encodeURIComponent(account.igUserId)}`;
  const params = new URLSearchParams({media_type:"REELS",video_url:videoUrl,caption:caption || "",access_token:account.accessToken});
  if (coverUrl) params.set("cover_url", coverUrl);
  const created = await graph(`${base}/media`, params);
  if (!created.id) throw new Error("Meta did not return a media container ID.");
  // Poll processing for up to ~2 minutes.
  let ready = false, lastStatus = "";
  for (let i=0; i<24; i++) {
    const checkUrl = new URL(`https://graph.facebook.com/${account.graphVersion}/${created.id}`);
    checkUrl.searchParams.set("fields","status_code,status");
    checkUrl.searchParams.set("access_token",account.accessToken);
    const res = await fetch(checkUrl);
    const state = await res.json().catch(()=>({}));
    if (!res.ok || state.error) throw new Error(state.error?.message || "Could not check media processing status.");
    lastStatus = state.status_code || state.status || "";
    if (lastStatus === "FINISHED") { ready=true; break; }
    if (lastStatus === "ERROR" || lastStatus === "EXPIRED") throw new Error(`Meta processing status: ${lastStatus}`);
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  if (!ready) throw new Error(`Meta is still processing the Reel (${lastStatus || "unknown status"}). Try again later.`);
  const published = await graph(`${base}/media_publish`, new URLSearchParams({creation_id:created.id,access_token:account.accessToken}));
  if (!published.id) throw new Error("Meta did not confirm a published media ID.");
  return {mediaId:published.id};
}
export default {
 async fetch(request, env) {
  if (request.method === "OPTIONS") return withCors(new Response(null,{status:204}),request,env);
  const url = new URL(request.url);
  try {
   if (url.pathname === "/api/health" && request.method === "GET") return withCors(json({ok:true}),request,env);
   if (!authorized(request,env)) return withCors(json({error:"Incorrect dashboard password or password not configured."},401),request,env);
   if (url.pathname === "/api/accounts" && request.method === "GET") {
     const accounts = getAccounts(env).map(a=>({id:a.id,label:a.label || a.id}));
     return withCors(json({accounts}),request,env);
   }
   if (url.pathname === "/api/publish" && request.method === "POST") {
     if (!env.MEDIA || !env.R2_PUBLIC_BASE_URL) return withCors(json({error:"R2 is not configured. Set the MEDIA bucket binding and R2_PUBLIC_BASE_URL."},500),request,env);
     const form = await request.formData();
     const video = form.get("video"), cover = form.get("cover");
     const caption = String(form.get("caption") || "");
     let accountIds;
     try { accountIds = JSON.parse(String(form.get("accountIds") || "[]")); } catch { return withCors(json({error:"Invalid account selection."},400),request,env); }
     if (!video || typeof video.arrayBuffer !== "function") return withCors(json({error:"A video file is required."},400),request,env);
     if (!Array.isArray(accountIds) || !accountIds.length) return withCors(json({error:"Select at least one account."},400),request,env);
     if (video.size > 1024*1024*1024) return withCors(json({error:"Video exceeds the 1 GB starter limit."},413),request,env);
     const accounts = getAccounts(env);
     const selected = accounts.filter(a=>accountIds.includes(a.id));
     if (selected.length !== accountIds.length) return withCors(json({error:"One or more selected accounts are not configured."},400),request,env);
     const suffix = crypto.randomUUID();
     const videoKey = `temporary/${suffix}.mp4`;
     let coverKey = null;
     try {
       await env.MEDIA.put(videoKey, await video.arrayBuffer(), {httpMetadata:{contentType:video.type || "video/mp4"}});
       if (cover && typeof cover.arrayBuffer === "function" && cover.size) {
         coverKey = `temporary/${crypto.randomUUID()}.${(cover.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi,"").slice(0,8)}`;
         await env.MEDIA.put(coverKey, await cover.arrayBuffer(), {httpMetadata:{contentType:cover.type || "image/jpeg"}});
       }
       const base = env.R2_PUBLIC_BASE_URL.replace(/\/+$/,"");
       const videoUrl = `${base}/${videoKey}`;
       const coverUrl = coverKey ? `${base}/${coverKey}` : "";
       const results = [];
       for (const account of selected) {
         try { const out = await publishToAccount(account,videoUrl,caption,coverUrl); results.push({id:account.id,label:account.label || account.id,success:true,message:`Media ID ${out.mediaId}`}); }
         catch (e) { results.push({id:account.id,label:account.label || account.id,success:false,message:String(e.message || e)}); }
       }
       return withCors(json({results}),request,env);
     } finally {
       // Meta must finish fetching the public URL before deletion. Short delay allows initial fetch;
       // configure an R2 lifecycle rule for temporary/ as a backup cleanup measure.
       await new Promise(resolve=>setTimeout(resolve,60000));
       await env.MEDIA.delete(videoKey).catch(()=>{});
       if (coverKey) await env.MEDIA.delete(coverKey).catch(()=>{});
     }
   }
   return withCors(json({error:"Not found."},404),request,env);
  } catch(e) {
   return withCors(json({error:String(e.message || e)},500),request,env);
  }
 }
};
