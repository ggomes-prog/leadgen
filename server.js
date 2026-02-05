const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * ===== Variáveis no Railway =====
 * Obrigatórias (para o Action com Bearer):
 * - ACTION_API_KEY
 *
 * BuiltWith:
 * - BUILTWITH_API_KEY
 *
 * CNPJ.biz (depende da sua conta):
 * - CNPJBIZ_BASE_URL        (com https)
 * - CNPJBIZ_API_KEY
 * - CNPJBIZ_PATH_TEMPLATE   (ex: /cnpj/{cnpj}  ou /v1/cnpj/{cnpj})
 * - CNPJBIZ_AUTH_HEADER     (ex: Authorization  ou x-api-key)
 * - CNPJBIZ_AUTH_PREFIX     (ex: Bearer | Token | vazio)
 *
 * Opcionais:
 * - REQUEST_TIMEOUT_MS      (ex: 12000)
 * - MAX_EXTRA_LINKS         (ex: 12)
 */

// ====== AUTH: Authorization: Bearer <ACTION_API_KEY> ======
function checkAuth(req, res, next) {
  const expected = process.env.ACTION_API_KEY;
  if (!expected) return next(); // (debug) Em produção deixe configurado.

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

function stripTags(html) {
  return (html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function extractEmails(text) {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return uniq(matches.map((x) => x.toLowerCase()));
}

function extractPhones(text) {
  // Telefones BR comuns e formatos variados
  const m1 =
    text.match(/(\+?55\s?)?(\(?\d{2}\)?\s?)?\d{4,5}[-\s.]?\d{4}/g) || [];
  const telLinks = text.match(/tel:\+?[0-9()+\-\s.]{8,}/gi) || [];
  const m2 = telLinks.map((t) => t.replace(/^tel:/i, "").trim());

  const raw = uniq([...m1, ...m2].map((x) => x.trim()));

  // Normalização leve (não é perfeita, mas melhora)
  const normalized = raw
    .map((s) => s.replace(/[^\d+]/g, ""))
    .map((s) => {
      // se for só dígitos e começar com DDD, coloca +55
      const digits = s.replace(/\D/g, "");
      if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
      if (digits.length === 12 || digits.length === 13) return `+${digits}`;
      return s;
    })
    .filter((s) => s && s.length >= 8);

  return uniq(normalized);
}

function extractWhatsApps(text) {
  // Captura WhatsApp via wa.me ou api.whatsapp.com
  const wa = [];

  const m1 = text.match(/wa\.me\/\d{8,15}/gi) || [];
  for (const x of m1) {
    const num = x.split("/")[1];
    if (num) wa.push(`+${num}`);
  }

  const m2 =
    text.match(/api\.whatsapp\.com\/send\?phone=\d{8,15}/gi) || [];
  for (const x of m2) {
    const parts = x.split("phone=");
    const num = parts[1];
    if (num) wa.push(`+${num}`);
  }

  return uniq(wa);
}

function extractCNPJ(text) {
  const m = text.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g);
  if (!m || !m.length) return null;
  const digits = m[0].replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

function safeUrlJoin(base, path) {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

function pickInternalLinks(baseUrl, html) {
  // pega links internos que pareçam úteis (termos/privacidade/contato/reembolso/trocas/entrega)
  const maxExtra = Number(process.env.MAX_EXTRA_LINKS || "12");
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

      const p = (u.pathname || "").toLowerCase();

      const looksUseful =
        p.includes("termo") ||
        p.includes("priv") ||
        p.includes("contato") ||
        p.includes("fale") ||
        p.includes("sobre") ||
        p.includes("quem-somos") ||
        p.includes("institucional") ||
        p.includes("atendimento") ||
        p.includes("politica") ||
        p.includes("reembolso") ||
        p.includes("devol") ||
        p.includes("troca") ||
        p.includes("entrega") ||
        p.includes("frete") ||
        p.includes("envio") ||
        p.includes("shipping") ||
        p.includes("refund") ||
        p.includes("returns");

      if (looksUseful) links.push(abs);
    } catch {}
  }

  return uniq(links).slice(0, maxExtra);
}

async function safeFetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // “parecer navegador” para evitar páginas reduzidas/bloqueadas
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });

    if (!r.ok) return null;

    const text = await r.text();
    if (!text || text.length < 400) return null; // muito curto = provável bloqueio/placeholder
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ===== Crawl do site (robusto) =====
async function crawlSite(domain) {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || "12000");

  // tenta https/http com e sem www
  const candidates = [
    `https://${domain}`,
    `https://www.${domain}`,
    `http://${domain}`,
    `http://www.${domain}`,
  ];

  let baseUrl = candidates[0];
  let homeHtml = null;

  for (const base of candidates) {
    const html = await safeFetchText(base + "/", timeoutMs);
    if (html) {
      baseUrl = base;
      homeHtml = html;
      break;
    }
  }

  let combined = "";
  const visited = new Set();

  async function visit(url) {
    if (!url || visited.has(url)) return;
    visited.add(url);
    const html = await safeFetchText(url, timeoutMs);
    if (html) combined += "\n" + html;
  }

  if (homeHtml) combined += "\n" + homeHtml;

  // páginas comuns (BR + ecommerce)
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
    "/faq",
    "/faq/",
    "/trocas-e-devolucoes",
    "/trocas-e-devolucoes/",
    "/politica-de-reembolso",
    "/politica-de-reembolso/",
    "/reembolso",
    "/reembolso/",
    "/envio-e-entrega",
    "/envio-e-entrega/",
    "/frete-e-entrega",
    "/frete-e-entrega/",
    "/politica-de-envio",
    "/politica-de-envio/",
    "/shipping",
    "/shipping/",
    "/refund",
    "/refund/",
    "/returns",
    "/returns/",
  ];

  for (const p of paths) {
    await visit(baseUrl + p);
  }

  // links internos úteis encontrados na home
  if (homeHtml) {
    const extra = pickInternalLinks(baseUrl + "/", homeHtml);
    for (const u of extra) await visit(u);
  }

  const text = stripTags(combined);
  const emails = extractEmails(combined + " " + text);
  const phones = extractPhones(combined + " " + text);
  const whatsapps = extractWhatsApps(combined + " " + text);
  const cnpj = extractCNPJ(combined + " " + text);

  return {
    baseUrl,
    crawled: combined.length > 0,
    emails,
    phones,
    whatsapps,
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

// ===== Classificação (Plataforma + Automação) =====
function classifyFromBuiltWith(techList) {
  const tech = (techList || []).map((t) => t.toLowerCase());

  // Plataformas
  const platformRules = [
    { key: "bagy", name: "Bagy" },
    { key: "shopify", name: "Shopify" },
    { key: "woocommerce", name: "WooCommerce" },
    { key: "vtex", name: "VTEX" },
    { key: "magento", name: "Magento" },
    { key: "bigcommerce", name: "BigCommerce" },
    { key: "prestashop", name: "PrestaShop" },
    { key: "opencart", name: "OpenCart" },
    { key: "nuvemshop", name: "Nuvemshop" },
    { key: "loja integrada", name: "Loja Integrada" },
    { key: "tray", name: "Tray" },
    { key: "wake", name: "Wake" },
    { key: "linx commerce", name: "Linx Commerce" },
    { key: "oracle commerce", name: "Oracle Commerce" },
    { key: "salesforce commerce cloud", name: "Salesforce Commerce Cloud" },
    { key: "sap commerce", name: "SAP Commerce Cloud" },
  ];

  // Automação / CRM / Marketing
  const marketingRules = [
    { key: "klaviyo", name: "Klaviyo" },
    { key: "rd station", name: "RD Station" },
    { key: "hubspot", name: "HubSpot" },
    { key: "mailchimp", name: "Mailchimp" },
    { key: "activecampaign", name: "ActiveCampaign" },
    { key: "sendinblue", name: "Brevo (Sendinblue)" },
    { key: "salesforce marketing cloud", name: "Salesforce Marketing Cloud" },
    { key: "marketo", name: "Adobe Marketo" },
    { key: "zendesk", name: "Zendesk" },
    { key: "intercom", name: "Intercom" },
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

// ===== CNPJ.biz (configurável por variáveis) =====
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

    // Mapeamento genérico (ajuste depois conforme seu retorno real)
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
      raw: data, // útil pra debug; remova depois se quiser
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

  const site = await crawlSite(domain);

  const bw = await builtwithLookup(domain);
  const classified = classifyFromBuiltWith(bw.tech);

  const cnpjbiz = site.cnpj ? await cnpjbizLookup(site.cnpj) : null;

  res.json({
    domain,
    url: site.baseUrl,

    ecommerce_platform: classified.ecommerce_platform,
    marketing_automation_tools: classified.marketing_automation_tools,

    phones_found_on_site: site.phones,
    whatsapps_found_on_site: site.whatsapps,
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

    // Debug (útil pra você entender quando algo não aparece)
    builtwith_technologies: bw.tech,
    sources: { builtwith: bw.ok, site: site.crawled, cnpjbiz: !!cnpjbiz },
    notes: [
      site.crawled
        ? "Site visitado."
        : "Não consegui acessar o site (https/http e www falharam).",
      site.cnpj ? "CNPJ encontrado no site." : "CNPJ não encontrado no site.",
      bw.ok ? "BuiltWith consultado." : "BuiltWith não consultado (sem chave ou falha).",
      cnpjbiz ? "CNPJ.biz consultado." : "CNPJ.biz não consultado (sem CNPJ, sem config ou falha).",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
