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

const TELEGRAM_BOT_TOKEN =
  (process.env.TELEGRAM_BOT_TOKEN || "").trim();

const TELEGRAM_CHAT_ID =
  (process.env.TELEGRAM_CHAT_ID || "").trim();

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

/* =========================================================
   TELEGRAM
========================================================= */

async function getTelegramInviteUrl() {

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurado."
    );
  }

  console.log(
    "SOLICITANDO NOVO LINK DE CONVITE AO TELEGRAM..."
  );

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {

    console.error(
      "ERRO AO CRIAR LINK TELEGRAM:",
      data
    );

    throw new Error(
      data?.description ||
      "Não foi possível criar o link do Telegram."
    );
  }

  const inviteLink =
    data.result?.invite_link;

  if (!inviteLink) {
    throw new Error(
      "O Telegram não retornou o link de convite."
    );
  }

  console.log(
    "NOVO LINK TELEGRAM GERADO COM SUCESSO."
  );

  return inviteLink;
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

  console.log("Tabela payments verificada com sucesso.");
}
/* =========================================================
   PÁGINA PRINCIPAL
========================================================= */

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Baiano Tips</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #071b0e;
  color: white;
  min-height: 100vh;
}

.container {
  max-width: 700px;
  margin: auto;
  padding: 25px 15px 50px;
}

.header {
  text-align: center;
  margin-bottom: 25px;
}

.logo {
  font-size: 42px;
  font-weight: 900;
  color: #19ff72;
}

.subtitle {
  color: #ddd;
}

.card {
  background: #0b1d10;
  border: 1px solid #285c38;
  border-radius: 18px;
  padding: 22px;
  margin-bottom: 18px;
}

.plan {
  border: 1px solid #315f40;
  border-radius: 12px;
  padding: 15px;
  margin: 10px 0;
  cursor: pointer;
}

.plan.selected {
  border-color: #19ff72;
  background: #102b18;
}

.plan-title {
  font-weight: bold;
  font-size: 18px;
}

.price {
  color: #19ff72;
  font-size: 24px;
  font-weight: bold;
}

input {
  width: 100%;
  padding: 14px;
  margin: 7px 0;
  border-radius: 9px;
  border: 1px solid #35513d;
  background: #07140b;
  color: white;
  font-size: 16px;
}

button {
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 15px;
  margin-top: 10px;
  background: #19ff72;
  color: #001507;
  font-size: 17px;
  font-weight: bold;
  cursor: pointer;
}

.secondary {
  background: #17251b;
  color: white;
}

.qr {
  display: block;
  max-width: 280px;
  width: 100%;
  margin: 20px auto;
}

.pix-code {
  word-break: break-all;
  background: #020904;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
}

.success {
  color: #19ff72;
  font-weight: bold;
}

.error {
  color: #ff6767;
  font-weight: bold;
}

.warning {
  color: #ffc857;
  font-size: 13px;
  line-height: 1.5;
}
</style>
</head>

<body>

<div class="container">

  <div class="header">
    <div class="logo">BAIANO TIPS</div>
    <div class="subtitle">Tips e Alavancagem</div>
  </div>

  <div class="card">
    <h2>Escolha seu plano</h2>

    <div class="plan selected" data-plan="mensal" onclick="selectPlan('mensal')">
      <div class="plan-title">Mensal</div>
      <div class="price">R$ 29,90</div>
      <div>30 dias de acesso</div>
    </div>

    <div class="plan" data-plan="trimestral" onclick="selectPlan('trimestral')">
      <div class="plan-title">Trimestral</div>
      <div class="price">R$ 69,90</div>
      <div>90 dias de acesso</div>
    </div>

    <div class="plan" data-plan="semestral" onclick="selectPlan('semestral')">
      <div class="plan-title">Semestral</div>
      <div class="price">R$ 119,90</div>
      <div>180 dias de acesso</div>
    </div>

    <div class="plan" data-plan="anual" onclick="selectPlan('anual')">
      <div class="plan-title">Anual</div>
      <div class="price">R$ 199,90</div>
      <div>365 dias de acesso</div>
    </div>
  </div>

  <div class="card">
    <h2>Seus dados</h2>

    <input id="name" placeholder="Nome completo">
    <input id="cpf" placeholder="CPF">
    <input id="email" type="email" placeholder="E-mail">

    <button onclick="createPayment()">
      GERAR PIX
    </button>

    <div id="paymentResult"></div>
  </div>

  <div class="card">
    <h2>Já sou assinante</h2>

    <input
      id="accessEmail"
      type="email"
      placeholder="Digite seu e-mail"
    >

    <button class="secondary" onclick="checkAccess()">
      VERIFICAR ACESSO
    </button>

    <div id="accessResult"></div>
  </div>

  <div class="card warning">
    🔞 Conteúdo destinado exclusivamente a maiores de 18 anos.
    <br><br>
    Aposte com responsabilidade. O conteúdo disponibilizado pelo
    Baiano Tips não garante resultados financeiros.
  </div>

