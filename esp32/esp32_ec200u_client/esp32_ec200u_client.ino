// ============================================================================
//  MODEM SELECTION (MUST BE FIRST!)
// ============================================================================
#define TINY_GSM_MODEM_EC200U

// ============================================================================
//  INCLUDES
// ============================================================================
#include <Arduino.h>
#include <TinyGsmClient.h>
#include <ArduinoJson.h>

// ============================================================================
//  HARDWARE SERIAL PINS (ESP32)
// ============================================================================
#define SIM_RX 16
#define SIM_TX 17
#define HMI_RX 4
#define HMI_TX 2

HardwareSerial sim(2);   // EC200U on UART2
HardwareSerial hmi(1);   // HMI on UART1

// ============================================================================
//  BACKEND CONFIGURATION (UPDATE AFTER RENDER DEPLOYMENT)
// ============================================================================
const char* backend_host = "your-backend.onrender.com";   // <-- CHANGE THIS
const int   backend_port = 80;                            // Use HTTP
const char* device_id    = "esp32_001";

// ============================================================================
//  APN & NETWORK (Jio India)
// ============================================================================
const char apn[]  = "jionet";
const char user[] = "";
const char pass[] = "";

// ============================================================================
//  GLOBAL OBJECTS
// ============================================================================
TinyGsm modem(sim);
TinyGsmClient http_client(modem);
bool hmi_connected = false;
String hmi_ip = "";
int hmi_port = 0;
unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;

// ============================================================================
//  EC200U POWER ON (GPIO4 = PWRKEY)
// ============================================================================
void powerOnEC200U() {
    pinMode(4, OUTPUT);
    digitalWrite(4, LOW);
    delay(1000);
    digitalWrite(4, HIGH);
    delay(2000);
    Serial.println("[EC200U] Power toggled");
}

// ============================================================================
//  READ SIM RESPONSE UNTIL OK/ERROR
// ============================================================================
String readSimResponse(unsigned long timeoutMs = 3000) {
    String resp = "";
    unsigned long start = millis();
    while (millis() - start < timeoutMs) {
        while (sim.available()) {
            char c = sim.read();
            resp += c;
            if (resp.endsWith("\r\nOK\r\n") || resp.endsWith("\r\nERROR\r\n")) {
                return resp;
            }
        }
    }
    return resp;
}

// ============================================================================
//  SEND AT COMMAND AND CHECK
// ============================================================================
bool sendAT(const String& cmd, const String& expected, unsigned long timeoutMs = 3000) {
    sim.println(cmd);
    String resp = readSimResponse(timeoutMs);
    Serial.println("→ " + cmd);
    Serial.println("← " + resp);
    return (resp.indexOf(expected) != -1);
}

// ============================================================================
//  AUTO DETECT APN (Indian carriers)
// ============================================================================
String detectAPN() {
    sim.println("AT+COPS?");
    String resp = readSimResponse(3000);
    int first = resp.indexOf('"');
    int second = resp.indexOf('"', first + 1);
    String op = (first != -1 && second != -1) ? resp.substring(first + 1, second) : "";
    op.toLowerCase();
    Serial.println("Operator: " + op);
    
    if (op.indexOf("airtel") != -1)   return "airtelgprs.com";
    if (op.indexOf("jio") != -1)      return "jionet";
    if (op.indexOf("vodafone") != -1 || op.indexOf("idea") != -1 || op.indexOf("vi") != -1) return "www";
    if (op.indexOf("bsnl") != -1)     return "bsnlnet";
    
    sim.println("AT+CIMI");
    resp = readSimResponse(3000);
    resp.trim();
    if (resp.startsWith("404") || resp.startsWith("405")) return "internet";
    return "jionet";
}

// ============================================================================
//  WAIT FOR NETWORK REGISTRATION
// ============================================================================
bool waitForNetwork() {
    Serial.print("[NET] Waiting for registration");
    for (int i = 0; i < 40; i++) {
        sim.println("AT+CREG?");
        String resp = readSimResponse(1500);
        if (resp.indexOf(",1") != -1 || resp.indexOf(",5") != -1) {
            Serial.println(" OK");
            return true;
        }
        Serial.print(".");
        delay(1000);
    }
    Serial.println(" FAIL");
    return false;
}

// ============================================================================
//  ACTIVATE PDP CONTEXT WITH GIVEN APN
// ============================================================================
bool activatePDP(const String& apn) {
    Serial.println("[NET] Activating APN: " + apn);
    sim.println("AT+QIDEACT=1");
    readSimResponse(5000);
    delay(500);
    
    String cmd = "AT+QICSGP=1,1,\"" + apn + "\",\"\",\"\",1";
    if (!sendAT(cmd, "OK", 3000)) return false;
    if (!sendAT("AT+QIACT=1", "OK", 15000)) return false;
    
    sim.println("AT+QIACT?");
    String resp = readSimResponse(3000);
    if (resp.indexOf("+QIACT: 1,1,") != -1) {
        Serial.println("[NET] Internet active");
        return true;
    }
    Serial.println("[NET] No IP assigned");
    return false;
}

