const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * ===== Variáveis no Railway =====
 * Obrigatórias:
 * - ACTION_API_KEY (senha do Bearer pro Action)
 *
 * Recomendadas:
 * - BUILTWITH_API_KEY
 *
 * Para CNPJ.biz (depende da sua conta):
 * - CNPJBIZ_API_KEY
 * - CNPJBIZ_BASE_URL (com https)
 * - CNPJBIZ_PATH_TEMPLATE  (ex: /cnpj/{cnpj}  ou /v1/cnpj/{cnpj})
 * - CNPJBIZ_AUTH_HEADER    (ex: Authorization)
 * - CNPJBIZ_AUTH_PREFIX    (ex: Bearer)  ou deixe vazio pra usar a key pura
 */

// ====== AUTH: Authorization: Bearer <ACTION_API_KEY> ======
function checkAuth(req, res, next) {
  const expected = process.env.ACTION_API_KEY;
  if (!expected) return next(); // útil no começo, mas em produção deixe configurado

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ===== Helpers =====
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

function normalizePhone(s) {
  return (s || "")
    .replace(/[^\d+]/g, "")
    .replace(/^(\d{2})(\d{8,9})$/, "+55$1$2"); // tentativa BR simples
}

function extractEmails(text) {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return uniq(matches.map((x) => x.toLowerCase()));
}

function extractPhones(text) {
  // Pega padrões comuns BR + tel:
  const m1 =
    text.match(/(\+?55\s?)?(\(?\d{2}\)?\s?)?\d{4,5}[-\s.]?\d{4}/g) || [];
  const m2 = [];
  const telLinks = text.match(/tel:\+?[0-9()+\-\s.]{8,}/gi) || [];
  for (const t of telLinks) m2.push(t.replace(/^tel:/i, ""));
  const raw = uniq([...m1, ...m2].map((x) => x.trim()));
  return uniq(raw.map(normalizePhone).filter((x) => x.length >= 8));
}

function extractCNPJ(text) {
  const m = text.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g);
  if (!m || !m.length) return null;
  const digits = m[0].replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

function stripTags(html) {
  return (html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function safeUrlJoin(base, path) {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

function pickInternalLinks(baseUrl, html) {
  // pega links internos que pareçam úteis (termos/privacidade/contato/sobre)
  const links = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html || ""))) {
    const href = m[1];
    if (!href || href.startsWith("#")) continue;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;

    const abs = safeUrlJoin(baseUrl, href);
    if (!abs) continue;
    try {
      const u = new URL(abs);
      const b = new URL(baseUrl);
      if (u.hostname !== b.hostname) continue;

      const p = u.pathname.toLowerCase();
      if (
        p.includes("termo") ||
        p.includes("priv") ||
        p.includes("contato") ||
        p.includes("fale") ||
        p.includes("sobre") ||
        p.includes("quem-somos") ||
        p.includes("institucional") ||
        p.includes("atendimento") ||
        p.includes("politica")
      ) {
        links.push(abs);
      }
    } catch {}
  }
  return uniq(links).slice(0, 12); // limite
}

async function safeFetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!r.ok) return null;

    const ct = (r.headers.get("content-type") || "").toLowerCase();
    // alguns sites devolvem html sem content-type perfeito, mas isso cobre a maioria
    if (ct && !ct.includes("text/html") && !ct.includes("application/xhtml")) {
      // ainda assim, tenta ler se for vazio
      // return null;
    }
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ===== Crawl do site (muito mais robusto) =====
async function crawlSite(domain) {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || "10000");

  const baseHttps = `https://${domain}`;
  const baseHttp = `http://${domain}`;

  // caminhos comuns (BR) + variações com / no final
  const paths = [
    "/",
    "/contato",
    "/contato/",
    "/fale-conosco",
    "/fale-conosco/",
    "/atendimento",
    "/atendimento/",
    "/institucional",
    "/institucional/",
    "/sobre",
    "/sobre/",
    "/quem-somos",
    "/quem-somos/",
    "/termos",
    "/termos/",
    "/termos-de-uso",
    "/termos-de-uso/",
    "/politica-de-privacidade",
    "/politica-de-privacidade/",
    "/privacidade",
    "/privacidade/",
    "/politica",
    "/politica/",
  ];

  // 1) tenta https primeiro
  let baseUrl = baseHttps;
  let homeHtml = await safeFetchText(baseUrl + "/", timeoutMs);

  // 2) se https falhar, tenta http
  if (!homeHtml) {
    baseUrl = baseHttp;
    homeHtml = await safeFetchText(baseUrl + "/", timeoutMs);
  }

  let combined = "";
  const visited = new Set();

  async function visit(url) {
    if (!url || visited.has(url)) return;
    visited.add(url);
    const html = await safeFetchText(url, timeoutMs);
    if (html) combined += "\n" + html;
  }

  // visita home
  if (homeHtml) combined += "\n" + homeHtml;

  // visita caminhos padrão
  for (const p of paths) {
    await visit(baseUrl + p);
  }

  // pega links internos “úteis” na home e visita também
  if (homeHtml) {
    const extra = pickInternalLinks(baseUrl + "/", homeHtml);
    for (const u of extra) await visit(u);
  }

  const text = stripTags(combined);

  const emails = extractEmails(combined + " " + text);
  const phones = extractPhones(combined + " " + text);
  const cnpj = extractCNPJ(combined + " " + text);

  return {
    baseUrl,
    crawled: combined.length > 0,
    emails,
    phones,
    cnpj,
  };
}