</div>

<script>

let selectedPlan = "mensal";

function selectPlan(plan) {
  selectedPlan = plan;

  document.querySelectorAll(".plan").forEach(function(el) {
    el.classList.remove("selected");
  });

  const selected = document.querySelector(
    '[data-plan="' + plan + '"]'
  );

  if (selected) {
    selected.classList.add("selected");
  }
}

async function createPayment() {

  const name =
    document.getElementById("name").value.trim();

  const cpf =
    document.getElementById("cpf").value.trim();

  const email =
    document.getElementById("email").value.trim();

  const result =
    document.getElementById("paymentResult");

  if (!name || !cpf || !email) {
    result.innerHTML =
      '<p class="error">Preencha todos os campos.</p>';
    return;
  }

  result.innerHTML = "Gerando PIX...";

  try {

    const response = await fetch(
      "/api/create-payment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: name,
          cpf: cpf,
          email: email,
          plan: selectedPlan
        })
      }
    );

    const data = await response.json();

    if (!data.success) {
      result.innerHTML =
        '<p class="error">' +
        (data.message || "Erro ao gerar PIX.") +
        '</p>';
      return;
    }

    let html =
      '<h3 class="success">PIX gerado!</h3>';

    if (data.qrCodeBase64) {

      html +=
        '<img class="qr" src="data:image/png;base64,' +
        data.qrCodeBase64 +
        '">';

    }

    if (data.qrCode) {

      html +=
        '<div class="pix-code">' +
        data.qrCode +
        '</div>';

      html +=
        '<button onclick="copyPix(' +
        JSON.stringify(data.qrCode) +
        ')">' +
        'COPIAR PIX' +
        '</button>';
    }

    html +=
      '<p>Após o pagamento, aguarde a confirmação e consulte seu acesso pelo e-mail.</p>';

    result.innerHTML = html;

  } catch (error) {

    console.error(error);

    result.innerHTML =
      '<p class="error">Erro de conexão com o servidor.</p>';
  }
}

async function copyPix(code) {

  try {

    await navigator.clipboard.writeText(code);

    alert("PIX copiado!");

  } catch (error) {

    alert("Não foi possível copiar automaticamente.");
  }
}

async function checkAccess() {

  const email =
    document.getElementById("accessEmail").value.trim();

  const result =
    document.getElementById("accessResult");

  if (!email) {

    result.innerHTML =
      '<p class="error">Digite seu e-mail.</p>';

    return;
  }

  result.innerHTML = "Verificando...";

  try {

    const response = await fetch(
      "/api/access?email=" +
      encodeURIComponent(email)
    );

    const data = await response.json();

    if (!data.active) {

      result.innerHTML =
        '<p class="error">' +
        (data.message ||
          "Nenhuma assinatura ativa encontrada.") +
        '</p>';

      return;
    }

    let html =
      '<p class="success">✅ Assinatura ativa!</p>';

    html +=
      '<p>Plano: <strong>' +
      (data.plan || "") +
      '</strong></p>';

    html +=
      '<p>Válido até: <strong>' +
      (data.activeUntil || "") +
      '</strong></p>';

    if (data.telegram) {

      html +=
        '<a href="' +
        data.telegram +
        '" target="_blank" style="text-decoration:none">' +
        '<button>ENTRAR NO TELEGRAM</button>' +
        '</a>';

    } else {

      html +=
        '<p class="error">' +
        'Não foi possível gerar o link do Telegram. ' +
        'Tente novamente.' +
        '</p>';
    }

    result.innerHTML = html;

  } catch (error) {

    console.error(error);

    result.innerHTML =
      '<p class="error">Erro ao verificar acesso.</p>';
  }
}

