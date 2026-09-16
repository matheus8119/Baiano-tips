import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BASE_URL =
  process.env.BASE_URL ||
  "http://localhost:" + PORT;

const PIX_ENABLED =
  String(process.env.PIX_ENABLED || "false").toLowerCase() === "true";

const TELEGRAM_INVITE_URL =
  process.env.TELEGRAM_INVITE_URL || "";

const MERCADO_PAGO_ACCESS_TOKEN =
  process.env.MERCADOPAGO_ACCESS_TOKEN || "";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5
});

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

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function generateExternalReference() {
  return (
    "BAIANOTIPS-" +
    Date.now() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_id TEXT,
      external_reference TEXT,
      name TEXT,
      cpf TEXT,
      email TEXT,
      plan TEXT,
      amount NUMERIC(10,2),
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMPTZ,
      active_until TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_email
    ON payments(email)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_payment_id
    ON payments(payment_id)
  `);

  console.log("BANCO DE DADOS INICIALIZADO.");
}

async function mercadoPagoRequest(url, options = {}) {
  if (!MERCADO_PAGO_ACCESS_TOKEN) {
    throw new Error(
      "MERCADOPAGO_ACCESS_TOKEN não configurado."
    );
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization:
        "Bearer " + MERCADO_PAGO_ACCESS_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

/* ==================================================
   SITE
================================================== */

app.get("/", (req, res) => {

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Baiano Tips</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;

  background:
    radial-gradient(
      circle at top,
      #173d24 0%,
      #07130b 45%,
      #020603 100%
    );

  color: white;
  min-height: 100vh;
}

.container {
  width: 100%;
  max-width: 600px;
  margin: auto;
  padding: 25px 18px 40px;
}

.card {
  background: rgba(10, 25, 15, 0.94);

  border: 1px solid rgba(75, 190, 100, 0.25);

  border-radius: 20px;

  padding: 25px;

  box-shadow:
    0 15px 50px rgba(0,0,0,.4);
}

h1 {
  text-align: center;
  margin: 0;

  font-size: 34px;

  color: #35e76b;
}

.subtitle {
  text-align: center;

  color: #bbb;

  margin:
    8px 0 25px;
}

label {
  display: block;

  margin-top: 14px;
  margin-bottom: 6px;

  color: #ddd;
}

input,
select {
  width: 100%;

  padding: 14px;

  border-radius: 10px;

  border:
    1px solid #35513d;

  background: #07110a;

  color: white;

  font-size: 16px;
}

button {
  width: 100%;

  margin-top: 18px;

  padding: 15px;

  border: 0;

  border-radius: 10px;

  background: #23d85b;

  color: #031006;

  font-size: 17px;

  font-weight: bold;

  cursor: pointer;
}

button:hover {
  filter: brightness(1.1);
}

.secondary {
  background: #17351f;
  color: white;
}

#resultado {
  margin-top: 20px;
}

.pix-box {
  background: #061009;

  border:
    1px solid #25452d;

  border-radius: 14px;

  padding: 15px;

  margin-top: 15px;
}

.pix-code {
  word-break: break-all;

  font-size: 12px;

  color: #b9ffca;

  max-height: 120px;

  overflow: auto;
}

.qr {
  display: block;

  max-width: 260px;

  width: 100%;

  margin: 15px auto;

  border-radius: 10px;

  background: white;

  padding: 10px;
}

.success {
  color: #4cff82;

  font-weight: bold;
}

.error {
  color: #ff7070;
}

.warning {
  color: #ffc857;

  font-size: 13px;

  line-height: 1.5;

  margin-top: 20px;
}

.telegram {
  display: block;

  text-align: center;

  background: #229ed9;

  color: white;

  padding: 15px;

  border-radius: 10px;

  text-decoration: none;

  font-weight: bold;

  margin-top: 18px;
}

hr {
  border: 0;

  border-top:
    1px solid #24402b;

  margin: 28px 0;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>BAIANO TIPS</h1>

<div class="subtitle">
Tips e Alavancagem
</div>

<label>Nome</label>

<input
  id="nome"
  placeholder="Seu nome"
>

<label>CPF</label>

<input
  id="cpf"
  placeholder="Seu CPF"
>

<label>E-mail</label>

<input
  id="email"
  type="email"
  placeholder="Seu melhor e-mail"
>

<label>Plano</label>

<select id="plano">

<option value="mensal">
Mensal — R$ 29,90
</option>

<option value="trimestral">
Trimestral — R$ 69,90
</option>

<option value="semestral">
Semestral — R$ 119,90
</option>

<option value="anual">
Anual — R$ 199,90
</option>

</select>

<button onclick="gerarPix()">
GERAR PIX
</button>

<div id="resultado"></div>

<hr>

<h2>Já sou assinante</h2>

<label>Digite seu e-mail</label>

<input
  id="emailAcesso"
  type="email"
  placeholder="E-mail usado na assinatura"
>

<button
  class="secondary"
  onclick="verificarAcesso()"
>
VERIFICAR ACESSO
</button>

<div id="acessoResultado"></div>

<div class="warning">

⚠️ Conteúdo destinado exclusivamente para maiores de 18 anos.

Aposte com responsabilidade.
Nunca aposte mais do que pode perder.

</div>

</div>

</div>

<script>

async function gerarPix() {

  var nome =
    document.getElementById("nome").value.trim();

  var cpf =
    document.getElementById("cpf").value.trim();

  var email =
    document.getElementById("email").value.trim();

  var plan =
    document.getElementById("plano").value;

  var resultado =
    document.getElementById("resultado");

  if (!nome || !cpf || !email) {

    resultado.innerHTML =
      '<p class="error">Preencha todos os campos.</p>';

    return;
  }

  resultado.innerHTML =
    "<p>Gerando PIX...</p>";

  try {

    var response =
      await fetch(
        "/api/create-payment",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            name: nome,
            cpf: cpf,
            email: email,
            plan: plan
          })
        }
      );

    var data =
      await response.json();

    if (!data.success) {

      resultado.innerHTML =
        '<p class="error">' +
        (data.message ||
          "Erro ao gerar PIX.") +
        "</p>";

      return;
    }

    var html =
      '<div class="pix-box">' +

      '<p class="success">' +
      "PIX gerado com sucesso!" +
      "</p>";

    if (data.qrCodeBase64) {

      html +=
        '<img ' +
        'class="qr" ' +
        'src="' +
        data.qrCodeBase64 +
        '" ' +
        'alt="QR Code PIX">';
    }

    if (data.qrCode) {

      html +=
        "<p>Copie o código PIX:</p>" +

        '<div class="pix-code">' +
        data.qrCode +
        "</div>" +

        '<button onclick="copiarPix(' +
        "'" +
        encodeURIComponent(data.qrCode) +
        "'" +
        ')">' +
        "COPIAR PIX" +
        "</button>";
    }

    html +=
      "<p>" +
      "Após o pagamento aprovado, " +
      "seu acesso será liberado." +
      "</p>" +

      "</div>";

    resultado.innerHTML = html;

  } catch (error) {

    console.error(error);

    resultado.innerHTML =
      '<p class="error">' +
      "Erro de conexão com o servidor." +
      "</p>";
  }
}

async function copiarPix(code) {

  try {

    var decoded =
      decodeURIComponent(code);

    await navigator.clipboard.writeText(
      decoded
    );

    alert("PIX copiado!");

  } catch (error) {

    alert(
      "Não foi possível copiar automaticamente."
    );
  }
}

async function verificarAcesso() {

  var email =
    document
      .getElementById("emailAcesso")
      .value
      .trim();

  var resultado =
    document.getElementById(
      "acessoResultado"
    );

  if (!email) {

    resultado.innerHTML =
      '<p class="error">' +
      "Informe seu e-mail." +
      "</p>";

    return;
  }

  resultado.innerHTML =
    "<p>Verificando assinatura...</p>";

  try {

    var response =
      await fetch(
        "/api/access?email=" +
        encodeURIComponent(email)
      );

    var data =
      await response.json();

    if (
      data.success &&
      data.active
    ) {

      var amount =
        Number(data.amount)
          .toFixed(2)
          .replace(".", ",");

      var activeUntil =
        new Date(
          data.activeUntil
        ).toLocaleString("pt-BR");

      var html =
        '<div class="pix-box">' +

        '<p class="success">' +
        "✅ Assinatura ativa!" +
        "</p>" +

        "<p>" +
        "Plano: <strong>" +
        data.plan +
        "</strong>" +
        "</p>" +

        "<p>" +
        "Valor: R$ " +
        amount +
        "</p>" +

        "<p>" +
        "Ativo até: " +
        activeUntil +
        "</p>";

      if (data.telegram) {

        html +=
          '<a ' +
          'class="telegram" ' +
          'href="' +
          data.telegram +
          '" ' +
          'target="_blank">' +
          "ENTRAR NO TELEGRAM" +
          "</a>";
      }

      html +=
        "</div>";

      resultado.innerHTML =
        html;

    } else {

      resultado.innerHTML =
        '<p class="error">' +
        (
          data.message ||
          "Nenhuma assinatura ativa encontrada."
        ) +
        "</p>";
    }

  } catch (error) {

    console.error(error);

    resultado.innerHTML =
      '<p class="error">' +
      "Erro ao verificar acesso." +
      "</p>";
  }
}

</script>

</body>

</html>
`;

  res.send(html);
});

