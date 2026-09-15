import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || "";
const PAGBANK_SANDBOX_TOKEN = process.env.PAGBANK_SANDBOX_TOKEN || "";
const BASE_URL = process.env.BASE_URL || "";
const PIX_ENABLED = process.env.PIX_ENABLED === "true";
const TELEGRAM_INVITE_URL = process.env.TELEGRAM_INVITE_URL || "";

const PAGBANK_API = "https://api.pagseguro.com";
const PAGBANK_SANDBOX_API = "https://sandbox.api.pagseguro.com";

const db = new Database("./baiano_tips.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    cpf TEXT,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    active_until TEXT,
    created_at TEXT NOT NULL
  )
`);

try {
  db.exec(`ALTER TABLE payments ADD COLUMN cpf TEXT`);
} catch {}

const plans = {
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

function cleanCpf(cpf) {
  return String(cpf || "").replace(/\D/g, "");
}

function isValidCpf(cpf) {
  cpf = cleanCpf(cpf);

  if (cpf.length !== 11) return false;

  if (/^(\d)\1+$/.test(cpf)) return false;

  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }

  let digit1 = (sum * 10) % 11;

  if (digit1 === 10) digit1 = 0;

  if (digit1 !== Number(cpf[9])) return false;

  sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }

  let digit2 = (sum * 10) % 11;

  if (digit2 === 10) digit2 = 0;

  return digit2 === Number(cpf[10]);
}

function formatPagBankError(responseData, httpStatus) {
  if (!responseData) {
    return `PagBank respondeu HTTP ${httpStatus}.`;
  }

  if (responseData.error_messages) {
    return responseData.error_messages
      .map((item) => {
        const parameter = item.parameter_name
          ? ` (${item.parameter_name})`
          : "";

        return `${item.code || "ERRO"}${parameter}: ${
          item.description || "Erro não informado"
        }`;
      })
      .join(" | ");
  }

  if (responseData.message) {
    return responseData.message;
  }

  if (responseData.error) {
    return responseData.error;
  }

  return `PagBank respondeu HTTP ${httpStatus}: ${JSON.stringify(
    responseData
  )}`;
}

/*
|--------------------------------------------------------------------------
| TESTE SANDBOX
|--------------------------------------------------------------------------
*/

app.get("/api/sandbox-test", async (req, res) => {
  try {
    if (!PAGBANK_SANDBOX_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "PAGBANK_SANDBOX_TOKEN não configurado."
      });
    }

    const referenceId = `sandbox-${Date.now()}`;

    const response = await fetch(`${PAGBANK_SANDBOX_API}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAGBANK_SANDBOX_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        reference_id: referenceId,
        customer: {
          name: "MATHEUS GONCALVES SILVA",
          email: "sandbox@baianotips.com",
          tax_id: "12345678909"
        },
        items: [
          {
            reference_id: "sandbox-item",
            name: "Teste Baiano Tips",
            quantity: 1,
            unit_amount: 100
          }
        ],
        qr_codes: [
          {
            amount: {
              value: 100
            }
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: "PagBank recusou o pedido Sandbox.",
        details: data
      });
    }

    const qrCode =
      data.qr_codes &&
      data.qr_codes[0] &&
      data.qr_codes[0].text
        ? data.qr_codes[0].text
        : null;

    return res.json({
      success: true,
      message: "Sandbox PagBank funcionando corretamente.",
      orderId: data.id,
      chargeStatus:
        data.qr_codes &&
        data.qr_codes[0] &&
        data.qr_codes[0].charges &&
        data.qr_codes[0].charges[0]
          ? data.qr_codes[0].charges[0].status
          : null,
      pix: qrCode,
      messageDetails:
        "Pedido criado no ambiente Sandbox. Nenhum dinheiro real foi movimentado."
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Erro interno no teste Sandbox.",
      details: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| CRIAR PAGAMENTO PIX REAL
|--------------------------------------------------------------------------
*/

app.post("/api/create-payment", async (req, res) => {
  try {
    const { name, cpf, email, plan } = req.body;

    if (!name || !cpf || !email || !plan) {
      return res.status(400).json({
        success: false,
        message: "Preencha nome, CPF, e-mail e plano."
      });
    }

    if (!PAGBANK_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "Token PagBank de produção não configurado."
      });
    }

    if (!PIX_ENABLED) {
      return res.status(403).json({
        success: false,
        message: "PIX está desativado no momento."
      });
    }

    if (!plans[plan]) {
      return res.status(400).json({
        success: false,
        message: "Plano inválido."
      });
    }

    const cleanCpfValue = cleanCpf(cpf);

    if (!isValidCpf(cleanCpfValue)) {
      return res.status(400).json({
        success: false,
        message: "CPF inválido."
      });
    }

    const selectedPlan = plans[plan];

    const referenceId = `baiano-${Date.now()}-${crypto
      .randomBytes(4)
      .toString("hex")}`;

    const payload = {
      reference_id: referenceId,

      customer: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        tax_id: cleanCpfValue
      },

      items: [
        {
          reference_id: plan,
          name: selectedPlan.name,
          quantity: 1,
          unit_amount: selectedPlan.amount
        }
      ],

      qr_codes: [
        {
          amount: {
            value: selectedPlan.amount
          }
        }
      ]
    };

    console.log("Criando pedido PagBank...");
    console.log("Reference ID:", referenceId);
    console.log("Plano:", plan);
    console.log("Valor:", selectedPlan.amount);

    const response = await fetch(`${PAGBANK_API}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAGBANK_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    /*
    |--------------------------------------------------------------------------
    | SE O PAGBANK RECUSAR
    |--------------------------------------------------------------------------
    */

    if (!response.ok) {
      const detailedError = formatPagBankError(data, response.status);

      console.error("=================================");
      console.error("ERRO PAGBANK");
      console.error("HTTP:", response.status);
      console.error("DETALHE:", detailedError);
      console.error("RESPOSTA COMPLETA:", JSON.stringify(data));
      console.error("=================================");

      return res.status(response.status).json({
        success: false,
        message: detailedError,
        pagbankStatus: response.status,
        details: data
      });
    }

    const orderId = data.id;

    let pixText = null;
    let qrCodePng = null;

    if (data.qr_codes && data.qr_codes[0]) {
      pixText = data.qr_codes[0].text || null;

      const links = data.qr_codes[0].links || [];

      const pngLink = links.find(
        (link) =>
          link.rel === "QRCODE.PNG" ||
          link.media === "image/png"
      );

      if (pngLink && pngLink.href) {
        try {
          const imageResponse = await fetch(pngLink.href, {
            headers: {
              Authorization: `Bearer ${PAGBANK_TOKEN}`,
              Accept: "image/png"
            }
          });

          if (imageResponse.ok) {
            const imageBuffer = Buffer.from(
              await imageResponse.arrayBuffer()
            );

            qrCodePng = `data:image/png;base64,${imageBuffer.toString(
              "base64"
            )}`;
          }
        } catch (imageError) {
          console.error(
            "Erro ao baixar imagem do QR Code:",
            imageError.message
          );
        }
      }
    }

    db.prepare(`
      INSERT INTO payments (
        order_id,
        name,
        email,
        cpf,
        plan,
        amount,
        status,
        active_until,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      name.trim(),
      email.trim().toLowerCase(),
      cleanCpfValue,
      plan,
      selectedPlan.amount,
      "WAITING",
      null,
      new Date().toISOString()
    );

    console.log("Pagamento criado com sucesso.");
    console.log("Order ID:", orderId);

    return res.json({
      success: true,
      orderId,
      status: "WAITING",
      pix: pixText,
      qrCode: qrCodePng,
      message: "PIX criado com sucesso."
    });
  } catch (error) {
    console.error("=================================");
    console.error("ERRO INTERNO CREATE PAYMENT");
    console.error(error);
    console.error("=================================");

    return res.status(500).json({
      success: false,
      message: `Erro interno: ${error.message}`
    });
  }
});

