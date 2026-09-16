import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5
});

const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL;
const TELEGRAM_INVITE_URL = process.env.TELEGRAM_INVITE_URL;

const plans = {
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

// ========================================
// BANCO
// ========================================

async function initDatabase() {
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_email
    ON payments(email)
  `);

  console.log("Banco PostgreSQL conectado e tabela verificada.");
}

// ========================================
// MERCADO PAGO
// ========================================

async function mercadoPagoRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
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

// ========================================
// CRIAR PAGAMENTO
// ========================================

app.post("/api/create-payment", async (req, res) => {
  try {
    const {
      name,
      cpf,
      email,
      plan
    } = req.body;

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

    const normalizedName = String(name || "").trim();

    const normalizedCpf = String(cpf || "")
      .replace(/\D/g, "");

    if (!normalizedName || !normalizedCpf || !normalizedEmail || !plan) {
      return res.status(400).json({
        success: false,
        message: "Preencha todos os campos."
      });
    }

    if (!plans[plan]) {
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

    const selectedPlan = plans[plan];

    const externalReference =
      `BAIANOTIPS-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    const paymentData = {
      transaction_amount: selectedPlan.amount,
      description: `Baiano Tips - ${selectedPlan.name}`,
      payment_method_id: "pix",
      external_reference: externalReference,
      payer: {
        email: normalizedEmail,
        first_name: normalizedName
      },
      notification_url: `${BASE_URL}/api/mercadopago/webhook`
    };

    console.log("CRIANDO PAGAMENTO:", {
      email: normalizedEmail,
      plan,
      amount: selectedPlan.amount,
      externalReference
    });

    const mpResponse = await mercadoPagoRequest(
      "https://api.mercadopago.com/v1/payments",
      {
        method: "POST",
        headers: {
          "X-Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify(paymentData)
      }
    );

    if (!mpResponse.ok) {
      console.error("ERRO MERCADO PAGO:", mpResponse.data);

      return res.status(mpResponse.status).json({
        success: false,
        message: "Erro ao criar pagamento.",
        error: mpResponse.data
      });
    }

    const payment = mpResponse.data;

    const createdAt = payment.date_created
      ? new Date(payment.date_created)
      : new Date();

    let activeUntil = null;

    if (payment.status === "approved") {
      activeUntil = new Date(
        createdAt.getTime() +
        selectedPlan.days * 24 * 60 * 60 * 1000
      );
    }

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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        String(payment.id),
        externalReference,
        normalizedName,
        normalizedCpf,
        normalizedEmail,
        plan,
        selectedPlan.amount,
        payment.status || "pending",
        createdAt,
        payment.status === "approved"
          ? new Date(payment.date_approved || createdAt)
          : null,
        activeUntil
      ]
    );

    const transactionData =
      payment.point_of_interaction?.transaction_data || {};

    return res.json({
      success: true,
      paymentId: payment.id,
      status: payment.status,
      statusDetail: payment.status_detail,
      qrCode: transactionData.qr_code || null,
      qrCodeBase64: transactionData.qr_code_base64 || null,
      pixCopyPaste: transactionData.qr_code || null,
      externalReference
    });

  } catch (error) {
    console.error("ERRO CREATE PAYMENT:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao criar pagamento."
    });
  }
});

// ========================================
// WEBHOOK MERCADO PAGO
// ========================================

