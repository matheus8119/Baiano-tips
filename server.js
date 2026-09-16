import express from "express";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const MP_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;

const TELEGRAM_INVITE_URL =
  process.env.TELEGRAM_INVITE_URL ||
  "https://t.me/+1F0a440X9zg2MDgx";

const PLAN_DAYS = {
  mensal: 30,
  trimestral: 90,
  semestral: 180,
  anual: 365
};

const PLAN_PRICES = {
  mensal: 29.90,
  trimestral: 69.90,
  semestral: 119.90,
  anual: 199.90
};

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

async function ensureTable() {
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
}

/* =========================
   PÁGINA PRINCIPAL
========================= */

app.get("/", (req, res) => {

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1.0">

<title>Baiano Tips</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #080808;
  color: white;
}

.container {
  max-width: 500px;
  margin: auto;
  padding: 25px 18px 40px;
}

h1 {
  text-align: center;
  margin-bottom: 5px;
  font-size: 36px;
}

.subtitle {
  text-align: center;
  color: #aaa;
  margin-bottom: 25px;
}

.card {
  background: #151515;
  border: 1px solid #292929;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 18px;
}

.plan {
  border: 1px solid #333;
  border-radius: 12px;
  padding: 15px;
  margin-bottom: 10px;
  cursor: pointer;
}

.plan:hover {
  border-color: #00ff88;
}

.plan strong {
  display: block;
  font-size: 19px;
}

.plan span {
  display: block;
  color: #00ff88;
  font-size: 22px;
  font-weight: bold;
  margin-top: 5px;
}

input {
  width: 100%;
  padding: 14px;
  margin-top: 10px;
  border-radius: 8px;
  border: 1px solid #333;
  background: #0d0d0d;
  color: white;
  font-size: 16px;
}

button {
  width: 100%;
  padding: 15px;
  margin-top: 15px;
  border: 0;
  border-radius: 9px;
  background: #00d979;
  color: #000;
  font-size: 17px;
  font-weight: bold;
  cursor: pointer;
}

.result {
  margin-top: 15px;
  padding: 15px;
  border-radius: 10px;
  background: #101010;
  line-height: 1.5;
}

.qr {
  width: 100%;
  max-width: 300px;
  display: block;
  margin: 15px auto;
}

.pix {
  word-break: break-all;
  background: #080808;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
}

.success {
  color: #00ff88;
}

.error {
  color: #ff5555;
}

.telegram {
  display: block;
  text-decoration: none;
  text-align: center;
  background: #229ED9;
  color: white;
  padding: 15px;
  border-radius: 9px;
  margin-top: 15px;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="container">

<h1>BAIANO TIPS</h1>

<div class="subtitle">
Tips e Alavancagem
</div>

<div class="card">

<h2>Escolha seu plano</h2>

<div class="plan" onclick="selectPlan('mensal')">
<strong>Mensal</strong>
<span>R$ 29,90</span>
<small>30 dias</small>
</div>

<div class="plan" onclick="selectPlan('trimestral')">
<strong>Trimestral</strong>
<span>R$ 69,90</span>
<small>90 dias</small>
</div>

<div class="plan" onclick="selectPlan('semestral')">
<strong>Semestral</strong>
<span>R$ 119,90</span>
<small>180 dias</small>
</div>

<div class="plan" onclick="selectPlan('anual')">
<strong>Anual</strong>
<span>R$ 199,90</span>
<small>365 dias</small>
</div>

<input
id="name"
placeholder="Digite seu nome"
>

<input
id="cpf"
placeholder="Digite seu CPF"
>

<input
id="email"
type="email"
placeholder="Digite seu e-mail"
>

<button onclick="generatePix()">
GERAR PIX
</button>

<div id="pixResult"></div>

</div>

<div class="card">

<h2>Já sou assinante</h2>

<input
id="accessEmail"
type="email"
placeholder="Digite seu e-mail"
>

<button onclick="checkAccess()">
VERIFICAR ACESSO
</button>

<div id="accessResult"></div>

</div>

<div style="text-align:center;color:#777;font-size:12px;">
18+ | Aposte com responsabilidade.
</div>

</div>

<script>

let selectedPlan = "mensal";

function selectPlan(plan) {

  selectedPlan = plan;

  alert("Plano selecionado: " + plan);

}

async function generatePix() {

  const name =
    document.getElementById("name").value.trim();

  const cpf =
    document.getElementById("cpf").value.trim();

  const email =
    document.getElementById("email").value.trim();

  if (!name || !cpf || !email) {

    alert("Preencha nome, CPF e e-mail.");

    return;

  }

  document.getElementById("pixResult").innerHTML =
    "<div class='result'>Gerando PIX...</div>";

  try {

    const response = await fetch(
      "/api/create-payment",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          name,
          cpf,
          email,
          plan: selectedPlan
        })
      }
    );

    const data = await response.json();

    if (!data.success) {

      document.getElementById("pixResult").innerHTML =
        "<div class='result error'>" +
        (data.message || "Erro ao gerar PIX.") +
        "</div>";

      return;

    }

    document.getElementById("pixResult").innerHTML =

      "<div class='result'>" +

      "<h3>PIX gerado!</h3>" +

      "<img class='qr' src='data:image/png;base64," +
      data.qrCodeBase64 +
      "'>" +

      "<p>Copie o código PIX:</p>" +

      "<div class='pix'>" +
      data.qrCode +
      "</div>" +

      "<button onclick='copyPix()'>" +
      "COPIAR PIX" +
      "</button>" +

      "</div>";

    window.currentPix = data.qrCode;

  } catch (error) {

    console.error(error);

    document.getElementById("pixResult").innerHTML =
      "<div class='result error'>" +
      "Erro de conexão." +
      "</div>";

  }

}