/*
|--------------------------------------------------------------------------
| WEBHOOK PAGBANK
|--------------------------------------------------------------------------
*/

app.post("/api/pagbank/webhook", async (req, res) => {
  try {
    const orderId =
      req.body?.id ||
      req.body?.order?.id ||
      req.body?.data?.id;

    console.log("Webhook recebido:", JSON.stringify(req.body));

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID não encontrado no webhook."
      });
    }

    const response = await fetch(
      `${PAGBANK_API}/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${PAGBANK_TOKEN}`,
          Accept: "application/json"
        }
      }
    );

    const order = await response.json();

    if (!response.ok) {
      console.error(
        "Erro ao consultar pedido no PagBank:",
        JSON.stringify(order)
      );

      return res.status(response.status).json({
        success: false,
        message: "Erro ao consultar pedido no PagBank.",
        details: order
      });
    }

    const payment = db
      .prepare(`SELECT * FROM payments WHERE order_id = ?`)
      .get(orderId);

    if (!payment) {
      console.log("Pagamento não encontrado no banco:", orderId);

      return res.json({
        success: true,
        message: "Webhook recebido, mas pagamento não encontrado."
      });
    }

    let status = "WAITING";

    if (order.charges && order.charges.length > 0) {
      status = order.charges[0].status || "WAITING";
    }

    let activeUntil = payment.active_until;

    if (status === "PAID") {
      const plan = plans[payment.plan];

      if (plan) {
        const startDate = new Date();

        startDate.setDate(
          startDate.getDate() + plan.days
        );

        activeUntil = startDate.toISOString();
      }
    }

    db.prepare(`
      UPDATE payments
      SET status = ?, active_until = ?
      WHERE order_id = ?
    `).run(
      status,
      activeUntil,
      orderId
    );

    console.log(
      `Pagamento ${orderId} atualizado para ${status}`
    );

    return res.json({
      success: true,
      orderId,
      status
    });
  } catch (error) {
    console.error("Erro no webhook:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| VERIFICAR ACESSO
|--------------------------------------------------------------------------
*/

app.get("/api/access", (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return res.status(400).json({
        active: false,
        message: "Informe o e-mail."
      });
    }

    const payment = db
      .prepare(`
        SELECT *
        FROM payments
        WHERE email = ?
          AND status = 'PAID'
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(email);

    if (!payment) {
      return res.json({
        active: false
      });
    }

    if (
      payment.active_until &&
      new Date(payment.active_until) > new Date()
    ) {
      return res.json({
        active: true,
        plan: payment.plan,
        activeUntil: payment.active_until,
        invite: TELEGRAM_INVITE_URL
      });
    }

    return res.json({
      active: false
    });
  } catch (error) {
    return res.status(500).json({
      active: false,
      message: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    server: "online",
    pixEnabled: PIX_ENABLED,
    sandboxTokenConfigured: Boolean(PAGBANK_SANDBOX_TOKEN),
    productionTokenConfigured: Boolean(PAGBANK_TOKEN)
  });
});

/*
|--------------------------------------------------------------------------
| CONFIG TEST
|--------------------------------------------------------------------------
*/

app.get("/api/config-test", (req, res) => {
  res.json({
    server: "online",
    pagbankTokenConfigured: Boolean(PAGBANK_TOKEN),
    pagbankSandboxTokenConfigured: Boolean(PAGBANK_SANDBOX_TOKEN),
    pixEnabled: PIX_ENABLED,
    baseUrlConfigured: Boolean(BASE_URL),
    message: "Configuração carregada com sucesso."
  });
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
  console.log(`Servidor online na porta ${PORT}`);
});