app.post("/api/mercadopago/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK MERCADO PAGO:", req.body);

    let paymentId = null;

    if (req.body?.data?.id) {
      paymentId = req.body.data.id;
    }

    if (!paymentId && req.body?.id) {
      paymentId = req.body.id;
    }

    if (!paymentId) {
      return res.sendStatus(200);
    }

    const mpResponse = await mercadoPagoRequest(
      `https://api.mercadopago.com/v1/payments/${paymentId}`
    );

    if (!mpResponse.ok) {
      console.error(
        "ERRO CONSULTANDO PAGAMENTO:",
        mpResponse.data
      );

      return res.sendStatus(200);
    }

    const payment = mpResponse.data;

    const externalReference =
      payment.external_reference || null;

    const payerEmail =
      payment.payer?.email
        ? String(payment.payer.email)
            .trim()
            .toLowerCase()
        : null;

    const existing = await pool.query(
      `
      SELECT *
      FROM payments
      WHERE payment_id = $1
      LIMIT 1
      `,
      [String(payment.id)]
    );

    let plan = existing.rows[0]?.plan || null;

    if (!plan && externalReference) {
      const referenceResult = await pool.query(
        `
        SELECT *
        FROM payments
        WHERE external_reference = $1
        LIMIT 1
        `,
        [externalReference]
      );

      if (referenceResult.rows.length > 0) {
        plan = referenceResult.rows[0].plan;
      }
    }

    if (!plan) {
      plan = "mensal";
    }

    const selectedPlan = plans[plan] || plans.mensal;

    let activeUntil =
      existing.rows[0]?.active_until || null;

    let approvedAt =
      existing.rows[0]?.approved_at || null;

    if (payment.status === "approved") {
      approvedAt = payment.date_approved
        ? new Date(payment.date_approved)
        : new Date();

      activeUntil = new Date(
        approvedAt.getTime() +
        selectedPlan.days * 24 * 60 * 60 * 1000
      );
    }

    if (existing.rows.length > 0) {
      await pool.query(
        `
        UPDATE payments
        SET
          status = $1,
          approved_at = $2,
          active_until = $3,
          email = COALESCE(NULLIF($4, ''), email)
        WHERE payment_id = $5
        `,
        [
          payment.status || "pending",
          approvedAt,
          activeUntil,
          payerEmail || "",
          String(payment.id)
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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          String(payment.id),
          externalReference,
          payment.payer?.first_name || "",
          "",
          payerEmail || "",
          plan,
          Number(
            payment.transaction_amount ||
            selectedPlan.amount
          ),
          payment.status || "pending",
          payment.date_created
            ? new Date(payment.date_created)
            : new Date(),
          approvedAt,
          activeUntil
        ]
      );
    }

    console.log("WEBHOOK PROCESSADO:", {
      paymentId: payment.id,
      status: payment.status,
      plan,
      email: payerEmail
    });

    return res.sendStatus(200);

  } catch (error) {
    console.error("ERRO WEBHOOK:", error);
    return res.sendStatus(200);
  }
});

// ========================================
// ACESSO DO ASSINANTE
// ========================================

