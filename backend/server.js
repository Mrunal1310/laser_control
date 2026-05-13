require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const mqtt = require('mqtt');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const DEVICE_ID = process.env.DEVICE_ID || 'device01';

const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const TOPIC_CMD = `laser/${DEVICE_ID}/cmd`;
const TOPIC_ACK = `laser/${DEVICE_ID}/ack`;
const TOPIC_STATUS = `laser/${DEVICE_ID}/status`;

let latestStatus = {
  deviceId: DEVICE_ID,
  state: 'UNKNOWN',
  info: 'No status yet',
  ts: new Date().toISOString()
};

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  wsClients.add(ws);

  ws.send(JSON.stringify({
    type: 'server_info',
    mqttConnected: mqttClient.connected,
    deviceId: DEVICE_ID,
    latestStatus
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('WebSocket client disconnected');
  });
});

console.log('MQTT config:', {
  MQTT_HOST,
  MQTT_PORT,
  MQTT_USERNAME
});

const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  reconnectPeriod: 5000,
  clean: true,
  connectTimeout: 30000
});

mqttClient.on('connect', () => {
  console.log('MQTT connected');

  mqttClient.subscribe([TOPIC_ACK, TOPIC_STATUS], { qos: 1 }, (err) => {
    if (err) {
      console.error('Subscribe error:', err.message);
      return;
    }
    console.log(`Subscribed: ${TOPIC_ACK} ${TOPIC_STATUS}`);
  });

  broadcast({
    type: 'mqtt_connection',
    connected: true,
    ts: new Date().toISOString()
  });
});

mqttClient.on('reconnect', () => {
  console.log('MQTT reconnecting...');
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

mqttClient.on('close', () => {
  console.log('MQTT disconnected');
  broadcast({
    type: 'mqtt_connection',
    connected: false,
    ts: new Date().toISOString()
  });
});

mqttClient.on('message', (topic, message) => {
  const text = message.toString();
  console.log('MQTT IN =>', topic, text);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    payload = { raw: text };
  }

  if (topic === TOPIC_STATUS) {
    latestStatus = {
      ...payload,
      ts: payload.ts || new Date().toISOString()
    };
  }

  broadcast({
    type: 'mqtt_message',
    topic,
    payload
  });
});

function buildCommand(action, params = {}) {
  return {
    cmdId: `${Date.now()}`,
    deviceId: DEVICE_ID,
    action,
    params,
    ts: new Date().toISOString()
  };
}

function publishCommand(command, res) {
  if (!mqttClient.connected) {
    return res.status(500).json({
      ok: false,
      error: 'MQTT not connected'
    });
  }

  mqttClient.publish(
    TOPIC_CMD,
    JSON.stringify(command),
    { qos: 1, retain: false },
    (err) => {
      if (err) {
        return res.status(500).json({
          ok: false,
          error: err.message
        });
      }

      console.log('MQTT OUT =>', TOPIC_CMD, JSON.stringify(command));

      res.json({
        ok: true,
        topic: TOPIC_CMD,
        command
      });
    }
  );
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'laser control backend',
    mqttConnected: mqttClient.connected,
    deviceId: DEVICE_ID,
    topics: {
      cmd: TOPIC_CMD,
      ack: TOPIC_ACK,
      status: TOPIC_STATUS
    },
    latestStatus
  });
});

app.get('/api/device/status', (req, res) => {
  res.json({
    ok: true,
    mqttConnected: mqttClient.connected,
    latestStatus
  });
});

app.post('/api/device/start-hmi', (req, res) => {
  publishCommand(buildCommand('start_hmi'), res);
});

app.post('/api/device/stop-hmi', (req, res) => {
  publishCommand(buildCommand('stop_hmi'), res);
});

app.post('/api/device/start-print', (req, res) => {
  const { jobName = 'default_job' } = req.body || {};
  publishCommand(buildCommand('start_print', { jobName }), res);
});

app.post('/api/device/stop-print', (req, res) => {
  publishCommand(buildCommand('stop_print'), res);
});

app.post('/api/device/show-message', (req, res) => {
  const { text = '' } = req.body || {};
  publishCommand(buildCommand('show_message', { text }), res);
});

app.post('/api/device/get-status', (req, res) => {
  publishCommand(buildCommand('get_status'), res);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});