function copyPix() {

  if (!window.currentPix) {
    return;
  }

  navigator.clipboard.writeText(window.currentPix);

  alert("PIX copiado!");

}

async function checkAccess() {

  const email =
    document.getElementById("accessEmail")
      .value
      .trim();

  if (!email) {

    alert("Digite seu e-mail.");

    return;

  }

  const result =
    document.getElementById("accessResult");

  result.innerHTML =
    "<div class='result'>Verificando...</div>";

  try {

    const response = await fetch(
      "/api/access?email=" +
      encodeURIComponent(email)
    );

    const data = await response.json();

    if (!data.success || !data.active) {

      result.innerHTML =
        "<div class='result error'>" +
        (data.message ||
        "Nenhuma assinatura ativa encontrada.") +
        "</div>";

      return;

    }

    result.innerHTML =

      "<div class='result'>" +

      "<div class='success'>" +
      "<strong>ASSINATURA ATIVA!</strong>" +
      "</div>" +

      "<p>Plano: " +
      (data.plan || "assinatura") +
      "</p>" +

      "<p>Válido até: " +
      new Date(data.activeUntil)
        .toLocaleDateString("pt-BR") +
      "</p>" +

      "<a class='telegram' href='" +
      data.telegram +
      "' target='_blank'>" +

      "ENTRAR NO TELEGRAM" +

      "</a>" +

      "</div>";

  } catch (error) {

    console.error(error);

    result.innerHTML =
      "<div class='result error'>" +
      "Erro ao verificar acesso." +
      "</div>";

  }

}

</script>

</body>

