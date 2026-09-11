// Teşhis ucu. Tarayıcıda /api/test adresini aç ve çıkan metni oku.
// Anahtarın tamamını asla göstermez, sadece var olup olmadığını ve ilk harflerini.

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.MODEL || "claude-sonnet-5";

  const rapor = {
    node_surumu: process.version,
    anahtar_tanimli: key.length > 0,
    anahtar_uzunlugu: key.length,
    anahtar_basi: key ? key.slice(0, 8) + "..." : "(yok)",
    anahtar_bosluk_var: key !== key.trim(),
    kullanilan_model: model,
  };

  if (!key) {
    rapor.sonuc = "ANTHROPIC_API_KEY tanımlı değil. Vercel > Settings > Environment Variables'a ekle, sonra Redeploy yap.";
    res.status(200).json(rapor);
    return;
  }

  // 1) Anthropic'e minik bir istek
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 20,
        messages: [{ role: "user", content: "Svar kun med ordet OK." }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    rapor.anthropic_http = r.status;
    if (r.ok) {
      rapor.sonuc = "ÇALIŞIYOR — model yanıtı: " +
        (d.content || []).map((b) => b.text || "").join("").trim();
    } else {
      rapor.sonuc = "HATA — " + ((d.error && d.error.message) || JSON.stringify(d).slice(0, 400));
      if (r.status === 401) rapor.ipucu = "Anahtar yanlış veya eksik kopyalanmış.";
      if (r.status === 400 && /model/i.test(JSON.stringify(d))) {
        rapor.ipucu = "Model adı geçersiz. Vercel'de MODEL değişkenini claude-sonnet-4-5 yapıp tekrar dene.";
      }
      if (r.status === 429) rapor.ipucu = "Bakiye bitmiş veya limit dolmuş. console.anthropic.com > Billing.";
    }
  } catch (e) {
    rapor.sonuc = "İstek hiç atılamadı: " + String((e && e.message) || e);
  }

  // 2) NRK akışına erişim
  try {
    const r2 = await fetch("https://www.nrk.no/toppsaker.rss");
    const t = await r2.text();
    rapor.nrk_http = r2.status;
    rapor.nrk_madde_sayisi = (t.match(/<item/g) || []).length;
  } catch (e) {
    rapor.nrk_http = "hata: " + String((e && e.message) || e);
  }

  res.status(200).json(rapor);
}
