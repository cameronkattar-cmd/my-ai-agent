// Runs on Netlify's servers. Keys stay in Netlify environment variables:
//   GEMINI_API_KEY    (required)
//   FIREBASE_API_KEY  (optional; if set, logged-in users are verified)
//   ALLOW_GUESTS      (optional; set to false to require login)

const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"];
const TOOLS = { search: { google_search: {} }, code: { code_execution: {} }, url: { url_context: {} } };
// Extra providers (optional). Each appears in the model picker once its key is set in Netlify.
const PROVIDERS = {
  groq: { label: "Groq", url: "https://api.groq.com/openai/v1", key: () => process.env.GROQ_API_KEY },
  or: { label: "OpenRouter (free)", url: "https://openrouter.ai/api/v1", key: () => process.env.OPENROUTER_API_KEY },
};
const BASE_PROMPT =
  "You are CK AI Agent, a helpful, concise assistant. Use markdown. " +
  "For files, documents, games or small apps, put the COMPLETE file in one fenced block starting ```artifact:filename.ext (apps must be ONE self-contained HTML file). " +
  "For quizzes or practice questions NEVER make a file. Output ONE fenced block starting ```quiz containing only JSON: {\"title\":\"\",\"questions\":[{\"q\":\"\",\"o\":[\"A\",\"B\",\"C\",\"D\"],\"a\":0,\"e\":\"short explanation\",\"m\":1}]}. For short-answer questions omit \"o\" and put the model answer text in \"a\". \"a\" for multiple choice is the index of the correct option. Default 8 questions. For flashcards output ONE ```flashcards block, JSON only: {\"title\":\"\",\"cards\":[{\"f\":\"front\",\"b\":\"back\"}]}, default 10 cards. Keep other text brief. " +
  "You can see attached images/PDFs. Maths: $$..$$ display, \\( .. \\) inline. Diagrams: ```mermaid. " +
  "To make a picture, write one short sentence then a ```image block containing only a detailed English visual prompt. " +
  "Never claim usage is unlimited.";

const BAD = /whisper|tts|guard|orpheus|embed|playai|dall-e|image|moderation|audio|realtime|transcribe|search|instruct|davinci|babbage|codex/i;
const keepModels = (pid, ids) => pid === "or" ? ids.filter((x) => x.endsWith(":free"))
  : ids.filter((x) => !BAD.test(x));

