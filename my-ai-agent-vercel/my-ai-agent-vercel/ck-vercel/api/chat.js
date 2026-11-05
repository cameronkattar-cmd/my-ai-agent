// Vercel serverless function: POST /api/chat
// Env vars: GEMINI_API_KEY (required), FIREBASE_API_KEY (login check), GROQ_API_KEY / OPENROUTER_API_KEY (optional backups),
// ALLOW_GUESTS=false (optional, to require login)
const GEM = "https://generativelanguage.googleapis.com/v1beta/models/";
const PROVIDERS = {
  groq: { label: "Groq", url: "https://api.groq.com/openai/v1", key: () => process.env.GROQ_API_KEY },
  or: { label: "OpenRouter (free)", url: "https://openrouter.ai/api/v1", key: () => process.env.OPENROUTER_API_KEY },
};
const TOOLS = { search: { google_search: {} }, code: { code_execution: {} }, url: { url_context: {} } };
// Fallback order, best first. "Auto" starts at the top and moves down as each model runs out.
const LADDER = [
  ["g", "gemini-3.8-flash"], ["g", "gemini-3.5-flash"], ["g", "gemini-3.5-flash-lite"], ["g", "gemini-3.1-flash-lite"],
  ["auto", "groq", /llama.*70b/i], ["auto", "groq", /llama.*8b/i], ["auto", "or", null],
];
const GEMINI_IDS = LADDER.filter((l) => l[0] === "g").map((l) => l[1]);
const PROMPT =
  "You are CK AI Agent, a helpful, concise personal assistant. Use markdown. " +
  "When the user wants a file, document, quiz, study tool, game or small app, put the COMPLETE file in one fenced block whose first line is ```artifact:filename.ext (for example ```artifact:quiz.html). Interactive items must be ONE self-contained HTML file with inline CSS and JS and no external resources. Keep prose outside the block short. " +
  "For quizzes: put the questions in a JS array; show one question at a time with 4 options, instant right/wrong feedback with a one-line explanation, a progress bar, a final score screen with a Retry button; modern, clean, mobile-friendly design. If the user attached notes or a file, base every question on it. " +
  "You do not know this app's usage limits, quotas or plan. Never claim usage is unlimited; say limits depend on the user's plan and may cause temporary busy errors.";
