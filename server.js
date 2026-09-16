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


/* =====================================================
   BANCO DE DADOS
===================================================== */

const db = new Database("baiano-tips.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpf TEXT,
    order_id TEXT,
    external_reference TEXT,
    name TEXT,
    email TEXT,
    plan TEXT,
    amount REAL,
    status TEXT,
    active_until TEXT,
    created_at TEXT
  )
`);


/* Compatibilidade com banco antigo */

try {
  db.exec(`
    ALTER TABLE payments
    ADD COLUMN external_reference TEXT
  `);
} catch (error) {
  // Coluna já existe.
}


/* =====================================================
   PLANOS
===================================================== */

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


/* =====================================================
   CPF
===================================================== */

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


/* =====================================================
   MERCADO PAGO REQUEST
===================================================== */

async function mercadoPagoRequest(url, options = {}) {

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

    console.error(
      "Mercado Pago HTTP:",
      response.status
    );

    console.error(
      "Mercado Pago:",
      JSON.stringify(data, null, 2)
    );

    throw new Error(
      data?.message ||
      data?.error ||
      data?.raw ||
      `Erro Mercado Pago HTTP ${response.status}`
    );
  }

  return data;
}


/* =====================================================
   TESTE MERCADO PAGO
===================================================== */

app.get(
  "/api/mercadopago-test",
  async (req, res) => {

    try {

      const response =
        await mercadoPagoRequest(
          "https://api.mercadopago.com/v1/payment_methods",
          {
            method: "GET"
          }
        );

      return res.json({
        success: true,
        httpStatus: 200,
        message:
          "Token aceito pelo Mercado Pago.",
        paymentMethods:
          Array.isArray(response)
            ? response.length
            : null
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


/* =====================================================
   CRIAR PIX
===================================================== */

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
        String(name)
          .trim()
          .split(" ")[0] ||
        "Cliente",

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


/* =====================================================
   CRIAR PAGAMENTO
===================================================== */

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

      console.log(
        "CRIANDO PIX:",
        externalReference
      );

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

      if (
        !paymentId ||
        !qrCode
      ) {

        return res.status(500).json({
          success: false,
          message:
            "Mercado Pago não retornou os dados do PIX."
        });
      }

      db.prepare(`
        INSERT INTO payments (
          cpf,
          order_id,
          external_reference,
          name,
          email,
          plan,
          amount,
          status,
          active_until,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(

        cleanCpf,

        paymentId,

        externalReference,

        name,

        email,

        plan,

        selectedPlan.amount,

        payment.status || "pending",

        null,

        new Date().toISOString()
      );

      console.log(
        "PAGAMENTO SALVO:",
        paymentId
      );

      return res.json({

        success: true,

        paymentId,

        orderId:
          paymentId,

        externalReference,

        status:
          payment.status ||
          "pending",

        pix:
          qrCode,

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
        "ERRO CREATE PAYMENT:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Não foi possível gerar o PIX."
      });
    }
  }
);


/* =====================================================
   ATIVAR PAGAMENTO
===================================================== */

