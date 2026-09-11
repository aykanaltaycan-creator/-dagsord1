// Çeviri ve sözlük isteklerini iletir. API anahtarı sunucuda kalır, tarayıcıya hiç inmez.

const MODEL = process.env.MODEL || "claude-sonnet-5";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Sadece POST" });
    return;
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY tanımlı değil. Vercel > Settings > Environment Variables" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const prompt = body && body.prompt;
  const max = Math.min(Number(body && body.max) || 700, 2000);

  if (!prompt || typeof prompt !== "string" || prompt.length > 6000) {
    res.status(400).json({ error: "Geçersiz istek" });
    return;
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: max,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: (d && d.error && d.error.message) || "API hatası" });
      return;
    }

    const text = (d.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
