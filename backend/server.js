// =============================================================================
//  Remote HMI Backend — Production Server v2.1
//  Stack : Node.js + Express + ws
//  Deploy: Render Web Service (or any Node host)
//
//  v2.1 ADDITIONS:
//    • /proxy/* translator routes — ESP32 hits these instead of direct routes
//    • Poll response cache (2 s TTL) — duplicate polls answered instantly
//    • Keep-warm upgraded to 14-min self-ping on /proxy-health
//    • All proxy logic is inline — no separate file needed
// =============================================================================

'use strict';

const express   = require('express');
const WebSocket = require('ws');
const http      = require('http');
const https     = require('https');
const cors      = require('cors');

// ─── Environment ──────────────────────────────────────────────────────────────
const PORT           = process.env.PORT                || 10000;
const WATCHDOG_MS    = parseInt(process.env.WATCHDOG_MS    || '60000');  // 60 s
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '50');
const SELF_URL       = process.env.RENDER_EXTERNAL_URL
                    || process.env.BACKEND_BASE_URL
                    || '';

// ─── App + HTTP Server ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Shared State ─────────────────────────────────────────────────────────────
const state = {
    esp32Online   : false,
    hmiConnected  : false,
    lastSeenMs    : 0,
    lastCommandId : 0,
    commandQueue  : [],   // Array<{ cmd, request_id, ...extras }>
    deviceInfo    : {},
};

const frontendClients = new Set();

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
            try { ws.send(payload); } catch { /* stale socket */ }
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
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '16kb' }));
app.use(express.text({ type: '*/*', limit: '16kb' }));  // needed for proxy body passthrough

// ─── Watchdog ─────────────────────────────────────────────────────────────────
setInterval(() => {
    if (state.esp32Online && Date.now() - state.lastSeenMs > WATCHDOG_MS) {
        log('WATCHDOG', 'ESP32 timed out — marking offline');
        state.esp32Online  = false;
        state.hmiConnected = false;
        broadcastStatus();
    }
}, 10_000);

// =============================================================================
//  POLL CACHE  (prevents duplicate /poll hits hammering the queue)
//  Keyed by deviceId — TTL 2 seconds
// =============================================================================
const pollCache    = new Map();   // deviceId → { body: string, ts: number }
const POLL_CACHE_TTL = 2000;

function getCachedPoll(deviceId) {
    const e = pollCache.get(deviceId);
    if (!e || Date.now() - e.ts > POLL_CACHE_TTL) {
        pollCache.delete(deviceId);
        return null;
    }
    return e.body;
}
function setCachedPoll(deviceId, body) {
    pollCache.set(deviceId, { body, ts: Date.now() });
}

// =============================================================================
//  INTERNAL LOOPBACK FORWARD
//  Proxy routes call this to reach the real Express routes on 127.0.0.1
//  — no network round-trip through Render's load balancer.
// =============================================================================
function forwardInternal({ method, path, body }) {
    return new Promise((resolve, reject) => {
        const bodyStr = body
            ? (typeof body === 'string' ? body : JSON.stringify(body))
            : null;
        const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;

        const options = {
            hostname : '127.0.0.1',
            port     : PORT,
            path,
            method   : method.toUpperCase(),
            headers  : {
                'Content-Type'     : 'application/json',
                'X-Internal-Proxy' : 'true',
                ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => (data += chunk));
            res.on('end',  () => resolve({ status: res.statusCode, body: data }));
        });

        req.on('error', reject);
        req.setTimeout(40000, () => req.destroy(new Error('internal forward timeout')));
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

// =============================================================================
//  PROXY TRANSLATOR ROUTES  — mounted at /proxy/*
//
//  ESP32 firmware v4 sends:
//    GET  /proxy/poll/:deviceId
//    POST /proxy/update/:deviceId
//    POST /proxy/command/:deviceId
//
//  These translate and forward to the real routes below via loopback.
//  Benefits:
//    • Poll cache avoids queue-draining on rapid retries
//    • Cache invalidated on every POST so commands are never stale
//    • /proxy-health keeps Render warm without touching business logic
// =============================================================================

// GET /proxy/poll/:deviceId  — with 2-second cache
app.get('/proxy/poll/:deviceId', async (req, res) => {
    const { deviceId } = req.params;

    const cached = getCachedPoll(deviceId);
    if (cached) {
        log('PROXY', `GET /poll/${deviceId} → CACHE HIT`);
        return res.status(200).type('application/json').send(cached);
    }

    log('PROXY', `GET /poll/${deviceId} → forwarding`);
    try {
        const result = await forwardInternal({ method: 'GET', path: `/poll/${deviceId}` });
        setCachedPoll(deviceId, result.body);
        res.status(result.status).type('application/json').send(result.body);
    } catch (err) {
        log('PROXY', `/poll/${deviceId} error: ${err.message}`);
        res.status(502).json({ error: 'proxy_error', detail: err.message });
    }
});

// POST /proxy/update/:deviceId  — invalidates poll cache
app.post('/proxy/update/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    pollCache.delete(deviceId);   // new status → next poll must be fresh

    log('PROXY', `POST /update/${deviceId} body=${body}`);
    try {
        const result = await forwardInternal({ method: 'POST', path: `/update/${deviceId}`, body });
        res.status(result.status).type('application/json').send(result.body);
    } catch (err) {
        log('PROXY', `/update/${deviceId} error: ${err.message}`);
        res.status(502).json({ error: 'proxy_error', detail: err.message });
    }
});

// POST /proxy/command/:deviceId  — invalidates poll cache
app.post('/proxy/command/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    pollCache.delete(deviceId);

    log('PROXY', `POST /command/${deviceId}`);
    try {
        const result = await forwardInternal({ method: 'POST', path: `/command/${deviceId}`, body });
        res.status(result.status).type('application/json').send(result.body);
    } catch (err) {
        log('PROXY', `/command/${deviceId} error: ${err.message}`);
        res.status(502).json({ error: 'proxy_error', detail: err.message });
    }
});