app.get("/api/access", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();

    console.log("VERIFICANDO ASSINATURA:", {
      recebido: req.query.email,
      normalizado: email
    });

    if (!email) {
      return res.json({
        success: false,
        active: false,
        message: "Informe o e-mail."
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM payments
      WHERE LOWER(TRIM(email)) = $1
        AND LOWER(TRIM(status)) = 'approved'
        AND active_until > CURRENT_TIMESTAMP
      ORDER BY active_until DESC
      LIMIT 1
      `,
      [email]
    );

    console.log(
      "PAGAMENTOS ENCONTRADOS:",
      result.rows.length
    );

    if (result.rows.length > 0) {
      const payment = result.rows[0];

      return res.json({
        success: true,
        active: true,
        plan: payment.plan,
        amount: Number(payment.amount),
        activeUntil: payment.active_until,
        telegram: TELEGRAM_INVITE_URL || null,
        message: "Assinatura ativa."
      });
    }

    console.log(
      "Não encontrou no banco. Consultando Mercado Pago..."
    );

    try {
      const searchUrl =
        `https://api.mercadopago.com/v1/payments/search?payer.email=${encodeURIComponent(email)}`;

      const mpResponse =
        await mercadoPagoRequest(searchUrl);

      if (
        mpResponse.ok &&
        mpResponse.data?.results
      ) {
        const approvedPayment =
          mpResponse.data.results.find(
            p =>
              p.status === "approved" &&
              Number(p.transaction_amount) > 0
          );

        if (approvedPayment) {
          const plan =
            Object.keys(plans).find(
              key =>
                Math.abs(
                  plans[key].amount -
                  Number(
                    approvedPayment.transaction_amount
                  )
                ) < 0.01
            ) || "mensal";

          const selectedPlan = plans[plan];

          const approvedAt =
            approvedPayment.date_approved
              ? new Date(
                  approvedPayment.date_approved
                )
              : new Date();

          const activeUntil = new Date(
            approvedAt.getTime() +
            selectedPlan.days *
              24 *
              60 *
              60 *
              1000
          );

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
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `,
            [
              String(approvedPayment.id),
              approvedPayment.external_reference ||
                null,
              approvedPayment.payer?.first_name ||
                "",
              "",
              email,
              plan,
              Number(
                approvedPayment.transaction_amount
              ),
              "approved",
              approvedPayment.date_created
                ? new Date(
                    approvedPayment.date_created
                  )
                : new Date(),
              approvedAt,
              activeUntil
            ]
          );

          return res.json({
            success: true,
            active: true,
            plan,
            amount: Number(
              approvedPayment.transaction_amount
            ),
            activeUntil,
            telegram:
              TELEGRAM_INVITE_URL || null,
            message: "Assinatura ativa."
          });
        }
      }
    } catch (fallbackError) {
      console.error(
        "ERRO NO FALLBACK MERCADO PAGO:",
        fallbackError
      );
    }

    return res.json({
      success: true,
      active: false,
      message: "Nenhuma assinatura ativa encontrada."
    });

  } catch (error) {
    console.error(
      "ERRO AO VERIFICAR ACESSO:",
      error
    );

    return res.status(500).json({
      success: false,
      active: false,
      message: "Erro ao verificar assinatura."
    });
  }
});

// ========================================
// DIAGNÓSTICO DO ACESSO
// ========================================

app.get("/api/debug-access", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();

    const result = await pool.query(`
      SELECT
        id,
        email,
        LOWER(TRIM(email)) AS email_normalizado,
        status,
        active_until,
        CURRENT_TIMESTAMP AS agora,
        (active_until > CURRENT_TIMESTAMP) AS data_valida
      FROM payments
      ORDER BY id DESC
      LIMIT 10
    `);

    return res.json({
      success: true,
      email_recebido: email,
      quantidade_registros: result.rows.length,
      registros: result.rows
    });

  } catch (error) {
    console.error(
      "ERRO DEBUG ACCESS:",
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========================================
// RECUPERAR PAGAMENTO PELO ID
// ========================================

app.get("/api/recover-payment-by-id", async (req, res) => {
  try {
    const paymentId = String(
      req.query.id || ""
    ).trim();

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: "Informe o ID do pagamento."
      });
    }

    const mpResponse =
      await mercadoPagoRequest(
        `https://api.mercadopago.com/v1/payments/${paymentId}`
      );

    if (!mpResponse.ok) {
      return res.status(mpResponse.status).json({
        success: false,
        message:
          "Pagamento não encontrado no Mercado Pago.",
        error: mpResponse.data
      });
    }

    const payment = mpResponse.data;

    if (payment.status !== "approved") {
      return res.json({
        success: false,
        recovered: false,
        message:
          `Pagamento não está aprovado. Status: ${payment.status}`,
        paymentId: payment.id,
        status: payment.status
      });
    }

    const amount =
      Number(payment.transaction_amount);

    let plan = "mensal";

    if (Math.abs(amount - 29.90) < 0.01) {
      plan = "mensal";
    } else if (Math.abs(amount - 69.90) < 0.01) {
      plan = "trimestral";
    } else if (Math.abs(amount - 119.90) < 0.01) {
      plan = "semestral";
    } else if (Math.abs(amount - 199.90) < 0.01) {
      plan = "anual";
    }

    const selectedPlan = plans[plan];

    const approvedAt =
      payment.date_approved
        ? new Date(payment.date_approved)
        : new Date();

    const activeUntil = new Date(
      approvedAt.getTime() +
      selectedPlan.days *
        24 *
        60 *
        60 *
        1000
    );

    const email =
      payment.payer?.email
        ? String(payment.payer.email)
            .trim()
            .toLowerCase()
        : null;

    const existing = await pool.query(
      `
      SELECT id
      FROM payments
      WHERE payment_id = $1
      LIMIT 1
      `,
      [String(payment.id)]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `
        UPDATE payments
        SET
          status = 'approved',
          email = COALESCE(NULLIF($1, ''), email),
          plan = $2,
          amount = $3,
          approved_at = $4,
          active_until = $5
        WHERE payment_id = $6
        `,
        [
          email || "",
          plan,
          amount,
          approvedAt,
          activeUntil,
          String(payment.id)
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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          String(payment.id),
          payment.external_reference || null,
          payment.payer?.first_name || "",
          "",
          email || "",
          plan,
          amount,
          "approved",
          payment.date_created
            ? new Date(payment.date_created)
            : new Date(),
          approvedAt,
          activeUntil
        ]
      );
    }

    return res.json({
      success: true,
      recovered: true,
      message:
        "Pagamento aprovado recuperado com sucesso.",
      paymentId: String(payment.id),
      status: payment.status,
      plan,
      amount,
      email,
      activeUntil,
      telegram:
        TELEGRAM_INVITE_URL || null
    });

  } catch (error) {
    console.error(
      "ERRO RECUPERANDO PAGAMENTO:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Erro ao recuperar pagamento."
    });
  }
});

