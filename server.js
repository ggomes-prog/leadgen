const express = require("express");

const app = express();
app.use(express.json());

// Railway define a porta automaticamente (PORT). Localmente, usamos 3000.
const PORT = process.env.PORT || 3000;

// Uma “senha” simples para proteger seu endpoint (você configura no Railway depois)
function checkAuth(req, res, next) {
  const expected = process.env.ACTION_API_KEY;
  if (!expected) return next(); // se não tiver configurado, não bloqueia (útil no começo)

  const auth = req.headers.authorization || "";
  const ok = auth === `Bearer ${expected}`;
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Teste rápido pra ver se está no ar
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Middleware online" });
});

// O endpoint principal que o ChatGPT vai chamar
app.post("/lead/inspect", checkAuth, async (req, res) => {
  const domain = (req.body?.domain || "").trim().toLowerCase();

  if (!domain) {
    return res.status(400).json({ error: "Envie { domain: 'exemplo.com.br' }" });
  }

  // Por enquanto, resposta “fake” só pra testar pipeline Railway + Action.
  // Depois você coloca aqui as chamadas do BuiltWith + scraping + CNPJ.biz.
  return res.json({
    domain,
    url: `https://${domain}`,
    ecommerce_platform: null,
    marketing_automation_tools: [],
    phones_found_on_site: [],
    emails_found_on_site: [],
    cnpj: null,
    cnpjbiz: null,
    sources: { builtwith: false, site: false, cnpjbiz: false },
    notes: ["Endpoint funcionando. Próximo passo: implementar BuiltWith, scraping e CNPJ.biz."]
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
