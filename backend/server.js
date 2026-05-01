// =============================================================================
//  Remote HMI Backend — Production Server v2.0
//  Stack : Node.js + Express + ws
//  Deploy: Render Web Service (or any Node host)
// =============================================================================

'use strict';

const express   = require('express');
const WebSocket = require('ws');
const http      = require('http');
const cors      = require('cors');

// ─── Environment ─────────────────────────────────────────────────────────────
const PORT             = process.env.PORT              || 10000;
const WATCHDOG_MS      = parseInt(process.env.WATCHDOG_MS     || '60000');   // 60 s
const MAX_QUEUE_SIZE   = parseInt(process.env.MAX_QUEUE_SIZE   || '50');
const SELF_URL         = process.env.RENDER_EXTERNAL_URL || '';               // auto-set by Render

// ─── App + Server ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Shared State ─────────────────────────────────────────────────────────────
const state = {
    esp32Online   : false,
    hmiConnected  : false,
    lastSeenMs    : 0,
    lastCommandId : 0,
    commandQueue  : [],   // Array<{ cmd, request_id, ...extras }>
    deviceInfo    : {},   // populated on HELLO from ESP32
};

const frontendClients = new Set();   // active WebSocket browser connections

// ─── Utilities ────────────────────────────────────────────────────────────────
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
                            ? (state.hmiConnected ? 'HMI connected' : 'ESP32 online, HMI idle')
                            : 'ESP32 offline',
        last_ping       : ts(),
        command_pending : state.commandQueue.length > 0,
        queue_length    : state.commandQueue.length,
        device_info     : state.deviceInfo,
    });
    for (const ws of frontendClients) {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(payload); } catch { /* stale socket — ignore */ }
        }
    }
}

function markEsp32Seen() {
    state.esp32Online = true;
    state.lastSeenMs  = Date.now();
}

function enqueueCommand(cmd) {
    if (state.commandQueue.length >= MAX_QUEUE_SIZE) {
        log('QUEUE', `Full (${MAX_QUEUE_SIZE}) — dropping oldest`);
        state.commandQueue.shift();
    }
    state.commandQueue.push(cmd);
    broadcastStatus();
}

// ─── Middleware ────────────────────────────────────────────────────────────────
// NOTE: Do NOT touch x-forwarded-proto. Render terminates TLS before Express.
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '16kb' }));

// ─── Watchdog: mark ESP32 offline if silent for WATCHDOG_MS ─────────────────
setInterval(() => {
    if (state.esp32Online && Date.now() - state.lastSeenMs > WATCHDOG_MS) {
        log('WATCHDOG', 'ESP32 timed out — marking offline');
        state.esp32Online  = false;
        state.hmiConnected = false;
        broadcastStatus();
    }
}, 10_000);

// ─── Keep-alive: prevent Render free-tier sleep (pings every 10 min) ─────────
if (SELF_URL) {
    setInterval(() => {
        require('https').get(`${SELF_URL}/health`, res =>
            log('KEEPALIVE', `Self-ping → ${res.statusCode}`)
        ).on('error', err =>
            log('KEEPALIVE', `Self-ping failed: ${err.message}`)
        );
    }, 10 * 60 * 1000);
}

// =============================================================================
//  ESP32 HTTP Endpoints
// =============================================================================

/**
 * GET /poll/:deviceId
 * Called by ESP32 every ~3 s to retrieve the next queued command.
 * Returns: { command: {...} | null, queue_remaining: number }
 */
app.get('/poll/:deviceId', (req, res) => {
    markEsp32Seen();
    const command = state.commandQueue.shift() || null;
    if (command) log('POLL', `Dispatching to ${req.params.deviceId}:`, command);
    res.json({ command, queue_remaining: state.commandQueue.length });
});

/**
 * POST /update/:deviceId
 * ESP32 posts events and heartbeats here.
 *
 * Accepted bodies:
 *   { event: "HELLO",           fw, apn, version }
 *   { event: "HMI_CONNECTED",   hmi_ip, hmi_port }
 *   { event: "HMI_DISCONNECTED" }
 *   { event: "HMI_RX",          data }
 *   { type:  "PING" }
 *   { request_id, status, error? }    ← command result
 */
app.post('/update/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const data = req.body;

    if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    markEsp32Seen();
    log('UPDATE', `From ${deviceId}:`, data);

    const key = data.event || data.type;
    switch (key) {
        case 'HELLO':
            state.deviceInfo = {
                device_id    : deviceId,
                fw           : data.fw      || 'unknown',
                apn          : data.apn     || 'unknown',
                version      : data.version || 'unknown',
                connected_at : ts(),
            };
            log('HELLO', `Registered — fw=${state.deviceInfo.fw}  apn=${state.deviceInfo.apn}`);
            break;

        case 'HMI_CONNECTED':
            state.hmiConnected = true;
            log('HMI', `Connected → ${data.hmi_ip}:${data.hmi_port}`);
            break;

        case 'HMI_DISCONNECTED':
            state.hmiConnected = false;
            log('HMI', 'Disconnected');
            break;

        case 'PING':
            // heartbeat — markEsp32Seen() already called above
            break;

        default:
            // command result or HMI_RX — no state change needed
            break;
    }

    broadcastStatus();
    res.json({ status: 'ok', server_time: ts() });
});

