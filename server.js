import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const MERCADO_PAGO_TOKEN =
  process.env.MERCADOPAGO_ACCESS_TOKEN;

const BASE_URL =
  process.env.BASE_URL ||
  `http://localhost:${PORT}`;

const PIX_ENABLED =
  String(process.env.PIX_ENABLED || "true")
    .toLowerCase() === "true";

const TELEGRAM_INVITE_URL =
  process.env.TELEGRAM_INVITE_URL || "";

const plans = {
  mensal: {
    name: "Mensal",
    price: 29.90,
    days: 30
  },
  trimestral: {
    name: "Trimestral",
    price: 69.90,
    days: 90
  },
  semestral: {
    name: "Semestral",
    price: 119.90,
    days: 180
  },
  anual: {
    name: "Anual",
    price: 199.90,
    days: 365
  }
};

// ======================================================
// BANCO DE DADOS
// ======================================================

const db = new Database("baiano-tips.db");

db.pragma("journal_mode = WAL");

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

function addColumnIfMissing(
  table,
  column,
  definition
) {
  try {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all();

    const exists = columns.some(
      (col) => col.name === column
    );

    if (!exists) {
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
      );
    }
  } catch (error) {
    console.error(
      `Erro verificando coluna ${column}:`,
      error.message
    );
  }
}

addColumnIfMissing(
  "payments",
  "external_reference",
  "TEXT"
);

addColumnIfMissing(
  "payments",
  "approved_at",
  "TEXT"
);

addColumnIfMissing(
  "payments",
  "active_until",
  "TEXT"
);

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeCPF(cpf) {
  return String(cpf || "")
    .replace(/\D/g, "");
}

function isValidCPF(cpf) {
  cpf = normalizeCPF(cpf);

  if (cpf.length !== 11) {
    return false;
  }

  if (/^(\d)\1+$/.test(cpf)) {
    return false;
  }

  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }

  let remainder =
    (sum * 10) % 11;

  if (remainder === 10) {
    remainder = 0;
  }

  if (remainder !== Number(cpf[9])) {
    return false;
  }

  sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }

  remainder =
    (sum * 10) % 11;

  if (remainder === 10) {
    remainder = 0;
  }

  return remainder === Number(cpf[10]);
}

function getPlanFromPayment(payment) {
  const description =
    String(
      payment?.description || ""
    ).toLowerCase();

  const amount =
    Number(
      payment?.transaction_amount || 0
    );

  if (
    description.includes("anual") ||
    Math.abs(
      amount - plans.anual.price
    ) < 0.01
  ) {
    return "anual";
  }

  if (
    description.includes("semestral") ||
    Math.abs(
      amount - plans.semestral.price
    ) < 0.01
  ) {
    return "semestral";
  }

  if (
    description.includes("trimestral") ||
    Math.abs(
      amount - plans.trimestral.price
    ) < 0.01
  ) {
    return "trimestral";
  }

  if (
    description.includes("mensal") ||
    Math.abs(
      amount - plans.mensal.price
    ) < 0.01
  ) {
    return "mensal";
  }

  return null;
}

function calculateActiveUntil(
  planKey,
  approvedDate
) {
  const plan = plans[planKey];

  if (!plan) {
    return null;
  }

  const date = new Date(
    approvedDate || new Date()
  );

  date.setDate(
    date.getDate() + plan.days
  );

  return date.toISOString();
}

// ======================================================
// MERCADO PAGO
// ======================================================

