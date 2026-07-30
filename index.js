const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

/* =========================
   FLEVO CONFIG
========================= */
const FLEVO_API_KEY = process.env.FLEVO_API_KEY;
const FLEVO_URL = "https://app.flevopay.com.br/api/v1/transaction";
const FLEVO_POSTBACK_URL = process.env.FLEVO_POSTBACK_URL || "https://backendflevo-production.up.railway.app/webhook/flevo";

/* =========================
   DATAIMPULSE
========================= */
const DI_LOGIN = process.env.DI_LOGIN;
const DI_PASSWORD = process.env.DI_PASSWORD;

/* =========================
   SUPABASE
========================= */
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/* =========================
   ADMIN AUTH
========================= */
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).send("ADMIN_PASSWORD não configurada no ambiente.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Autenticação necessária.");
  }

  const [user, password] = Buffer.from(encoded, "base64").toString().split(":");

  if (user !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Credenciais inválidas.");
  }

  next();
}

/* =========================
   PLANOS
========================= */
const planos = {
  1: 10,
  3: 22,
  5: 34,
  7: 38,
  10: 51,
  20: 97,
  50: 251,
  100: 466
};

/* =========================
   FUNÇÕES
========================= */
function gerarTxid() {
  return crypto.randomBytes(16).toString("hex");
}

function gerarCPF() {
  const n = () => Math.floor(Math.random() * 9);

  let cpf = [];
  for (let i = 0; i < 9; i++) cpf.push(n());

  let d1 = 0;
  for (let i = 0; i < 9; i++) d1 += cpf[i] * (10 - i);
  d1 = (d1 * 10) % 11;
  if (d1 === 10) d1 = 0;

  let d2 = 0;
  for (let i = 0; i < 10; i++) d2 += (cpf[i] || d1) * (11 - i);
  d2 = (d2 * 10) % 11;
  if (d2 === 10) d2 = 0;

  return cpf.join("") + d1 + d2;
}

/* =========================
   RECARREGAR PROXY
========================= */
async function recarregarProxy(subuser_id, gigas) {
  const auth = await axios.post(
    "https://api.dataimpulse.com/reseller/user/token/get",
    {
      login: DI_LOGIN,
      password: DI_PASSWORD
    }
  );

  const token = auth.data.token;

  const recharge = await axios.post(
    "https://api.dataimpulse.com/reseller/sub-user/balance/add",
    {
      subuser_id,
      traffic: gigas
    },
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  return recharge.data;
}

/* =========================
   CRIAR PIX
========================= */
app.post("/criar-pix", async (req, res) => {
  const { subuser_id, gigas, telefone } = req.body;

  if (!planos[gigas]) {
    return res.json({ erro: "plano inválido" });
  }

  const valor = planos[gigas];
  const txid = gerarTxid();

  const cliente = {
    name: "Cliente Proxy",
    email: `cliente_${txid}@proxy.com`,
    phone: telefone || "11999999999",
    document: gerarCPF()
  };

  const { error: insertError } = await supabase.from("vendas").insert({
    txid,
    subuser_id,
    gigas,
    valor,
    telefone,
    status: "PENDENTE"
  });

  if (insertError) {
    console.log("erro ao salvar venda:", insertError.message);
    return res.json({ erro: "erro ao registrar venda" });
  }

  try {
    const response = await axios.post(
      FLEVO_URL,
      {
        amount: valor * 100,
        description: "Recarga Proxy",
        reference: txid,
        source: "api_externa",
        customer: cliente,
        postback_url: FLEVO_POSTBACK_URL
      },
      {
        headers: {
          "X-API-Key": FLEVO_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      txid,
      pix: response.data.qr_code,
      qrcode: response.data.qr_code_base64
    });

  } catch (err) {
    console.log(err.response?.data || err.message);
    res.json({ erro: "erro ao gerar pix" });
  }
});

/* =========================
   WEBHOOK
========================= */
app.post("/webhook/flevo", async (req, res) => {
  try {
    const { external_id, status } = req.body;

    if (!external_id) return res.sendStatus(200);
    if (status !== "approved") return res.sendStatus(200);

    const { data: venda, error: fetchError } = await supabase
      .from("vendas")
      .select("*")
      .eq("txid", external_id)
      .single();

    if (fetchError || !venda) return res.sendStatus(200);
    if (venda.status !== "PENDENTE") return res.sendStatus(200);

    await supabase.from("vendas").update({ status: "PROCESSANDO" }).eq("txid", external_id);

    try {
      await recarregarProxy(venda.subuser_id, venda.gigas);
      await supabase.from("vendas").update({ status: "CONCLUIDO" }).eq("txid", external_id);
    } catch (err) {
      await supabase.from("vendas").update({ status: "ERRO" }).eq("txid", external_id);
    }

    res.sendStatus(200);

  } catch (err) {
    res.sendStatus(500);
  }
});

/* =========================
   ADMIN
========================= */
app.get("/admin/vendas", requireAdminAuth, async (req, res) => {
  const { data: vendas, error } = await supabase
    .from("vendas")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).send("Erro ao carregar vendas: " + error.message);
  }

  const linhas = vendas.map(v => `
    <tr>
      <td>${v.txid}</td>
      <td>${v.subuser_id}</td>
      <td>${v.gigas} GB</td>
      <td>R$ ${v.valor}</td>
      <td>${v.telefone || "-"}</td>
      <td class="status-${v.status.toLowerCase()}">${v.status}</td>
      <td>${new Date(v.created_at).toLocaleString("pt-BR")}</td>
    </tr>
  `).join("");

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>Vendas - Admin</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
        h1 { margin-bottom: 1rem; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; }
        th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid #334155; }
        th { background: #334155; }
        .status-pendente { color: #facc15; }
        .status-processando { color: #38bdf8; }
        .status-concluido { color: #4ade80; }
        .status-erro { color: #f87171; }
      </style>
    </head>
    <body>
      <h1>Vendas</h1>
      <table>
        <thead>
          <tr>
            <th>TXID</th>
            <th>Subuser ID</th>
            <th>Plano</th>
            <th>Valor</th>
            <th>Telefone</th>
            <th>Status</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          ${linhas}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

/* =========================
   START
========================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Servidor rodando");
});