// ============================================================================
//  FULL INTERNET SETUP
// ============================================================================
bool setupInternet() {
    Serial.println("=== EC200U Internet Setup ===");
    if (!sendAT("AT", "OK", 2000)) {
        powerOnEC200U();
        delay(5000);
        if (!sendAT("AT", "OK", 2000)) return false;
    }
    sendAT("ATE0", "OK", 2000);
    if (!sendAT("AT+CPIN?", "READY", 3000)) return false;
    sendAT("AT+CSQ", "OK", 2000);
    if (!waitForNetwork()) return false;
    sendAT("AT+CFUN=1", "OK", 5000);
    
    String detected = detectAPN();
    if (activatePDP(detected)) return true;
    
    const char* fallbacks[] = {"airtelgprs.com", "www", "bsnlnet", "internet"};
    for (int i = 0; i < 4; i++) {
        if (String(fallbacks[i]) == detected) continue;
        if (activatePDP(fallbacks[i])) return true;
    }
    return false;
}

// ============================================================================
//  HTTP GET (poll for command)
// ============================================================================
String httpGetCommand() {
    if (!http_client.connect(backend_host, backend_port)) {
        Serial.println("[HTTP] GET connection failed");
        return "";
    }
    String path = "/poll/" + String(device_id);
    String request = "GET " + path + " HTTP/1.1\r\n";
    request += "Host: " + String(backend_host) + "\r\n";
    request += "Connection: close\r\n\r\n";
    http_client.print(request);
    
    unsigned long timeout = millis() + 8000;
    while (!http_client.available() && millis() < timeout);
    if (!http_client.available()) {
        http_client.stop();
        return "";
    }
    // Skip HTTP headers
    while (http_client.available()) {
        String line = http_client.readStringUntil('\n');
        if (line == "\r") break;
    }
    String body = http_client.readString();
    http_client.stop();
    return body;
}

// ============================================================================
//  HTTP POST (send status update)
// ============================================================================
bool httpPostStatus(const String& payload) {
    if (!http_client.connect(backend_host, backend_port)) {
        Serial.println("[HTTP] POST connection failed");
        return false;
    }
    String path = "/update/" + String(device_id);
    String request = "POST " + path + " HTTP/1.1\r\n";
    request += "Host: " + String(backend_host) + "\r\n";
    request += "Content-Type: application/json\r\n";
    request += "Content-Length: " + String(payload.length()) + "\r\n";
    request += "Connection: close\r\n\r\n";
    request += payload;
    http_client.print(request);
    
    unsigned long timeout = millis() + 5000;
    while (!http_client.available() && millis() < timeout);
    http_client.stop();
    return true;
}

// ============================================================================
//  SEND COMMAND TO HMI
// ============================================================================
void sendHMICommand(const String& cmd) {
    if (cmd == "start") {
        uint8_t frame[] = {0x02, 0x07, 0x73, 0x74, 0x61, 0x72, 0x74, 0x3A, 0x03};
        hmi.write(frame, sizeof(frame));
        Serial.println("[HMI] START sent");
    } else if (cmd == "stop") {
        uint8_t frame[] = {0x02, 0x06, 0x73, 0x74, 0x6F, 0x70, 0x3A, 0x03};
        hmi.write(frame, sizeof(frame));
        Serial.println("[HMI] STOP sent");
    } else {
        Serial.println("[HMI] Unknown command: " + cmd);
    }
}

// ============================================================================
//  READ HMI RESPONSE
// ============================================================================
String readHMIResponse(unsigned long timeoutMs = 3000) {
    String resp = "";
    unsigned long start = millis();
    while (millis() - start < timeoutMs) {
        while (hmi.available()) {
            resp += (char)hmi.read();
        }
    }
    return resp;
}

// ============================================================================
//  PARSE HMI STATUS
// ============================================================================
int parseHMIStatus(const String& resp) {
    if (resp.indexOf(":1") != -1) return 1;
    if (resp.indexOf(":0") != -1) return 0;
    return -1;
}