async function mercadoPagoRequest(
  path,
  options = {}
) {
  if (!MERCADO_PAGO_TOKEN) {
    throw new Error(
      "MERCADOPAGO_ACCESS_TOKEN não configurado."
    );
  }

  const response = await fetch(
    `https://api.mercadopago.com${path}`,
    {
      method:
        options.method || "GET",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${MERCADO_PAGO_TOKEN}`,

        ...(options.headers || {})
      },

      body: options.body
        ? JSON.stringify(options.body)
        : undefined
    }
  );

  const text =
    await response.text();

  let data = {};

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

// ======================================================
// CRIAR PAGAMENTO PIX
// ======================================================

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
        !email ||
        !cpf ||
        !plan
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Nome, CPF, e-mail e plano são obrigatórios."
        });
      }

      if (!plans[plan]) {
        return res.status(400).json({
          success: false,
          message:
            "Plano inválido."
        });
      }

      const cleanCPF =
        normalizeCPF(cpf);

      const cleanEmail =
        normalizeEmail(email);

      if (!isValidCPF(cleanCPF)) {
        return res.status(400).json({
          success: false,
          message:
            "CPF inválido."
        });
      }

      if (
        !cleanEmail.includes("@") ||
        cleanEmail.length < 5
      ) {
        return res.status(400).json({
          success: false,
          message:
            "E-mail inválido."
        });
      }

      const selectedPlan =
        plans[plan];

      const externalReference =
        `BAIANOTIPS-${Date.now()}-${crypto
          .randomBytes(4)
          .toString("hex")
          .toUpperCase()}`;

      const idempotencyKey =
        crypto.randomUUID();

      const paymentPayload = {
        transaction_amount:
          selectedPlan.price,

        description:
          `Baiano Tips - ${selectedPlan.name}`,

        payment_method_id:
          "pix",

        payer: {
          email: cleanEmail,
          first_name:
            String(name).trim()
        },

        external_reference:
          externalReference,

        notification_url:
          `${BASE_URL}/api/mercadopago/webhook`
      };

      paymentPayload.payer.identification = {
        type: "CPF",
        number: cleanCPF
      };

      const result =
        await mercadoPagoRequest(
          "/v1/payments",
          {
            method: "POST",

            headers: {
              "X-Idempotency-Key":
                idempotencyKey
            },

            body:
              paymentPayload
          }
        );

      if (!result.ok) {
        console.error(
          "Erro Mercado Pago:",
          result.status,
          result.data
        );

        return res.status(
          result.status
        ).json({
          success: false,
          message:
            result.data?.message ||
            "Erro ao criar pagamento.",
          error:
            result.data
        });
      }

      const payment =
        result.data;

      const paymentId =
        String(payment.id);

      const transactionData =
        payment
          .point_of_interaction
          ?.transaction_data;

      const qrCode =
        transactionData
          ?.qr_code || null;

      const qrCodeBase64 =
        transactionData
          ?.qr_code_base64 || null;

      const createdAt =
        payment.date_created ||
        new Date().toISOString();

      db.prepare(`
        INSERT OR REPLACE INTO payments (
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
        VALUES (
          @payment_id,
          @external_reference,
          @name,
          @cpf,
          @email,
          @plan,
          @amount,
          @status,
          @created_at,
          NULL,
          NULL
        )
      `).run({
        payment_id:
          paymentId,

        external_reference:
          externalReference,

        name:
          String(name).trim(),

        cpf:
          cleanCPF,

        email:
          cleanEmail,

        plan,

        amount:
          selectedPlan.price,

        status:
          payment.status ||
          "pending",

        created_at:
          createdAt
      });

      return res.json({
        success: true,
        paymentId,
        status:
          payment.status,
        qrCode,
        qrCodeBase64,
        pix: qrCode,
        externalReference
      });

    } catch (error) {
      console.error(
        "Erro create-payment:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Erro interno ao criar pagamento."
      });
    }
  }
);

// ======================================================
// WEBHOOK MERCADO PAGO
// ======================================================

app.post(
  "/api/mercadopago/webhook",
  async (req, res) => {
    try {
      console.log(
        "Webhook Mercado Pago:",
        JSON.stringify(req.body)
      );

      res.sendStatus(200);

      const body =
        req.body || {};

      let paymentId = null;

      if (
        body.data?.id
      ) {
        paymentId =
          String(body.data.id);
      }

      if (!paymentId) {
        return;
      }

      const result =
        await mercadoPagoRequest(
          `/v1/payments/${encodeURIComponent(
            paymentId
          )}`
        );

      if (!result.ok) {
        console.error(
          "Erro consultando pagamento:",
          result.status,
          result.data
        );

        return;
      }

      const payment =
        result.data;

      if (
        payment.status !==
        "approved"
      ) {
        db.prepare(`
          UPDATE payments
          SET status = ?
          WHERE payment_id = ?
        `).run(
          payment.status ||
            "unknown",
          String(payment.id)
        );

        return;
      }

      const existing =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE payment_id = ?
          LIMIT 1
        `).get(
          String(payment.id)
        );

      const plan =
        existing?.plan ||
        getPlanFromPayment(
          payment
        );

      if (!plan) {
        console.error(
          "Não foi possível identificar o plano."
        );

        return;
      }

      const approvedAt =
        payment.date_approved ||
        new Date().toISOString();

      const activeUntil =
        calculateActiveUntil(
          plan,
          approvedAt
        );

      const email =
        normalizeEmail(
          existing?.email ||
          payment.payer?.email ||
          ""
        );

      db.prepare(`
        INSERT OR REPLACE INTO payments (
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
        VALUES (
          @payment_id,
          @external_reference,
          @name,
          @cpf,
          @email,
          @plan,
          @amount,
          'approved',
          @created_at,
          @approved_at,
          @active_until
        )
      `).run({
        payment_id:
          String(payment.id),

        external_reference:
          payment.external_reference ||
          existing?.external_reference ||
          null,

        name:
          existing?.name ||
          payment.payer?.first_name ||
          "",

        cpf:
          existing?.cpf ||
          payment.payer?.identification
            ?.number ||
          "",

        email,

        plan,

        amount:
          Number(
            payment.transaction_amount ||
            0
          ),

        created_at:
          payment.date_created ||
          new Date().toISOString(),

        approved_at:
          approvedAt,

        active_until:
          activeUntil
      });

      console.log(
        "Pagamento aprovado registrado:",
        payment.id
      );

    } catch (error) {
      console.error(
        "Erro webhook:",
        error
      );
    }
  }
);