</script>

</body>
</html>
  `);
});

/* =========================================================
   CRIAR PAGAMENTO
========================================================= */

app.post("/api/create-payment", async (req, res) => {

  try {

    if (!MP_TOKEN) {

      return res.status(500).json({
        success: false,
        message: "Token do Mercado Pago não configurado."
      });

    }

    const {
      name,
      cpf,
      email,
      plan
    } = req.body;

    const normalizedEmail = normalizeEmail(email);

    if (
      !name ||
      !cpf ||
      !normalizedEmail ||
      !PLAN_DAYS[plan] ||
      !PLAN_PRICES[plan]
    ) {

      return res.status(400).json({
        success: false,
        message: "Dados inválidos."
      });

    }

    const externalReference =
      "BAIANOTIPS-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(16)
        .substring(2, 10)
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
        email: normalizedEmail,
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

          "Content-Type": "application/json",

          "Authorization":
            "Bearer " + MP_TOKEN,

          "X-Idempotency-Key":
            externalReference

        },

        body:
          JSON.stringify(paymentData)

      }
    );

    const data = await response.json();

    if (!response.ok) {

      console.error(
        "ERRO MERCADO PAGO:",
        data
      );

      return res.status(response.status).json({

        success: false,

        message:
          data.message ||
          "Erro ao criar pagamento."

      });

    }

    const transactionData =
      data.point_of_interaction &&
      data.point_of_interaction
        .transaction_data;

    const qrCode =
      transactionData &&
      transactionData.qr_code;

    const qrCodeBase64 =
      transactionData &&
      transactionData.qr_code_base64;

    await pool.query(
      `
      INSERT INTO payments (
        payment_id,
        external_reference,
        name,
        cpf,
        email,
        plan,
        amount,
        status,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      `,
      [
        String(data.id),
        externalReference,
        name,
        cpf,
        normalizedEmail,
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

      qrCodeBase64,

      status:
        data.status,

      externalReference

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

/* =========================================================
   WEBHOOK MERCADO PAGO
========================================================= */

app.post("/api/mercadopago/webhook", async (req, res) => {

  try {

    const paymentId =
      req.body?.data?.id ||
      req.query?.id;

    if (!paymentId) {

      return res.json({
        success: true
      });

    }

    const response = await fetch(
      "https://api.mercadopago.com/v1/payments/" +
      paymentId,
      {

        headers: {
          Authorization:
            "Bearer " + MP_TOKEN
        }

      }
    );

    if (!response.ok) {

      return res.json({
        success: true
      });

    }

    const payment =
      await response.json();

    const status =
      payment.status;

    const payerEmail =
      normalizeEmail(
        payment.payer?.email
      );

    const externalReference =
      payment.external_reference;

    let existing =
      await pool.query(
        `
        SELECT *
        FROM payments
        WHERE payment_id = $1
        LIMIT 1
        `,
        [String(paymentId)]
      );

    let plan =
      existing.rows[0]?.plan ||
      "mensal";

    if (!existing.rows.length && externalReference) {

      const refResult =
        await pool.query(
          `
          SELECT *
          FROM payments
          WHERE external_reference = $1
          LIMIT 1
          `,
          [externalReference]
        );

      existing =
        refResult;

      plan =
        existing.rows[0]?.plan ||
        plan;
    }

    if (existing.rows.length) {

      const current =
        existing.rows[0];

      if (status === "approved") {

        const approvedAt =
          payment.date_approved
            ? new Date(payment.date_approved)
            : new Date();

        const activeUntil =
          addDays(
            approvedAt,
            PLAN_DAYS[plan] || 30
          );

        await pool.query(
          `
          UPDATE payments
          SET
            status = 'approved',
            email = COALESCE(NULLIF($1,''), email),
            approved_at = $2,
            active_until = $3
          WHERE id = $4
          `,
          [
            payerEmail,
            approvedAt,
            activeUntil,
            current.id
          ]
        );

      } else {

        await pool.query(
          `
          UPDATE payments
          SET status = $1
          WHERE id = $2
          `,
          [
            status,
            current.id
          ]
        );

      }

    }

    return res.json({
      success: true
    });

  } catch (error) {

    console.error(
      "WEBHOOK ERROR:",
      error
    );

    return res.json({
      success: true
    });

  }

});

/* =========================================================
   ACESSO
========================================================= */

app.get("/api/access", async (req, res) => {

  try {

    const email =
      normalizeEmail(req.query.email);

    if (!email) {

      return res.status(400).json({

        success: false,

        active: false,

        message:
          "Informe o e-mail."

      });

    }

    console.log(
      "VERIFICANDO ASSINATURA:",
      {
        recebido: req.query.email,
        normalizado: email
      }
    );

    const result =
      await pool.query(
        `
        SELECT *
        FROM payments
        WHERE LOWER(TRIM(email)) = $1
          AND status = 'approved'
          AND active_until > NOW()
        ORDER BY active_until DESC
        LIMIT 1
        `,
        [email]
      );

    console.log(
      "PAGAMENTOS ENCONTRADOS:",
      result.rows.length
    );

    if (result.rows.length) {

      const payment =
        result.rows[0];

      let telegramInviteUrl = null;

      try {

        telegramInviteUrl =
          await getTelegramInviteUrl();

      } catch (telegramError) {

        console.error(
          "ERRO AO GERAR CONVITE TELEGRAM:",
          telegramError
        );

      }

      return res.json({

        success: true,

        active: true,

        plan:
          payment.plan,

        amount:
          Number(payment.amount),

        activeUntil:
          payment.active_until,

        telegram:
          telegramInviteUrl

      });

    }

    return res.json({

      success: true,

      active: false,

      message:
        "Nenhuma assinatura ativa encontrada."

    });

  } catch (error) {

    console.error(
      "ACCESS ERROR:",
      error
    );

    return res.status(500).json({

      success: false,

      active: false,

      message:
        "Erro interno ao verificar assinatura."

    });

  }

});

/* =========================================================
   CORRIGIR E-MAIL DA ASSINATURA
========================================================= */

app.get("/api/fix-access", async (req, res) => {

  try {

    const email =
      normalizeEmail(req.query.email);

    const paymentId =
      String(
        req.query.paymentId || ""
      ).trim();

    if (!email || !paymentId) {

      return res.status(400).json({

        success: false,

        message:
          "Informe email e paymentId."

      });

    }

    const result =
      await pool.query(
        `
        UPDATE payments
        SET email = $1
        WHERE payment_id = $2
        RETURNING
          payment_id,
          plan,
          amount,
          status,
          active_until
        `,
        [
          email,
          paymentId
        ]
      );

    if (result.rowCount === 0) {

      return res.status(404).json({

        success: false,

        message:
          "Pagamento não encontrado no banco."

      });

    }

    const payment =
      result.rows[0];

    let telegramInviteUrl = null;

    try {

      telegramInviteUrl =
        await getTelegramInviteUrl();

    } catch (telegramError) {

      console.error(
        "ERRO AO GERAR CONVITE TELEGRAM:",
        telegramError
      );

    }

    return res.json({

      success: true,

      message:
        "E-mail vinculado à assinatura com sucesso.",

      paymentId:
        payment.payment_id,

      plan:
        payment.plan,

      amount:
        Number(payment.amount),

      status:
        payment.status,

      activeUntil:
        payment.active_until,

      telegram:
        telegramInviteUrl

    });

  } catch (error) {

    console.error(
      "ERRO AO CORRIGIR ACESSO:",
      error
    );

    return res.status(500).json({

      success: false,

      message:
        "Erro interno ao corrigir acesso."

    });

  }

});

/* =========================================================
   DEBUG ACCESS
========================================================= */

app.get("/api/debug-access", async (req, res) => {

  try {

    const email =
      normalizeEmail(req.query.email);

    const result =
      await pool.query(
        `
        SELECT
          id,
          email,
          LOWER(TRIM(email)) AS email_normalizado,
          status,
          active_until,
          NOW() AS agora,
          active_until > NOW() AS data_valida
        FROM payments
        ORDER BY id DESC
        `,
        []
      );

    return res.json({

      success: true,

      email_recebido:
        email,

      quantidade_registros:
        result.rows.length,

      registros:
        result.rows

    });

  } catch (error) {

    return res.status(500).json({

      success: false,

      message:
        error.message

    });

  }

});

/* =========================================================
   RECUPERAR PAGAMENTO
========================================================= */

app.get("/api/recover-payment-by-id", async (req, res) => {

  try {

    const paymentId =
      String(
        req.query.id || ""
      ).trim();

    if (!paymentId) {

      return res.status(400).json({

        success: false,

        message:
          "Informe o ID do pagamento."

      });

    }

    const response =
      await fetch(
        "https://api.mercadopago.com/v1/payments/" +
        paymentId,
        {

          headers: {
            Authorization:
              "Bearer " + MP_TOKEN
          }

        }
      );

    const payment =
      await response.json();

    if (!response.ok) {

      return res.status(response.status).json({

        success: false,

        message:
          payment.message ||
          "Pagamento não encontrado."

      });

    }

    if (payment.status !== "approved") {

      return res.json({

        success: false,

        recovered: false,

        message:
          "Pagamento ainda não está aprovado.",

        status:
          payment.status

      });

    }

    const email =
      normalizeEmail(
        payment.payer?.email
      );

    const externalReference =
      payment.external_reference;

    let existing =
      await pool.query(
        `
        SELECT *
        FROM payments
        WHERE payment_id = $1
        LIMIT 1
        `,
        [paymentId]
      );

    if (!existing.rows.length && externalReference) {

      existing =
        await pool.query(
          `
          SELECT *
          FROM payments
          WHERE external_reference = $1
          LIMIT 1
          `,
          [externalReference]
        );

    }

    const plan =
      existing.rows[0]?.plan ||
      "mensal";

    const approvedAt =
      payment.date_approved
        ? new Date(payment.date_approved)
        : new Date();

    const activeUntil =
      addDays(
        approvedAt,
        PLAN_DAYS[plan] || 30
      );

    if (existing.rows.length) {

      await pool.query(
        `
        UPDATE payments
        SET
          payment_id = $1,
          external_reference = $2,
          email = $3,
          plan = $4,
          amount = $5,
          status = 'approved',
          approved_at = $6,
          active_until = $7
        WHERE id = $8
        `,
        [
          paymentId,
          externalReference,
          email,
          plan,
          payment.transaction_amount,
          approvedAt,
          activeUntil,
          existing.rows[0].id
        ]
      );

    } else {

      await pool.query(
        `
        INSERT INTO payments (
          payment_id,
          external_reference,
          name,
          cpf,
          email,
          plan,
          amount,
          status,
          approved_at,
          active_until
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,'approved',$8,$9
        )
        `,
        [
          paymentId,
          externalReference,
          "",
          "",
          email,
          plan,
          payment.transaction_amount,
          approvedAt,
          activeUntil
        ]
      );

    }

    let telegramInviteUrl = null;

    try {

      telegramInviteUrl =
        await getTelegramInviteUrl();

    } catch (telegramError) {

      console.error(
        "ERRO AO GERAR CONVITE TELEGRAM:",
        telegramError
      );

    }

    return res.json({

      success: true,

      recovered: true,

      message:
        "Pagamento aprovado recuperado com sucesso.",

      paymentId,

      status:
        payment.status,

      plan,

      amount:
        payment.transaction_amount,

      email,

      activeUntil,

      telegram:
        telegramInviteUrl

    });

  } catch (error) {

    console.error(
      "RECOVER ERROR:",
      error
    );

    return res.status(500).json({

      success: false,

      message:
        error.message

    });

  }

});

/* =========================================================
   LISTAR PAGAMENTOS MERCADO PAGO
========================================================= */

app.get("/api/mercadopago-payments", async (req, res) => {

  try {

    const response =
      await fetch(
        "https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=20",
        {

          headers: {
            Authorization:
              "Bearer " + MP_TOKEN
          }

        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      return res.status(response.status).json({

        success: false,

        message:
          data.message ||
          "Erro ao consultar pagamentos."

      });

    }

    const payments =
      (data.results || []).map(payment => ({

        id:
          payment.id,

        status:
          payment.status,

        statusDetail:
          payment.status_detail,

        amount:
          payment.transaction_amount,

        description:
          payment.description,

        dateCreated:
          payment.date_created,

        dateApproved:
          payment.date_approved,

        email:
          payment.payer?.email || null,

        externalReference:
          payment.external_reference,

        paymentMethod:
          payment.payment_method_id

      }));

    return res.json({

      success: true,

      total:
        payments.length,

      payments

    });

  } catch (error) {

    return res.status(500).json({

      success: false,

      message:
        error.message

    });

  }

});

/* =========================================================
   TESTE MERCADO PAGO
========================================================= */

app.get("/api/mercadopago-test", async (req, res) => {

  try {

    const response =
      await fetch(
        "https://api.mercadopago.com/v1/payment_methods",
        {

          headers: {

            Authorization:
              "Bearer " + MP_TOKEN

          }

        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      return res.status(response.status).json({

        success: false,

        httpStatus:
          response.status,

        message:
          data.message ||
          "Token recusado."

      });

    }

    return res.json({

      success: true,

      httpStatus:
        response.status,

      message:
        "Token aceito pelo Mercado Pago.",

      paymentMethods:
        Array.isArray(data)
          ? data.length
          : 0

    });

  } catch (error) {

    return res.status(500).json({

      success: false,

      message:
        error.message

    });

  }

});

/* =========================================================
   CONFIG TEST
========================================================= */

app.get("/api/config-test", (req, res) => {

  const token =
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    "";

  res.json({

    server:
      "online",

    mercadoPagoTokenConfigured:
      Boolean(token),

    mercadoPagoTokenPrefix:
      token
        ? token.substring(0, 7)
        : "",

    mercadoPagoTokenLength:
      token.length,

    pixEnabled:
      process.env.PIX_ENABLED === "true",

    baseUrlConfigured:
      Boolean(
        process.env.BASE_URL
      ),

    telegramConfigured:
      Boolean(
        TELEGRAM_BOT_TOKEN &&
        TELEGRAM_CHAT_ID
      ),

    databaseConfigured:
      Boolean(
        process.env.DATABASE_URL
      ),

    message:
      "Configuração carregada com sucesso."

  });

});

/* =========================================================
   DIAGNÓSTICO PAGAMENTO
========================================================= */

app.get("/api/payment-diagnose", async (req, res) => {

  try {

    const db =
      await pool.query(
        `
        SELECT *
        FROM payments
        ORDER BY id DESC
        `
      );

    const mpResponse =
      await fetch(
        "https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=20",
        {

          headers: {
            Authorization:
              "Bearer " + MP_TOKEN
          }

        }
      );

    const mpData =
      await mpResponse.json();

    return res.json({

      success: true,

      total:
        db.rows.length,

      databasePayment:
        db.rows[0] || null,

      payments:
        (mpData.results || []).map(payment => ({

          id:
            payment.id,

          status:
            payment.status,

          statusDetail:
            payment.status_detail,

          amount:
            payment.transaction_amount,

          description:
            payment.description,

          dateCreated:
            payment.date_created,

          dateApproved:
            payment.date_approved,

          email:
            payment.payer?.email || null,

          externalReference:
            payment.external_reference,

          paymentMethod:
            payment.payment_method_id

        }))

    });

  } catch (error) {

    return res.status(500).json({

      success: false,

      message:
        error.message

    });

  }

});

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {

  try {

    await pool.query(
      "SELECT 1"
    );

    return res.json({

      success: true,

      server:
        "online",

      database:
        "online"

    });

  } catch (error) {

    return res.status(500).json({

      success: false,

      server:
        "online",

      database:
        "offline",

      error:
        error.message

    });

  }

});

/* =========================================================
   START
========================================================= */

async function startServer() {

  try {

    await ensureTable();

    app.listen(
      PORT,
      () => {

        console.log(
          "Servidor online na porta " +
          PORT
        );

      }
    );

  } catch (error) {

    console.error(
      "ERRO AO INICIAR SERVIDOR:",
      error
    );

    process.exit(1);

  }

}

startServer();
```