function activatePayment(
  paymentRow,
  paymentStatus
) {

  let activeUntil =
    paymentRow.active_until;

  if (
    paymentStatus === "approved" &&
    !activeUntil
  ) {

    const date =
      new Date();

    const days =
      plans[paymentRow.plan]?.days ||
      30;

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
    WHERE id = ?
  `).run(

    paymentStatus,

    activeUntil,

    paymentRow.id
  );

  return activeUntil;
}


/* =====================================================
   WEBHOOK MERCADO PAGO
===================================================== */

app.post(
  "/api/mercadopago/webhook",
  async (req, res) => {

    try {

      const body =
        req.body || {};

      console.log(
        "===== WEBHOOK RECEBIDO ====="
      );

      console.log(
        JSON.stringify(
          body,
          null,
          2
        )
      );

      let paymentId =
        body?.data?.id ||
        body?.id ||
        req.query?.["data.id"] ||
        req.query?.id ||
        null;

      if (!paymentId) {

        console.log(
          "Webhook sem ID."
        );

        return res.sendStatus(200);
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
        payment?.status ||
        "pending";

      const externalReference =
        payment?.external_reference ||
        null;

      console.log(
        "Pagamento:",
        paymentId,
        "Status:",
        status
      );

      let paymentRow =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE order_id = ?
          LIMIT 1
        `).get(paymentId);

      if (
        !paymentRow &&
        externalReference
      ) {

        paymentRow =
          db.prepare(`
            SELECT *
            FROM payments
            WHERE external_reference = ?
            LIMIT 1
          `).get(
            externalReference
          );
      }

      if (!paymentRow) {

        console.log(
          "Pagamento não encontrado no banco."
        );

        return res.sendStatus(200);
      }

      const activeUntil =
        activatePayment(
          paymentRow,
          status
        );

      console.log(
        "Pagamento atualizado:",
        {
          paymentId,
          status,
          activeUntil
        }
      );

      return res.sendStatus(200);

    } catch (error) {

      console.error(
        "ERRO WEBHOOK:",
        error
      );

      return res.sendStatus(200);
    }
  }
);


/* =====================================================
   RECUPERAÇÃO AUTOMÁTICA
   DO ÚLTIMO PAGAMENTO APROVADO
===================================================== */

app.get(
  "/api/recover-payment",
  async (req, res) => {

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
            "Informe o e-mail usado no pagamento."
        });
      }


      /*
        Procuramos pagamentos aprovados
        recentemente no Mercado Pago.

        O Mercado Pago permite pesquisar
        pagamentos por status e intervalo
        de datas.
      */

      const searchUrl =
        "https://api.mercadopago.com/v1/payments/search" +
        "?sort=date_created" +
        "&criteria=desc" +
        "&range=date_created" +
        "&begin_date=NOW-30DAYS" +
        "&end_date=NOW" +
        "&status=approved" +
        "&limit=50";


      const search =
        await mercadoPagoRequest(
          searchUrl,
          {
            method: "GET"
          }
        );


      const results =
        Array.isArray(search?.results)
          ? search.results
          : [];


      /*
        Primeiro tentamos encontrar
        exatamente pelo e-mail do pagador.
      */

      const emailMatches =
        results.filter((payment) => {

          const payerEmail =
            String(
              payment?.payer?.email ||
              ""
            )
              .trim()
              .toLowerCase();

          return (
            payerEmail === email
          );
        });


      if (emailMatches.length === 0) {

        return res.json({

          success: false,

          recovered: false,

          message:
            "Não encontrei pagamento aprovado para este e-mail nos últimos 30 dias."
        });
      }


      /*
        O primeiro resultado é o mais recente,
        porque a pesquisa está ordenada
        por date_created desc.
      */

      const payment =
        emailMatches[0];


      const paymentId =
        payment.id
          ? String(payment.id)
          : null;


      const description =
        String(
          payment.description || ""
        );


      /*
        Descobre o plano pela descrição
        ou pelo valor.
      */

      let planKey = null;


      for (
        const [key, plan]
        of Object.entries(plans)
      ) {

        if (
          description
            .toLowerCase()
            .includes(
              plan.name.toLowerCase()
            )
        ) {

          planKey = key;
          break;
        }

        if (
          Number(payment.transaction_amount) ===
          Number(plan.amount)
        ) {

          planKey = key;
          break;
        }
      }


      /*
        Se não conseguir identificar,
        usamos mensal como fallback.
      */

      if (!planKey) {
        planKey = "mensal";
      }


      const selectedPlan =
        plans[planKey];


      /*
        Verifica se esse pagamento
        já existe no banco.
      */

      let existing =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE order_id = ?
          LIMIT 1
        `).get(paymentId);


      let activeUntil =
        existing?.active_until ||
        null;


      if (!activeUntil) {

        const date =
          new Date();

        date.setDate(
          date.getDate() +
          selectedPlan.days
        );

        activeUntil =
          date.toISOString();
      }


      if (existing) {

        db.prepare(`
          UPDATE payments
          SET
            status = ?,
            plan = ?,
            amount = ?,
            active_until = ?,
            external_reference = ?
          WHERE id = ?
        `).run(

          "approved",

          planKey,

          Number(
            payment.transaction_amount ||
            selectedPlan.amount
          ),

          activeUntil,

          payment.external_reference ||
            null,

          existing.id
        );

      } else {

        db.prepare(`
          INSERT INTO payments (
            cpf,
            order_id,
            external_reference,
            name,
            email,
            plan,
            amount,
            status,
            active_until,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(

          null,

          paymentId,

          payment.external_reference ||
            null,

          payment?.payer?.first_name ||
            "Cliente",

          email,

          planKey,

          Number(
            payment.transaction_amount ||
            selectedPlan.amount
          ),

          "approved",

          activeUntil,

          payment.date_created ||
            new Date().toISOString()
        );
      }


      console.log(
        "PAGAMENTO RECUPERADO:",
        paymentId,
        email,
        planKey
      );


      return res.json({

        success: true,

        recovered: true,

        message:
          "Pagamento aprovado recuperado com sucesso.",

        paymentId,

        status:
          "approved",

        plan:
          planKey,

        activeUntil,

        telegram:
          TELEGRAM_INVITE_URL ||
          null
      });


    } catch (error) {

      console.error(
        "ERRO RECOVERY:",
        error
      );

      return res.status(500).json({

        success: false,

        recovered: false,

        message:
          error.message ||
          "Erro ao recuperar pagamento."
      });
    }
  }
);


