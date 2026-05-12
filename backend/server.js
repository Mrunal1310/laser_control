const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = process.env.MQTT_PORT || 8883;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const PORT = process.env.PORT || 3000;

const DEVICE_ID = "device01";
const TOPIC_CMD = `laser/${DEVICE_ID}/cmd`;
const TOPIC_ACK = `laser/${DEVICE_ID}/ack`;
const TOPIC_STATUS = `laser/${DEVICE_ID}/status`;

let latestStatus = { state: "OFFLINE" };
let latestAck = { info: "No ack yet" };

const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  keepalive: 60,
  reconnectPeriod: 5000,
  clean: true,
  clientId: `render_gateway_${Math.random().toString(16).slice(2, 10)}`
});

mqttClient.on("connect", () => {
  console.log("MQTT connected");

  mqttClient.subscribe([TOPIC_ACK, TOPIC_STATUS], { qos: 1 }, (err) => {
    if (err) console.error("Subscribe error:", err);
    else console.log("Subscribed to ACK and STATUS topics");
  });
});

mqttClient.on("error", (err) => {
  console.error("MQTT error:", err.message);
});

mqttClient.on("message", (topic, message) => {
  const raw = message.toString();
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  if (topic === TOPIC_ACK) {
    latestAck = payload;
    broadcast({ type: "ack", payload });
  }

  if (topic === TOPIC_STATUS) {
    latestStatus = payload;
    broadcast({ type: "status", payload });
  }
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", payload: latestStatus }));
  ws.send(JSON.stringify({ type: "ack", payload: latestAck }));
});

app.get("/", (req, res) => {
  res.send("Laser MQTT gateway running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mqttConnected: mqttClient.connected,
    latestStatus,
    latestAck
  });
});

app.post("/api/device/:id/command", (req, res) => {
  const { id } = req.params;
  const { action, params } = req.body;

  if (id !== DEVICE_ID) {
    return res.status(404).json({ error: "Unknown device" });
  }

  const allowedActions = [
    "start_hmi",
    "stop_hmi",
    "show_message",
    "start_print",
    "stop_print",
    "get_status"
  ];

  if (!allowedActions.includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  const cmd = {
    cmdId: crypto.randomUUID(),
    deviceId: id,
    action,
    params: params || {},
    ts: new Date().toISOString()
  };

  mqttClient.publish(TOPIC_CMD, JSON.stringify(cmd), { qos: 1 }, (err) => {
    if (err) {
      console.error("Publish failed:", err);
      return res.status(500).json({ error: "MQTT publish failed" });
    }

    res.json({ ok: true, cmdId: cmd.cmdId });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});