// =============================================================================
//  Frontend Command Endpoints  (called by React dashboard)
// =============================================================================

app.post('/start', (_req, res) => {
    const cmd = { cmd: 'START', request_id: String(++state.lastCommandId) };
    enqueueCommand(cmd);
    log('API', 'START queued', cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/stop', (_req, res) => {
    const cmd = { cmd: 'STOP', request_id: String(++state.lastCommandId) };
    enqueueCommand(cmd);
    log('API', 'STOP queued', cmd);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/connect', (req, res) => {
    const { hmi_ip, hmi_port } = req.body || {};
    if (!hmi_ip || typeof hmi_ip !== 'string' || !hmi_ip.trim())
        return res.status(400).json({ success: false, message: 'hmi_ip is required' });
    const port = parseInt(hmi_port, 10);
    if (isNaN(port) || port < 1 || port > 65535)
        return res.status(400).json({ success: false, message: 'hmi_port must be 1–65535' });

    const cmd = { cmd: 'CONNECT', hmi_ip: hmi_ip.trim(), hmi_port: port,
                  request_id: String(++state.lastCommandId) };
    enqueueCommand(cmd);
    log('API', `CONNECT queued → ${cmd.hmi_ip}:${cmd.hmi_port}`);
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/disconnect', (_req, res) => {
    const cmd = { cmd: 'DISCONNECT', request_id: String(++state.lastCommandId) };
    enqueueCommand(cmd);
    log('API', 'DISCONNECT queued');
    res.json({ success: true, request_id: cmd.request_id });
});

app.post('/send', (req, res) => {
    const { data } = req.body || {};
    if (!data || typeof data !== 'string' || !data.trim())
        return res.status(400).json({ success: false, message: 'data (string) is required' });
    if (data.length > 512)
        return res.status(400).json({ success: false, message: 'data too long (max 512 chars)' });

    const cmd = { cmd: 'SEND', data: data.trim(), request_id: String(++state.lastCommandId) };
    enqueueCommand(cmd);
    log('API', `SEND queued: ${cmd.data}`);
    res.json({ success: true, request_id: cmd.request_id });
});

/** Flush the command queue (useful during debugging / testing) */
app.post('/clear-queue', (_req, res) => {
    const cleared = state.commandQueue.length;
    state.commandQueue.length = 0;
    broadcastStatus();
    log('API', `Queue cleared (${cleared} removed)`);
    res.json({ success: true, cleared });
});

// =============================================================================
//  Info / Utility Endpoints
// =============================================================================

app.get('/status', (_req, res) => res.json({
    esp32_connected : state.esp32Online,
    hmi_connected   : state.hmiConnected,
    queue_length    : state.commandQueue.length,
    device_info     : state.deviceInfo,
    last_ping       : ts(),
    uptime_s        : Math.floor(process.uptime()),
}));

app.get('/health', (_req, res) => res.status(200).send('OK'));
app.get('/',       (_req, res) => res.json({ name: 'Remote HMI Backend', version: '2.0.0' }));

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    log('ERROR', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// =============================================================================
//  WebSocket — real-time status feed for browser
// =============================================================================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    log('WS', `Frontend connected from ${ip}`);
    frontendClients.add(ws);

    // Send full state snapshot immediately on connect
    try {
        ws.send(JSON.stringify({
            esp32_connected : state.esp32Online,
            hmi_connected   : state.hmiConnected,
            message         : state.esp32Online
                               ? (state.hmiConnected ? 'HMI connected' : 'ESP32 online')
                               : 'ESP32 offline',
            last_ping       : ts(),
            command_pending : state.commandQueue.length > 0,
            queue_length    : state.commandQueue.length,
            device_info     : state.deviceInfo,
        }));
    } catch { /* ignore */ }

    ws.on('close', () => { frontendClients.delete(ws); log('WS', `Disconnected (${ip})`); });
    ws.on('error', err  => { frontendClients.delete(ws); log('WS', `Error: ${err.message}`); });
});

// =============================================================================
//  Start
// =============================================================================
server.listen(PORT, '0.0.0.0', () => {
    log('SERVER', `Listening on port ${PORT}`);
    log('SERVER', `Watchdog ${WATCHDOG_MS / 1000}s | Keep-alive: ${SELF_URL || 'disabled'}`);
});

process.on('SIGTERM', () => {
    log('SERVER', 'SIGTERM — shutting down gracefully');
    server.close(() => process.exit(0));
});