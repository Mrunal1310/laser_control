// server.js – MQTT Bridge for ESP32
'use strict';

const express   = require('express');
const WebSocket = require('ws');
const http      = require('http');
const cors      = require('cors');
const mqtt      = require('mqtt');

// ─── Environment ─────────────────────────────────────────────
const PORT             = process.env.PORT              || 10000;
const WATCHDOG_MS      = parseInt(process.env.WATCHDOG_MS     || '60000');
const MAX_QUEUE_SIZE   = parseInt(process.env.MAX_QUEUE_SIZE   || '50');
const SELF_URL         = process.env.RENDER_EXTERNAL_URL || '';

// ─── App + Server ──────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Shared State ──────────────────────────────────────────
const state = {
    esp32Online   : false,
    hmiConnected  : false,
    lastSeenMs    : 0,
    lastCommandId : 0,
    deviceInfo    : {},
};
const frontendClients = new Set();   // WebSocket connections

// ─── Utilities ──────────────────────────────────────────────
const ts  = () => new Date().toISOString();
const log = (tag, msg, extra) => {
    const line = `[${ts()}] [${tag}] ${msg}`;
    extra !== undefined ? console.log(line, extra) : console.log(line);
};

function broadcastStatus() {
    const payload = JSON.stringify({
        esp32_connected : state.esp32Online,
        hmi_connected   : state.hmiConnected,
        message         : state.esp32Online
                            ? (state.hmiConnected ? 'HMI connected' : 'ESP32 online')
                            : 'ESP32 offline',
        last_ping       : ts(),
        device_info     : state.deviceInfo,
    });
    for (const ws of frontendClients) {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(payload); } catch { /* ignore */ }
        }
    }
}

function markEsp32Seen() {
    state.esp32Online = true;
    state.lastSeenMs  = Date.now();
}

// ─── Middleware ─────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '16kb' }));

// ─── Watchdog ──────────────────────────────────────────────
setInterval(() => {
    if (state.esp32Online && Date.now() - state.lastSeenMs > WATCHDOG_MS) {
        log('WATCHDOG', 'ESP32 timed out — marking offline');
        state.esp32Online  = false;
        state.hmiConnected = false;
        broadcastStatus();
    }
}, 10_000);

// ─── Keep‑alive for Render free tier ───────────────────────
if (SELF_URL) {
    setInterval(() => {
        require('https').get(`${SELF_URL}/health`, res =>
            log('KEEPALIVE', `Self-ping → ${res.statusCode}`)
        ).on('error', err =>
            log('KEEPALIVE', `Self-ping failed: ${err.message}`)
        );
    }, 10 * 60 * 1000);
}

// =========================================================================
//  MQTT Bridge (public broker, port 1883)
// =========================================================================
const mqttClient = mqtt.connect('mqtt://broker.emqx.io:1883');

mqttClient.on('connect', () => {
    log('MQTT', 'Connected to broker');
    mqttClient.subscribe('status/esp32_001');
});
mqttClient.on('message', (topic, msg) => {
    if (topic === 'status/esp32_001') {
        const data = msg.toString();
        log('MQTT', 'ESP32 status:', data);
        // Update local state if needed
        try {
            const json = JSON.parse(data);
            if (json.online !== undefined) {
                markEsp32Seen();
                if (json.hmiConnected !== undefined) state.hmiConnected = json.hmiConnected;
                if (json.info) state.deviceInfo = json.info;
                broadcastStatus();
            } else {
                // Just forward to frontend as is
                broadcastStatus(); // but status already being sent? We'll broadcast separately
                // Actually we should broadcast this specific status to the frontend
                for (const ws of frontendClients) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(data);
                }
            }
        } catch (e) {
            // not JSON or malformed – still forward raw
            for (const ws of frontendClients) {
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
            }
        }
    }
});

// Helper to publish command to MQTT
function publishCommand(cmdObj) {
    mqttClient.publish('command/esp32_001', JSON.stringify(cmdObj));
    log('MQTT', `Command published: ${JSON.stringify(cmdObj)}`);
}

// =========================================================================
//  Frontend API – unchanged (but now forward to MQTT instead of queue)
// =========================================================================
app.post('/start', (req, res) => {
    const cmd = { cmd: 'START', request_id: String(++state.lastCommandId) };
    publishCommand(cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/stop', (req, res) => {
    const cmd = { cmd: 'STOP', request_id: String(++state.lastCommandId) };
    publishCommand(cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/connect', (req, res) => {
    const { hmi_ip, hmi_port } = req.body || {};
    if (!hmi_ip || typeof hmi_ip !== 'string' || !hmi_ip.trim())
        return res.status(400).json({ success: false, message: 'hmi_ip required' });
    const port = parseInt(hmi_port, 10);
    if (isNaN(port) || port < 1 || port > 65535)
        return res.status(400).json({ success: false, message: 'hmi_port must be 1–65535' });
    const cmd = { cmd: 'CONNECT', hmi_ip: hmi_ip.trim(), hmi_port: port,
                  request_id: String(++state.lastCommandId) };
    publishCommand(cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/disconnect', (req, res) => {
    const cmd = { cmd: 'DISCONNECT', request_id: String(++state.lastCommandId) };
    publishCommand(cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/send', (req, res) => {
    const { data } = req.body || {};
    if (!data || typeof data !== 'string' || !data.trim())
        return res.status(400).json({ success: false, message: 'data (string) required' });
    if (data.length > 512)
        return res.status(400).json({ success: false, message: 'data too long (max 512 chars)' });
    const cmd = { cmd: 'SEND', data: data.trim(), request_id: String(++state.lastCommandId) };
    publishCommand(cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

// Info endpoints (unchanged)
app.get('/status', (req, res) => res.json({
    esp32_connected : state.esp32Online,
    hmi_connected   : state.hmiConnected,
    device_info     : state.deviceInfo,
    last_ping       : ts(),
    uptime_s        : Math.floor(process.uptime()),
}));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.json({ name: 'Remote HMI Backend', version: '3.0-mqtt' }));

// =========================================================================
//  WebSocket for frontend (unchanged)
// =========================================================================
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    log('WS', `Frontend connected from ${ip}`);
    frontendClients.add(ws);
    try {
        ws.send(JSON.stringify({
            esp32_connected : state.esp32Online,
            hmi_connected   : state.hmiConnected,
            message         : state.esp32Online ? (state.hmiConnected ? 'HMI connected' : 'ESP32 online') : 'ESP32 offline',
            last_ping       : ts(),
            device_info     : state.deviceInfo,
        }));
    } catch { /* ignore */ }
    ws.on('close', () => frontendClients.delete(ws));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    log('SERVER', `Listening on port ${PORT}`);
    log('SERVER', `Watchdog ${WATCHDOG_MS / 1000}s | Keep-alive: ${SELF_URL || 'disabled'}`);
});