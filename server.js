import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

const BASE_URL = (
  process.env.BASE_URL ||
  `http://localhost:${PORT}`
).trim();

const MERCADOPAGO_ACCESS_TOKEN = (
  process.env.MERCADOPAGO_ACCESS_TOKEN || ""
).trim();

const TELEGRAM_INVITE_URL = (
  process.env.TELEGRAM_INVITE_URL || ""
).trim();

const PIX_ENABLED =
  String(process.env.PIX_ENABLED || "true")
    .trim()
    .toLowerCase() === "true";

app.use(express.json());
app.use(express.static("public"));

/* =========================
   BANCO DE DADOS
========================= */

const db = new Database("baiano-tips.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpf TEXT,
    order_id TEXT,
    name TEXT,
    email TEXT,
    plan TEXT,
    amount REAL,
    status TEXT,
    active_until TEXT,
    created_at TEXT
  )
`);

/* =========================
   PLANOS
========================= */

const plans = {
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

/* =========================
   CPF
========================= */

function cleanCPF(cpf) {
  return String(cpf || "").replace(/\D/g, "");
}

function validCPF(cpf) {
  cpf = cleanCPF(cpf);

  if (cpf.length !== 11) {
    return false;
  }

  if (/^(\d)\1{10}$/.test(cpf)) {
    return false;
  }

  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }

  let digit1 = 11 - (sum % 11);

  if (digit1 >= 10) {
    digit1 = 0;
  }

  if (digit1 !== Number(cpf[9])) {
    return false;
  }

  sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }

  let digit2 = 11 - (sum % 11);

  if (digit2 >= 10) {
    digit2 = 0;
  }

  return digit2 === Number(cpf[10]);
}

/* =========================
   VERIFICAÇÃO DO TOKEN
========================= */

app.get("/api/mercadopago-test", async (req, res) => {
  try {
    if (!MERCADOPAGO_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        message:
          "MERCADOPAGO_ACCESS_TOKEN não está configurado."
      });
    }

    const response = await fetch(
      "https://api.mercadopago.com/v1/payment_methods",
      {
        method: "GET",
        headers: new Headers({
          "Accept": "application/json",
          "Authorization":
            `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`
        })
      }
    );

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        raw: text
      };
    }

    console.log(
      "TESTE MERCADO PAGO:",
      response.status
    );

    if (!response.ok) {
      console.error(
        "RESPOSTA MERCADO PAGO:",
        JSON.stringify(data, null, 2)
      );

      return res.status(response.status).json({
        success: false,
        httpStatus: response.status,
        message:
          data?.message ||
          data?.error ||
          "Mercado Pago recusou a autenticação.",
        details: data
      });
    }

    return res.json({
      success: true,
      httpStatus: response.status,
      message:
        "Token aceito pelo Mercado Pago.",
      paymentMethods:
        Array.isArray(data)
          ? data.length
          : null
    });

  } catch (error) {
    console.error(
      "ERRO NO TESTE MERCADO PAGO:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Erro ao testar Mercado Pago."
    });
  }
});

/* =========================
   FUNÇÃO MERCADO PAGO
========================= */

async function mercadoPagoRequest(
  url,
  options = {}
) {
  if (!MERCADOPAGO_ACCESS_TOKEN) {
    throw new Error(
      "MERCADOPAGO_ACCESS_TOKEN não está configurado."
    );
  }

  const headers = new Headers(
    options.headers || {}
  );

  headers.set(
    "Accept",
    "application/json"
  );

  headers.set(
    "Content-Type",
    "application/json"
  );

  headers.set(
    "Authorization",
    `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`
  );

  const response = await fetch(
    url,
    {
      ...options,
      headers
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    console.error(
      "Mercado Pago HTTP:",
      response.status
    );

    console.error(
      "Mercado Pago:",
      JSON.stringify(
        data,
        null,
        2
      )
    );

    let message =
      data?.message ||
      data?.error ||
      data?.raw ||
      "Erro na API do Mercado Pago.";

    if (Array.isArray(data?.cause)) {
      const causes =
        data.cause
          .map((item) =>
            `${item.code || "ERRO"} - ${item.description || ""}`
          )
          .join(" | ");

      if (causes) {
        message += ` | ${causes}`;
      }
    }

    throw new Error(
      `${message} (HTTP ${response.status})`
    );
  }

  return data;
}

/* =========================
   CRIAR PIX
========================= */

async function createMercadoPagoPix({
  name,
  email,
  cpf,
  amount,
  description,
  externalReference
}) {
  const idempotencyKey =
    crypto.randomUUID();

  const body = {
    transaction_amount:
      Number(amount),

    description,

    payment_method_id:
      "pix",

    payer: {
      email,

      first_name:
        String(name || "")
          .trim()
          .split(" ")[0] || "Cliente",

      identification: {
        type: "CPF",
        number:
          cleanCPF(cpf)
      }
    },

    external_reference:
      externalReference,

    notification_url:
      `${BASE_URL}/api/mercadopago/webhook`
  };

  return await mercadoPagoRequest(
    "https://api.mercadopago.com/v1/payments",
    {
      method: "POST",

      headers: {
        "X-Idempotency-Key":
          idempotencyKey
      },

      body:
        JSON.stringify(body)
    }
  );
}

/* =========================
   CRIAR PAGAMENTO
========================= */

app.post(
  "/api/create-payment",
  async (req, res) => {
    try {
      if (!PIX_ENABLED) {
        return res.status(503).json({
          success: false,
          message:
            "PIX está desativado."
        });
      }

      const {
        name,
        cpf,
        email,
        plan
      } = req.body;

      if (
        !name ||
        !cpf ||
        !email ||
        !plan
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Preencha nome, CPF, e-mail e plano."
        });
      }

      const cleanCpf =
        cleanCPF(cpf);

      if (!validCPF(cleanCpf)) {
        return res.status(400).json({
          success: false,
          message:
            "CPF inválido."
        });
      }

      if (!plans[plan]) {
        return res.status(400).json({
          success: false,
          message:
            "Plano inválido."
        });
      }

      const selectedPlan =
        plans[plan];

      const externalReference =
        `BAIANOTIPS-${Date.now()}-${crypto
          .randomBytes(4)
          .toString("hex")
          .toUpperCase()}`;

      const payment =
        await createMercadoPagoPix({
          name,
          email,
          cpf: cleanCpf,
          amount:
            selectedPlan.amount,
          description:
            `Baiano Tips - ${selectedPlan.name}`,
          externalReference
        });

      const transactionData =
        payment
          ?.point_of_interaction
          ?.transaction_data;

      const qrCode =
        transactionData?.qr_code ||
        null;

      const qrCodeBase64 =
        transactionData?.qr_code_base64 ||
        null;

      const paymentId =
        payment?.id
          ? String(payment.id)
          : "";

      if (!paymentId || !qrCode) {
        return res.status(500).json({
          success: false,
          message:
            "Mercado Pago não retornou os dados do PIX.",
          details:
            payment
        });
      }

      db.prepare(`
        INSERT INTO payments (
          cpf,
          order_id,
          name,
          email,
          plan,
          amount,
          status,
          active_until,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleanCpf,
        paymentId,
        name,
        email,
        plan,
        selectedPlan.amount,
        payment.status ||
          "pending",
        null,
        new Date().toISOString()
      );

      return res.json({
        success: true,

        paymentId,

        orderId:
          paymentId,

        status:
          payment.status ||
          "pending",

        pix:
          qrCode,

        qrCode:
          qrCode,

        qrCodeBase64:
          qrCodeBase64
            ? `data:image/png;base64,${qrCodeBase64}`
            : null,

        amount:
          selectedPlan.amount,

        plan,

        message:
          "PIX criado com sucesso."
      });

    } catch (error) {
      console.error(
        "ERRO /api/create-payment:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Não foi possível gerar o PIX."
      });
    }
  }
);

