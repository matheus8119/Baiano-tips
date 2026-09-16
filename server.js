import express from "express";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;

const TELEGRAM_INVITE_URL =
  process.env.TELEGRAM_INVITE_URL ||
  "https://t.me/+1F0a440X9zg2MDgx";

const PLAN_DAYS = {
  mensal: 30,
  trimestral: 90,
  semestral: 180,
  anual: 365
};

const PLAN_PRICES = {
  mensal: 29.90,
  trimestral: 69.90,
  semestral: 119.90,
  anual: 199.90
};

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      payment_id TEXT,
      external_reference TEXT,
      name TEXT,
      cpf TEXT,
      email TEXT,
      plan TEXT,
      amount NUMERIC(10,2),
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      active_until TIMESTAMPTZ
    )
  `);
}

/* =========================
   PÁGINA PRINCIPAL
========================= */

app.get("/", (req, res) => {

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1.0">

<title>Baiano Tips</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #080808;
  color: white;
}

.container {
  max-width: 500px;
  margin: auto;
  padding: 25px 18px 40px;
}

h1 {
  text-align: center;
  margin-bottom: 5px;
  font-size: 36px;
}

.subtitle {
  text-align: center;
  color: #aaa;
  margin-bottom: 25px;
}

.card {
  background: #151515;
  border: 1px solid #292929;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 18px;
}

.plan {
  border: 1px solid #333;
  border-radius: 12px;
  padding: 15px;
  margin-bottom: 10px;
  cursor: pointer;
}

.plan:hover {
  border-color: #00ff88;
}

.plan strong {
  display: block;
  font-size: 19px;
}

.plan span {
  display: block;
  color: #00ff88;
  font-size: 22px;
  font-weight: bold;
  margin-top: 5px;
}

input {
  width: 100%;
  padding: 14px;
  margin-top: 10px;
  border-radius: 8px;
  border: 1px solid #333;
  background: #0d0d0d;
  color: white;
  font-size: 16px;
}

button {
  width: 100%;
  padding: 15px;
  margin-top: 15px;
  border: 0;
  border-radius: 9px;
  background: #00d979;
  color: #000;
  font-size: 17px;
  font-weight: bold;
  cursor: pointer;
}

.result {
  margin-top: 15px;
  padding: 15px;
  border-radius: 10px;
  background: #101010;
  line-height: 1.5;
}

.qr {
  width: 100%;
  max-width: 300px;
  display: block;
  margin: 15px auto;
}

.pix {
  word-break: break-all;
  background: #080808;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
}

.success {
  color: #00ff88;
}

.error {
  color: #ff5555;
}

.telegram {
  display: block;
  text-decoration: none;
  text-align: center;
  background: #229ED9;
  color: white;
  padding: 15px;
  border-radius: 9px;
  margin-top: 15px;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="container">

<h1>BAIANO TIPS</h1>

<div class="subtitle">
Tips e Alavancagem
</div>

<div class="card">

<h2>Escolha seu plano</h2>

<div class="plan" onclick="selectPlan('mensal')">
<strong>Mensal</strong>
<span>R$ 29,90</span>
<small>30 dias</small>
</div>

<div class="plan" onclick="selectPlan('trimestral')">
<strong>Trimestral</strong>
<span>R$ 69,90</span>
<small>90 dias</small>
</div>

<div class="plan" onclick="selectPlan('semestral')">
<strong>Semestral</strong>
<span>R$ 119,90</span>
<small>180 dias</small>
</div>

<div class="plan" onclick="selectPlan('anual')">
<strong>Anual</strong>
<span>R$ 199,90</span>
<small>365 dias</small>
</div>

<input
id="name"
placeholder="Digite seu nome"
>

<input
id="cpf"
placeholder="Digite seu CPF"
>

<input
id="email"
type="email"
placeholder="Digite seu e-mail"
>

<button onclick="generatePix()">
GERAR PIX
</button>

<div id="pixResult"></div>

</div>

<div class="card">

<h2>Já sou assinante</h2>

<input
id="accessEmail"
type="email"
placeholder="Digite seu e-mail"
>

<button onclick="checkAccess()">
VERIFICAR ACESSO
</button>

<div id="accessResult"></div>

</div>

<div style="text-align:center;color:#777;font-size:12px;">
18+ | Aposte com responsabilidade.
</div>

</div>

<script>

let selectedPlan = "mensal";

function selectPlan(plan) {

  selectedPlan = plan;

  alert("Plano selecionado: " + plan);

}

async function generatePix() {

  const name =
    document.getElementById("name").value.trim();

  const cpf =
    document.getElementById("cpf").value.trim();

  const email =
    document.getElementById("email").value.trim();

  if (!name || !cpf || !email) {

    alert("Preencha nome, CPF e e-mail.");

    return;

  }

  document.getElementById("pixResult").innerHTML =
    "<div class='result'>Gerando PIX...</div>";

  try {

    const response = await fetch(
      "/api/create-payment",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          name,
          cpf,
          email,
          plan: selectedPlan
        })
      }
    );

    const data = await response.json();

    if (!data.success) {

      document.getElementById("pixResult").innerHTML =
        "<div class='result error'>" +
        (data.message || "Erro ao gerar PIX.") +
        "</div>";

      return;

    }

    document.getElementById("pixResult").innerHTML =

      "<div class='result'>" +

      "<h3>PIX gerado!</h3>" +

      "<img class='qr' src='data:image/png;base64," +
      data.qrCodeBase64 +
      "'>" +

      "<p>Copie o código PIX:</p>" +

      "<div class='pix'>" +
      data.qrCode +
      "</div>" +

      "<button onclick='copyPix()'>" +
      "COPIAR PIX" +
      "</button>" +

      "</div>";

    window.currentPix = data.qrCode;

  } catch (error) {

    console.error(error);

    document.getElementById("pixResult").innerHTML =
      "<div class='result error'>" +
      "Erro de conexão." +
      "</div>";

  }

}

function copyPix() {

  if (!window.currentPix) {
    return;
  }

  navigator.clipboard.writeText(window.currentPix);

  alert("PIX copiado!");

}

async function checkAccess() {

  const email =
    document.getElementById("accessEmail")
      .value
      .trim();

  if (!email) {

    alert("Digite seu e-mail.");

    return;

  }

  const result =
    document.getElementById("accessResult");

  result.innerHTML =
    "<div class='result'>Verificando...</div>";

  try {

    const response = await fetch(
      "/api/access?email=" +
      encodeURIComponent(email)
    );

    const data = await response.json();

    if (!data.success || !data.active) {

      result.innerHTML =
        "<div class='result error'>" +
        (data.message ||
        "Nenhuma assinatura ativa encontrada.") +
        "</div>";

      return;

    }

    result.innerHTML =

      "<div class='result'>" +

      "<div class='success'>" +
      "<strong>ASSINATURA ATIVA!</strong>" +
      "</div>" +

      "<p>Plano: " +
      (data.plan || "assinatura") +
      "</p>" +

      "<p>Válido até: " +
      new Date(data.activeUntil)
        .toLocaleDateString("pt-BR") +
      "</p>" +

      "<a class='telegram' href='" +
      data.telegram +
      "' target='_blank'>" +

      "ENTRAR NO TELEGRAM" +

      "</a>" +

      "</div>";

  } catch (error) {

    console.error(error);

    result.innerHTML =
      "<div class='result error'>" +
      "Erro ao verificar acesso." +
      "</div>";

  }

}

</script>

</body>

</html>
`;

  res.send(html);

});

