import { useState, useEffect, useRef, useCallback } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://laser-control.onrender.com';
const WS_URL = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://');

export default function App() {
    const [esp32Online, setEsp32Online] = useState(false);
    const [hmiConnected, setHmiConnected] = useState(false);
    const [statusMsg, setStatusMsg] = useState('ESP32 offline');
    const [logs, setLogs] = useState([]);
    const [sendData, setSendData] = useState('');
    const [error, setError] = useState('');
    const [wsState, setWsState] = useState('connecting');

    const wsRef = useRef(null);
    const retryRef = useRef(null);
    const logsEndRef = useRef(null);

    const addLog = useCallback((msg, type = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [...prev.slice(-199), { time, msg, type }]);
    }, []);

    const connectWS = useCallback(() => {
        if (retryRef.current) clearTimeout(retryRef.current);
        if (wsRef.current?.readyState === WebSocket.OPEN) return;
        if (wsRef.current) wsRef.current.close();

        setWsState('connecting');
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            setWsState('open');
            addLog('Connected to backend', 'success');
        };
        ws.onmessage = (e) => {
            try {
                const d = JSON.parse(e.data);
                setEsp32Online(d.esp32_connected === true);
                setHmiConnected(d.hmi_connected === true);
                setStatusMsg(d.message || '');
                if (d.esp32_connected && !esp32Online) addLog('ESP32 online', 'success');
                else if (!d.esp32_connected && esp32Online) addLog('ESP32 offline', 'warn');
            } catch { addLog('Invalid status', 'warn'); }
        };
        ws.onerror = () => {
            setWsState('closed');
            addLog('WebSocket error', 'error');
        };
        ws.onclose = () => {
            setWsState('closed');
            addLog('Disconnected – retrying in 5s', 'warn');
            retryRef.current = setTimeout(connectWS, 5000);
        };
    }, [addLog, esp32Online]);

    useEffect(() => {
        connectWS();
        return () => {
            clearTimeout(retryRef.current);
            wsRef.current?.close();
        };
    }, [connectWS]);

    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    async function apiPost(path, body) {
        const res = await fetch(`${BACKEND_URL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return res.json();
    }

    async function handleStart() {
        if (!esp32Online) return setError('ESP32 offline');
        setError('');
        addLog('START command sent', 'info');
        const d = await apiPost('/start');
        if (d.success) addLog('START queued ✓', 'success');
        else setError(d.message);
    }
    async function handleStop() {
        if (!esp32Online) return setError('ESP32 offline');
        setError('');
        addLog('STOP command sent', 'info');
        const d = await apiPost('/stop');
        if (d.success) addLog('STOP queued ✓', 'success');
        else setError(d.message);
    }
    async function handleConnect() {
        const ip = prompt('Enter HMI IP:', '192.168.5.158');
        const port = prompt('Enter HMI Port:', '8050');
        if (!ip || !port) return;
        setError('');
        addLog(`Connecting to ${ip}:${port}...`, 'info');
        const d = await apiPost('/connect', { hmi_ip: ip, hmi_port: parseInt(port) });
        if (d.success) addLog(`Connect queued → ${ip}:${port}`, 'success');
        else setError(d.message);
    }
    async function handleDisconnect() {
        setError('');
        addLog('Disconnect requested', 'warn');
        const d = await apiPost('/disconnect');
        if (d.success) addLog('Disconnect queued', 'warn');
        else setError(d.message);
    }
    async function handleSend() {
        if (!sendData.trim()) return;
        if (!esp32Online) return setError('ESP32 offline');
        setError('');
        addLog(`Sending: ${sendData}`, 'info');
        const d = await apiPost('/send', { data: sendData });
        if (d.success) {
            addLog('Sent ✓', 'success');
            setSendData('');
        } else setError(d.message);
    }

    return (
        <div className="min-h-screen bg-slate-900 text-slate-200 p-6 font-mono">
            <div className="max-w-3xl mx-auto">
                <h1 className="text-2xl font-bold mb-2">Remote HMI Control</h1>
                <div className="bg-slate-800 rounded p-4 mb-4">
                    <div className="flex gap-4">
                        <div>🔌 Backend: <span className={wsState === 'open' ? 'text-green-400' : 'text-red-400'}>{wsState}</span></div>
                        <div>📡 ESP32: <span className={esp32Online ? 'text-green-400' : 'text-red-400'}>{esp32Online ? 'Online' : 'Offline'}</span></div>
                        <div>⚙️ HMI: <span className={hmiConnected ? 'text-green-400' : 'text-yellow-400'}>{hmiConnected ? 'Connected' : 'Idle'}</span></div>
                    </div>
                    <div className="text-sm mt-2">{statusMsg}</div>
                </div>

                <div className="flex gap-3 flex-wrap mb-4">
                    <button onClick={handleStart} className="bg-green-700 px-4 py-2 rounded hover:bg-green-600">START</button>
                    <button onClick={handleStop} className="bg-red-700 px-4 py-2 rounded hover:bg-red-600">STOP</button>
                    <button onClick={handleConnect} className="bg-blue-700 px-4 py-2 rounded hover:bg-blue-600">CONNECT HMI</button>
                    <button onClick={handleDisconnect} className="bg-yellow-700 px-4 py-2 rounded hover:bg-yellow-600">DISCONNECT</button>
                </div>

                <div className="flex gap-2 mb-4">
                    <input
                        value={sendData}
                        onChange={e => setSendData(e.target.value)}
                        placeholder="Custom command"
                        className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-2"
                    />
                    <button onClick={handleSend} className="bg-purple-700 px-4 py-2 rounded hover:bg-purple-600">SEND</button>
                </div>

                {error && <div className="bg-red-900 p-2 rounded mb-4">{error}</div>}

                <div className="bg-slate-800 rounded p-3 h-64 overflow-y-auto">
                    <div className="text-xs text-slate-400 mb-2">Activity Log</div>
                    {logs.map((log, i) => (
                        <div key={i} className="text-xs border-b border-slate-700 py-1">
                            [{log.time}] {log.msg}
                        </div>
                    ))}
                    <div ref={logsEndRef} />
                </div>
            </div>
        </div>
    );
}