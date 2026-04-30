'use strict';

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const admin = require('firebase-admin');

// ========== Firebase Admin SDK – load from environment variable (safe) ==========
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // On Render: we set this environment variable with the minified JSON
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    // Local development: fallback to a local file (ignored by Git)
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
        console.error('Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT env var or add serviceAccountKey.json');
        process.exit(1);
    }
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://laser-control-default-rtdb.firebaseio.com"
});
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ========== Shared state (mirrored from Firebase) ==========
let esp32Online = false;
let hmiConnected = false;
let deviceInfo = {};

// Listen to ESP32 status updates
const statusRef = db.ref('status/esp32_001');
statusRef.on('value', (snapshot) => {
    const data = snapshot.val();
    if (data) {
        esp32Online = data.online === true;
        hmiConnected = data.hmiConnected === true;
        deviceInfo = data.info || {};
        broadcastToFrontend();
    }
});

// ========== WebSocket Server for frontend ==========
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const frontendClients = new Set();

function broadcastToFrontend() {
    const payload = JSON.stringify({
        esp32_connected: esp32Online,
        hmi_connected: hmiConnected,
        message: esp32Online ? (hmiConnected ? "HMI connected" : "ESP32 online") : "ESP32 offline",
        last_ping: new Date().toISOString(),
        device_info: deviceInfo
    });
    for (const ws of frontendClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
}

wss.on('connection', (ws) => {
    frontendClients.add(ws);
    broadcastToFrontend();
    ws.on('close', () => frontendClients.delete(ws));
});

// ========== Helper: Write command to Firebase ==========
async function pushCommand(cmdObj) {
    const ref = db.ref('commands/esp32_001');
    await ref.push(cmdObj);
}

// ========== HTTP endpoints for frontend ==========
app.post('/start', async (req, res) => {
    await pushCommand({ cmd: 'START', request_id: Date.now().toString() });
    res.json({ success: true });
});
app.post('/stop', async (req, res) => {
    await pushCommand({ cmd: 'STOP', request_id: Date.now().toString() });
    res.json({ success: true });
});
app.post('/connect', async (req, res) => {
    const { hmi_ip, hmi_port } = req.body;
    await pushCommand({ cmd: 'CONNECT', hmi_ip, hmi_port, request_id: Date.now().toString() });
    res.json({ success: true });
});
app.post('/disconnect', async (req, res) => {
    await pushCommand({ cmd: 'DISCONNECT', request_id: Date.now().toString() });
    res.json({ success: true });
});
app.post('/send', async (req, res) => {
    const { data } = req.body;
    await pushCommand({ cmd: 'SEND', data, request_id: Date.now().toString() });
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    res.json({ esp32_connected: esp32Online, hmi_connected: hmiConnected });
});
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.json({ name: 'Remote HMI Backend', version: '2.0-firebase' }));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}`);
    console.log('Firebase Admin SDK initialized');
});