/* =========================
   WEBHOOK
========================= */

app.post(
  "/api/mercadopago/webhook",
  async (req, res) => {
    try {
      console.log(
        "WEBHOOK:",
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      res.sendStatus(200);

      const data =
        req.body || {};

      let paymentId =
        data?.data?.id ||
        data?.id ||
        null;

      if (!paymentId) {
        return;
      }

      paymentId =
        String(paymentId);

      const payment =
        await mercadoPagoRequest(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          {
            method: "GET"
          }
        );

      const status =
        payment.status ||
        "pending";

      const paymentRow =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE order_id = ?
          LIMIT 1
        `).get(paymentId);

      if (!paymentRow) {
        console.log(
          "Pagamento não encontrado:",
          paymentId
        );
        return;
      }

      let activeUntil =
        paymentRow.active_until;

      if (
        status === "approved" &&
        !activeUntil
      ) {
        const date =
          new Date();

        const days =
          plans[
            paymentRow.plan
          ]?.days || 0;

        date.setDate(
          date.getDate() + days
        );

        activeUntil =
          date.toISOString();
      }

      db.prepare(`
        UPDATE payments
        SET
          status = ?,
          active_until = ?
        WHERE order_id = ?
      `).run(
        status,
        activeUntil,
        paymentId
      );

    } catch (error) {
      console.error(
        "ERRO WEBHOOK:",
        error
      );
    }
  }
);

/* =========================
   ACESSO
========================= */

app.get(
  "/api/access",
  (req, res) => {
    try {
      const email =
        String(
          req.query.email || ""
        )
          .trim()
          .toLowerCase();

      if (!email) {
        return res.status(400).json({
          success: false,
          message:
            "Informe o e-mail."
        });
      }

      const payment =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE LOWER(email) = ?
            AND status = 'approved'
          ORDER BY id DESC
          LIMIT 1
        `).get(email);

      if (!payment) {
        return res.json({
          success: false,
          active: false,
          message:
            "Nenhuma assinatura ativa encontrada."
        });
      }

      const activeUntil =
        payment.active_until
          ? new Date(
              payment.active_until
            )
          : null;

      if (
        !activeUntil ||
        activeUntil <= new Date()
      ) {
        return res.json({
          success: false,
          active: false,
          message:
            "Sua assinatura está expirada."
        });
      }

      return res.json({
        success: true,
        active: true,
        name:
          payment.name,
        plan:
          payment.plan,
        activeUntil:
          payment.active_until,
        telegram:
          TELEGRAM_INVITE_URL ||
          null,
        message:
          "Assinatura ativa."
      });

    } catch (error) {
      console.error(
        "ERRO ACCESS:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Erro ao consultar acesso."
      });
    }
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      server: "online",
      provider:
        "mercadopago"
    });
  }
);

