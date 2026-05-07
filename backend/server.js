const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");

const app = express();
app.use(cors());
app.use(express.json());

// ==============================
// HiveMQ Cloud TLS Config
// ==============================
const MQTT_HOST = "c1e68200354e42858661c5180464a682.s1.eu.hivemq.cloud";
const MQTT_PORT = 8883;

const MQTT_USERNAME = "esp32";
const MQTT_PASSWORD = "Esp32@123";

// Topics
const TOPIC_UI_TO_ESP32 = "laser/ui/to/esp32";
const TOPIC_ESP32_TO_UI = "laser/esp32/to/ui";

// Store latest message from ESP32
let latestFromEsp32 = "No message yet";

// ==============================
// MQTT Connect (TLS)
// ==============================
console.log("Connecting to HiveMQ TLS broker...");

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  keepalive: 60,
  reconnectPeriod: 5000,
  clean: true
});

client.on("connect", () => {
  console.log("MQTT Connected Successfully!");

  client.subscribe(TOPIC_ESP32_TO_UI, { qos: 0 }, (err) => {
    if (err) {
      console.log("MQTT Subscribe Error:", err);
    } else {
      console.log("Subscribed to:", TOPIC_ESP32_TO_UI);
    }
  });
});

client.on("reconnect", () => {
  console.log("MQTT reconnecting...");
});

client.on("error", (err) => {
  console.log("MQTT ERROR:", err.message);
});

client.on("close", () => {
  console.log("MQTT connection closed");
});

client.on("message", (topic, message) => {
  const msg = message.toString();
  console.log("MQTT RX:", topic, msg);

  if (topic === TOPIC_ESP32_TO_UI) {
    latestFromEsp32 = msg;
  }
});

// ==============================
// API Routes
// ==============================
app.get("/", (req, res) => {
  res.send("Render MQTT Gateway Running OK");
});

app.post("/send", (req, res) => {
  const message = req.body.message;

  if (!message) {
    return res.status(400).json({ status: "Message missing" });
  }

  console.log("UI -> MQTT:", message);

  client.publish(TOPIC_UI_TO_ESP32, message, { qos: 0 }, (err) => {
    if (err) {
      console.log("Publish error:", err);
      return res.status(500).json({ status: "MQTT publish failed" });
    }
    res.json({ status: "Message sent to ESP32 via MQTT" });
  });
});

app.get("/esp32msg", (req, res) => {
  res.json({ message: latestFromEsp32 });
});

// ==============================
// Start Server
// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port:", PORT);
});