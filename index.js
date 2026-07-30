const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

/* =========================
   PARADISE CONFIG
========================= */
const PARADISE_API_KEY = "sk_b6ded86ad8e35617f29b65ffe00a0305a38c6063c76b68fb7e405ec1237a3d0d";
const PARADISE_URL = "https://multi.paradisepags.com/api/v1/transaction.php";

/* =========================
   DATAIMPULSE
========================= */
const DI_LOGIN = "thayslima270319@gmail.com";
const DI_PASSWORD = "fVyIYoCRbCVd4OKPsPAHjB8gzK76MAbF";

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
   MEMÓRIA
========================= */
const pagamentos = {};
const vendas = [];

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
  const { subuser_id, gigas, telefone } = req.body; // ✅ NOVO

  if (!planos[gigas]) {
    return res.json({ erro: "plano inválido" });
  }

  const valor = planos[gigas];
  const txid = gerarTxid();

  const cliente = {
    name: "Cliente Proxy",
    email: `cliente_${txid}@proxy.com`,
    phone: telefone || "11999999999", // ✅ USA WHATSAPP
    document: gerarCPF()
  };

  vendas.push({
    txid,
    subuser_id,
    gigas,
    valor,
    telefone, // ✅ SALVA WHATSAPP
    status: "PENDENTE",
    data: new Date()
  });

  try {
    const response = await axios.post(
      PARADISE_URL,
      {
        amount: valor * 100,
        description: "Recarga Proxy",
        reference: txid,
        source: "api_externa",
        customer: cliente,
        postback_url: "https://backendparadise-production.up.railway.app/webhook/paradise"
      },
      {
        headers: {
          "X-API-Key": PARADISE_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    pagamentos[txid] = {
      subuser_id,
      gigas,
      status: "PENDENTE"
    };

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
app.post("/webhook/paradise", async (req, res) => {
  try {
    const { external_id, status } = req.body;

    if (!external_id) return res.sendStatus(200);
    if (!pagamentos[external_id]) return res.sendStatus(200);

    const pagamento = pagamentos[external_id];

    if (status !== "approved") return res.sendStatus(200);
    if (pagamento.status !== "PENDENTE") return res.sendStatus(200);

    pagamento.status = "PROCESSANDO";

    const { subuser_id, gigas } = pagamento;

    const venda = vendas.find(v => v.txid === external_id);
    if (venda) venda.status = "PAGO";

    try {
      await recarregarProxy(subuser_id, gigas);
      pagamento.status = "CONCLUIDO";
    } catch (err) {
      pagamento.status = "ERRO";
    }

    res.sendStatus(200);

  } catch (err) {
    res.sendStatus(500);
  }
});

/* =========================
   ADMIN
========================= */
app.get("/admin/vendas", (req, res) => {
  res.json(vendas);
});

/* =========================
   START
========================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Servidor rodando");
});