</html>
`;

  res.send(html);

});

/* =========================
   CRIAR PAGAMENTO
========================= */

app.post("/api/create-payment", async (req, res) => {

  try {

    const {
      name,
      cpf,
      email,
      plan
    } = req.body;

    if (!name || !cpf || !email || !plan) {

      return res.status(400).json({
        success: false,
        message: "Dados incompletos."
      });

    }

    if (!PLAN_PRICES[plan]) {

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

    const externalReference =
      "BAIANOTIPS-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(16)
        .slice(2, 10)
        .toUpperCase();

    const paymentData = {

      transaction_amount:
        PLAN_PRICES[plan],

      description:
        "Baiano Tips - " +
        plan.charAt(0).toUpperCase() +
        plan.slice(1),

      payment_method_id: "pix",

      payer: {
        email: normalizeEmail(email),
        first_name: name
      },

      external_reference:
        externalReference

    };

    const response = await fetch(
      "https://api.mercadopago.com/v1/payments",
      {
        method: "POST",

        headers: {
          "Authorization": "Bearer " + MP_TOKEN,
          "Content-Type": "application/json",
          "X-Idempotency-Key": externalReference
        },

        body: JSON.stringify(paymentData)
      }
    );

    const data = await response.json();

    if (!response.ok) {

      console.error(
        "ERRO MERCADO PAGO:",
        data
      );

      return res.status(400).json({
        success: false,
        message:
          data.message ||
          "Erro ao criar pagamento."
      });

    }

    const transactionData =
      data.point_of_interaction &&
      data.point_of_interaction.transaction_data;

    const qrCode =
      transactionData &&
      transactionData.qr_code;

    const qrCodeBase64 =
      transactionData &&
      transactionData.qr_code_base64;

    await pool.query(
      `
      INSERT INTO payments
      (
        payment_id,
        external_reference,
        name,
        cpf,
        email,
        plan,
        amount,
        status
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        String(data.id),
        externalReference,
        name,
        cpf,
        normalizeEmail(email),
        plan,
        PLAN_PRICES[plan],
        data.status || "pending"
      ]
    );

    return res.json({

      success: true,

      paymentId:
        String(data.id),

      qrCode,

      qrCodeBase64

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
 
/* =========================
   WEBHOOK MERCADO PAGO
========================= */

app.post("/api/mercadopago/webhook", async (req, res) => {

  res.sendStatus(200);

  try {

    const paymentId =
      req.body &&
      req.body.data &&
      req.body.data.id;

    if (!paymentId || !MP_TOKEN) {
      return;
    }

    const response = await fetch(
      "https://api.mercadopago.com/v1/payments/" +
      paymentId,
      {
        headers: {
          "Authorization":
            "Bearer " + MP_TOKEN
        }
      }
    );

    const payment = await response.json();

    if (!response.ok) {
      return;
    }

    if (payment.status !== "approved") {
      return;
    }

    const email =
      payment.payer &&
      payment.payer.email
        ? normalizeEmail(payment.payer.email)
        : "";

    const description =
      String(payment.description || "")
        .toLowerCase();

    let plan = "mensal";

    if (description.includes("trimestral")) {
      plan = "trimestral";
    } else if (description.includes("semestral")) {
      plan = "semestral";
    } else if (description.includes("anual")) {
      plan = "anual";
    }

    const approvedAt =
      payment.date_approved
        ? new Date(payment.date_approved)
        : new Date();

    const activeUntil =
      addDays(
        approvedAt,
        PLAN_DAYS[plan]
      );

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
          payment.transaction_amount,
          approvedAt,
          activeUntil,
          String(payment.id)
        ]
      );

    } else {

      await pool.query(
        `
        INSERT INTO payments
        (
          payment_id,
          external_reference,
          email,
          plan,
          amount,
          status,
          approved_at,
          active_until
        )
        VALUES
        ($1,$2,$3,$4,$5,'approved',$6,$7)
        `,
        [
          String(payment.id),
          payment.external_reference || "",
          email,
          plan,
          payment.transaction_amount,
          approvedAt,
          activeUntil
        ]
      );

    }

    console.log(
      "PAGAMENTO APROVADO:",
      payment.id
    );

  } catch (error) {

    console.error(
      "ERRO WEBHOOK:",
      error
    );

  }

});


/* =========================
   VERIFICAR ACESSO
========================= */

