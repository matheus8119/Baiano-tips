import express from "express";
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;

const BASE_URL =
  process.env.BASE_URL ||
  "https://baiano-tips-1.onrender.com";

const TELEGRAM_INVITE_URL =
  process.env.TELEGRAM_INVITE_URL ||
  "https://t.me/+1F0a440X9zg2MDgx";

const PIX_ENABLED =
  String(process.env.PIX_ENABLED || "true").toLowerCase() === "true";

// ======================================================
// POSTGRES / SUPABASE
// ======================================================

if (!process.env.DATABASE_URL) {
  console.error("ERRO: DATABASE_URL não configurada.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE,
      external_reference TEXT,
      name TEXT,
      cpf TEXT,
      email TEXT,
      plan TEXT,
      amount NUMERIC(10,2),
      status TEXT,
      created_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      active_until TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_email
    ON payments (LOWER(email))
  `);

  console.log("Banco PostgreSQL conectado e tabela payments pronta.");
}

// ======================================================
// PLANOS
// ======================================================

const PLANS = {
  mensal: {
    name: "Mensal",
    amount: 29.90,
    days: 30
  },

  trimestral: {
    name: "Trimestral",
    amount: 69.90,
    days: 90
  },

  semestral: {
    name: "Semestral",
    amount: 119.90,
    days: 180
  },

  anual: {
    name: "Anual",
    amount: 199.90,
    days: 365
  }
};

// ======================================================
// NORMALIZAÇÃO DE E-MAIL
// ======================================================

function normalizeEmail(email) {
  let value = String(email || "")
    .trim()
    .toLowerCase();

  value = value.replace(/\s+/g, "+");

  return value;
}

// ======================================================
// CPF
// ======================================================

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

// ======================================================
// IDENTIFICAR PLANO
// ======================================================

function getPlanByDescription(description = "") {
  const text = String(description).toLowerCase();

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
  const value = Number(amount || 0);

  for (const [key, plan] of Object.entries(PLANS)) {
    if (Math.abs(plan.amount - value) < 0.01) {
      return key;
    }
  }

  return null;
}

function getPlan(payment) {
  return (
    getPlanByDescription(payment?.description) ||
    getPlanByAmount(payment?.transaction_amount)
  );
}

// ======================================================
// DATA DE VALIDADE
// ======================================================

function calculateActiveUntil(approvedAt, planKey) {
  const plan = PLANS[planKey];

  if (!plan) {
    return null;
  }

  const date = new Date(approvedAt);

  date.setDate(date.getDate() + plan.days);

  return date.toISOString();
}

// ======================================================
// MERCADO PAGO
// ======================================================

async function mercadoPagoRequest(path, options = {}) {
  if (!MP_TOKEN) {
    throw new Error(
      "MERCADOPAGO_ACCESS_TOKEN não configurado."
    );
  }

  const response = await fetch(
    `https://api.mercadopago.com${path}`,
    {
      method: options.method || "GET",

      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },

      body: options.body
        ? JSON.stringify(options.body)
        : undefined
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

// ======================================================
// SALVAR PAGAMENTO APROVADO
// ======================================================

async function saveApprovedPayment(
  payment,
  emailOverride = ""
) {
  const paymentId = String(payment.id);

  const plan = getPlan(payment);

  if (!plan) {
    throw new Error(
      "Plano não identificado."
    );
  }

  const approvedAt =
    payment.date_approved ||
    payment.date_last_updated ||
    payment.date_created ||
    new Date().toISOString();

  const activeUntil =
    calculateActiveUntil(
      approvedAt,
      plan
    );

  const overrideEmail =
    normalizeEmail(emailOverride);

  const paymentEmail =
    normalizeEmail(payment?.payer?.email);

  const email =
    overrideEmail ||
    paymentEmail ||
    "";

  const existingResult = await pool.query(
    `
      SELECT *
      FROM payments
      WHERE payment_id = $1
      LIMIT 1
    `,
    [paymentId]
  );

  const existing = existingResult.rows[0];

  if (existing) {
    await pool.query(
      `
        UPDATE payments
        SET
          email = $1,
          plan = $2,
          amount = $3,
          status = $4,
          external_reference = $5,
          approved_at = $6,
          active_until = $7
        WHERE payment_id = $8
      `,
      [
        email || existing.email || "",
        plan,
        Number(payment.transaction_amount || 0),
        "approved",
        payment.external_reference ||
          existing.external_reference ||
          null,
        approvedAt,
        activeUntil,
        paymentId
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
          created_at,
          approved_at,
          active_until
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11
        )
        ON CONFLICT (payment_id)
        DO UPDATE SET
          email = EXCLUDED.email,
          plan = EXCLUDED.plan,
          amount = EXCLUDED.amount,
          status = EXCLUDED.status,
          approved_at = EXCLUDED.approved_at,
          active_until = EXCLUDED.active_until
      `,
      [
        paymentId,
        payment.external_reference || null,
        payment?.payer?.first_name || "",
        payment?.payer?.identification?.number || "",
        email,
        plan,
        Number(payment.transaction_amount || 0),
        "approved",
        payment.date_created ||
          new Date().toISOString(),
        approvedAt,
        activeUntil
      ]
    );
  }

  return {
    paymentId,
    email,
    plan,

    amount:
      Number(
        payment.transaction_amount || 0
      ),

    status: "approved",

    activeUntil
  };
}

// ======================================================
// CRIAR PIX
// ======================================================

app.post(
  "/api/create-payment",
  async (req, res) => {
    try {
      if (!PIX_ENABLED) {
        return res.status(400).json({
          success: false,
          message: "PIX está desativado."
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
            "Preencha todos os campos."
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

      const cleanEmail =
        normalizeEmail(email);

      const selectedPlan =
        PLANS[plan];

      const externalReference =
        "BAIANOTIPS-" +
        Date.now() +
        "-" +
        crypto
          .randomBytes(4)
          .toString("hex")
          .toUpperCase();

      const payment =
        await mercadoPagoRequest(
          "/v1/payments",
          {
            method: "POST",

            headers: {
              "X-Idempotency-Key":
                crypto.randomUUID()
            },

            body: {
              transaction_amount:
                selectedPlan.amount,

              description:
                `Baiano Tips - ${selectedPlan.name}`,

              payment_method_id:
                "pix",

              external_reference:
                externalReference,

              notification_url:
                `${BASE_URL}/api/mercadopago/webhook`,

              payer: {
                email: cleanEmail,

                first_name:
                  String(name).trim(),

                identification: {
                  type: "CPF",
                  number:
                    String(cpf)
                      .replace(/\D/g, "")
                }
              }
            }
          }
        );

      // Salva o pagamento no PostgreSQL
      // mesmo enquanto estiver pendente.
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
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9
          )
          ON CONFLICT (payment_id)
          DO UPDATE SET
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            cpf = EXCLUDED.cpf,
            plan = EXCLUDED.plan,
            amount = EXCLUDED.amount,
            status = EXCLUDED.status
        `,
        [
          String(payment.id),
          externalReference,
          String(name).trim(),
          String(cpf).replace(/\D/g, ""),
          cleanEmail,
          plan,
          selectedPlan.amount,
          payment.status || "pending",
          payment.date_created ||
            new Date().toISOString()
        ]
      );

      const transactionData =
        payment
          ?.point_of_interaction
          ?.transaction_data;

      return res.json({
        success: true,

        paymentId:
          String(payment.id),

        status:
          payment.status,

        qrCode:
          transactionData?.qr_code ||
          null,

        qrCodeBase64:
          transactionData?.qr_code_base64 ||
          null,

        pix:
          transactionData?.qr_code ||
          null,

        plan,

        amount:
          selectedPlan.amount,

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
  }
);

// ======================================================
// WEBHOOK
// ======================================================

app.post(
  "/api/mercadopago/webhook",
  async (req, res) => {
    try {
      const paymentId =
        req.body?.data?.id ||
        req.body?.id;

      console.log(
        "WEBHOOK:",
        JSON.stringify(req.body)
      );

      if (!paymentId) {
        return res.sendStatus(200);
      }

      const payment =
        await mercadoPagoRequest(
          `/v1/payments/${paymentId}`
        );

      if (
        payment.status ===
        "approved"
      ) {
        await saveApprovedPayment(
          payment
        );

        console.log(
          "PAGAMENTO APROVADO:",
          payment.id
        );
      }

      return res.sendStatus(200);

    } catch (error) {
      console.error(
        "ERRO WEBHOOK:",
        error?.data || error
      );

      return res.sendStatus(200);
    }
  }
);

// ======================================================
// RECUPERAR PELO ID
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

      const payment =
        await mercadoPagoRequest(
          `/v1/payments/${paymentId}`
        );

      if (
        payment.status !==
        "approved"
      ) {
        return res.json({
          success: false,
          recovered: false,

          paymentId,

          status:
            payment.status,

          message:
            "O pagamento ainda não está aprovado."
        });
      }

      const saved =
        await saveApprovedPayment(
          payment
        );

      return res.json({
        success: true,

        recovered: true,

        message:
          "Pagamento aprovado recuperado com sucesso.",

        paymentId:
          saved.paymentId,

        status:
          saved.status,

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
        "ERRO RECOVER ID:",
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
  }
);

// ======================================================
// ACESSO DO ASSINANTE
// ======================================================

app.get(
  "/api/access",
  async (req, res) => {
    try {
      const rawEmail =
        req.query.email;

      const email =
        normalizeEmail(rawEmail);

      console.log(
        "VERIFICANDO ASSINATURA:",
        {
          recebido: rawEmail,
          normalizado: email
        }
      );

      if (!email) {
        return res.status(400).json({
          success: false,
          active: false,
          message:
            "Informe o e-mail."
        });
      }

      // =================================================
      // 1. PROCURA NO POSTGRES
      // =================================================

      const result =
        await pool.query(
          `
            SELECT *
            FROM payments
            WHERE status = 'approved'
              AND LOWER(email) = LOWER($1)
            ORDER BY id DESC
          `,
          [email]
        );

      console.log(
        "PAGAMENTOS ENCONTRADOS:",
        result.rows.length
      );

      const localPayment =
        result.rows[0];

      if (localPayment) {
        const activeUntil =
          localPayment.active_until
            ? new Date(
                localPayment.active_until
              )
            : null;

        if (
          activeUntil &&
          activeUntil > new Date()
        ) {
          console.log(
            "ASSINATURA ENCONTRADA:",
            localPayment.payment_id
          );

          return res.json({
            success: true,

            active: true,

            plan:
              localPayment.plan,

            amount:
              Number(
                localPayment.amount
              ),

            paymentId:
              localPayment.payment_id,

            activeUntil:
              localPayment.active_until,

            telegram:
              TELEGRAM_INVITE_URL
          });
        }
      }

      // =================================================
      // 2. PROCURA NO MERCADO PAGO
      // =================================================

      console.log(
        "Não encontrou no banco. Consultando Mercado Pago..."
      );

      const search =
        await mercadoPagoRequest(
          "/v1/payments/search?sort=date_created&criteria=desc&limit=50"
        );

      const results =
        Array.isArray(search.results)
          ? search.results
          : [];

      for (
        const item of results
      ) {
        if (
          item.status !==
          "approved"
        ) {
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
            payerEmail === email
          ) {
            const saved =
              await saveApprovedPayment(
                payment,
                email
              );

            if (
              new Date(
                saved.activeUntil
              ) > new Date()
            ) {
              return res.json({
                success: true,

                active: true,

                plan:
                  saved.plan,

                amount:
                  saved.amount,

                paymentId:
                  saved.paymentId,

                activeUntil:
                  saved.activeUntil,

                telegram:
                  TELEGRAM_INVITE_URL
              });
            }
          }

        } catch (error) {
          console.error(
            "Erro consultando pagamento:",
            item.id,
            error.message
          );
        }
      }

      return res.json({
        success: true,

        active: false,

        message:
          "Nenhuma assinatura ativa encontrada."
      });

    } catch (error) {
      console.error(
        "ERRO ACCESS:",
        error?.data || error
      );

      return res.status(500).json({
        success: false,

        active: false,

        message:
          error?.data?.message ||
          error.message ||
          "Erro ao verificar assinatura."
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
            "Informe o e-mail."
        });
      }

      const result =
        await pool.query(
          `
            SELECT *
            FROM payments
            WHERE status = 'approved'
              AND LOWER(email) = LOWER($1)
            ORDER BY id DESC
            LIMIT 1
          `,
          [email]
        );

      const found =
        result.rows[0];

      if (found) {
        return res.json({
          success: true,
          recovered: true,

          paymentId:
            found.payment_id,

          plan:
            found.plan,

          amount:
            Number(found.amount),

          email:
            found.email,

          activeUntil:
            found.active_until,

          telegram:
            TELEGRAM_INVITE_URL
        });
      }

      return res.json({
        success: false,
        recovered: false,

        message:
          "Não encontrei pagamento aprovado para este e-mail."
      });

    } catch (error) {
      console.error(
        "ERRO RECOVER EMAIL:",
        error
      );

      return res.status(500).json({
        success: false,
        recovered: false,
        message:
          error.message
      });
    }
  }
);

// ======================================================
// DIAGNÓSTICO
// ======================================================

app.get(
  "/api/payment-diagnose",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
            SELECT
              id,
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
            FROM payments
            ORDER BY id DESC
          `
        );

      return res.json({
        success: true,

        total:
          result.rows.length,

        databasePayment:
          result.rows[0] ||
          null,

        payments:
          result.rows
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);

// ======================================================
// PAGAMENTOS MERCADO PAGO
// ======================================================

app.get(
  "/api/mercadopago-payments",
  async (req, res) => {
    try {
      const data =
        await mercadoPagoRequest(
          "/v1/payments/search?sort=date_created&criteria=desc&limit=50"
        );

      const payments =
        (data.results || [])
          .map(
            (payment) => ({
              id:
                String(payment.id),

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
                payment?.payer?.email ||
                null,

              externalReference:
                payment.external_reference,

              paymentMethod:
                payment.payment_method_id
            })
          );

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
  }
);

// ======================================================
// TESTE MERCADO PAGO
// ======================================================

app.get(
  "/api/mercadopago-test",
  async (req, res) => {
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
      return res.status(
        error.status || 500
      ).json({
        success: false,

        httpStatus:
          error.status || 500,

        message:
          error?.data?.message ||
          error.message
      });
    }
  }
);

// ======================================================
// CONFIGURAÇÃO
// ======================================================

app.get(
  "/api/config-test",
  (req, res) => {
    const token =
      MP_TOKEN || "";

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

      databaseConfigured:
        Boolean(
          process.env.DATABASE_URL
        ),

      message:
        "Configuração carregada com sucesso."
    });
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

      server:
        "online",

      time:
        new Date().toISOString()
    });
  }
);

// ======================================================
// SERVIDOR
// ======================================================

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      () => {
        console.log(
          `Servidor online na porta ${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      "ERRO AO CONECTAR AO BANCO:",
      error
    );

    process.exit(1);
  }
}

startServer();