/* ==================================================
   CRIAR PAGAMENTO PIX
================================================== */

app.post("/api/create-payment", async (req, res) => {

  try {

    const {
      name,
      cpf,
      email,
      plan
    } = req.body;

    const selectedPlan =
      plans[plan];

    if (!selectedPlan) {

      return res.status(400).json({
        success: false,
        message: "Plano inválido."
      });
    }

    if (!name || !cpf || !email) {

      return res.status(400).json({
        success: false,
        message:
          "Preencha todos os campos."
      });
    }

    const normalizedEmail =
      normalizeEmail(email);

    const externalReference =
      generateExternalReference();

    const paymentPayload = {

      transaction_amount:
        selectedPlan.amount,

      description:
        "Baiano Tips - " +
        selectedPlan.name,

      payment_method_id:
        "pix",

      external_reference:
        externalReference,

      payer: {
        email:
          normalizedEmail,

        first_name:
          String(name).trim()
      }
    };

    const mpResponse =
      await mercadoPagoRequest(
        "https://api.mercadopago.com/v1/payments",
        {
          method: "POST",

          headers: {
            "X-Idempotency-Key":
              crypto.randomUUID()
          },

          body:
            JSON.stringify(
              paymentPayload
            )
        }
      );

    if (!mpResponse.ok) {

      console.error(
        "ERRO MERCADO PAGO:",
        mpResponse.status,
        mpResponse.data
      );

      return res.status(500).json({

        success: false,

        message:
          "Não foi possível gerar o PIX.",

        error:
          mpResponse.data
      });
    }

    const payment =
      mpResponse.data;

    const transactionData =
      payment
        .point_of_interaction
        ?.transaction_data;

    const qrCode =
      transactionData?.qr_code ||
      null;

    const qrCodeBase64 =
      transactionData?.qr_code_base64
        ? "data:image/png;base64," +
          transactionData.qr_code_base64
        : null;

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
        $1,$2,$3,$4,$5,$6,$7,$8,$9
      )
      `,
      [
        String(payment.id),

        externalReference,

        String(name).trim(),

        String(cpf).trim(),

        normalizedEmail,

        plan,

        selectedPlan.amount,

        payment.status ||
          "pending",

        payment.date_created
          ? new Date(
              payment.date_created
            )
          : new Date()
      ]
    );

    return res.json({

      success: true,

      paymentId:
        payment.id,

      status:
        payment.status,

      qrCode,

      qrCodeBase64,

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

/* ==================================================
   WEBHOOK MERCADO PAGO
================================================== */

app.post(
  "/api/mercadopago/webhook",
  async (req, res) => {

    try {

      console.log(
        "WEBHOOK MERCADO PAGO:",
        JSON.stringify(req.body)
      );

      const paymentId =
        req.body?.data?.id ||
        req.body?.id;

      if (!paymentId) {

        return res.sendStatus(200);
      }

      const mpResponse =
        await mercadoPagoRequest(
          "https://api.mercadopago.com/v1/payments/" +
          paymentId
        );

      if (!mpResponse.ok) {

        console.error(
          "ERRO AO CONSULTAR PAGAMENTO:",
          mpResponse.data
        );

        return res.sendStatus(200);
      }

      const payment =
        mpResponse.data;

      const status =
        payment.status ||
        "pending";

      const paymentResult =
        await pool.query(
          `
          SELECT *
          FROM payments
          WHERE payment_id = $1
          LIMIT 1
          `,
          [
            String(paymentId)
          ]
        );

      if (
        paymentResult.rows.length === 0
      ) {

        console.log(
          "Pagamento não encontrado no banco:",
          paymentId
        );

        return res.sendStatus(200);
      }

      const existing =
        paymentResult.rows[0];

      let approvedAt =
        existing.approved_at;

      let activeUntil =
        existing.active_until;

      if (status === "approved") {

        approvedAt =
          payment.date_approved
            ? new Date(
                payment.date_approved
              )
            : new Date();

        const selectedPlan =
          plans[existing.plan] ||
          plans.mensal;

        activeUntil =
          new Date(
            approvedAt.getTime() +
            selectedPlan.days *
              24 *
              60 *
              60 *
              1000
          );
      }

      const payerEmail =
        normalizeEmail(
          payment.payer?.email ||
          existing.email
        );

      await pool.query(
        `
        UPDATE payments

        SET
          status = $1,
          email = $2,
          approved_at = $3,
          active_until = $4

        WHERE payment_id = $5
        `,
        [
          status,
          payerEmail,
          approvedAt,
          activeUntil,
          String(paymentId)
        ]
      );

      console.log(
        "PAGAMENTO ATUALIZADO:",
        paymentId,
        status
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

/* ==================================================
   ACESSO
================================================== */

app.get(
  "/api/access",
  async (req, res) => {

    try {

      const email =
        normalizeEmail(
          req.query.email
        );

      console.log(
        "VERIFICANDO ASSINATURA:",
        {
          recebido:
            req.query.email,

          normalizado:
            email
        }
      );

      if (!email) {

        return res.json({

          success: false,

          active: false,

          message:
            "Informe o e-mail."
        });
      }

      /*
      1. TENTA DIRETO NO BANCO
      */

      const directResult =
        await pool.query(
          `
          SELECT *
          FROM payments

          WHERE
            LOWER(
              REGEXP_REPLACE(
                TRIM(email),
                '\\s+',
                '',
                'g'
              )
            ) = $1

            AND LOWER(
              TRIM(status)
            ) = 'approved'

            AND active_until >
              CURRENT_TIMESTAMP

          ORDER BY active_until DESC

          LIMIT 1
          `,
          [email]
        );

      console.log(
        "PAGAMENTOS ENCONTRADOS:",
        directResult.rows.length
      );

      if (
        directResult.rows.length > 0
      ) {

        const payment =
          directResult.rows[0];

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
            TELEGRAM_INVITE_URL ||
            null,

          message:
            "Assinatura ativa."
        });
      }

      /*
      2. FALLBACK PELOS PAGAMENTOS ATIVOS
      */

      console.log(
        "Não encontrou pelo e-mail."
      );

      console.log(
        "Procurando pagamentos aprovados ativos..."
      );

      const activePayments =
        await pool.query(
          `
          SELECT *
          FROM payments

          WHERE
            LOWER(TRIM(status)) =
              'approved'

            AND active_until >
              CURRENT_TIMESTAMP

          ORDER BY active_until DESC

          LIMIT 20
          `
        );

      console.log(
        "PAGAMENTOS ATIVOS:",
        activePayments.rows.length
      );

      /*
      3. CONFERE CADA PAGAMENTO NO MP
      */

      for (
        const localPayment
        of activePayments.rows
      ) {

        if (
          !localPayment.payment_id
        ) {
          continue;
        }

        try {

          console.log(
            "Consultando pagamento MP:",
            localPayment.payment_id
          );

          const mpResponse =
            await mercadoPagoRequest(
              "https://api.mercadopago.com/v1/payments/" +
              localPayment.payment_id
            );

          if (!mpResponse.ok) {

            continue;
          }

          const mpPayment =
            mpResponse.data;

          const payerEmail =
            normalizeEmail(
              mpPayment.payer?.email
            );

          if (
            payerEmail &&
            payerEmail === email
          ) {

            console.log(
              "ASSINATURA ENCONTRADA PELO MERCADO PAGO!"
            );

            await pool.query(
              `
              UPDATE payments

              SET email = $1

              WHERE id = $2
              `,
              [
                payerEmail,
                localPayment.id
              ]
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

              activeUntil:
                localPayment.active_until,

              telegram:
                TELEGRAM_INVITE_URL ||
                null,

              message:
                "Assinatura ativa."
            });
          }

        } catch (checkError) {

          console.error(
            "ERRO AO CONFERIR PAGAMENTO:",
            checkError
          );
        }
      }

      /*
      4. BUSCA DIRETA NO MERCADO PAGO
      */

      console.log(
        "Consultando Mercado Pago pelo e-mail..."
      );

      try {

        const searchUrl =
          "https://api.mercadopago.com/v1/payments/search?payer.email=" +
          encodeURIComponent(email);

        const mpResponse =
          await mercadoPagoRequest(
            searchUrl
          );

        if (
          mpResponse.ok &&
          mpResponse.data?.results
        ) {

          const approvedPayment =
            mpResponse.data.results.find(
              function(payment) {

                return (
                  payment.status ===
                    "approved" &&

                  Number(
                    payment.transaction_amount
                  ) > 0
                );
              }
            );

          if (approvedPayment) {

            const plan =
              Object.keys(plans).find(
                function(key) {

                  return (
                    Math.abs(
                      plans[key].amount -
                      Number(
                        approvedPayment
                          .transaction_amount
                      )
                    ) < 0.01
                  );
                }
              ) || "mensal";

            const selectedPlan =
              plans[plan];

            const approvedAt =
              approvedPayment
                .date_approved
                ? new Date(
                    approvedPayment
                      .date_approved
                  )
                : new Date();

            const activeUntil =
              new Date(
                approvedAt.getTime() +
                selectedPlan.days *
                  24 *
                  60 *
                  60 *
                  1000
              );

            const existingPayment =
              await pool.query(
                `
                SELECT id
                FROM payments

                WHERE payment_id = $1

                LIMIT 1
                `,
                [
                  String(
                    approvedPayment.id
                  )
                ]
              );

            if (
              existingPayment.rows.length > 0
            ) {

              await pool.query(
                `
                UPDATE payments

                SET
                  email = $1,
                  status = 'approved',
                  approved_at = $2,
                  active_until = $3

                WHERE payment_id = $4
                `,
                [
                  email,
                  approvedAt,
                  activeUntil,
                  String(
                    approvedPayment.id
                  )
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
                  $1,$2,$3,$4,$5,
                  $6,$7,$8,$9,$10,$11
                )
                `,
                [
                  String(
                    approvedPayment.id
                  ),

                  approvedPayment
                    .external_reference ||
                    null,

                  approvedPayment
                    .payer
                    ?.first_name ||
                    "",

                  "",

                  email,

                  plan,

                  Number(
                    approvedPayment
                      .transaction_amount
                  ),

                  "approved",

                  approvedPayment
                    .date_created
                    ? new Date(
                        approvedPayment
                          .date_created
                      )
                    : new Date(),

                  approvedAt,

                  activeUntil
                ]
              );
            }

            return res.json({

              success: true,

              active: true,

              plan,

              amount:
                Number(
                  approvedPayment
                    .transaction_amount
                ),

              activeUntil,

              telegram:
                TELEGRAM_INVITE_URL ||
                null,

              message:
                "Assinatura ativa."
            });
          }
        }

      } catch (fallbackError) {

        console.error(
          "ERRO FALLBACK MP:",
          fallbackError
        );
      }

      return res.json({

        success: true,

        active: false,

        message:
          "Nenhuma assinatura ativa encontrada."
      });

    } catch (error) {

      console.error(
        "ERRO AO VERIFICAR ACESSO:",
        error
      );

      return res.status(500).json({

        success: false,

        active: false,

        message:
          "Erro ao verificar assinatura."
      });
    }
  }
);