// ======================================================
// RECUPERAR PAGAMENTO DIRETAMENTE PELO ID
// ======================================================

app.get(
  "/api/recover-payment-by-id",
  async (req, res) => {
    try {
      const paymentId =
        String(
          req.query.id || ""
        ).trim();

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          recovered: false,
          message:
            "Informe o ID do pagamento."
        });
      }

      console.log(
        "Recuperando pagamento:",
        paymentId
      );

      const result =
        await mercadoPagoRequest(
          `/v1/payments/${encodeURIComponent(
            paymentId
          )}`
        );

      if (!result.ok) {
        console.error(
          "Erro Mercado Pago:",
          result.status,
          result.data
        );

        return res.status(
          result.status
        ).json({
          success: false,
          recovered: false,
          message:
            "Não foi possível consultar esse pagamento no Mercado Pago.",
          mercadoPagoStatus:
            result.status,
          error:
            result.data
        });
      }

      const payment =
        result.data;

      if (
        payment.status !==
        "approved"
      ) {
        return res.json({
          success: false,
          recovered: false,
          message:
            "O pagamento ainda não está aprovado.",
          paymentId:
            String(payment.id),
          status:
            payment.status,
          statusDetail:
            payment.status_detail
        });
      }

      const plan =
        getPlanFromPayment(
          payment
        );

      if (!plan) {
        return res.json({
          success: false,
          recovered: false,
          message:
            "Pagamento aprovado, mas não consegui identificar o plano.",
          paymentId:
            String(payment.id),
          amount:
            payment.transaction_amount,
          description:
            payment.description
        });
      }

      const existing =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE payment_id = ?
          LIMIT 1
        `).get(
          String(payment.id)
        );

      /*
       * Como o Mercado Pago não está retornando
       * o e-mail na pesquisa, aproveitamos o e-mail
       * que já estava salvo localmente, se existir.
       *
       * Se o banco tiver sido perdido após um deploy,
       * o acesso será recuperado pelo pagamento,
       * mas precisaremos informar o e-mail depois.
       */

      const email =
        normalizeEmail(
          existing?.email ||
          payment.payer?.email ||
          ""
        );

      const approvedAt =
        payment.date_approved ||
        payment.date_created ||
        new Date().toISOString();

      const activeUntil =
        calculateActiveUntil(
          plan,
          approvedAt
        );

      db.prepare(`
        INSERT OR REPLACE INTO payments (
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
        VALUES (
          @payment_id,
          @external_reference,
          @name,
          @cpf,
          @email,
          @plan,
          @amount,
          'approved',
          @created_at,
          @approved_at,
          @active_until
        )
      `).run({
        payment_id:
          String(payment.id),

        external_reference:
          payment.external_reference ||
          existing?.external_reference ||
          null,

        name:
          existing?.name ||
          payment.payer?.first_name ||
          "",

        cpf:
          existing?.cpf ||
          payment.payer?.identification
            ?.number ||
          "",

        email,

        plan,

        amount:
          Number(
            payment.transaction_amount ||
            0
          ),

        created_at:
          payment.date_created ||
          approvedAt,

        approved_at:
          approvedAt,

        active_until:
          activeUntil
      });

      return res.json({
        success: true,
        recovered: true,
        message:
          "Pagamento aprovado recuperado com sucesso.",
        paymentId:
          String(payment.id),
        status:
          payment.status,
        plan,
        amount:
          Number(
            payment.transaction_amount ||
            0
          ),
        email:
          email || null,
        activeUntil,
        telegram:
          TELEGRAM_INVITE_URL
      });

    } catch (error) {
      console.error(
        "Erro recover-payment-by-id:",
        error
      );

      return res.status(500).json({
        success: false,
        recovered: false,
        message:
          "Erro interno ao recuperar pagamento."
      });
    }
  }
);

// ======================================================
// RECUPERAÇÃO POR E-MAIL
// ======================================================

app.get(
  "/api/recover-payment",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.query.email
        );

      if (!email) {
        return res.status(400).json({
          success: false,
          recovered: false,
          message:
            "Informe o e-mail usado no pagamento."
        });
      }

      const now =
        new Date();

      const begin =
        new Date(
          now.getTime() -
          30 *
          24 *
          60 *
          60 *
          1000
        );

      const params =
        new URLSearchParams({
          sort: "date_created",
          criteria: "desc",
          range: "date_created",
          begin_date:
            begin.toISOString(),
          end_date:
            now.toISOString(),
          status: "approved",
          limit: "50"
        });

      const result =
        await mercadoPagoRequest(
          `/v1/payments/search?${params.toString()}`
        );

      if (!result.ok) {
        return res.status(
          result.status
        ).json({
          success: false,
          recovered: false,
          message:
            "Erro ao pesquisar pagamentos.",
          error:
            result.data
        });
      }

      const payments =
        Array.isArray(
          result.data?.results
        )
          ? result.data.results
          : [];

      const matching =
        payments.filter(
          (payment) =>
            normalizeEmail(
              payment.payer?.email
            ) === email &&
            payment.status ===
              "approved"
        );

      if (!matching.length) {
        return res.json({
          success: true,
          recovered: false,
          message:
            "Não encontrei pagamento aprovado para este e-mail nos últimos 30 dias.",
          searchedPayments:
            payments.length
        });
      }

      const payment =
        matching[0];

      const plan =
        getPlanFromPayment(
          payment
        );

      if (!plan) {
        return res.json({
          success: false,
          recovered: false,
          message:
            "Pagamento encontrado, mas plano não identificado."
        });
      }

      const approvedAt =
        payment.date_approved ||
        payment.date_created;

      const activeUntil =
        calculateActiveUntil(
          plan,
          approvedAt
        );

      db.prepare(`
        INSERT OR REPLACE INTO payments (
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
        VALUES (
          @payment_id,
          @external_reference,
          @name,
          @cpf,
          @email,
          @plan,
          @amount,
          'approved',
          @created_at,
          @approved_at,
          @active_until
        )
      `).run({
        payment_id:
          String(payment.id),

        external_reference:
          payment.external_reference ||
          null,

        name:
          payment.payer?.first_name ||
          "",

        cpf:
          payment.payer?.identification
            ?.number ||
          "",

        email,

        plan,

        amount:
          Number(
            payment.transaction_amount ||
            0
          ),

        created_at:
          payment.date_created ||
          approvedAt,

        approved_at:
          approvedAt,

        active_until:
          activeUntil
      });

      return res.json({
        success: true,
        recovered: true,
        message:
          "Pagamento recuperado.",
        paymentId:
          String(payment.id),
        plan,
        activeUntil,
        telegram:
          TELEGRAM_INVITE_URL
      });

    } catch (error) {
      console.error(
        "Erro recover-payment:",
        error
      );

      return res.status(500).json({
        success: false,
        recovered: false,
        message:
          "Erro interno."
      });
    }
  }
);

// ======================================================
// ACESSO DO ASSINANTE
// ======================================================

app.get(
  "/api/access",
  (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.query.email
        );

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
          ORDER BY active_until DESC
          LIMIT 1
        `).get(email);

      if (!payment) {
        return res.json({
          success: true,
          active: false,
          message:
            "Nenhuma assinatura ativa."
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
          success: true,
          active: false,
          message:
            "Sua assinatura expirou."
        });
      }

      return res.json({
        success: true,
        active: true,
        name:
          payment.name,
        email:
          payment.email,
        plan:
          payment.plan,
        activeUntil:
          payment.active_until,
        telegram:
          TELEGRAM_INVITE_URL
      });

    } catch (error) {
      console.error(
        "Erro access:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Erro interno."
      });
    }
  }
);