const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
const hits = (globalThis.__ckHits ||= new Map());
const limited = (ip) => {
  const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 6e5);
  a.push(now); hits.set(ip, a); return a.length > 30;
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const key = clean(process.env.GEMINI_API_KEY);
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const mode = body.mode || "chat";

  // who is calling: logged in (incl. anonymous Firebase users) or plain guest
  const fb = process.env.FIREBASE_API_KEY, token = (req.headers.authorization || "").replace("Bearer ", "");
  let signedIn = false;
  if (fb && token) {
    try {
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fb}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
      signedIn = r.ok;
    } catch {}
  }
  if (!signedIn && mode !== "models") {
    if (process.env.ALLOW_GUESTS === "false") return res.status(401).json({ error: "Please log in." });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
    if (mode !== "title" && limited(ip)) return res.status(429).json({ error: "Guest limit reached (30 requests per 10 minutes). Log in or wait a bit." });
  }

  const t0 = Date.now(), left = () => 55000 - (Date.now() - t0);
  const timed = (url, opts, cap = 28000) => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), Math.max(1000, Math.min(cap, left())));
    return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
  };
  const gem = (m, payload, cap) => timed(`${GEM}${m}:generateContent?key=${encodeURIComponent(key)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, cap);
  const listIds = async (pid) => {
    const p = PROVIDERS[pid], k = p.key(); if (!k) return null;
    try {
      const d = await (await timed(p.url + "/models", { headers: { Authorization: "Bearer " + k } }, 8000)).json();
      const ids = (d.data || []).map((m) => m.id);
      return pid === "or" ? ids.filter((x) => x.endsWith(":free")) : ids.filter((x) => !/whisper|tts|guard|orpheus|embed|playai/i.test(x));
    } catch { return null; }
  };

  if (mode === "models") {
    const out = [];
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const ids = await listIds(id);
      if (ids && ids.length) out.push({ provider: id, label: p.label, models: ids.slice(0, 40) });
    }
    return res.status(200).json({ providers: out });
  }

  if (mode === "title") {
    try {
      const r = await gem("gemini-3.5-flash-lite", { contents: [{ role: "user", parts: [{ text:
        "Summarise this request as a chat title of 3 to 5 words. Reply with only the title, no quotes or final punctuation.\n\n" + String(body.text || "").slice(0, 1000) }] }] }, 9000);
      const d = await r.json();
      const title = (d?.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("").replace(/["\n]/g, "").trim().slice(0, 50);
      return title ? res.status(200).json({ title }) : res.status(502).json({ error: "No title" });
    } catch { return res.status(503).json({ error: "No title" }); }
  }

  if (mode === "image") {
    for (const m of ["gemini-2.5-flash-image", "gemini-3.1-flash-image"]) {
      try {
        const r = await gem(m, { contents: [{ role: "user", parts: [{ text: String(body.prompt || "").slice(0, 1500) }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }, 40000);
        const d = await r.json();
        const part = (d?.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData?.data);
        if (r.ok && part) return res.status(200).json({ image: part.inlineData.data, mime: part.inlineData.mimeType });
      } catch {}
    }
    return res.status(502).json({ error: "Image generation isn't available right now." });
  }

  // ---------------- chat ----------------
  const { messages, plugins = [], instructions = "" } = body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "No messages." });
  const hasBinary = messages.some((m) => (m.att || []).some((f) => f.data));
  const contents = messages.slice(-100).map((m) => {
    const parts = [{ text: String(m.text || "(see attached file)").slice(0, 8000) }];
    for (const f of m.att || []) {
      if (f.data) parts.push({ inlineData: { mimeType: f.mime, data: f.data } });
      else if (f.text) parts.push({ text: `\n[File: ${f.name}]\n${String(f.text).slice(0, 60000)}` });
    }
    return { role: m.role === "user" ? "user" : "model", parts };
  });
  const tools = plugins.filter((p) => TOOLS[p]).map((p) => TOOLS[p]);
  const system = PROMPT + (instructions ? "\nUser's custom instructions: " + String(instructions).slice(0, 3000) : "");

  const viaGemini = async (m) => {
    const go = (low) => gem(m, { systemInstruction: { parts: [{ text: system }] }, contents,
      ...(tools.length && { tools }), ...(low && { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } }) });
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
  const trim = (arr) => {
    let n = 0; const out = [];
    for (let i = arr.length - 1; i >= 0 && out.length < 60; i--) {
      n += String(arr[i].text || "").length;
      if (out.length && n > 14000) break;
      out.unshift(arr[i]);
    }
    return out;
  };
  const viaProvider = async (pid, mid) => {
    const p = PROVIDERS[pid], k = p && p.key();
    if (!k) return { status: 400, error: "That provider isn't set up in Vercel." };
    const msgs = [{ role: "system", content: system }].concat(trim(messages).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: String(m.text || "").slice(0, 8000) + (m.att || []).filter((f) => f.text).map((f) => `\n[File: ${f.name}]\n${String(f.text).slice(0, 30000)}`).join(""),
    })));
    const r = await timed(p.url + "/chat/completions", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + k }, body: JSON.stringify({ model: mid, messages: msgs }) });
    const d = await r.json();
    if (!r.ok) return { status: r.status, error: d?.error?.message };
    return { text: d?.choices?.[0]?.message?.content || "(No response.)" };
  };

  const want = String(body.model || "auto"), sep = want.indexOf("|");
  const ladder = hasBinary ? LADDER.filter((l) => l[0] === "g") : LADDER; // only Gemini can see pictures/PDFs
  const head = GEMINI_IDS.includes(want) ? [["g", want]] : sep > 0 && !hasBinary ? [["p", want.slice(0, sep), want.slice(sep + 1)]] : [];
  const chosenId = head.length ? want : ladder[0][1];
  const RETRY = [429, 500, 502, 503, 504];
  const tried = new Set();
  let first = true, lastErr, geminiOut = false; // one Gemini "out of quota" error means skip the rest of Gemini
  for (const [kind, a, b] of [...head, ...ladder]) {
    if (left() < 1500) break;
    if (kind === "g" && geminiOut && !hasBinary) continue; // pictures/PDFs can only go to Gemini, so those still try them all
    let mid = b, r;
    if (kind === "auto") { const ids = await listIds(a); mid = ids && (b ? ids.find((x) => b.test(x)) : ids[0]); if (!mid) continue; }
    const used = kind === "g" ? a : a + "|" + mid;
    if (tried.has(used)) continue;
    tried.add(used);
    try { r = kind === "g" ? await viaGemini(a) : await viaProvider(a, mid); }
    catch { r = { status: 503, error: "Timed out." }; }
    if (r.text) return res.status(200).json({ text: r.text, model: used, label: used.split("|").pop().replace(/:free$/, "").split("/").pop(), switched: used !== chosenId });
    if (kind === "g" && r.status === 429) geminiOut = true;
    lastErr = lastErr || r;
    if (first && head.length && !RETRY.includes(r.status)) return res.status(r.status || 500).json({ error: r.error || "Request failed." });
    first = false;
  }
  const msg = hasBinary ? "Pictures and PDFs can only be read by Gemini, and all Gemini models are at their limit right now. Try again in a minute."
    : lastErr?.error || "Every model is busy right now. Try again in a minute.";
  return res.status(503).json({ error: msg });
}
