const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;

// CORS first
app.use(cors({ origin: '*' }));
app.use(express.json());

// ========== FIX: Prevent HTTPS redirect for ESP32 endpoints ==========
app.use((req, res, next) => {
    if (req.path.startsWith('/poll') || req.path.startsWith('/update')) {
        // Tell Express that the request is already HTTPS? No – we want to keep it HTTP.
        // Render sets x-forwarded-proto; we override to 'http' to avoid 301 redirect.
        req.headers['x-forwarded-proto'] = 'http';
    }
    next();
});

// ==================== Configuration ====================
let esp32Online = false;
let hmiConnected = false;
let lastCommandId = 0;
let lastSeenMs = 0;
const commandQueue = [];
const frontendClients = new Set();

function broadcastStatus() {
    const status = {
        esp32_connected: esp32Online,
        hmi_connected: hmiConnected,
        message: esp32Online ? (hmiConnected ? "HMI connected" : "ESP32 online") : "ESP32 offline",
        last_ping: new Date().toISOString(),
        command_pending: commandQueue.length > 0
    };
    const msg = JSON.stringify(status);
    for (const ws of frontendClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

// Watchdog – mark ESP32 offline after 60 seconds no heartbeat
setInterval(() => {
    if (esp32Online && Date.now() - lastSeenMs > 60000) {
        console.log('[Watchdog] ESP32 timed out – marking offline');
        esp32Online = false;
        hmiConnected = false;
        broadcastStatus();
    }
}, 10000);

// ==================== ESP32 HTTP endpoints ====================
app.get('/poll/:deviceId', (req, res) => {
    const command = commandQueue.shift();
    if (command) {
        console.log(`[HTTP] Sending command to ${req.params.deviceId}:`, command);
        res.json({ command });
    } else {
        res.json({ command: null });
    }
});

app.post('/update/:deviceId', (req, res) => {
    const data = req.body;
    console.log(`[HTTP] Status from ${req.params.deviceId}:`, data);

    if (data.event === "HMI_CONNECTED") {
        hmiConnected = true;
        esp32Online = true;
        lastSeenMs = Date.now();
    } else if (data.event === "HMI_DISCONNECTED") {
        hmiConnected = false;
        lastSeenMs = Date.now();
    } else if (data.event === "HELLO") {
        esp32Online = true;
        lastSeenMs = Date.now();
    } else if (data.type === "PING") {
        esp32Online = true;
        lastSeenMs = Date.now();
    } else {
        if (esp32Online) lastSeenMs = Date.now();
    }

    broadcastStatus();
    res.json({ status: "ok" });
});

// ==================== Frontend command endpoints ====================
app.post('/start', (req, res) => {
    commandQueue.push({ cmd: "START", request_id: (++lastCommandId).toString() });
    console.log("[API] START queued");
    broadcastStatus();
    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    commandQueue.push({ cmd: "STOP", request_id: (++lastCommandId).toString() });
    console.log("[API] STOP queued");
    broadcastStatus();
    res.json({ success: true });
});

app.post('/connect', (req, res) => {
    const { hmi_ip, hmi_port } = req.body;
    commandQueue.push({
        cmd: "CONNECT",
        hmi_ip,
        hmi_port,
        request_id: (++lastCommandId).toString()
    });
    console.log(`[API] CONNECT queued to ${hmi_ip}:${hmi_port}`);
    broadcastStatus();
    res.json({ success: true });
});

app.post('/disconnect', (req, res) => {
    commandQueue.push({ cmd: "DISCONNECT", request_id: (++lastCommandId).toString() });
    console.log("[API] DISCONNECT queued");
    broadcastStatus();
    res.json({ success: true });
});

app.post('/send', (req, res) => {
    const { data } = req.body;
    commandQueue.push({ cmd: "SEND", data, request_id: (++lastCommandId).toString() });
    console.log(`[API] SEND queued: ${data}`);
    broadcastStatus();
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    res.json({
        esp32_connected: esp32Online,
        hmi_connected: hmiConnected,
        command_queue_length: commandQueue.length,
        last_ping: new Date().toISOString()
    });
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('Remote HMI Backend'));

// ==================== WebSocket for frontend ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[WS] Frontend connected');
    frontendClients.add(ws);
    broadcastStatus();
    ws.on('close', () => {
        console.log('[WS] Frontend disconnected');
        frontendClients.delete(ws);
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`[Server] running on port ${port}`);
});