// ======================================================
// PAGAMENTOS DO MERCADO PAGO - DIAGNÓSTICO
// ======================================================

app.get(
  "/api/mercadopago-payments",
  async (req, res) => {
    try {
      const now =
        new Date();

      const begin =
        new Date(
          now.getTime() -
          30 *
          24 *
          60 *
          60 *
          1000
        );

      const params =
        new URLSearchParams({
          sort: "date_created",
          criteria: "desc",
          range: "date_created",
          begin_date:
            begin.toISOString(),
          end_date:
            now.toISOString(),
          limit: "50"
        });

      const result =
        await mercadoPagoRequest(
          `/v1/payments/search?${params.toString()}`
        );

      if (!result.ok) {
        return res.status(
          result.status
        ).json({
          success: false,
          error:
            result.data
        });
      }

      const payments =
        Array.isArray(
          result.data?.results
        )
          ? result.data.results
          : [];

      const safePayments =
        payments.map(
          (payment) => ({
            id:
              String(payment.id),

            status:
              payment.status,

            statusDetail:
              payment.status_detail,

            amount:
              Number(
                payment.transaction_amount ||
                0
              ),

            description:
              payment.description ||
              null,

            dateCreated:
              payment.date_created ||
              null,

            dateApproved:
              payment.date_approved ||
              null,

            email:
              payment.payer?.email ||
              null,

            externalReference:
              payment.external_reference ||
              null,

            paymentMethod:
              payment.payment_method_id ||
              null
          })
        );

      return res.json({
        success: true,
        total:
          safePayments.length,
        payments:
          safePayments
      });

    } catch (error) {
      console.error(
        "Erro pagamentos:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Erro ao consultar pagamentos."
      });
    }
  }
);

