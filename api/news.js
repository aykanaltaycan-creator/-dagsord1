// NRK'nin akışını sunucu tarafında çeker, her haberin kendi sayfasını okur ve
// metni istenen seviyede yeniden yazar. Tarayıcıdaki CORS engeli burada yok.
//
// niva=lett     A2, uzun ama sade cümleler
// niva=middels  B1, orijinale yakın uzunluk ve kelime dağarcığı
// niva=original sadece RSS başlığı ve kısa özeti (yeniden yazma yok)

const FEEDS = {
  topp: "https://www.nrk.no/toppsaker.rss",
};

const MODEL = process.env.MODEL || "claude-sonnet-5";

function decode(t) {
  return String(t)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function grab(block, tag) {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">"));
  return m ? decode(m[1]) : "";
}

function parseRss(xml, limit) {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  return blocks.slice(0, limit).map((b) => ({
    tittel: grab(b, "title"),
    tekst: grab(b, "description"),
    lenke: grab(b, "link"),
    dato: grab(b, "pubDate"),
  })).filter((a) => a.tittel && a.lenke);
}

// Haber sayfasından gövde metnini çıkarır. Bu metin kullanıcıya hiç gösterilmez;
// sadece modele kaynak olarak verilir, model kendi cümleleriyle yeniden yazar.
async function articleBody(url) {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Dagsord/1.0 (personlig sprakapp)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "";
    let html = await r.text();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
               .replace(/<style[\s\S]*?<\/style>/gi, " ")
               .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, " ");
    const paras = (html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [])
      .map(decode)
      .filter((p) => p.length > 60 && !/informasjonskapsler|cookies|abonner|kontakt oss/i.test(p));
    return paras.join(" ").slice(0, 3000);
  } catch (e) {
    return "";
  }
}

const RULES = {
  lett: `Skriv på ENKEL norsk bokmål for en voksen nybegynner (A2).
Bruk korte hovedsetninger, vanlige hverdagsord og aktiv form.
Unngå lange sammensatte ord, fagord, forkortelser og passiv der du kan.
Forklar et vanskelig begrep med en ekstra kort setning i stedet for å hoppe over det.`,
  middels: `Skriv på naturlig norsk bokmål på B1-nivå.
Behold nyhetsspråkets tone og de fleste fagordene, men del opp de lengste setningene.
Teksten skal ligge nær originalen i lengde og innhold.`,
};

async function rewriteChunk(items, niva) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { saker: null, feil: "ANTHROPIC_API_KEY tanımlı değil (Vercel > Settings > Environment Variables)" };

  const kilder = items.map((a, i) =>
    `### SAK ${i + 1}\nTITTEL: ${a.tittel}\nINGRESS: ${a.tekst}\nBRØDTEKST: ${a.body || "(mangler)"}`
  ).join("\n\n");

  const prompt = `Du lager lesestoff for en voksen tyrker som lærer norsk.

${RULES[niva] || RULES.lett}

For hver sak under: skriv en sammenhengende tekst på 10-14 setninger MED DINE EGNE ORD.
Ikke kopier setninger fra kilden. Behold de konkrete opplysningene — tall, steder,
tidspunkt, hvem som sier hva — slik at teksten fortsatt er en ordentlig nyhet.
Teksten skal ha en rød tråd: hva har skjedd, hvorfor, hva betyr det, hva skjer videre.
Ingen direkte sitater. Ingen punktlister. Behold rekkefølgen og antallet saker.

${kilder}

Svar KUN med JSON, ingen forklaring:
[{"nr":1,"tittel":"kort tittel","tekst":"10-14 setninger i én sammenhengende tekst."}]`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": String(key).trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 6000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { saker: null, feil: "Anthropic HTTP " + r.status + " — " + ((d.error && d.error.message) || "").slice(0, 200) };
  }
  const text = (d.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
  try {
    const arr = JSON.parse(text.replace(/```json/gi, "").replace(/```/g, "").trim());
    if (!Array.isArray(arr) || !arr.length) throw new Error("dizi değil");
    return { saker: arr, feil: "" };
  } catch (e) {
    return { saker: null, feil: "Model yanıtı okunamadı: " + text.slice(0, 160) };
  }
}

export default async function handler(req, res) {
  const feed = FEEDS[req.query.feed] || FEEDS.topp;
  const niva = ["lett", "middels", "original"].includes(req.query.niva) ? req.query.niva : "lett";
  // uzun metin üretimi pahalı, madde sayısını küçük tut
  const limit = Math.min(parseInt(req.query.limit, 10) || (niva === "original" ? 12 : 8), 12);

  try {
    const r = await fetch(feed, { headers: { "user-agent": "Dagsord/1.0 (personlig sprakapp)" } });
    if (!r.ok) throw new Error("NRK " + r.status);

    const items = parseRss(await r.text(), limit);
    if (!items.length) throw new Error("Akışta madde bulunamadı");

    if (niva === "original") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      res.status(200).json({ niva, hentet: new Date().toISOString(), saker: items });
      return;
    }

    // her haberin gövdesini paralel oku
    const bodies = await Promise.all(items.map((a) => articleBody(a.lenke)));
    items.forEach((a, i) => { a.body = bodies[i]; });

    // dörderli gruplara böl ve paralel gönder: hem hızlı hem süre sınırına takılmaz
    const CH = 4;
    const chunks = [];
    for (let i = 0; i < items.length; i += CH) chunks.push(items.slice(i, i + CH));
    const sonuclar = await Promise.all(chunks.map((c) => rewriteChunk(c, niva)));

    const saker = [];
    let feil = "", basarili = 0;
    chunks.forEach((c, ci) => {
      const r = sonuclar[ci];
      if (r.saker) basarili++; else if (!feil) feil = r.feil;
      c.forEach((a, i) => {
        const s = r.saker ? (r.saker.find((x) => Number(x.nr) === i + 1) || r.saker[i]) : null;
        saker.push(s && s.tekst
          ? { tittel: s.tittel || a.tittel, tekst: s.tekst, lenke: a.lenke, dato: a.dato }
          : { tittel: a.tittel, tekst: a.tekst, lenke: a.lenke, dato: a.dato });
      });
    });

    res.setHeader("Cache-Control", basarili ? "s-maxage=1800, stale-while-revalidate=3600" : "no-store");
    res.status(200).json({
      niva: basarili ? niva : "original",
      advarsel: basarili === chunks.length ? ""
        : (basarili ? "Bazı haberler uzun metne çevrilemedi. " : "Uzun metin üretilemedi, ham RSS özeti gösteriliyor. ") + "Sebep: " + feil,
      hentet: new Date().toISOString(),
      saker,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
