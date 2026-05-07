const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// HiveMQ Cloud TLS Broker
// ===============================
const MQTT_HOST = "c1e68200354e42858661c5180464a682.s1.eu.hivemq.cloud";
const MQTT_PORT = 8883;

const MQTT_USERNAME = "esp32";
const MQTT_PASSWORD = "Esp32@123";

// Topics
const TOPIC_UI_TO_ESP32 = "laser/ui/to/esp32";
const TOPIC_ESP32_TO_UI = "laser/esp32/to/ui";

// store latest ESP32 msg
let latestFromEsp32 = "No message yet";

// ===============================
// MQTT TLS CONNECT
// ===============================
const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  rejectUnauthorized: true,
  keepalive: 60,
  reconnectPeriod: 5000
});

client.on("connect", () => {
  console.log("MQTT TLS Connected");

  client.subscribe(TOPIC_ESP32_TO_UI, (err) => {
    if (err) {
      console.log("Subscribe error:", err);
    } else {
      console.log("Subscribed:", TOPIC_ESP32_TO_UI);
    }
  });
});

client.on("error", (err) => {
  console.log("MQTT ERROR:", err);
});

client.on("message", (topic, message) => {
  const msg = message.toString();
  console.log("MQTT RX:", topic, msg);

  if (topic === TOPIC_ESP32_TO_UI) {
    latestFromEsp32 = msg;
  }
});

// ===============================
// API ROUTES
// ===============================

// UI -> Render -> MQTT -> ESP32
app.post("/send", (req, res) => {
  const message = req.body.message;

  if (!message) {
    return res.status(400).json({ status: "Missing message" });
  }

  client.publish(TOPIC_UI_TO_ESP32, message);

  res.json({ status: "Sent to ESP32 via MQTT TLS" });
});

// UI reads latest message from ESP32
app.get("/esp32msg", (req, res) => {
  res.json({ message: latestFromEsp32 });
});

app.get("/", (req, res) => {
  res.send("MQTT TLS Server Running OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});