async function handle(req) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const key = (process.env.GEMINI_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!key) return json({ error: "GEMINI_API_KEY is not set in Netlify." }, 500);

  // Logged-in users send a Firebase token. Guests send none and are allowed (with a rate limit).
  // Set ALLOW_GUESTS=false in Netlify to require login again.
  const fb = process.env.FIREBASE_API_KEY;
  const idToken = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (fb && idToken) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return json({ error: "Please log in again." }, 401);
  } else if (fb) {
    if (process.env.ALLOW_GUESTS === "false") return json({ error: "Please log in." }, 401);
    // Best-effort guest limit: 30 requests per 10 minutes per IP (resets if the server restarts).
    const ip = req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "x";
    const now = Date.now(), hits = ((globalThis.__guest ||= new Map()).get(ip) || []).filter((t) => now - t < 600000);
    if (hits.length >= 30) return json({ error: "Guest limit reached. Wait a few minutes or log in." }, 429);
    hits.push(now); globalThis.__guest.set(ip, hits);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (body.mode === "models") {
    const out = [];
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const k = p.key();
      if (!k) continue;
      try {
        const rr = await fetch(p.url + "/models", { headers: { Authorization: "Bearer " + k } });
        const d = await rr.json();
        let list = (d.data || []).map((m) => m.id);
        list = keepModels(id, list);
        out.push({ provider: id, label: p.label, models: list.slice(0, 40) });
      } catch {}
    }
    return json({ providers: out });
  }
  if (body.mode === "image") {
    const prompt = String(body.prompt || "").slice(0, 1500);
    if (!prompt) return json({ error: "No prompt." }, 400);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 40000);
    let err = "Image request failed.";
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Generate an image: " + prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }) }
      );
      const d = await r.json();
      const part = (d?.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData || x.inline_data);
      const idat = part && (part.inlineData || part.inline_data);
      if (r.ok && idat?.data) { clearTimeout(t); return json({ image: idat.data, mime: idat.mimeType || idat.mime_type || "image/png" }); }
      err = d?.error?.message || err;
    } catch { err = "Image timed out."; }
    clearTimeout(t);
    return json({ error: err }, 502);
  }
  if (body.mode === "title") {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text:
              "Summarise this request as a chat title of 3 to 5 words. Reply with only the title, no quotes or final punctuation.\n\n" +
              String(body.text || "").slice(0, 1000) }] }],
          }),
        }
      );
      const d = await r.json();
      const title = (d?.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("")
        .replace(/["\n]/g, "").trim().slice(0, 50);
      return title ? json({ title }) : json({ error: "No title" }, 502);
    } catch {
      return json({ error: "No title" }, 503);
    } finally {
      clearTimeout(t);
    }
  }
  const { messages, plugins = [], instructions = "" } = body;
  const model = MODELS.includes(body.model) ? body.model : MODELS[0];
  if (!Array.isArray(messages) || !messages.length) return json({ error: "No messages." }, 400);

  const contents = messages.slice(-100).map((m) => {
    const parts = [{ text: String(m.text || "(see attached file)").slice(0, 8000) }];
    for (const f of m.att || []) {
      if (f.data) parts.push({ inlineData: { mimeType: f.mime, data: f.data } });
      else if (f.text) parts.push({ text: `\n[File: ${f.name}]\n${String(f.text).slice(0, 60000)}` });
    }
    return { role: m.role === "user" ? "user" : "model", parts };
  });
  const tools = plugins.filter((p) => TOOLS[p]).map((p) => TOOLS[p]);
  const system = BASE_PROMPT + (instructions ? "\nUser's custom instructions: " + String(instructions).slice(0, 3000) : "");

  // ---- Try the chosen model, then automatically fall back (Groq, OpenRouter, other Gemini models) ----
  const t0 = Date.now(), left = () => 52000 - (Date.now() - t0);
  const RETRY = [429, 500, 502, 503, 504];
  const timed = (url, opts) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.min(25000, Math.max(1000, left())));
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  };
  // Small free models have tight per-minute token limits, so send only as much history as fits (~14k characters).
  const trim = (arr) => {
    let n = 0; const out = [];
    for (let i = arr.length - 1; i >= 0 && out.length < 30; i--) {
      n += String(arr[i].text || "").length;
      if (out.length && n > 12000) break;
      out.unshift(arr[i]);
    }
    return out;
  };
  const label = (id) => id.replace(/:free$/, "").split("/").pop().split("|").pop();

  const viaGemini = async (mdl) => {
    const go = (low) => timed(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] }, contents,
          ...(tools.length && { tools }),
          generationConfig: { maxOutputTokens: 6000, ...(low && { thinkingConfig: { thinkingLevel: "low" } }) },
        }) });
    let r = await go(true);
    if (r.status === 400) {
      const pk = await r.clone().json().catch(() => ({}));
      if (/think/i.test(pk?.error?.message || "")) r = await go(false);
    }
    const d = await r.json();
    if (!r.ok) return { status: r.status, error: d?.error?.message };
    const text = (d?.candidates?.[0]?.content?.parts || [])
      .map((x) => x.text || (x.executableCode ? "\n```\n" + x.executableCode.code + "\n```\n" : "")).join("");
    return { text: text || "(No response. It may have been blocked.)" };
  };
  const pick = async (pid, want) => {
    const p = PROVIDERS[pid], k = p.key();
    if (!k) return null;
    try {
      const d = await (await timed(p.url + "/models", { headers: { Authorization: "Bearer " + k } })).json();
      let ids = (d.data || []).map((m) => m.id);
      ids = keepModels(pid, ids);
      return want ? ids.find((x) => want.test(x)) || null : ids[0] || null;
    } catch { return null; }
  };
  const viaProvider = async (pid, mid) => {
    const p = PROVIDERS[pid], k = p && p.key();
    if (!k) return { status: 400, error: "That provider isn't set up in Netlify." };
    const msgs = [{ role: "system", content: system }].concat(
      trim(messages).map((m) => {
        const txt = String(m.text || "").slice(0, 8000) +
          (m.att || []).filter((f) => f.text).map((f) => `\n[File: ${f.name}]\n${String(f.text).slice(0, 30000)}`).join("");
        return { role: m.role === "user" ? "user" : "assistant", content: txt };
      }));
    const r = await timed(p.url + "/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k },
      body: JSON.stringify({ model: mid, messages: msgs, max_tokens: 4096 }) });
    const d = await r.json();
    if (!r.ok) return { status: r.status, error: d?.error?.message };
    return { text: d?.choices?.[0]?.message?.content || "(No response.)" };
  };

  // Text-only fallbacks (Groq/OpenRouter) cannot see images or PDFs, so skip them when media is attached.
  const hasMedia = messages.some((m) => (m.att || []).some((f) => f.data));
  const sep = String(body.model || "").indexOf("|");
  const chosenId = sep > 0 ? body.model : model;
  // Fallback order, best quality first: Gemini (best to lightest), then Groq 70B, Groq 8B, then OpenRouter.
  const LADDER = [
    ["g", "gemini-3.8-flash"], ["g", "gemini-3.5-flash"], ["g", "gemini-3.5-flash-lite"], ["g", "gemini-3.1-flash-lite"],
    ["auto", "groq", /llama.*70b/i], ["auto", "groq", /llama.*8b/i], ["auto", "or", null],
  ];
  const order = [sep > 0 ? ["p", body.model.slice(0, sep), body.model.slice(sep + 1)] : ["g", model], ...LADDER];
  const tried = new Set();

  let first = true, lastErr;
  for (const [kind, a, b] of order) {
    if (left() < 1200) break;
    if (hasMedia && kind !== "g") continue;
    let mid = b, r;
    if (kind === "auto") { mid = await pick(a, b); if (!mid) continue; }
    const used = kind === "g" ? a : a + "|" + mid;
    if (tried.has(used)) continue;
    tried.add(used);
    const bad = (globalThis.__bad ||= new Map());
    if (!first && bad.get(used) > Date.now()) continue;
    try {
      r = kind === "g" ? await viaGemini(a) : await viaProvider(a, mid);
    } catch { r = { status: 503, error: "Timed out." }; }
    if (r.text) return json({ text: r.text, model: used, label: label(used), switched: used !== chosenId });
    if (RETRY.includes(r.status)) bad.set(used, Date.now() + 90000);
    lastErr = lastErr || r;
    if (first && !RETRY.includes(r.status)) return json({ error: r.error || "Request failed." }, r.status || 500);
    first = false;
  }
  return json({ error: lastErr?.error || "Every model is busy right now. Try again in a minute." }, 503);
};

export const POST = (req) => handle(req);
export const GET = () => json({ error: "Method not allowed" }, 405);

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