// Proxy health — used by keep-warm ping AND by ESP32 to verify proxy is alive
app.get('/proxy-health', (_req, res) => {
    res.json({
        status    : 'ok',
        proxy     : 'built-in',
        cacheSize : pollCache.size,
        uptime_s  : Math.floor(process.uptime()),
        backend   : SELF_URL || `http://127.0.0.1:${PORT}`,
    });
});

// =============================================================================
//  ESP32 DIRECT HTTP ENDPOINTS  (unchanged from v2.0)
//  ESP32 can also hit these directly without /proxy/* if needed.
// =============================================================================

/**
 * GET /poll/:deviceId
 * Called by ESP32 every ~3 s. Returns next queued command or null.
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
 */
app.post('/update/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const data = req.body;

    // Body may arrive as parsed object (express.json) or raw string (express.text)
    const parsed = typeof data === 'string'
        ? (() => { try { return JSON.parse(data); } catch { return {}; } })()
        : data;

    if (!parsed || typeof parsed !== 'object') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    markEsp32Seen();
    log('UPDATE', `From ${deviceId}:`, parsed);

    const key = parsed.event || parsed.type;
    switch (key) {
        case 'HELLO':
            state.deviceInfo = {
                device_id    : deviceId,
                fw           : parsed.fw      || 'unknown',
                apn          : parsed.apn     || 'unknown',
                version      : parsed.version || 'unknown',
                connected_at : ts(),
            };
            log('HELLO', `Registered — fw=${state.deviceInfo.fw}  apn=${state.deviceInfo.apn}`);
            break;

        case 'HMI_CONNECTED':
            state.hmiConnected = true;
            log('HMI', `Connected → ${parsed.hmi_ip}:${parsed.hmi_port}`);
            break;

        case 'HMI_DISCONNECTED':
            state.hmiConnected = false;
            log('HMI', 'Disconnected');
            break;

        case 'PING':
            // heartbeat — markEsp32Seen() already called
            break;

        default:
            // command result or HMI_RX — no extra state change needed
            break;
    }

    broadcastStatus();
    res.json({ status: 'ok', server_time: ts() });
});

// =============================================================================
//  FRONTEND COMMAND ENDPOINTS  (called by React dashboard — unchanged)
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

    const cmd = {
        cmd        : 'CONNECT',
        hmi_ip     : hmi_ip.trim(),
        hmi_port   : port,
        request_id : String(++state.lastCommandId),
    };
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

app.post('/clear-queue', (_req, res) => {
    const cleared = state.commandQueue.length;
    state.commandQueue.length = 0;
    pollCache.clear();            // also wipe proxy cache
    broadcastStatus();
    log('API', `Queue cleared (${cleared} removed)`);
    res.json({ success: true, cleared });
});

// =============================================================================
//  INFO / UTILITY ENDPOINTS
// =============================================================================

app.get('/status', (_req, res) => res.json({
    esp32_connected : state.esp32Online,
    hmi_connected   : state.hmiConnected,
    queue_length    : state.commandQueue.length,
    device_info     : state.deviceInfo,
    last_ping       : ts(),
    uptime_s        : Math.floor(process.uptime()),
    proxy_cache     : pollCache.size,
}));

app.get('/health', (_req, res) => res.status(200).send('OK'));
app.get('/',       (_req, res) => res.json({ name: 'Remote HMI Backend', version: '2.1.0' }));

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    log('ERROR', err.stack || err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// =============================================================================
//  WEBSOCKET — real-time status feed for browser dashboard
// =============================================================================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    log('WS', `Frontend connected from ${ip}`);
    frontendClients.add(ws);

    // Send full snapshot immediately on connect
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
//  KEEP-WARM SELF-PING
//  14 min interval < Render's 15-min inactivity cutoff — service never sleeps.
//  Hits /proxy-health (lightweight, no queue/state side-effects).
//  Set RENDER_EXTERNAL_URL or BACKEND_BASE_URL env var to enable.
// =============================================================================
function startKeepWarm() {
    if (!SELF_URL) {
        log('KEEPALIVE', 'No SELF_URL set — keep-warm disabled (set RENDER_EXTERNAL_URL)');
        return;
    }

    const pingUrl = `${SELF_URL}/proxy-health`;
    log('KEEPALIVE', `Self-ping every 14 min → ${pingUrl}`);

    const ping = () => {
        const mod = pingUrl.startsWith('https') ? https : http;
        const req = mod.get(pingUrl, (res) => {
            log('KEEPALIVE', `Self-ping → HTTP ${res.statusCode}`);
            res.resume();
        });
        req.on('error', (e) => log('KEEPALIVE', `Self-ping failed: ${e.message}`));
        req.setTimeout(10000, () => req.destroy());
    };

    setTimeout(ping, 8000);              // initial ping once server is ready
    setInterval(ping, 14 * 60 * 1000);  // then every 14 minutes
}

// =============================================================================
//  START
// =============================================================================
server.listen(PORT, '0.0.0.0', () => {
    log('SERVER', `Listening on port ${PORT}`);
    log('SERVER', `Watchdog: ${WATCHDOG_MS / 1000}s | URL: ${SELF_URL || '(local — keep-warm disabled)'}`);
    log('SERVER', 'Proxy routes: /proxy/poll/:id  /proxy/update/:id  /proxy/command/:id');
    startKeepWarm();
});

process.on('SIGTERM', () => {
    log('SERVER', 'SIGTERM — shutting down gracefully');
    server.close(() => process.exit(0));
});