// ===== BuiltWith =====
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

    const names = [];
    const results = data?.Results || data?.results || [];
    for (const res of results) {
      const paths = res?.Result?.Paths || res?.result?.paths || [];
      for (const p of paths) {
        const tech = p?.Technologies || p?.technologies || [];
        for (const t of tech) {
          const name = t?.Name || t?.name;
          if (name) names.push(name);
        }
      }
    }
    return { ok: true, tech: uniq(names) };
  } catch {
    return { ok: false, tech: [] };
  }
}

// ===== Classificação (para preencher os campos que você quer) =====
function classifyFromBuiltWith(techList) {
  const tech = (techList || []).map((t) => t.toLowerCase());

  const platformRules = [
    { key: "shopify", name: "Shopify" },
    { key: "woocommerce", name: "WooCommerce" },
    { key: "magento", name: "Magento" },
    { key: "vtex", name: "VTEX" },
    { key: "bigcommerce", name: "BigCommerce" },
    { key: "prestashop", name: "PrestaShop" },
    { key: "opencart", name: "OpenCart" },
    { key: "salesforce commerce cloud", name: "Salesforce Commerce Cloud" },
    { key: "sap commerce", name: "SAP Commerce Cloud" },
    { key: "nuvemshop", name: "Nuvemshop" },
    { key: "tray", name: "Tray" },
    { key: "loja integrada", name: "Loja Integrada" },
  ];

  const marketingRules = [
    { key: "rd station", name: "RD Station" },
    { key: "hubspot", name: "HubSpot" },
    { key: "mailchimp", name: "Mailchimp" },
    { key: "klaviyo", name: "Klaviyo" },
    { key: "activecampaign", name: "ActiveCampaign" },
    { key: "salesforce marketing cloud", name: "Salesforce Marketing Cloud" },
    { key: "marketo", name: "Adobe Marketo" },
    { key: "zendesk", name: "Zendesk" }, // suporte/CRM, às vezes útil
    { key: "intercom", name: "Intercom" },
    { key: "tawk", name: "Tawk.to" },
    { key: "hotjar", name: "Hotjar" }, // analytics (não é automação, mas ajuda; se não quiser, remova)
  ];

  let ecommerce_platform = null;
  for (const r of platformRules) {
    if (tech.some((t) => t.includes(r.key))) {
      ecommerce_platform = r.name;
      break;
    }
  }

  const marketing_automation_tools = [];
  for (const r of marketingRules) {
    if (tech.some((t) => t.includes(r.key))) {
      marketing_automation_tools.push(r.name);
    }
  }

  return {
    ecommerce_platform,
    marketing_automation_tools: uniq(marketing_automation_tools),
  };
}

// ===== CNPJ.biz (encaixável por variáveis) =====
async function cnpjbizLookup(cnpjDigits) {
  const base = process.env.CNPJBIZ_BASE_URL;
  const key = process.env.CNPJBIZ_API_KEY;
  if (!base || !key) return null;

  const pathTemplate = process.env.CNPJBIZ_PATH_TEMPLATE || "/cnpj/{cnpj}";
  const authHeader = process.env.CNPJBIZ_AUTH_HEADER || "Authorization";
  const authPrefix = process.env.CNPJBIZ_AUTH_PREFIX || "Bearer";

  const path = pathTemplate.replace("{cnpj}", cnpjDigits);
  const url = `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;

  const headers = {};
  headers[authHeader] = authPrefix ? `${authPrefix} ${key}` : key;

  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const data = await r.json();

    // Mapeamento genérico (você pode ajustar quando ver o retorno real)
    const partners = data?.partners || data?.socios || data?.qsa || [];
    const phones = data?.phones || data?.telefones || [];
    const emails = data?.emails || (data?.email ? [data.email] : []);
    const city =
      data?.city ||
      data?.cidade ||
      data?.endereco?.cidade ||
      data?.address?.city ||
      null;

    return {
      partners,
      phones: Array.isArray(phones) ? phones : [phones].filter(Boolean),
      emails: Array.isArray(emails) ? emails : [emails].filter(Boolean),
      city,
      raw: data, // útil pra debug; se não quiser, remova depois
    };
  } catch {
    return null;
  }
}

// ===== Rotas =====
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Middleware online" });
});

app.post("/lead/inspect", checkAuth, async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);

  if (!domain) {
    return res.status(400).json({ error: "Envie { domain: 'exemplo.com.br' }" });
  }

  // 1) site
  const site = await crawlSite(domain);

  // 2) builtwith + classificação
  const bw = await builtwithLookup(domain);
  const classified = classifyFromBuiltWith(bw.tech);

  // 3) cnpjbiz (se tiver CNPJ)
  const cnpjbiz = site.cnpj ? await cnpjbizLookup(site.cnpj) : null;

  // Formato final como você quer
  res.json({
    domain,
    url: site.baseUrl,

    ecommerce_platform: classified.ecommerce_platform,
    marketing_automation_tools: classified.marketing_automation_tools,

    phones_found_on_site: site.phones,
    emails_found_on_site: site.emails,

    cnpj: site.cnpj,

    cnpjbiz: cnpjbiz
      ? {
          partners: cnpjbiz.partners,
          phones: cnpjbiz.phones,
          emails: cnpjbiz.emails,
          city: cnpjbiz.city,
        }
      : null,

    // debug opcional
    builtwith_technologies: bw.tech,
    sources: { builtwith: bw.ok, site: site.crawled, cnpjbiz: !!cnpjbiz },
    notes: [
      site.crawled ? "Site visitado." : "Não consegui acessar o site (https e http falharam).",
      site.cnpj ? "CNPJ encontrado no site." : "CNPJ não encontrado no site.",
      bw.ok ? "BuiltWith consultado." : "BuiltWith não consultado (sem chave ou falha).",
      cnpjbiz ? "CNPJ.biz consultado." : "CNPJ.biz não consultado (sem CNPJ, sem config ou falha).",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