// ========================================
// DIAGNÓSTICO DO BANCO
// ========================================

app.get("/api/payment-diagnose", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM payments
      ORDER BY id DESC
      LIMIT 20
    `);

    return res.json({
      success: true,
      total: result.rows.length,
      databasePayment:
        result.rows[0] || null,
      payments: result.rows
    });

  } catch (error) {
    console.error(
      "ERRO DIAGNOSTICO:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Erro ao consultar banco.",
      error: error.message
    });
  }
});

// ========================================
// PAGAMENTOS MERCADO PAGO
// ========================================

app.get("/api/mercadopago-payments", async (req, res) => {
  try {
    const mpResponse =
      await mercadoPagoRequest(
        "https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc"
      );

    if (!mpResponse.ok) {
      return res.status(mpResponse.status).json({
        success: false,
        error: mpResponse.data
      });
    }

    const payments =
      (mpResponse.data.results || [])
        .map(payment => ({
          id: String(payment.id),
          status: payment.status,
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
      total: payments.length,
      payments
    });

  } catch (error) {
    console.error(
      "ERRO LISTANDO PAGAMENTOS:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Erro ao consultar Mercado Pago."
    });
  }
});

// ========================================
// TESTE MERCADO PAGO
// ========================================

app.get("/api/mercadopago-test", async (req, res) => {
  try {
    if (!MP_TOKEN) {
      return res.json({
        success: false,
        message:
          "Token Mercado Pago não configurado."
      });
    }

    const response =
      await mercadoPagoRequest(
        "https://api.mercadopago.com/v1/payment_methods"
      );

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        httpStatus: response.status,
        message:
          "Token rejeitado pelo Mercado Pago.",
        error: response.data
      });
    }

    return res.json({
      success: true,
      httpStatus: response.status,
      message:
        "Token aceito pelo Mercado Pago.",
      paymentMethods:
        Array.isArray(response.data)
          ? response.data.length
          : 0
    });

  } catch (error) {
    console.error(
      "ERRO TESTE MERCADO PAGO:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Erro ao testar Mercado Pago."
    });
  }
});

// ========================================
// CONFIGURAÇÃO
// ========================================

app.get("/api/config-test", async (req, res) => {
  return res.json({
    server: "online",
    mercadoPagoTokenConfigured:
      !!MP_TOKEN,
    mercadoPagoTokenPrefix:
      MP_TOKEN
        ? MP_TOKEN.substring(0, 7)
        : null,
    mercadoPagoTokenLength:
      MP_TOKEN
        ? MP_TOKEN.length
        : 0,
    pixEnabled:
      process.env.PIX_ENABLED === "true",
    baseUrlConfigured:
      !!BASE_URL,
    telegramConfigured:
      !!TELEGRAM_INVITE_URL,
    databaseConfigured:
      !!process.env.DATABASE_URL,
    message:
      "Configuração carregada com sucesso."
  });
});

// ========================================
// HEALTH
// ========================================

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      success: true,
      server: "online",
      database: "online"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      server: "online",
      database: "offline",
      error: error.message
    });
  }
});

// ========================================
// INICIAR
// ========================================

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(
        `Servidor online na porta ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      "ERRO AO INICIAR SERVIDOR:",
      error
    );

    process.exit(1);
  }
}

startServer();