app.get("/api/access", async (req, res) => {

  try {

    const requestedEmail =
      normalizeEmail(req.query.email);

    console.log(
      "VERIFICANDO ASSINATURA:",
      requestedEmail
    );

    if (!requestedEmail) {

      return res.json({
        success: false,
        active: false,
        message: "Digite seu e-mail."
      });

    }


    /* 1 - BANCO LOCAL */

    const direct = await pool.query(
      `
      SELECT *
      FROM payments
      WHERE
        LOWER(TRIM(email)) = $1
        AND status = 'approved'
        AND active_until > NOW()
      ORDER BY active_until DESC
      LIMIT 1
      `,
      [requestedEmail]
    );


    if (direct.rows.length > 0) {

      const payment =
        direct.rows[0];

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
          TELEGRAM_INVITE_URL

      });

    }


    /* 2 - CONFERIR PAGAMENTOS EXISTENTES
          DIRETAMENTE NO MERCADO PAGO */

    const approved =
      await pool.query(
        `
        SELECT *
        FROM payments
        WHERE
          status = 'approved'
          AND active_until > NOW()
        ORDER BY active_until DESC
        `
      );


    for (const payment of approved.rows) {

      if (!payment.payment_id) {
        continue;
      }

      try {

        const mpResponse =
          await fetch(
            "https://api.mercadopago.com/v1/payments/" +
            payment.payment_id,
            {
              headers: {
                "Authorization":
                  "Bearer " + MP_TOKEN
              }
            }
          );


        if (!mpResponse.ok) {
          continue;
        }


        const mpPayment =
          await mpResponse.json();


        const mpEmail =
          mpPayment.payer &&
          mpPayment.payer.email
            ? normalizeEmail(
                mpPayment.payer.email
              )
            : "";


        if (
          mpEmail &&
          mpEmail === requestedEmail
        ) {

          await pool.query(
            `
            UPDATE payments
            SET email = $1
            WHERE payment_id = $2
            `,
            [
              requestedEmail,
              String(payment.payment_id)
            ]
          );


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
              TELEGRAM_INVITE_URL

          });

        }

      } catch (error) {

        console.error(
          "ERRO CONSULTANDO PAGAMENTO:",
          error.message
        );

      }

    }


    /* 3 - BUSCAR DIRETO NO MERCADO PAGO */

    try {

      const searchUrl =
        "https://api.mercadopago.com/v1/payments/search" +
        "?sort=date_created" +
        "&criteria=desc" +
        "&limit=100";


      const mpResponse =
        await fetch(
          searchUrl,
          {
            headers: {
              "Authorization":
                "Bearer " + MP_TOKEN
            }
          }
        );


      if (mpResponse.ok) {

        const mpData =
          await mpResponse.json();

        const results =
          mpData.results || [];


        for (const payment of results) {

          if (
            payment.status !==
            "approved"
          ) {
            continue;
          }


          const mpEmail =
            payment.payer &&
            payment.payer.email
              ? normalizeEmail(
                  payment.payer.email
                )
              : "";


          if (
            !mpEmail ||
            mpEmail !== requestedEmail
          ) {
            continue;
          }


          const description =
            String(
              payment.description || ""
            ).toLowerCase();


          let plan = "mensal";


          if (
            description.includes(
              "trimestral"
            )
          ) {

            plan = "trimestral";

          } else if (
            description.includes(
              "semestral"
            )
          ) {

            plan = "semestral";

          } else if (
            description.includes(
              "anual"
            )
          ) {

            plan = "anual";

          }


          const approvedAt =
            payment.date_approved
              ? new Date(
                  payment.date_approved
                )
              : new Date();


          const activeUntil =
            addDays(
              approvedAt,
              PLAN_DAYS[plan]
            );


          const existingPayment =
            await pool.query(
              `
              SELECT id
              FROM payments
              WHERE payment_id = $1
              LIMIT 1
              `,
              [String(payment.id)]
            );


          if (
            existingPayment.rows.length > 0
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
                requestedEmail,
                plan,
                payment.transaction_amount,
                approvedAt,
                activeUntil,
                String(payment.id)
              ]
            );

          } else {

            await pool.query(
              `
              INSERT INTO payments
              (
                payment_id,
                external_reference,
                email,
                plan,
                amount,
                status,
                approved_at,
                active_until
              )
              VALUES
              (
                $1,$2,$3,$4,$5,
                'approved',
                $6,$7
              )
              `,
              [
                String(payment.id),
                payment.external_reference || "",
                requestedEmail,
                plan,
                payment.transaction_amount,
                approvedAt,
                activeUntil
              ]
            );

          }


          if (
            activeUntil > new Date()
          ) {

            return res.json({

              success: true,

              active: true,

              plan,

              amount:
                Number(
                  payment.transaction_amount
                ),

              activeUntil,

              telegram:
                TELEGRAM_INVITE_URL

            });

          }

        }

      }

    } catch (error) {

      console.error(
        "ERRO BUSCA MERCADO PAGO:",
        error.message
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
      "ERRO ACCESS:",
      error
    );


    return res.status(500).json({

      success: false,

      active: false,

      message:
        "Erro interno ao verificar acesso."

    });

  }

});


