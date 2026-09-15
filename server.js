import express from "express";

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("BAIANO TIPS ONLINE");
});

app.listen(PORT, () => {
  console.log(`Servidor online na porta ${PORT}`);
});
