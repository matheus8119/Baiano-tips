import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const ASAAS_URL = "https://api.asaas.com/v3";

const plans = {
  mensal: { name: "Mensal", value: 29.90, days: 30 },
  trimestral: { name: "Trimestral", value: 69.90, days: 90 },
  semestral: { name: "Semestral", value: 119.90, days: 180 },
  anual: { name: "Anual", value: 199.90, days: 365 }
};

const db = new Database("baiano-tips.db");

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  asaas_payment_id TEXT,
  status TEXT DEFAULT 'PENDING',
  pix TEXT,
  invite TEXT,
  expires_at TEXT,
  telegram_user_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

async function asaas(path, options = {}) {
  const response = await fetch(ASAAS_URL + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "access_token": process.env.ASAAS_API_KEY,
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function telegram(method, data) {
  const response = await fetch(
    https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method},
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  return await response.json();
}

app.get("/api/health", (req, res) => {
  res.json({
    online: true,
    service: "Baiano Tips"
  });
});

app.post("/api/create-payment", async (req, res) => {
  try {
    const { name, email, plan } = req.body;

    if (!name || !email || !plans[plan]) {
      return res.status(400).json({
        error: "Preencha nome, e-mail e plano."
      });
    }

    // Procurar/criar cliente no Asaas
    const customers = await asaas(
      /customers?email=${encodeURIComponent(email)}
    );

    let customer = customers.data?.[0];

    if (!customer) {
      customer = await asaas("/customers", {
        method: "POST",
        body: JSON.stringify({
          name,
          email
        })
      });
    }

    const selected = plans[plan];

    // Criar cobrança Pix
    const payment = await asaas("/payments", {
      method: "POST",
      body: JSON.stringify({
        customer: customer.id,
        billingType: "PIX",
        value: selected.value,
        dueDate: new Date().toISOString().slice(0, 10),
        description: Baiano Tips - ${selected.name}
      })
    });

    // Buscar QR Code Pix
    const pix = await asaas(
      /payments/${payment.id}/pixQrCode
    );

    const result = db.prepare(`
      INSERT INTO payments
      (name,email,plan,asaas_payment_id,pix)
      VALUES (?,?,?,?,?)
    `).run(
      name,
      email.toLowerCase(),
      plan,
      payment.id,
      pix.payload
    );

    res.json({
      success: true,
      paymentId: result.lastInsertRowid,
      asaasPaymentId: payment.id,
      plan: selected.name,
      value: selected.value,
      pix: pix.payload,
      encodedImage: pix.encodedImage
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Erro ao criar pagamento."
    });
  }
});

app.get("/api/access", (req, res) => {

  const email = String(req.query.email || "")
    .trim()
    .toLowerCase();

  const payment = db.prepare(`
    SELECT *
    FROM payments
    WHERE email = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(email);

  if (!payment) {
    return res.json({
      found: false
    });
  }

  const active =
    payment.status === "PAID" &&
    payment.expires_at &&
    new Date(payment.expires_at) > new Date();

  res.json({
    found: true,
    active,
    plan: plans[payment.plan]?.name,
    expiresAt: payment.expires_at,
    invite: active ? payment.invite : null
  });
});

app.post("/api/asaas/webhook", async (req, res) => {

  if (
    process.env.ASAAS_WEBHOOK_TOKEN &&
    req.headers["asaas-access-token"] !==
      process.env.ASAAS_WEBHOOK_TOKEN
  ) {
    return res.status(401).send("Unauthorized");
  }

  res.sendStatus(200);

  const event = req.body;

  if (
    event.event !== "PAYMENT_RECEIVED" &&
    event.event !== "PAYMENT_CONFIRMED"
  ) {
    return;
  }

  const asaasId = event.payment?.id;

  if (!asaasId) return;

  const payment = db.prepare(`
    SELECT *
    FROM payments
    WHERE asaas_payment_id = ?
  `).get(asaasId);

  if (!payment || payment.status === "PAID") return;

  const selected = plans[payment.plan];

  const expires = new Date();

  expires.setDate(
    expires.getDate() + selected.days
  );

  let invite = null;

  try {

    const telegramResult = await telegram(
      "createChatInviteLink",
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        member_limit: 1,
        expire_date: Math.floor(
          expires.getTime() / 1000
        )
      }
    );

    if (telegramResult.ok) {
      invite =
        telegramResult.result.invite_link;
    }

  } catch (e) {
    console.error(
      "Erro Telegram:",
      e.message
    );
  }

  db.prepare(`
    UPDATE payments
    SET
      status='PAID',
      invite=?,
      expires_at=?
    WHERE id=?
  `).run(
    invite,
    expires.toISOString(),
    payment.id
  );
});

async function configurarTelegram() {
 app.listen(PORT, () => {
  console.log(Baiano Tips online na porta ${PORT});
});