/* =========================
   DEBUG ACCESS
========================= */

app.get("/api/debug-access", async (req, res) => {

  try {

    const email =
      normalizeEmail(req.query.email);


    const result =
      await pool.query(
        `
        SELECT
          id,
          email,
          status,
          active_until,
          NOW() AS agora,
          (
            active_until > NOW()
          ) AS data_valida
        FROM payments
        `
      );


    return res.json({

      success: true,

      email_recebido:
        email,

      quantidade_registros:
        result.rows.length,

      registros:
        result.rows.map(row => ({

          id:
            row.id,

          email:
            row.email,

          email_normalizado:
            normalizeEmail(row.email),

          status:
            row.status,

          active_until:
            row.active_until,

          agora:
            row.agora,

          data_valida:
            row.data_valida

        }))

    });


  } catch (error) {

    return res.status(500).json({

      success: false,

      error:
        error.message

    });

  }

});


/* =========================
   RECUPERAR PAGAMENTO
========================= */

app.get(
  "/api/recover-payment-by-id",
  async (req, res) => {

    try {

      const id =
        req.query.id;


      if (!id) {

        return res.json({

          success: false,

          message:
            "Informe o ID do pagamento."

        });

      }


      if (!MP_TOKEN) {

        return res.status(500).json({

          success: false,

          message:
            "Mercado Pago não configurado."

        });

      }


      const response =
        await fetch(
          "https://api.mercadopago.com/v1/payments/" +
          id,
          {
            headers: {
              "Authorization":
                "Bearer " + MP_TOKEN
            }
          }
        );


      const payment =
        await response.json();


      if (!response.ok) {

        return res.status(400).json({

          success: false,

          message:
            "Pagamento não encontrado."

        });

      }


      if (
        payment.status !==
        "approved"
      ) {

        return res.json({

          success: false,

          message:
            "Pagamento ainda não está aprovado.",

          status:
            payment.status

        });

      }


      const email =
        payment.payer &&
        payment.payer.email
          ? normalizeEmail(
              payment.payer.email
            )
          : "";


      const description =
        String(
          payment.description || ""
        ).toLowerCase();


      let plan = "mensal";


      if (
        description.includes(
          "trimestral"
        )
      ) {

        plan = "trimestral";

      } else if (
        description.includes(
          "semestral"
        )
      ) {

        plan = "semestral";

      } else if (
        description.includes(
          "anual"
        )
      ) {

        plan = "anual";

      }


      const approvedAt =
        payment.date_approved
          ? new Date(
              payment.date_approved
            )
          : new Date();


      const activeUntil =
        addDays(
          approvedAt,
          PLAN_DAYS[plan]
        );


      const existing =
        await pool.query(
          `
          SELECT id
          FROM payments
          WHERE payment_id = $1
          LIMIT 1
          `,
          [String(payment.id)]
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
            payment.transaction_amount,
            approvedAt,
            activeUntil,
            String(payment.id)
          ]
        );

      } else {

        await pool.query(
          `
          INSERT INTO payments
          (
            payment_id,
            external_reference,
            email,
            plan,
            amount,
            status,
            approved_at,
            active_until
          )
          VALUES
          (
            $1,$2,$3,$4,$5,
            'approved',
            $6,$7
          )
          `,
          [
            String(payment.id),
            payment.external_reference || "",
            email,
            plan,
            payment.transaction_amount,
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

        paymentId:
          String(payment.id),

        status:
          payment.status,

        plan,

        amount:
          payment.transaction_amount,

        email,

        activeUntil,

        telegram:
          TELEGRAM_INVITE_URL

      });


    } catch (error) {

      console.error(
        "ERRO RECUPERANDO PAGAMENTO:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Erro interno ao recuperar pagamento."

      });

    }

  }
);


