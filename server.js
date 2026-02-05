const express = require("express");

const app = express();
app.use(express.json());

// Railway injeta PORT automaticamente
const PORT = process.env.PORT || 3000;

// ====== AUTH: Authorization: Bearer <ACTION_API_KEY> ======
function checkAuth(req, res, next) {
  const expected = process.env.ACTION_API_KEY;
  if (!expected) return next(); // se não tiver configurado, não bloqueia (apenas pra debug)

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ====== Helpers ======
function normalizeDomain(input) {
  return (input || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function extractEmails(html) {
  const matches = html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return uniq(matches.map(s => s.toLowerCase()));
}

function extractPhones(html) {
  const raw = html.match(/(\+?55\s?)?(\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}/g) || [];
  return uniq(raw.map(s => s.replace(/\s+/g, " ").trim()));
}

function extractCNPJ(html) {
  const m = html.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g);
  if (!m || !m.length) return null;
  const digits = m[0].replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

async function safeFetchText(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html")) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function crawlSite(domain) {
  const base = `https://${domain}`;
  const paths = [
    "/",
    "/contato",
    "/fale-conosco",
    "/atendimento",
    "/institucional",
    "/politica-de-privacidade",
    "/privacidade",
    "/termos",
    "/quem-somos",
    "/sobre",
  ];

  let allHtml = "";
  for (const p of paths) {
    const html = await safeFetchText(base + p);
    if (html) allHtml += "\n" + html;
  }

  const emails = extractEmails(allHtml);
  const phones = extractPhones(allHtml);
  const cnpj = extractCNPJ(allHtml);

  return { baseUrl: base, crawled: allHtml.length > 0, emails, phones, cnpj };
}

// ====== BuiltWith ======
async function builtwithLookup(domain) {
  const key = process.env.BUILTWITH_API_KEY;
  if (!key) return { ok: false, tech: [] };

  const url = `https://api.builtwith.com/v20/api.json?KEY=${encodeURIComponent(
    key
  )}&LOOKUP=${encodeURIComponent(domain)}`;

  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, tech: [] };
    const data = await r.json();

    const techNames = [];
    const results = data?.Results || data?.results || [];
    for (const res of results) {
      const paths = res?.Result?.Paths || res?.result?.paths || [];
      for (const p of paths) {
        const tech = p?.Technologies || p?.technologies || [];
        for (const t of tech) {
          const name = t?.Name || t?.name;
          if (name) techNames.push(name);
        }
      }
    }

    return { ok: true, tech: uniq(techNames) };
  } catch {
    return { ok: false, tech: [] };
  }
}

// ====== CNPJ.biz (encaixe) ======
// IMPORTANTÍSSIMO: aqui você precisa ajustar a URL e headers conforme sua conta/doc.
// Variáveis usadas:
// - CNPJBIZ_BASE_URL (com https)
// - CNPJBIZ_API_KEY
async function cnpjbizLookup(cnpjDigits) {
  const base = process.env.CNPJBIZ_BASE_URL;
  const key = process.env.CNPJBIZ_API_KEY;

  if (!base || !key) return null;

  // Ajuste o endpoint conforme a doc do CNPJ.biz que você usa:
  const url = `${base.replace(/\/$/, "")}/cnpj/${cnpjDigits}`;

  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) return null;

    const data = await r.json();

    // Ajuste os campos conforme o retorno real do seu CNPJ.biz
    return {
      partners: data?.partners || data?.socios || [],
      phones: data?.phones || data?.telefones || [],
      emails: data?.emails || (data?.email ? [data.email] : []),
      city: data?.city || data?.cidade || null,
    };
  } catch {
    return null;
  }
}

// ====== Rotas ======
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Middleware online" });
});

app.post("/lead/inspect", checkAuth, async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);

  if (!domain) {
    return res.status(400).json({ error: "Envie { domain: 'exemplo.com.br' }" });
  }

  const site = await crawlSite(domain);
  const bw = await builtwithLookup(domain);
  const cnpjbiz = site.cnpj ? await cnpjbizLookup(site.cnpj) : null;

  // Por enquanto deixo ecommerce_platform e marketing_automation_tools vazios.
  // Depois a gente classifica builtwith_technologies nesses dois campos.
  return res.json({
    domain,
    url: site.baseUrl,
    ecommerce_platform: null,
    marketing_automation_tools: [],
    phones_found_on_site: site.phones,
    emails_found_on_site: site.emails,
    cnpj: site.cnpj,
    cnpjbiz,
    builtwith_technologies: bw.tech,
    sources: { builtwith: bw.ok, site: site.crawled, cnpjbiz: !!cnpjbiz },
    notes: [
      bw.ok
        ? "BuiltWith consultado (lista em builtwith_technologies)."
        : "BuiltWith não consultado (sem chave ou falha).",
      site.cnpj ? "CNPJ encontrado no site." : "CNPJ não encontrado no site.",
      cnpjbiz ? "CNPJ.biz consultado." : "CNPJ.biz não consultado (sem CNPJ, sem config ou falha).",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
