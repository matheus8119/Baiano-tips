import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import crypto from "crypto";

const app = express();

const PORT = process.env.PORT || 3000;

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN;
const PAGBANK_SANDBOX_TOKEN = process.env.PAGBANK_SANDBOX_TOKEN;

const BASE_URL = process.env.BASE_URL || "";
const PIX_ENABLED = process.env.PIX_ENABLED === "true";

const PAGBANK_API = "https://api.pagseguro.com";
const PAGBANK_SANDBOX_API = "https://sandbox.api.pagseguro.com";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("./baiano_tips.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    active_until TEXT,
    created_at TEXT NOT NULL
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

const PLANS = {
  mensal: {
    name: "Plano Mensal",
    amount: 2990,
    days: 30
  },

  trimestral: {
    name: "Plano Trimestral",
    amount: 6990,
    days: 90
  },

  semestral: {
    name: "Plano Semestral",
    amount: 11990,
    days: 180
  },

  anual: {
    name: "Plano Anual",
    amount: 19990,
    days: 365
  }
};

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString();
}


/* =====================================================
   TESTE SANDBOX PAGBANK
   ===================================================== */

app.get("/api/sandbox-test", async (req, res) => {
  try {
    if (!PAGBANK_SANDBOX_TOKEN) {
      return res.status(500).json({
        success: false,
        message:
          "PAGBANK_SANDBOX_TOKEN não está configurado no Render."
      });
    }

    const referenceId =
      `BAIANO-SANDBOX-${Date.now()}-${crypto
        .randomUUID()
        .slice(0, 8)}`;

    const expiration = new Date(
      Date.now() + 30 * 60 * 1000
    ).toISOString();

    const orderPayload = {
      reference_id: referenceId,

      customer: {
        name: "Cliente Teste Baiano Tips",
        email: "teste@baianotips.com",

        // CPF fictício para o Sandbox
        tax_id: "12345678909"
      },

      items: [
        {
          reference_id: "sandbox-teste",
          name: "Teste Baiano Tips",
          quantity: 1,
          unit_amount: 100
        }
      ],

      charges: [
        {
          reference_id: referenceId,

          description:
            "Teste Sandbox Baiano Tips",

          amount: {
            value: 100,
            currency: "BRL"
          },

          payment_method: {
            type: "PIX",

            pix: {
              expiration_date: expiration
            }
          }
        }
      ],

      notification_urls: BASE_URL
        ? [
            `${BASE_URL}/api/pagbank/webhook`
          ]
        : []
    };

    const response = await fetch(
      `${PAGBANK_SANDBOX_API}/orders`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${PAGBANK_SANDBOX_TOKEN}`,

          Accept:
            "application/json",

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(orderPayload)
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "Erro Sandbox PagBank:",
        data
      );

      return res.status(response.status).json({
        success: false,

        message:
          "PagBank recusou o pedido Sandbox.",

        details: data
      });
    }

    const orderId =
      data.id;

    const charge =
      data.charges?.[0];

    return res.json({
      success: true,

      message:
        "Sandbox PagBank funcionando corretamente.",

      orderId,

      chargeStatus:
        charge?.status || null,

      pix:
        charge?.qr_code?.text || null,

      messageDetails:
        "Pedido criado no ambiente Sandbox. Nenhum dinheiro real foi movimentado."
    });

  } catch (error) {
    console.error(
      "Erro no teste Sandbox:",
      error
    );

    return res.status(500).json({
      success: false,

      message:
        "Erro interno ao testar o Sandbox.",

      details:
        error.message
    });
  }
});


/* =====================================================
   PAGAMENTO REAL
   ===================================================== */

app.post("/api/create-payment", async (req, res) => {
  try {
    const {
      name,
      email,
      plan
    } = req.body;

    if (!name || !email || !plan) {
      return res.status(400).json({
        error:
          "Nome, e-mail e plano são obrigatórios."
      });
    }

    if (!PLANS[plan]) {
      return res.status(400).json({
        error:
          "Plano inválido."
      });
    }

    if (!PAGBANK_TOKEN) {
      return res.status(500).json({
        error:
          "PAGBANK_TOKEN não configurado no Render."
      });
    }

    if (!PIX_ENABLED) {
      return res.status(403).json({
        error:
          "PIX está temporariamente desativado durante a configuração."
      });
    }

    const selectedPlan =
      PLANS[plan];

    const referenceId =
      `BAIANO-${Date.now()}-${crypto
        .randomUUID()
        .slice(0, 8)}`;

    const expiration =
      new Date(
        Date.now() +
        30 * 60 * 1000
      ).toISOString();

    const orderPayload = {
      reference_id:
        referenceId,

      customer: {
        name:
          name.trim(),

        email:
          email
            .trim()
            .toLowerCase()
      },

      items: [
        {
          reference_id:
            plan,

          name:
            selectedPlan.name,

          quantity:
            1,

          unit_amount:
            selectedPlan.amount
        }
      ],

      charges: [
        {
          reference_id:
            referenceId,

          description:
            selectedPlan.name,

          amount: {
            value:
              selectedPlan.amount,

            currency:
              "BRL"
          },

          payment_method: {
            type:
              "PIX",

            pix: {
              expiration_date:
                expiration
            }
          }
        }
      ],

      notification_urls: [
        `${BASE_URL}/api/pagbank/webhook`
      ]
    };

    const response =
      await fetch(
        `${PAGBANK_API}/orders`,
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${PAGBANK_TOKEN}`,

            Accept:
              "application/json",

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              orderPayload
            )
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "Erro PagBank:",
        data
      );

      return res.status(
        response.status
      ).json({
        error:
          "Erro ao criar pagamento no PagBank.",

        details:
          data
      });
    }

    const orderId =
      data.id;

    const charge =
      data.charges?.[0];

    if (!orderId || !charge) {
      return res.status(500).json({
        error:
          "Resposta inesperada do PagBank."
      });
    }

    const pixText =
      charge.qr_code?.text || "";

    let encodedImage = "";

    const qrLink =
      charge.links?.find(
        link =>
          link.rel ===
          "QRCODE.PNG"
      );

    if (qrLink?.href) {
      try {
        const imageResponse =
          await fetch(
            qrLink.href,
            {
              headers: {
                Authorization:
                  `Bearer ${PAGBANK_TOKEN}`,

                Accept:
                  "image/png"
              }
            }
          );

        if (imageResponse.ok) {
          const imageBuffer =
            Buffer.from(
              await imageResponse.arrayBuffer()
            );

          encodedImage =
            `data:image/png;base64,${imageBuffer.toString("base64")}`;
        }

      } catch (error) {
        console.error(
          "Erro ao obter QR Code:",
          error
        );
      }
    }

    db.prepare(`
      INSERT INTO payments
      (
        order_id,
        name,
        email,
        plan,
        amount,
        status,
        active_until,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,

      name.trim(),

      email
        .trim()
        .toLowerCase(),

      plan,

      selectedPlan.amount,

      charge.status ||
        "WAITING",

      null,

      new Date()
        .toISOString()
    );

    res.json({
      success:
        true,

      orderId,

      pix:
        pixText,

      encodedImage,

      status:
        charge.status ||
        "WAITING"
    });

  } catch (error) {
    console.error(
      "Erro interno:",
      error
    );

    res.status(500).json({
      error:
        "Erro interno do servidor."
    });
  }
});


/* =====================================================
   WEBHOOK PAGBANK
   ===================================================== */

app.post(
  "/api/pagbank/webhook",
  async (req, res) => {

    try {

      const orderId =
        req.body?.id ||
        req.body?.order?.id;

      if (
        !orderId ||
        !PAGBANK_TOKEN
      ) {
        return res.status(200).json({
          received:
            true
        });
      }

      const response =
        await fetch(
          `${PAGBANK_API}/orders/${orderId}`,
          {
            headers: {
              Authorization:
                `Bearer ${PAGBANK_TOKEN}`,

              Accept:
                "application/json"
            }
          }
        );

      if (!response.ok) {
        return res.status(200).json({
          received:
            true
        });
      }

      const order =
        await response.json();

      const charge =
        order.charges?.[0];

      if (!charge) {
        return res.status(200).json({
          received:
            true
        });
      }

      const payment =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE order_id = ?
        `).get(orderId);

      if (!payment) {
        return res.status(200).json({
          received:
            true
        });
      }

      let activeUntil =
        payment.active_until;

      if (
        charge.status ===
        "PAID"
      ) {
        activeUntil =
          addDays(
            new Date(),

            PLANS[
              payment.plan
            ]?.days || 30
          );
      }

      db.prepare(`
        UPDATE payments
        SET status = ?,
            active_until = ?
        WHERE order_id = ?
      `).run(
        charge.status ||
          "WAITING",

        activeUntil,

        orderId
      );

      return res.status(200).json({
        received:
          true
      });

    } catch (error) {

      console.error(
        "Webhook:",
        error
      );

      return res.status(200).json({
        received:
          true
      });
    }
  }
);