// ============================================================================
//  SETUP
// ============================================================================
void setup() {
    Serial.begin(115200);
    hmi.begin(115200, SERIAL_8N1, HMI_RX, HMI_TX);
    sim.begin(115200, SERIAL_8N1, SIM_RX, SIM_TX);
    delay(2000);
    
    Serial.println("\n=== ESP32 + EC200U HTTP Polling Client ===");
    if (!setupInternet()) {
        Serial.println("[FATAL] Internet setup failed. Restarting...");
        delay(3000);
        ESP.restart();
    }
    
    // Send HELLO message to backend
    DynamicJsonDocument hello(128);
    hello["event"] = "HELLO";
    hello["device"] = "esp32";
    hello["fw"] = "1.0.0";
    hello["version"] = "4.3.0";
    hello["apn"] = apn;
    String helloStr;
    serializeJson(hello, helloStr);
    httpPostStatus(helloStr);
    
    Serial.println("[OK] System ready. Polling for commands...");
}

// ============================================================================
//  MAIN LOOP
// ============================================================================
void loop() {
    // Poll for commands every 3 seconds
    if (millis() - lastPoll > 3000) {
        String response = httpGetCommand();
        if (response.length() > 0) {
            DynamicJsonDocument doc(256);
            DeserializationError err = deserializeJson(doc, response);
            if (!err && doc.containsKey("command") && !doc["command"].isNull()) {
                JsonObject cmd = doc["command"];
                String action = cmd["cmd"];
                String req_id = cmd["request_id"] | "";
                Serial.printf("[CMD] Received: %s (id=%s)\n", action.c_str(), req_id.c_str());
                
                if (action == "START") {
                    sendHMICommand("start");
                    String hmiResp = readHMIResponse(4000);
                    int status = parseHMIStatus(hmiResp);
                    if (status == -1) status = 0;
                    DynamicJsonDocument result(128);
                    result["request_id"] = req_id;
                    result["status"] = status == 1 ? "OK" : "ERROR";
                    if (status == 0) result["error"] = "HMI command failed";
                    String out;
                    serializeJson(result, out);
                    httpPostStatus(out);
                }
                else if (action == "STOP") {
                    sendHMICommand("stop");
                    String hmiResp = readHMIResponse(4000);
                    int status = parseHMIStatus(hmiResp);
                    if (status == -1) status = 0;
                    DynamicJsonDocument result(128);
                    result["request_id"] = req_id;
                    result["status"] = status == 1 ? "OK" : "ERROR";
                    if (status == 0) result["error"] = "HMI command failed";
                    String out;
                    serializeJson(result, out);
                    httpPostStatus(out);
                }
                else if (action == "SEND") {
                    String data = cmd["data"].as<String>();
                    hmi.println(data);
                    Serial.println("[HMI] Custom data sent: " + data);
                    DynamicJsonDocument result(128);
                    result["request_id"] = req_id;
                    result["status"] = "OK";
                    String out;
                    serializeJson(result, out);
                    httpPostStatus(out);
                }
                else if (action == "CONNECT") {
                    hmi_connected = true;
                    hmi_ip = cmd["hmi_ip"].as<String>();
                    hmi_port = cmd["hmi_port"];
                    Serial.printf("[HMI] Connected to %s:%d\n", hmi_ip.c_str(), hmi_port);
                    DynamicJsonDocument ev(128);
                    ev["event"] = "HMI_CONNECTED";
                    ev["hmi_ip"] = hmi_ip;
                    ev["hmi_port"] = hmi_port;
                    String out;
                    serializeJson(ev, out);
                    httpPostStatus(out);
                    
                    DynamicJsonDocument result(128);
                    result["request_id"] = req_id;
                    result["status"] = "OK";
                    serializeJson(result, out);
                    httpPostStatus(out);
                }
                else if (action == "DISCONNECT") {
                    hmi_connected = false;
                    Serial.println("[HMI] Disconnected");
                    DynamicJsonDocument ev(128);
                    ev["event"] = "HMI_DISCONNECTED";
                    String out;
                    serializeJson(ev, out);
                    httpPostStatus(out);
                    
                    DynamicJsonDocument result(128);
                    result["request_id"] = req_id;
                    result["status"] = "OK";
                    serializeJson(result, out);
                    httpPostStatus(out);
                }
            }
        }
        lastPoll = millis();
    }
    
    // Send heartbeat every 30 seconds
    if (millis() - lastHeartbeat > 30000) {
        DynamicJsonDocument ping(64);
        ping["type"] = "PING";
        String out;
        serializeJson(ping, out);
        httpPostStatus(out);
        lastHeartbeat = millis();
    }
    
    // Forward any unsolicited HMI data
    if (hmi_connected && hmi.available()) {
        String line = hmi.readStringUntil('\n');
        if (line.length()) {
            DynamicJsonDocument event(256);
            event["event"] = "HMI_RX";
            event["data"] = line;
            String out;
            serializeJson(event, out);
            httpPostStatus(out);
            Serial.print("[HMI] ->: ");
            Serial.println(line);
        }
    }
    
    delay(10);
}