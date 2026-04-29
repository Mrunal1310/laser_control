import { useState, useEffect, useRef, useCallback } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:10000";
const WS_URL = BACKEND_URL.replace("http://", "ws://").replace("https://", "wss://");

export default function App() {
  const [hmiIp, setHmiIp] = useState("192.168.5.158");
  const [hmiPort, setHmiPort] = useState("8050");
  const [esp32Online, setEsp32Online] = useState(false);
  const [hmiConnected, setHmiConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("ESP32 offline");
  const [lastPing, setLastPing] = useState(null);
  const [wsState, setWsState] = useState("connecting");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);
  const [sendData, setSendData] = useState("");
  const [lastResponse, setLastResponse] = useState("");

  const wsRef = useRef(null);
  const retryRef = useRef(null);
  const logsEndRef = useRef(null);

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-199), { time, msg, type }]);
  }, []);

  // WebSocket for live status
  const connectWS = useCallback(() => {
    if (retryRef.current) clearTimeout(retryRef.current);
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current) wsRef.current.close();

    setWsState("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState("open");
      addLog("Status feed connected", "success");
    };

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        setEsp32Online(d.esp32_connected === true);
        setHmiConnected(d.hmi_connected === true);
        setStatusMsg(d.message || "");
        if (d.last_ping) setLastPing(d.last_ping);
        if (d.esp32_connected) addLog("✓ ESP32 online", "success");
        else if (d.esp32_connected === false && d.esp32_connected !== undefined)
          addLog("ESP32 offline", "warn");
      } catch {
        addLog("Status feed: bad JSON", "warn");
      }
    };

    ws.onerror = () => {
      setWsState("closed");
      addLog("Status feed error", "error");
    };

    ws.onclose = (e) => {
      setWsState("closed");
      if (e.code === 1000) return;
      addLog("Status feed dropped — retrying in 5 s", "warn");
      retryRef.current = setTimeout(connectWS, 5000);
    };
  }, [addLog]);

  useEffect(() => {
    connectWS();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [connectWS]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // API calls
  async function handleConnect() {
    if (!hmiIp || !hmiPort) return setError("Enter HMI IP and Port.");
    if (!esp32Online) return setError("ESP32 is offline — cannot connect.");
    setError("");
    setIsLoading(true);
    addLog(`Connecting HMI ${hmiIp}:${hmiPort}…`, "info");
    try {
      const res = await fetch(`${BACKEND_URL}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hmi_ip: hmiIp, hmi_port: parseInt(hmiPort) }),
      });
      const data = await res.json();
      if (data.success) addLog(`HMI connected at ${hmiIp}:${hmiPort}`, "success");
      else { setError(data.message); addLog(`Failed: ${data.message}`, "error"); }
    } catch (e) {
      setError(`Backend error: ${e.message}`);
      addLog(`Backend error: ${e.message}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDisconnect() {
    setIsLoading(true);
    addLog("Disconnecting HMI…", "warn");
    try {
      const res = await fetch(`${BACKEND_URL}/disconnect`, { method: "POST" });
      const data = await res.json();
      addLog(data.message || "Disconnected", "warn");
    } catch (e) {
      setError(`Disconnect error: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleStart() {
    if (!esp32Online) return setError("ESP32 is offline — cannot start.");
    setError("");
    addLog("Start command sent", "info");
    try {
      const res = await fetch(`${BACKEND_URL}/start`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        addLog("Start OK", "success");
        setLastResponse(JSON.stringify({ status: "queued" }, null, 2));
      } else {
        setError(data.message);
        addLog(`Start failed: ${data.message}`, "error");
      }
    } catch (e) {
      setError(`Start error: ${e.message}`);
      addLog(`Start error: ${e.message}`, "error");
    }
  }

  async function handleStop() {
    if (!esp32Online) return setError("ESP32 is offline — cannot stop.");
    setError("");
    addLog("Stop command sent", "info");
    try {
      const res = await fetch(`${BACKEND_URL}/stop`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        addLog("Stop OK", "success");
        setLastResponse(JSON.stringify({ status: "queued" }, null, 2));
      } else {
        setError(data.message);
        addLog(`Stop failed: ${data.message}`, "error");
      }
    } catch (e) {
      setError(`Stop error: ${e.message}`);
      addLog(`Stop error: ${e.message}`, "error");
    }
  }

  async function handleSend() {
    if (!sendData.trim()) return;
    if (!esp32Online) return setError("ESP32 is offline — cannot send.");
    setError("");
    addLog(`Sending: ${sendData}`, "info");
    try {
      const res = await fetch(`${BACKEND_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: sendData }),
      });
      const data = await res.json();
      if (data.success) {
        setLastResponse(JSON.stringify({ status: "queued", data: sendData }, null, 2));
        addLog("Sent ✓", "success");
        setSendData("");
      } else {
        setError(data.message);
        addLog(`Send failed: ${data.message}`, "error");
      }
    } catch (e) {
      setError(`Send error: ${e.message}`);
      addLog(`Send error: ${e.message}`, "error");
    }
  }

  const wsDot = wsState === "open" ? "bg-green-400" : wsState === "connecting" ? "bg-yellow-400" : "bg-red-400";

  return (
    <div className="min-h-screen bg-slate-950 flex justify-center items-center p-4 font-mono">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 w-full max-w-3xl shadow-2xl">
        <div className="text-center mb-6">
          <h1 className="text-slate-100 text-2xl font-bold tracking-tight">Remote HMI Control</h1>
          <p className="text-sky-400 text-xs uppercase tracking-wider mt-1">EC200U · 4G LTE · Render</p>
        </div>

        {/* Status bar */}
        <div className="flex items-center flex-wrap gap-2 p-3 rounded-xl bg-slate-800/50 border border-slate-700 mb-4">
          <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${esp32Online ? "border-green-800 bg-green-950/30" : "border-slate-700 bg-slate-900"}`}>
            <span className={`w-2 h-2 rounded-full ${esp32Online ? "bg-green-400 shadow-green-400" : "bg-slate-600"}`}></span>
            <span className="text-slate-400 text-xs font-semibold">ESP32</span>
            <span className={`text-xs font-bold ${esp32Online ? "text-green-400" : "text-slate-500"}`}>{esp32Online ? "ACTIVE" : "OFFLINE"}</span>
          </div>
          <span className="text-slate-700 text-sm">→</span>
          <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${hmiConnected ? "border-blue-800 bg-blue-950/30" : "border-slate-700 bg-slate-900"}`}>
            <span className={`w-2 h-2 rounded-full ${hmiConnected ? "bg-blue-400" : "bg-slate-600"}`}></span>
            <span className="text-slate-400 text-xs font-semibold">HMI</span>
            <span className={`text-xs font-bold ${hmiConnected ? "text-blue-400" : "text-slate-500"}`}>{hmiConnected ? "CONNECTED" : "IDLE"}</span>
          </div>
          <div className="ml-auto flex items-center gap-1 text-slate-500 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full ${wsDot}`}></span>
            <span>{wsState === "open" ? "live" : wsState === "connecting" ? "connecting…" : "reconnecting…"}</span>
          </div>
          <span className="text-slate-500 text-xs italic w-full mt-1">{statusMsg}</span>
        </div>

        {lastPing && esp32Online && (
          <div className="bg-slate-800/50 border border-slate-700 text-sky-300 text-xs p-2 rounded mb-3">⚡ Last PING: {new Date(lastPing).toLocaleTimeString()}</div>
        )}

        {!esp32Online && (
          <div className="bg-amber-950/30 border border-amber-800/50 text-amber-400 text-xs p-3 rounded mb-3">
            🔌 Waiting for ESP32 to connect…<br />
            <small className="text-amber-700">ESP32 should poll /poll/esp32_001</small>
          </div>
        )}

        {error && (
          <div className="bg-red-950/30 border border-red-800/50 text-red-300 text-xs p-3 rounded mb-3 flex justify-between">
            <span>⚠ {error}</span>
            <button onClick={() => setError("")} className="text-red-300 hover:text-red-100">✕</button>
          </div>
        )}

        {/* HMI Connection Card */}
        <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-5 mb-4">
          <h2 className="text-sky-300 text-xs font-bold uppercase tracking-wider mb-3">HMI Connection</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <label className="text-slate-500 text-xs uppercase tracking-wide">HMI IP Address
              <input className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200 text-sm mt-1" value={hmiIp} onChange={e => setHmiIp(e.target.value)} disabled={hmiConnected} />
            </label>
            <label className="text-slate-500 text-xs uppercase tracking-wide">HMI Port
              <input className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-slate-200 text-sm mt-1" value={hmiPort} onChange={e => setHmiPort(e.target.value)} type="number" disabled={hmiConnected} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            <button onClick={handleConnect} disabled={hmiConnected || !esp32Online || isLoading} className={`px-4 py-2 rounded text-sm font-bold ${hmiConnected || !esp32Online || isLoading ? "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed" : "bg-blue-600 text-white border border-blue-600 hover:bg-blue-700"}`}>
              {isLoading && !hmiConnected ? "CONNECTING…" : "▶ CONNECT HMI"}
            </button>
            <button onClick={handleDisconnect} disabled={!hmiConnected || isLoading} className={`px-4 py-2 rounded text-sm font-bold ${!hmiConnected || isLoading ? "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed" : "bg-red-600 text-white border border-red-600 hover:bg-red-700"}`}>
              {isLoading && hmiConnected ? "DISCONNECTING…" : "■ DISCONNECT"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={handleStart} disabled={!esp32Online || isLoading} className={`px-4 py-2 rounded text-sm font-bold ${!esp32Online || isLoading ? "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed" : "bg-green-600 text-white border border-green-600 hover:bg-green-700"}`}>START</button>
            <button onClick={handleStop} disabled={!esp32Online || isLoading} className={`px-4 py-2 rounded text-sm font-bold ${!esp32Online || isLoading ? "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed" : "bg-orange-600 text-white border border-orange-600 hover:bg-orange-700"}`}>STOP</button>
          </div>
        </div>

        {/* Send Custom Data Card */}
        {hmiConnected && (
          <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-5 mb-4">
            <h2 className="text-sky-300 text-xs font-bold uppercase tracking-wider mb-3">Send Custom Data to HMI</h2>
            <div className="flex gap-2">
              <input className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-slate-200 text-sm" value={sendData} onChange={e => setSendData(e.target.value)} placeholder='{"action":"read","register":1}' onKeyDown={e => e.key === "Enter" && handleSend()} />
              <button onClick={handleSend} className="bg-green-600 text-white px-4 py-2 rounded text-sm font-bold hover:bg-green-700">SEND</button>
            </div>
            {lastResponse && <pre className="bg-slate-950 text-green-400 text-xs p-3 rounded mt-3 overflow-x-auto">{lastResponse}</pre>}
          </div>
        )}

        {/* Activity Log */}
        <div className="bg-slate-800/30 border border-slate-700 rounded-xl p-5">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sky-300 text-xs font-bold uppercase tracking-wider">Activity Log</h2>
            {logs.length > 0 && <button onClick={() => setLogs([])} className="text-slate-500 text-xs hover:text-slate-300">CLEAR</button>}
          </div>
          <div className="bg-slate-950 rounded p-3 h-56 overflow-y-auto text-xs font-mono">
            {!logs.length && <p className="text-slate-600">No activity yet…</p>}
            {logs.map((log, i) => (
              <div key={i} className="mb-1">
                <span className="text-slate-600">[{log.time}] </span>
                <span className={log.type === "success" ? "text-green-400" : log.type === "error" ? "text-red-400" : log.type === "warn" ? "text-yellow-400" : "text-slate-400"}>{log.msg}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>

        <p className="text-slate-700 text-center text-xs mt-5">BACKEND <code className="text-blue-500">{BACKEND_URL}</code></p>
      </div>
    </div>
  );
}