/* =====================================================
   VERIFICAR ACESSO
   ===================================================== */

app.get(
  "/api/access",
  (req, res) => {

    try {

      const email =
        String(
          req.query.email ||
          ""
        )
        .trim()
        .toLowerCase();

      if (!email) {
        return res.json({
          active:
            false
        });
      }

      const payment =
        db.prepare(`
          SELECT *
          FROM payments
          WHERE email = ?
          AND status = 'PAID'
          ORDER BY active_until DESC
          LIMIT 1
        `).get(email);

      if (!payment) {
        return res.json({
          active:
            false
        });
      }

      if (
        !payment.active_until ||
        new Date(
          payment.active_until
        ) <= new Date()
      ) {
        return res.json({
          active:
            false
        });
      }

      res.json({

        active:
          true,

        plan:
          payment.plan,

        activeUntil:
          payment.active_until,

        invite:
          process.env
            .TELEGRAM_INVITE_URL ||
          null
      });

    } catch (error) {

      console.error(
        "Access:",
        error
      );

      res.status(500).json({
        active:
          false
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

      online:
        true,

      pixEnabled:
        PIX_ENABLED,

      sandboxTokenConfigured:
        Boolean(
          PAGBANK_SANDBOX_TOKEN
        ),

      productionTokenConfigured:
        Boolean(
          PAGBANK_TOKEN
        )
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

      pagbankTokenConfigured:
        Boolean(
          PAGBANK_TOKEN
        ),

      pagbankSandboxTokenConfigured:
        Boolean(
          PAGBANK_SANDBOX_TOKEN
        ),

      pixEnabled:
        PIX_ENABLED,

      baseUrlConfigured:
        Boolean(
          BASE_URL
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

  }
);