/* ==================================================
   DEBUG
================================================== */

app.get(
  "/api/debug-access",
  async (req, res) => {

    try {

      const email =
        normalizeEmail(
          req.query.email
        );

      const result =
        await pool.query(
          `
          SELECT
            id,
            email,
            LOWER(TRIM(email))
              AS email_normalizado,
            status,
            active_until,
            CURRENT_TIMESTAMP AS agora,

            (
              active_until >
              CURRENT_TIMESTAMP
            ) AS data_valida

          FROM payments

          ORDER BY id DESC

          LIMIT 10
          `
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

      console.error(
        "ERRO DEBUG ACCESS:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);

/* ==================================================
   RECUPERAR PAGAMENTO
================================================== */

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

          message:
            "Informe o ID do pagamento."
        });
      }

      const mpResponse =
        await mercadoPagoRequest(
          "https://api.mercadopago.com/v1/payments/" +
          paymentId
        );

      if (!mpResponse.ok) {

        return res.status(400).json({

          success: false,

          message:
            "Pagamento não encontrado no Mercado Pago.",

          error:
            mpResponse.data
        });
      }

      const payment =
        mpResponse.data;

      if (
        payment.status !==
        "approved"
      ) {

        return res.json({

          success: false,

          message:
            "O pagamento não está aprovado.",

          status:
            payment.status
        });
      }

      const amount =
        Number(
          payment.transaction_amount
        );

      const plan =
        Object.keys(plans).find(
          function(key) {

            return (
              Math.abs(
                plans[key].amount -
                amount
              ) < 0.01
            );
          }
        ) || "mensal";

      const selectedPlan =
        plans[plan];

      const approvedAt =
        payment.date_approved
          ? new Date(
              payment.date_approved
            )
          : new Date();

      const activeUntil =
        new Date(
          approvedAt.getTime() +
          selectedPlan.days *
            24 *
            60 *
            60 *
            1000
        );

      const email =
        normalizeEmail(
          payment.payer?.email
        );

      const existing =
        await pool.query(
          `
          SELECT id
          FROM payments

          WHERE payment_id = $1

          LIMIT 1
          `,
          [paymentId]
        );

      if (
        existing.rows.length > 0
      ) {

        await pool.query(
          `
          UPDATE payments

          SET
            email = $1,
            plan = $2,
            amount = $3,
            status = 'approved',
            approved_at = $4,
            active_until = $5

          WHERE payment_id = $6
          `,
          [
            email,
            plan,
            amount,
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
            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,$11
          )
          `,
          [
            paymentId,

            payment.external_reference ||
              null,

            payment.payer?.first_name ||
              "",

            "",

            email,

            plan,

            amount,

            "approved",

            payment.date_created
              ? new Date(
                  payment.date_created
                )
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

        paymentId,

        status:
          payment.status,

        plan,

        amount,

        email,

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

        message:
          "Erro ao recuperar pagamento.",

        error:
          error.message
      });
    }
  }
);

/* ==================================================
   DIAGNÓSTICO
================================================== */

app.get(
  "/api/payment-diagnose",
  async (req, res) => {

    try {

      const dbResult =
        await pool.query(
          `
          SELECT *
          FROM payments

          ORDER BY id DESC

          LIMIT 20
          `
        );

      let payments = [];

      try {

        const mpResponse =
          await mercadoPagoRequest(
            "https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc"
          );

        if (
          mpResponse.ok &&
          mpResponse.data?.results
        ) {

          payments =
            mpResponse.data.results.map(
              function(payment) {

                return {

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
                    payment.payer?.email ||
                    null,

                  externalReference:
                    payment.external_reference,

                  paymentMethod:
                    payment.payment_method_id
                };
              }
            );
        }

      } catch (error) {

        console.error(
          "ERRO DIAGNOSTICO MP:",
          error
        );
      }

      return res.json({

        success: true,

        total:
          dbResult.rows.length,

        databasePayment:
          dbResult.rows[0] ||
          null,

        databasePayments:
          dbResult.rows,

        payments
      });

    } catch (error) {

      console.error(
        "ERRO PAYMENT DIAGNOSE:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);

/* ==================================================
   MERCADO PAGO PAYMENTS
================================================== */

app.get(
  "/api/mercadopago-payments",
  async (req, res) => {

    try {

      const mpResponse =
        await mercadoPagoRequest(
          "https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc"
        );

      if (!mpResponse.ok) {

        return res.status(
          mpResponse.status
        ).json({

          success: false,

          error:
            mpResponse.data
        });
      }

      const results =
        mpResponse.data?.results ||
        [];

      const payments =
        results.map(
          function(payment) {

            return {

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
                payment.payer?.email ||
                null,

              externalReference:
                payment.external_reference,

              paymentMethod:
                payment.payment_method_id
            };
          }
        );

      return res.json({

        success: true,

        total:
          payments.length,

        payments
      });

    } catch (error) {

      console.error(
        "ERRO MP PAYMENTS:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);

/* ==================================================
   TESTE MERCADO PAGO
================================================== */

app.get(
  "/api/mercadopago-test",
  async (req, res) => {

    try {

      const mpResponse =
        await mercadoPagoRequest(
          "https://api.mercadopago.com/v1/payment_methods"
        );

      return res.status(
        mpResponse.ok
          ? 200
          : mpResponse.status
      ).json({

        success:
          mpResponse.ok,

        httpStatus:
          mpResponse.status,

        message:
          mpResponse.ok
            ? "Token aceito pelo Mercado Pago."
            : "Token recusado pelo Mercado Pago.",

        paymentMethods:
          Array.isArray(
            mpResponse.data
          )
            ? mpResponse.data.length
            : 0,

        error:
          mpResponse.ok
            ? undefined
            : mpResponse.data
      });

    } catch (error) {

      console.error(
        "ERRO TESTE MP:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Erro ao testar Mercado Pago.",

        error:
          error.message
      });
    }
  }
);

/* ==================================================
   CONFIG TEST
================================================== */

app.get(
  "/api/config-test",
  async (req, res) => {

    return res.json({

      server:
        "online",

      mercadoPagoTokenConfigured:
        Boolean(
          MERCADO_PAGO_ACCESS_TOKEN
        ),

      mercadoPagoTokenPrefix:
        MERCADO_PAGO_ACCESS_TOKEN
          ? MERCADO_PAGO_ACCESS_TOKEN.substring(
              0,
              8
            )
          : null,

      mercadoPagoTokenLength:
        MERCADO_PAGO_ACCESS_TOKEN
          ? MERCADO_PAGO_ACCESS_TOKEN.length
          : 0,

      pixEnabled:
        PIX_ENABLED,

      baseUrlConfigured:
        Boolean(BASE_URL),

      telegramConfigured:
        Boolean(
          TELEGRAM_INVITE_URL
        ),

      databaseConfigured:
        Boolean(DATABASE_URL),

      message:
        "Configuração carregada com sucesso."
    });
  }
);

/* ==================================================
   HEALTH
================================================== */

app.get(
  "/api/health",
  async (req, res) => {

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

      console.error(
        "HEALTH DATABASE ERROR:",
        error
      );

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
  }
);

/* ==================================================
   INICIAR
================================================== */

async function startServer() {

  try {

    await initDatabase();

    app.listen(
      PORT,
      function() {

        console.log(
          "Servidor online na porta " +
          PORT
        );

        console.log(
          "BASE_URL: " +
          BASE_URL
        );

        console.log(
          "PIX_ENABLED: " +
          PIX_ENABLED
        );

        console.log(
          "MERCADO PAGO CONFIGURADO: " +
          Boolean(
            MERCADO_PAGO_ACCESS_TOKEN
          )
        );

        console.log(
          "TELEGRAM CONFIGURADO: " +
          Boolean(
            TELEGRAM_INVITE_URL
          )
        );

        console.log(
          "DATABASE CONFIGURADO: " +
          Boolean(
            DATABASE_URL
          )
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
