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
 *
 * (opcional, se sua API do CNPJ.biz não for o padrão)
 * - CNPJBIZ_PATH_TEMPLATE   (ex: /cnpj/{cnpj} ou /v1/cnpj/{cnpj})
 * - CNPJBIZ_AUTH_HEADER     (ex: Authorization ou x-api-key)
 * - CNPJBIZ_AUTH_PREFIX     (ex: Bearer | Token | vazio)
 *
 * Opcionais:
 * - REQUEST_TIMEOUT_MS      (ex: 12000)
 * - MAX_EXTRA_LINKS         (ex: 12)
 */

// ===================== AUTH =====================
function checkAuth(req, res, next) {
  const expected = process.env.ACTION_API_KEY;
  if (!expected) return next(); // debug: em produção, mantenha configurado

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

// -------- Telefones (melhorado) + WhatsApp como contato --------
function extractPhones(text) {
  const t = (text || "").replace(/\s+/g, " ");

  // 1) tel: links
  const telLinks = t.match(/tel:\+?[0-9()+\-\s.]{8,}/gi) || [];
  const fromTel = telLinks.map((x) => x.replace(/^tel:/i, "").trim());

  // 2) WhatsApp links (também conta como telefone de contato)
  const wa = [];
  const m1 = t.match(/wa\.me\/\d{8,15}/gi) || [];
  for (const x of m1) wa.push("+" + x.split("/")[1]);

  const m2 = t.match(/api\.whatsapp\.com\/send\?phone=\d{8,15}/gi) || [];
  for (const x of m2) wa.push("+" + x.split("phone=")[1]);

  // 3) números “escritos” (flexível)
  const normalMatches =
    t.match(/(\+?55\s?)?(\(?\d{2}\)?\s?)?\d{4,5}[\s.\-]?\d{4}/g) || [];

  // 4) 0800
  const tollFree = t.match(/\b0800[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g) || [];

  const raw = uniq([...fromTel, ...wa, ...normalMatches, ...tollFree].map((x) => x.trim()));

  // normalização simples
  const normalized = raw
    .map((s) => s.replace(/[^\d+]/g, ""))
    .map((s) => {
      const digits = s.replace(/\D/g, "");
      if (digits.startsWith("0800")) return digits; // mantém 0800
      if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
      if (digits.length === 12 || digits.length === 13) return `+${digits}`;
      if (s.startsWith("+")) return s;
      return digits.length >= 8 ? digits : null;
    })
    .filter(Boolean);

  return uniq(normalized);
}

// -------- CNPJ: pega TODOS e escolhe o mais provável (rodapé/termos/privacidade) --------
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
    const variants = uniq([cnpjDigits, formatted].filter(Boolean)).map((v) => v.toLowerCase());

    let s = 0;

    // Palavras que indicam CNPJ de empresa (mais provável ser o "certo")
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
      "comércio",
      "comercio",
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
      "rodap", // pega "rodapé" mesmo sem acento
    ];

    for (const v of variants) {
      let idx = html.indexOf(v);
      // se o site esconde pontuação, tenta achar só dígitos também
      if (idx < 0 && v.includes(".") && v.includes("/")) {
        const vd = v.replace(/\D/g, "");
        idx = html.indexOf(vd);
      }
      if (idx >= 0) {
        const start = Math.max(0, idx - 200);
        const end = Math.min(html.length, idx + 200);
        const window = html.slice(start, end);

        for (const k of keywords) {
          if (window.includes(k)) s += 5;
        }

        // bônus se estiver perto de "shopify"/"bagy"/etc no footer? (não essencial)
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

async function safeFetchText(url, timeoutMs = 12000) {
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

    if (!r.ok) return null;

    const text = await r.text();
    if (!text || text.length < 400) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ===================== CRAWL SITE =====================
async function crawlSite(domain) {
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || "12000");

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

  // CNPJ: candidatos + escolha do melhor
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
    { key: "linx commerce", name: "Linx Commerce" },
    { key: "oracle commerce", name: "Oracle Commerce" },
    { key: "salesforce commerce cloud", name: "Salesforce Commerce Cloud" },
    { key: "sap commerce", name: "SAP Commerce Cloud" },
  ];

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

  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const data = await r.json();

    // Mapeamento genérico (ajuste se necessário, conforme retorno real da sua conta)
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

    // Telefones (inclui WhatsApp/0800/tel: quando existir)
    phones_found_on_site: site.phones,
    emails_found_on_site: site.emails,

    // CNPJ escolhido + candidatos (pra você auditar)
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

    // Debug
    builtwith_technologies: bw.tech,
    sources: { builtwith: bw.ok, site: site.crawled, cnpjbiz: !!cnpjbiz },
    notes: [
      site.crawled
        ? "Site visitado."
        : "Não consegui acessar o site (https/http e www falharam).",
      site.cnpj ? "CNPJ encontrado no site (melhor candidato)." : "CNPJ não encontrado no site.",
      bw.ok ? "BuiltWith consultado." : "BuiltWith não consultado (sem chave ou falha).",
      cnpjbiz ? "CNPJ.biz consultado." : "CNPJ.biz não consultado (sem CNPJ, sem config ou falha).",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