/* =========================
   CRIAR PAGAMENTO
========================= */

app.post("/api/create-payment", async (req, res) => {

  try {

    const {
      name,
      cpf,
      email,
      plan
    } = req.body;

    if (!name || !cpf || !email || !plan) {

      return res.status(400).json({
        success: false,
        message: "Dados incompletos."
      });

    }

    if (!PLAN_PRICES[plan]) {

      return res.status(400).json({
        success: false,
        message: "Plano inválido."
      });

    }

    if (!MP_TOKEN) {

      return res.status(500).json({
        success: false,
        message: "Mercado Pago não configurado."
      });

    }

    const externalReference =
      "BAIANOTIPS-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(16)
        .slice(2, 10)
        .toUpperCase();

    const paymentData = {

      transaction_amount:
        PLAN_PRICES[plan],

      description:
        "Baiano Tips - " +
        plan.charAt(0).toUpperCase() +
        plan.slice(1),

      payment_method_id: "pix",

      payer: {
        email: normalizeEmail(email),
        first_name: name
      },

      external_reference:
        externalReference

    };

    const response = await fetch(
      "https://api.mercadopago.com/v1/payments",
      {
        method: "POST",

        headers: {
          "Authorization": "Bearer " + MP_TOKEN,
          "Content-Type": "application/json",
          "X-Idempotency-Key": externalReference
        },

        body: JSON.stringify(paymentData)
      }
    );

    const data = await response.json();

    if (!response.ok) {

      console.error(
        "ERRO MERCADO PAGO:",
        data
      );

      return res.status(400).json({
        success: false,
        message:
          data.message ||
          "Erro ao criar pagamento."
      });

    }

    const transactionData =
      data.point_of_interaction &&
      data.point_of_interaction.transaction_data;

    const qrCode =
      transactionData &&
      transactionData.qr_code;

    const qrCodeBase64 =
      transactionData &&
      transactionData.qr_code_base64;

    await pool.query(
      `
      INSERT INTO payments
      (
        payment_id,
        external_reference,
        name,
        cpf,
        email,
        plan,
        amount,
        status
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        String(data.id),
        externalReference,
        name,
        cpf,
        normalizeEmail(email),
        plan,
        PLAN_PRICES[plan],
        data.status || "pending"
      ]
    );

    return res.json({

      success: true,

      paymentId:
        String(data.id),

      qrCode,

      qrCodeBase64

    });

  } catch (error) {

    console.error(
      "ERRO CREATE PAYMENT:",
      error
    );

    return res.status(500).json({

      success: false,

      message:
        "Erro interno ao criar pagamento."

    });

  }

});