// ======================================================
// DIAGNÓSTICO BANCO
// ======================================================

app.get(
  "/api/payment-diagnose",
  (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.query.email
        );

      let payment;

      if (email) {
        payment =
          db.prepare(`
            SELECT
              id,
              payment_id,
              external_reference,
              name,
              email,
              plan,
              amount,
              status,
              created_at,
              approved_at,
              active_until
            FROM payments
            WHERE LOWER(email) = ?
            ORDER BY id DESC
            LIMIT 1
          `).get(email);
      } else {
        payment =
          db.prepare(`
            SELECT
              id,
              payment_id,
              external_reference,
              name,
              email,
              plan,
              amount,
              status,
              created_at,
              approved_at,
              active_until
            FROM payments
            ORDER BY id DESC
            LIMIT 1
          `).get();
      }

      if (!payment) {
        return res.json({
          success: true,
          databasePayment: null,
          message:
            "Nenhum pagamento encontrado no banco."
        });
      }

      return res.json({
        success: true,
        databasePayment:
          payment
      });

    } catch (error) {
      console.error(
        "Erro diagnose:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Erro no diagnóstico."
      });
    }
  }
);

// ======================================================
// CONFIG TEST
// ======================================================

app.get(
  "/api/config-test",
  (req, res) => {
    const token =
      MERCADO_PAGO_TOKEN || "";

    return res.json({
      server:
        "online",

      mercadoPagoTokenConfigured:
        Boolean(token),

      mercadoPagoTokenPrefix:
        token
          ? token.substring(0, 8)
          : null,

      mercadoPagoTokenLength:
        token.length,

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

// ======================================================
// MERCADO PAGO TEST
// ======================================================

app.get(
  "/api/mercadopago-test",
  async (req, res) => {
    try {
      const result =
        await mercadoPagoRequest(
          "/v1/payment_methods"
        );

      if (!result.ok) {
        return res.status(
          result.status
        ).json({
          success: false,
          httpStatus:
            result.status,
          message:
            "Mercado Pago recusou o token.",
          error:
            result.data
        });
      }

      const methods =
        Array.isArray(
          result.data
        )
          ? result.data
          : [];

      return res.json({
        success: true,
        httpStatus:
          result.status,
        message:
          "Token aceito pelo Mercado Pago.",
        paymentMethods:
          methods.length
      });

    } catch (error) {
      console.error(
        "Erro MP test:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Erro ao testar Mercado Pago."
      });
    }
  }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "online",
      service:
        "Baiano Tips"
    });
  }
);

// ======================================================
// SERVIDOR
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Servidor online na porta ${PORT}`
    );
  }
);