/* =========================
   LISTAR PAGAMENTOS
========================= */

app.get(
  "/api/mercadopago-payments",
  async (req, res) => {

    try {

      if (!MP_TOKEN) {

        return res.status(500).json({

          success: false,

          message:
            "Mercado Pago não configurado."

        });

      }


      const response =
        await fetch(
          "https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=20",
          {
            headers: {
              "Authorization":
                "Bearer " + MP_TOKEN
            }
          }
        );


      const data =
        await response.json();


      if (!response.ok) {

        return res.status(400).json({

          success: false,

          message:
            "Erro ao consultar pagamentos."

        });

      }


      const payments =
        (data.results || []).map(
          payment => ({

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
              payment.payer &&
              payment.payer.email
                ? payment.payer.email
                : null,

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

      console.error(
        "ERRO LISTANDO PAGAMENTOS:",
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


/* =========================
   TESTE MERCADO PAGO
========================= */

app.get(
  "/api/mercadopago-test",
  async (req, res) => {

    try {

      if (!MP_TOKEN) {

        return res.json({

          success: false,

          message:
            "Token não configurado."

        });

      }


      const response =
        await fetch(
          "https://api.mercadopago.com/v1/payment_methods",
          {
            headers: {
              "Authorization":
                "Bearer " + MP_TOKEN
            }
          }
        );


      const data =
        await response.json();


      if (!response.ok) {

        return res.status(
          response.status
        ).json({

          success: false,

          httpStatus:
            response.status,

          message:
            data.message ||
            "Token recusado."

        });

      }


      return res.json({

        success: true,

        httpStatus:
          response.status,

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

        message:
          error.message

      });

    }

  }
);


/* =========================
   CONFIG TEST
========================= */

app.get(
  "/api/config-test",
  (req, res) => {

    const token =
      process.env.MERCADOPAGO_ACCESS_TOKEN ||
      "";

    return res.json({

      server:
        "online",

      mercadoPagoTokenConfigured:
        Boolean(token),

      mercadoPagoTokenPrefix:
        token
          ? token.substring(0, 7)
          : "",

      mercadoPagoTokenLength:
        token.length,

      pixEnabled:
        process.env.PIX_ENABLED === "true",

      baseUrlConfigured:
        Boolean(process.env.BASE_URL),

      telegramConfigured:
        Boolean(
          process.env.TELEGRAM_INVITE_URL
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


/* =========================
   DIAGNÓSTICO PAGAMENTO
========================= */

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
          LIMIT 20
          `
        );


      return res.json({

        success: true,

        total:
          result.rows.length,

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


/* =========================
   HEALTH CHECK
========================= */

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


/* =========================
   INICIAR SERVIDOR
========================= */

async function startServer() {

  try {

    await ensureTable();

    app.listen(
      PORT,
      () => {

        console.log(
          "Servidor online na porta " +
          PORT
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
