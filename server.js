const express = require("express");

// ===== Fetch “garantido” (funciona mesmo se Node não tiver fetch) =====
let _fetch = global.fetch;
async function getFetch() {
  if (_fetch) return _fetch;
  // Fallback usando undici
  const undici = await import("undici");
  _fetch = undici.fetch;
  return _fetch;
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===================== AUTH =====================
function checkAuth(req, res, next) {
  const expected = process.env.ACTION_API_KEY;
  if (!expected) return next();

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ===================== HELPERS =====================
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

function formatCNPJ(cnpjDigits) {
  const d = (cnpjDigits || "").replace(/\D/g, "");
  if (d.length !== 14) return null;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(
    8,
    12
  )}-${d.slice(12)}`;
}

function extractEmails(text) {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return uniq(matches.map((x) => x.toLowerCase()));
}

// -------- Telefones (melhorado) + WhatsApp --------
function extractPhones(text) {
  const t = (text || "").replace(/\s+/g, " ");

  // tel: links
  const telLinks = t.match(/tel:\+?[0-9()+\-\s.]{8,}/gi) || [];
  const fromTel = telLinks.map((x) => x.replace(/^tel:/i, "").trim());

  // WhatsApp links
  const wa = [];
  const m1 = t.match(/wa\.me\/\d{8,15}/gi) || [];
  for (const x of m1) wa.push("+" + x.split("/")[1]);

  const m2 = t.match(/api\.whatsapp\.com\/send\?phone=\d{8,15}/gi) || [];
  for (const x of m2) wa.push("+" + x.split("phone=")[1]);

  // números escritos
  const normalMatches =
    t.match(/(\+?55\s?)?(\(?\d{2}\)?\s?)?\d{4,5}[\s.\-]?\d{4}/g) || [];

  // 0800
  const tollFree = t.match(/\b0800[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g) || [];

  const raw = uniq(
    [...fromTel, ...wa, ...normalMatches, ...tollFree].map((x) => x.trim())
  );

  const normalized = raw
    .map((s) => s.replace(/[^\d+]/g, ""))
    .map((s) => {
      const digits = s.replace(/\D/g, "");
      if (digits.startsWith("0800")) return digits;
      if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
      if (digits.length === 12 || digits.length === 13) return `+${digits}`;
      if (s.startsWith("+")) return s;
      return digits.length >= 8 ? digits : null;
    })
    .filter(Boolean);

  return uniq(normalized);
}

// -------- CNPJ: pega todos e escolhe o mais provável --------
function extractCNPJs(text) {
  const m = text.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g) || [];
  const digits = m
    .map((x) => x.replace(/\D/g, ""))
    .filter((x) => x.length === 14);
  return uniq(digits);
}

function chooseBestCNPJ(htmlCombined, cnpjList) {
  if (!cnpjList || cnpjList.length === 0) return null;
  if (cnpjList.length === 1) return cnpjList[0];

  const html = (htmlCombined || "").toLowerCase();

  function score(cnpjDigits) {
    const formatted = formatCNPJ(cnpjDigits);
    const variants = uniq([cnpjDigits, formatted].filter(Boolean)).map((v) =>
      v.toLowerCase()
    );

    let s = 0;
    const keywords = [
      "cnpj",
      "razão social",
      "razao social",
      "inscrição",
      "inscricao",
      "empresa",
      "ltda",
      "me",
      "eireli",
      "endereço",
      "endereco",
      "contato",
      "institucional",
      "termos",
      "privacidade",
      "reembolso",
      "trocas",
      "devol",
      "footer",
      "rodap",
    ];

    for (const v of variants) {
      let idx = html.indexOf(v);
      if (idx < 0) {
        const vd = v.replace(/\D/g, "");
        if (vd.length >= 10) idx = html.indexOf(vd);
      }
      if (idx >= 0) {
        const start = Math.max(0, idx - 220);
        const end = Math.min(html.length, idx + 220);
        const window = html.slice(start, end);

        for (const k of keywords) {
          if (window.includes(k)) s += 5;
        }
        if (window.includes("footer")) s += 3;
      }
    }

    return s;
  }

  const ranked = cnpjList
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s);

  return ranked[0].c;
}

function safeUrlJoin(base, path) {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

function pickInternalLinks(baseUrl, html) {
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

// ===================== HTTP HELPERS com LOG =====================
async function safeFetchText(url, timeoutMs = 15000) {
  const fetch = await getFetch();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });

    const text = await r.text();

    if (process.env.DEBUG_FETCH === "1") {
      console.log(
        `[fetch] ${r.status} ${url} len=${text ? text.length : 0} ct=${r.headers?.get?.("content-type") || ""}`
      );
    }

    if (!r.ok) return null;
    if (!text) return null;

    // corte BEM suave (não derruba páginas válidas)
    if (text.length < 40) return null;

    return text;
  } catch (e) {
    if (process.env.DEBUG_FETCH === "1") {
      console.log(
        `[fetch-error] ${url} -> ${e?.name || "Error"}: ${e?.message || e}`
      );
    }
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function safeFetchJson(url, headers = {}, timeoutMs = 15000) {
  const fetch = await getFetch();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        ...headers,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
      },
    });

    const text = await r.text();

    if (process.env.DEBUG_FETCH === "1") {
      console.log(
        `[fetch-json] ${r.status} ${url} len=${text ? text.length : 0}`
      );
    }

    if (!r.ok) return null;
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (e) {
    if (process.env.DEBUG_FETCH === "1") {
      console.log(
        `[fetch-json-error] ${url} -> ${e?.name || "Error"}: ${e?.message || e}`
      );
    }
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ===================== CRAWL SITE =====================
async function crawlSite(domain) {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || "15000");

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

  if (homeHtml) {
    const extra = pickInternalLinks(baseUrl + "/", homeHtml);
    for (const u of extra) await visit(u);
  }

  const text = stripTags(combined);

  const emails = extractEmails(combined + " " + text);
  const phones = extractPhones(combined + " " + text);

  const cnpjCandidates = extractCNPJs(combined + " " + text);
  const cnpj = chooseBestCNPJ(combined, cnpjCandidates);

  return {
    baseUrl,
    crawled: combined.length > 0,
    emails,
    phones,
    cnpj,
    cnpjCandidates,
  };
}

// ===================== BUILTWITH =====================
async function builtwithLookup(domain) {
  const key = process.env.BUILTWITH_API_KEY;
  if (!key) return { ok: false, tech: [] };

  const url = `https://api.builtwith.com/v20/api.json?KEY=${encodeURIComponent(
    key
  )}&LOOKUP=${encodeURIComponent(domain)}`;

  const data = await safeFetchJson(url, {}, 15000);
  if (!data) return { ok: false, tech: [] };

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
}

// ===================== CLASSIFICAÇÃO =====================
function classifyFromBuiltWith(techList) {
  const tech = (techList || []).map((t) => t.toLowerCase());

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
  ];

  const marketingRules = [
    { key: "klaviyo", name: "Klaviyo" },
    { key: "rd station", name: "RD Station" },
    { key: "hubspot", name: "HubSpot" },
    { key: "mailchimp", name: "Mailchimp" },
    { key: "activecampaign", name: "ActiveCampaign" },
    { key: "sendinblue", name: "Brevo (Sendinblue)" },
    { key: "marketo", name: "Adobe Marketo" },
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

// ===================== CNPJ.BIZ (CONFIGURÁVEL) =====================
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

  const data = await safeFetchJson(url, headers, 15000);
  if (!data) return null;

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
  };
}

// ===================== ROTAS =====================
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
    emails_found_on_site: site.emails,

    cnpj: site.cnpj ? formatCNPJ(site.cnpj) : null,
    cnpj_candidates: (site.cnpjCandidates || []).map(formatCNPJ).filter(Boolean),

    cnpjbiz: cnpjbiz
      ? {
          partners: cnpjbiz.partners,
          phones: cnpjbiz.phones,
          emails: cnpjbiz.emails,
          city: cnpjbiz.city,
        }
      : null,

    builtwith_technologies: bw.tech,
    sources: { builtwith: bw.ok, site: site.crawled, cnpjbiz: !!cnpjbiz },
    notes: [
      site.crawled
        ? "Site visitado."
        : "Não consegui acessar o site (https/http e www falharam).",
      site.cnpj
        ? "CNPJ encontrado no site (melhor candidato)."
        : "CNPJ não encontrado no site.",
      bw.ok ? "BuiltWith consultado." : "BuiltWith falhou (ver logs com DEBUG_FETCH=1).",
      cnpjbiz
        ? "CNPJ.biz consultado."
        : "CNPJ.biz não consultado (sem CNPJ ou falha).",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
{
  "name": "lead-middleware",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "engines": { "node": ">=18" },
  "dependencies": {
    "express": "^4.19.2",
    "undici": "^6.19.8"
  }
}