/* =========================
   CONFIGURAÇÃO
========================= */

app.get(
  "/api/config-test",
  (req, res) => {
    res.json({
      server: "online",

      mercadoPagoTokenConfigured:
        Boolean(
          MERCADOPAGO_ACCESS_TOKEN
        ),

      mercadoPagoTokenPrefix:
        MERCADOPAGO_ACCESS_TOKEN
          ? MERCADOPAGO_ACCESS_TOKEN.slice(
              0,
              8
            )
          : null,

      mercadoPagoTokenLength:
        MERCADOPAGO_ACCESS_TOKEN
          ? MERCADOPAGO_ACCESS_TOKEN.length
          : 0,

      pixEnabled:
        PIX_ENABLED,

      baseUrlConfigured:
        Boolean(BASE_URL),

      telegramConfigured:
        Boolean(
          TELEGRAM_INVITE_URL
        ),

      message:
        "Configuração carregada com sucesso."
    });
  }
);

/* =========================
   SERVIDOR
========================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Servidor online na porta ${PORT}`
    );

    console.log(
      `Mercado Pago configurado: ${
        MERCADOPAGO_ACCESS_TOKEN
          ? "SIM"
          : "NÃO"
      }`
    );

    console.log(
      `PIX habilitado: ${
        PIX_ENABLED
          ? "SIM"
          : "NÃO"
      }`
    );
  }
);