/* =====================================================
   DIAGNÓSTICO DO ÚLTIMO PAGAMENTO LOCAL
===================================================== */

app.get(
  "/api/payment-diagnose",
  async (req, res) => {

    try {

      const paymentRow =
        db.prepare(`
          SELECT
            id,
            order_id,
            external_reference,
            plan,
            amount,
            status,
            active_until,
            created_at
          FROM payments
          ORDER BY id DESC
          LIMIT 1
        `).get();


      if (!paymentRow) {

        return res.json({

          success: true,

          databasePayment:
            null,

          message:
            "Nenhum pagamento encontrado no banco."
        });
      }


      let mercadoPago = null;


      try {

        mercadoPago =
          await mercadoPagoRequest(
            `https://api.mercadopago.com/v1/payments/${paymentRow.order_id}`,
            {
              method: "GET"
            }
          );

      } catch (error) {

        mercadoPago = {
          error:
            error.message
        };
      }


      return res.json({

        success: true,

        databasePayment: {

          id:
            paymentRow.id,

          paymentId:
            paymentRow.order_id,

          externalReference:
            paymentRow.external_reference,

          plan:
            paymentRow.plan,

          amount:
            paymentRow.amount,

          status:
            paymentRow.status,

          activeUntil:
            paymentRow.active_until,

          createdAt:
            paymentRow.created_at
        },

        mercadoPago: {

          id:
            mercadoPago?.id ||
            null,

          status:
            mercadoPago?.status ||
            null,

          statusDetail:
            mercadoPago?.status_detail ||
            null,

          dateApproved:
            mercadoPago?.date_approved ||
            null
        },

        diagnosis: {

          databaseStatus:
            paymentRow.status,

          mercadoPagoStatus:
            mercadoPago?.status ||
            null,

          paymentApprovedOnMercadoPago:
            mercadoPago?.status ===
            "approved",

          accessShouldBeActive:
            paymentRow.status ===
              "approved" &&
            Boolean(
              paymentRow.active_until
            )
        }
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


/* =====================================================
   ACESSO DO ASSINANTE
===================================================== */

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


/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      server:
        "online",

      provider:
        "mercadopago"
    });
  }
);


/* =====================================================
   CONFIG TEST
===================================================== */

app.get(
  "/api/config-test",
  (req, res) => {

    res.json({

      server:
        "online",

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


/* =====================================================
   SERVIDOR
===================================================== */

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

    console.log(
      `Telegram configurado: ${
        TELEGRAM_INVITE_URL
          ? "SIM"
          : "NÃO"
      }`
    );
  }
);
