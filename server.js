app.get("/api/access", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();

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
        AND status = 'approved'
        AND active_until > NOW()
      ORDER BY active_until DESC
      LIMIT 1
      `,
      [email]
    );

    console.log("PAGAMENTOS ENCONTRADOS:", result.rows.length);

    if (result.rows.length > 0) {
      const payment = result.rows[0];

      return res.json({
        success: true,
        active: true,
        plan: payment.plan,
        amount: Number(payment.amount),
        activeUntil: payment.active_until,
        telegram: process.env.TELEGRAM_INVITE_URL || null,
        message: "Assinatura ativa."
      });
    }

    return res.json({
      success: true,
      active: false,
      message: "Nenhuma assinatura ativa encontrada."
    });

  } catch (error) {
    console.error("ERRO AO VERIFICAR ACESSO:", error);

    return res.status(500).json({
      success: false,
      active: false,
      message: "Erro ao verificar assinatura."
    });
  }
});
