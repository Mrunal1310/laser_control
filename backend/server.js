const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

let uiToEsp32 = "No Message";
let esp32ToUi = "No Message";

// UI sends message to ESP32
app.post("/send", (req, res) => {

  if (!req.body.message) {
    return res.status(400).json({ status: "Missing message" });
  }

  uiToEsp32 = req.body.message;
  console.log("UI -> ESP32:", uiToEsp32);

  res.json({ status: "Message Stored For ESP32" });
});

// ESP32 reads message from UI
app.get("/message", (req, res) => {

  res.json({
    message: uiToEsp32
  });
});

// ESP32 sends message to UI
app.post("/sendFromEsp32", (req, res) => {

  if (!req.body.message) {
    return res.status(400).json({ status: "Missing message" });
  }

  esp32ToUi = req.body.message;
  console.log("ESP32 -> UI:", esp32ToUi);

  res.json({ status: "ESP32 Message Stored" });
});

// UI reads ESP32 message
app.get("/esp32msg", (req, res) => {

  res.json({
    message: esp32ToUi
  });
});

app.get("/", (req, res) => {
  res.send("Server Running OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server Running On Port", PORT);
});