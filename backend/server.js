// server.js – Deploy on Render (Free tier)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1kb' }));

// ========== Status variables ==========
let esp32Online = false;
let lastHeartbeat = null;
let pendingText = null;        // text to be sent to ESP32 (only one at a time)

// ========== WebSocket Server for frontend ==========
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const frontendClients = new Set();

function broadcastStatus() {
    const status = {
        esp32_online: esp32Online,
        last_heartbeat: lastHeartbeat,
        pending: pendingText !== null
    };
    const msg = JSON.stringify(status);
    for (const ws of frontendClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
    console.log('[WS] Status broadcasted', status);
}

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('[WS] Frontend connected');
    frontendClients.add(ws);
    broadcastStatus(); // send initial status
    ws.on('close', () => {
        console.log('[WS] Frontend disconnected');
        frontendClients.delete(ws);
    });
});

// Heartbeat watchdog: mark ESP32 offline after 60 seconds
setInterval(() => {
    if (esp32Online && lastHeartbeat && (Date.now() - lastHeartbeat > 60000)) {
        console.warn('[WATCHDOG] ESP32 heartbeat timeout – marking offline');
        esp32Online = false;
        broadcastStatus();
    }
}, 10000);

// ========== ESP32 Endpoints ==========
// ESP32 calls this every few seconds to check for a pending text
app.get('/poll', (req, res) => {
    if (pendingText !== null) {
        const text = pendingText;
        console.log(`[POLL] Sending to ESP32: "${text}"`);
        res.json({ text });
        pendingText = null;          // clear after delivering
        broadcastStatus();           // update frontend that pending is gone
    } else {
        res.json({ text: null });
    }
});

// ESP32 calls this to report it is alive (every 30 seconds)
app.post('/heartbeat', (req, res) => {
    esp32Online = true;
    lastHeartbeat = Date.now();
    console.log('[HEARTBEAT] ESP32 is online');
    broadcastStatus();
    res.json({ status: 'ok' });
});

// ========== Frontend API Endpoint ==========
// Frontend sends text here
app.post('/send-text', (req, res) => {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Invalid text' });
    }
    console.log(`[API] Received text: "${text}"`);
    pendingText = text;
    broadcastStatus();     // frontend will see "pending: true"
    res.json({ success: true });
});

// Simple health check
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.send('Simple HMI Bridge'));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Running on port ${PORT}`);
});