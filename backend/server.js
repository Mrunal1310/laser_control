const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const crypto = require("crypto");
const http = require("http");
const WebSocket = require("ws");

const requiredEnv = ["MQTT_HOST", "MQTT_PORT", "MQTT_USERNAME", "MQTT_PASSWORD"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = Number(process.env.MQTT_PORT);
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const DEVICE_ID = "device01";
const TOPIC_CMD = `laser/${DEVICE_ID}/cmd`;
const TOPIC_ACK = `laser/${DEVICE_ID}/ack`;
const TOPIC_STATUS = `laser/${DEVICE_ID}/status`;

let latestStatus = {
  deviceId: DEVICE_ID,
  state: "OFFLINE",
  info: "No status yet",
  ts: new Date().toISOString()
};

let latestAck = {
  deviceId: DEVICE_ID,
  info: "No ack yet",
  ts: new Date().toISOString()
};

console.log("MQTT config:", {
  MQTT_HOST,
  MQTT_PORT,
  MQTT_USERNAME
});

const mqttClient = mqtt.connect({
  host: MQTT_HOST,
  port: MQTT_PORT,
  protocol: "mqtts",
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  keepalive: 60,
  reconnectPeriod: 5000,
  clean: true,
  rejectUnauthorized: true,
  clientId: `render_gateway_${Math.random().toString(16).slice(2, 10)}`
});

mqttClient.on("connect", () => {
  console.log("MQTT connected");

  mqttClient.subscribe([TOPIC_ACK, TOPIC_STATUS], { qos: 1 }, (err) => {
    if (err) {
      console.error("MQTT subscribe error:", err.message);
    } else {
      console.log("Subscribed:", TOPIC_ACK, TOPIC_STATUS);
    }
  });
});

mqttClient.on("reconnect", () => {
  console.log("MQTT reconnecting...");
});

mqttClient.on("close", () => {
  console.log("MQTT closed");
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
    payload = {
      deviceId: DEVICE_ID,
      raw,
      ts: new Date().toISOString()
    };
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
  const data = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  ws.send(JSON.stringify({ type: "status", payload: latestStatus }));
  ws.send(JSON.stringify({ type: "ack", payload: latestAck }));

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

app.get("/", (req, res) => {
  res.send("Laser Control Backend Running");
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
    return res.status(404).json({ ok: false, error: "Unknown device" });
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
    return res.status(400).json({ ok: false, error: "Invalid action" });
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
      console.error("Publish failed:", err.message);
      return res.status(500).json({ ok: false, error: "MQTT publish failed" });
    }

    res.json({ ok: true, cmdId: cmd.cmdId, sent: cmd });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});