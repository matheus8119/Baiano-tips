import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static("public"));

const db = new Database("payments.db");

// =========================
// BANCO DE DADOS
// =========================

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id TEXT UNIQUE,
    external_reference TEXT,
    name TEXT,
    cpf TEXT,
    email TEXT,
    plan TEXT,
    amount REAL,
    status TEXT,
    created_at TEXT,
    approved_at TEXT,
    active_until TEXT
  )
`);

// =========================
// CONFIGURAÇÕES
// =========================

const BASE_URL =
  process.env.BASE_URL || "https://baiano-tips-1.onrender.com";

const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;

const TELEGRAM_INVITE_URL =
  process.env.TELEGRAM_INVITE_URL ||
  "https://t.me/+1F0a440X9zg2MDgx";

const PIX_ENABLED =
  String(process.env.PIX_ENABLED).toLowerCase() === "true";

// =========================
// PLANOS
// =========================

const PLANS = {
  mensal: {
    name: "Mensal",
    amount: 29.9,
    days: 30
  },

  trimestral: {
    name: "Trimestral",
    amount: 69.9,
    days: 90
  },

  semestral: {
    name: "Semestral",
    amount: 119.9,
    days: 180
  },

  anual: {
    name: "Anual",
    amount: 199.9,
    days: 365
  }
};

// =========================
// FUNÇÕES AUXILIARES
// =========================

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateCPF(cpf) {
  const value = String(cpf || "").replace(/\D/g, "");

  if (value.length !== 11) {
    return false;
  }

  if (/^(\d)\1+$/.test(value)) {
    return false;
  }

  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += Number(value[i]) * (10 - i);
  }

  let digit = 11 - (sum % 11);

  if (digit >= 10) {
    digit = 0;
  }

  if (digit !== Number(value[9])) {
    return false;
  }

  sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(value[i]) * (11 - i);
  }

  digit = 11 - (sum % 11);

  if (digit >= 10) {
    digit = 0;
  }

  return digit === Number(value[10]);
}

function getPlanByDescription(description = "") {
  const text = description.toLowerCase();

  if (text.includes("anual")) {
    return "anual";
  }

  if (text.includes("semestral")) {
    return "semestral";
  }

  if (text.includes("trimestral")) {
    return "trimestral";
  }

  if (text.includes("mensal")) {
    return "mensal";
  }

  return null;
}

function getPlanByAmount(amount) {
  const value = Number(amount);

  for (const [key, plan] of Object.entries(PLANS)) {
    if (Math.abs(plan.amount - value) < 0.01) {
      return key;
    }
  }

  return null;
}

function calculateActiveUntil(approvedAt, planKey) {
  const plan = PLANS[planKey];

  if (!plan) {
    return null;
  }

  const date = new Date(approvedAt);

  date.setDate(date.getDate() + plan.days);

  return date.toISOString();
}

function generateExternalReference() {
  return (
    "BAIANOTIPS-" +
    Date.now() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

// =========================
// MERCADO PAGO
// =========================

async function mercadoPagoRequest(path, options = {}) {
  if (!MP_TOKEN) {
    throw new Error("MERCADOPAGO_ACCESS_TOKEN não configurado.");
  }

  const response = await fetch(
    `https://api.mercadopago.com${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      data?.error ||
      `Mercado Pago HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

// =========================
// SALVAR PAGAMENTO
// =========================

function saveApprovedPayment(payment, emailOverride = null) {
  const paymentId = String(payment.id);

  const description = payment.description || "";

  let plan = getPlanByDescription(description);

  if (!plan) {
    plan = getPlanByAmount(payment.transaction_amount);
  }

  if (!plan) {
    throw new Error(
      `Não consegui identificar o plano do pagamento ${paymentId}.`
    );
  }

  const approvedAt =
    payment.date_approved ||
    payment.date_last_updated ||
    new Date().toISOString();

  const email =
    normalizeEmail(emailOverride) ||
    normalizeEmail(payment?.payer?.email);

  const externalReference =
    payment.external_reference || null;

  const activeUntil = calculateActiveUntil(
    approvedAt,
    plan
  );

  const existing = db
    .prepare(
      `
      SELECT *
      FROM payments
      WHERE payment_id = ?
      `
    )
    .get(paymentId);

  if (existing) {
    db.prepare(
      `
      UPDATE payments
      SET
        email = ?,
        plan = ?,
        amount = ?,
        status = ?,
        external_reference = ?,
        approved_at = ?,
        active_until = ?
      WHERE payment_id = ?
      `
    ).run(
      email || existing.email || "",
      plan,
      Number(payment.transaction_amount),
      payment.status,
      externalReference,
      approvedAt,
      activeUntil,
      paymentId
    );
  } else {
    db.prepare(
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
        created_at,
        approved_at,
        active_until
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      paymentId,
      externalReference,
      "",
      "",
      email,
      plan,
      Number(payment.transaction_amount),
      payment.status,
      payment.date_created || new Date().toISOString(),
      approvedAt,
      activeUntil
    );
  }

  return {
    paymentId,
    plan,
    amount: Number(payment.transaction_amount),
    email,
    status: payment.status,
    approvedAt,
    activeUntil
  };
}

// =========================
// CRIAR PAGAMENTO PIX
// =========================

app.post("/api/create-payment", async (req, res) => {
  try {
    if (!PIX_ENABLED) {
      return res.status(400).json({
        success: false,
        message: "PIX está desativado."
      });
    }

    if (!MP_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "Mercado Pago não configurado."
      });
    }

    const {
      name,
      cpf,
      email,
      plan
    } = req.body;

    if (!name || !cpf || !email || !plan) {
      return res.status(400).json({
        success: false,
        message: "Preencha todos os campos."
      });
    }

    if (!PLANS[plan]) {
      return res.status(400).json({
        success: false,
        message: "Plano inválido."
      });
    }

    if (!validateCPF(cpf)) {
      return res.status(400).json({
        success: false,
        message: "CPF inválido."
      });
    }

    const cleanEmail = normalizeEmail(email);

    const selectedPlan = PLANS[plan];

    const externalReference =
      generateExternalReference();

    const payment = await mercadoPagoRequest(
      "/v1/payments",
      {
        method: "POST",
        headers: {
          "X-Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          transaction_amount: selectedPlan.amount,

          description:
            `Baiano Tips - ${selectedPlan.name}`,

          payment_method_id: "pix",

          external_reference:
            externalReference,

          payer: {
            email: cleanEmail,
            first_name: name
          }
        })
      }
    );

    if (!payment.id) {
      throw new Error(
        "Mercado Pago não retornou o ID do pagamento."
      );
    }

    const qrCode =
      payment.point_of_interaction
        ?.transaction_data
        ?.qr_code || null;

    const qrCodeBase64 =
      payment.point_of_interaction
        ?.transaction_data
        ?.qr_code_base64 || null;

    return res.json({
      success: true,

      paymentId: payment.id,

      status: payment.status,

      qrCode,

      qrCodeBase64,

      pix: qrCode,

      plan,

      amount: selectedPlan.amount,

      externalReference
    });

  } catch (error) {
    console.error(
      "ERRO CREATE PAYMENT:",
      error?.data || error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.data?.message ||
        error.message ||
        "Erro ao criar pagamento."
    });
  }
});

// =========================
// WEBHOOK
// =========================

app.post("/api/mercadopago/webhook", async (req, res) => {
  try {
    const paymentId =
      req.body?.data?.id ||
      req.body?.id;

    if (!paymentId) {
      return res.sendStatus(200);
    }

    const payment =
      await mercadoPagoRequest(
        `/v1/payments/${paymentId}`
      );

    if (payment.status === "approved") {
      saveApprovedPayment(payment);
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "ERRO WEBHOOK:",
      error?.data || error
    );

    return res.sendStatus(200);
  }
});

// =========================
// RECUPERAR PELO ID
// =========================

app.get("/api/recover-payment-by-id", async (req, res) => {
  try {
    const paymentId =
      String(req.query.id || "").trim();

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: "Informe o ID do pagamento."
      });
    }

    const payment =
      await mercadoPagoRequest(
        `/v1/payments/${paymentId}`
      );

    if (payment.status !== "approved") {
      return res.json({
        success: false,
        recovered: false,
        paymentId,
        status: payment.status,
        message:
          "Este pagamento ainda não está aprovado."
      });
    }

    const saved =
      saveApprovedPayment(payment);

    return res.json({
      success: true,
      recovered: true,
      message:
        "Pagamento aprovado recuperado com sucesso.",

      paymentId: saved.paymentId,

      status: saved.status,

      plan: saved.plan,

      amount: saved.amount,

      email: saved.email,

      activeUntil:
        saved.activeUntil,

      telegram:
        TELEGRAM_INVITE_URL
    });

  } catch (error) {
    console.error(
      "ERRO RECOVERY ID:",
      error?.data || error
    );

    return res.status(500).json({
      success: false,
      recovered: false,
      message:
        error?.data?.message ||
        error.message ||
        "Erro ao recuperar pagamento."
    });
  }
});

// =========================
// BUSCAR PAGAMENTOS NO MERCADO PAGO
// =========================

async function findApprovedPaymentByEmail(email) {
  const cleanEmail =
    normalizeEmail(email);

  if (!cleanEmail) {
    return null;
  }

  const search =
    await mercadoPagoRequest(
      "/v1/payments/search?sort=date_created&criteria=desc&limit=50"
    );

  const results =
    search.results || [];

  for (const item of results) {
    if (item.status !== "approved") {
      continue;
    }

    try {
      const payment =
        await mercadoPagoRequest(
          `/v1/payments/${item.id}`
        );

      const payerEmail =
        normalizeEmail(
          payment?.payer?.email
        );

      if (
        payerEmail &&
        payerEmail === cleanEmail
      ) {
        return payment;
      }

    } catch (error) {
      console.error(
        `Erro consultando pagamento ${item.id}:`,
        error.message
      );
    }
  }

  return null;
}

// =========================
// ACESSO DO ASSINANTE
// =========================

app.get("/api/access", async (req, res) => {
  try {
    const email =
      normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Informe o e-mail."
      });
    }

    // ---------------------------------
    // 1. PRIMEIRO PROCURA NO SQLITE
    // ---------------------------------

    const localPayment = db
      .prepare(
        `
        SELECT *
        FROM payments
        WHERE LOWER(email) = ?
          AND status = 'approved'
        ORDER BY active_until DESC
        LIMIT 1
        `
      )
      .get(email);

    if (
      localPayment &&
      localPayment.active_until
    ) {
      const activeUntil =
        new Date(localPayment.active_until);

      if (activeUntil > new Date()) {
        return res.json({
          success: true,
          active: true,

          plan: localPayment.plan,

          amount: localPayment.amount,

          paymentId:
            localPayment.payment_id,

          activeUntil:
            localPayment.active_until,

          telegram:
            TELEGRAM_INVITE_URL
        });
      }
    }

    // ---------------------------------
    // 2. SE NÃO ACHOU, CONSULTA
    //    O MERCADO PAGO
    // ---------------------------------

    const payment =
      await findApprovedPaymentByEmail(email);

    if (!payment) {
      return res.json({
        success: true,
        active: false,
        message:
          "Nenhuma assinatura ativa encontrada."
      });
    }

    // ---------------------------------
    // 3. RECRIA A ASSINATURA NO BANCO
    // ---------------------------------

    const saved =
      saveApprovedPayment(
        payment,
        email
      );

    if (
      new Date(saved.activeUntil) <=
      new Date()
    ) {
      return res.json({
        success: true,
        active: false,
        message:
          "A assinatura encontrada está expirada."
      });
    }

    return res.json({
      success: true,
      active: true,

      plan: saved.plan,

      amount: saved.amount,

      paymentId:
        saved.paymentId,

      activeUntil:
        saved.activeUntil,

      telegram:
        TELEGRAM_INVITE_URL
    });

  } catch (error) {
    console.error(
      "ERRO ACCESS:",
      error?.data || error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.data?.message ||
        error.message ||
        "Erro ao verificar assinatura."
    });
  }
});

// =========================
// RECOVERY POR E-MAIL
// =========================

app.get("/api/recover-payment", async (req, res) => {
  try {
    const email =
      normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Informe o e-mail."
      });
    }

    const payment =
      await findApprovedPaymentByEmail(email);

    if (!payment) {
      return res.json({
        success: false,
        recovered: false,
        message:
          "Não encontrei pagamento aprovado para este e-mail."
      });
    }

    const saved =
      saveApprovedPayment(
        payment,
        email
      );

    return res.json({
      success: true,
      recovered: true,

      paymentId:
        saved.paymentId,

      plan:
        saved.plan,

      amount:
        saved.amount,

      email:
        saved.email,

      activeUntil:
        saved.activeUntil,

      telegram:
        TELEGRAM_INVITE_URL
    });

  } catch (error) {
    console.error(
      "ERRO RECOVER EMAIL:",
      error?.data || error
    );

    return res.status(500).json({
      success: false,
      recovered: false,
      message:
        error.message ||
        "Erro ao recuperar assinatura."
    });
  }
});

// =========================
// LISTAR PAGAMENTOS MERCADO PAGO
// =========================

app.get("/api/mercadopago-payments", async (req, res) => {
  try {
    const data =
      await mercadoPagoRequest(
        "/v1/payments/search?sort=date_created&criteria=desc&limit=20"
      );

    const payments =
      (data.results || []).map((payment) => ({
        id: String(payment.id),

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
          payment?.payer?.email || null,

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
        error?.data?.message ||
        error.message
    });
  }
});

// =========================
// DIAGNÓSTICO DO BANCO
// =========================

app.get("/api/payment-diagnose", (req, res) => {
  try {
    const email =
      normalizeEmail(req.query.email);

    let payment;

    if (email) {
      payment = db
        .prepare(
          `
          SELECT *
          FROM payments
          WHERE LOWER(email) = ?
          ORDER BY id DESC
          LIMIT 1
          `
        )
        .get(email);
    } else {
      payment = db
        .prepare(
          `
          SELECT *
          FROM payments
          ORDER BY id DESC
          LIMIT 1
          `
        )
        .get();
    }

    return res.json({
      success: true,

      databasePayment:
        payment || null,

      message:
        payment
          ? "Pagamento encontrado no banco."
          : "Nenhum pagamento encontrado no banco."
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =========================
// TESTE MERCADO PAGO
// =========================

app.get("/api/mercadopago-test", async (req, res) => {
  try {
    const data =
      await mercadoPagoRequest(
        "/v1/payment_methods"
      );

    return res.json({
      success: true,

      httpStatus: 200,

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

      httpStatus:
        error.status || 500,

      message:
        error?.data?.message ||
        error.message
    });
  }
});

// =========================
// CONFIG TEST
// =========================

app.get("/api/config-test", (req, res) => {
  return res.json({
    server: "online",

    mercadoPagoTokenConfigured:
      Boolean(MP_TOKEN),

    mercadoPagoTokenPrefix:
      MP_TOKEN
        ? MP_TOKEN.substring(0, 8)
        : null,

    mercadoPagoTokenLength:
      MP_TOKEN
        ? MP_TOKEN.length
        : 0,

    pixEnabled:
      PIX_ENABLED,

    baseUrlConfigured:
      Boolean(BASE_URL),

    telegramConfigured:
      Boolean(TELEGRAM_INVITE_URL),

    message:
      "Configuração carregada com sucesso."
  });
});

// =========================
// HEALTH
// =========================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    time: new Date().toISOString()
  });
});

// =========================
// INICIAR SERVIDOR
// =========================

app.listen(PORT, () => {
  console.log(
    `Servidor online na porta ${PORT}`
  );
});
