// esp32_firebase_poller.ino
// Uses AT+QHTTP for HTTPS, ignores certificate errors
#define TINY_GSM_MODEM_QUECTEL_EC200U
#include <Arduino.h>
#include <ArduinoJson.h>

// ========== Pins ==========
#define SIM_RX          16
#define SIM_TX          17
#define HMI_RX          4
#define HMI_TX          2
#define EC200U_PWRKEY   5

HardwareSerial sim(2);
HardwareSerial hmi(1);

// ========== Firebase configuration ==========
const char* firebase_host = "laser-control-default-rtdb.firebaseio.com";
const char* auth_host     = "identitytoolkit.googleapis.com";
const char* web_api_key   = "AIzaSyA5FXBzy1mjHh5fWIzU_uUrQ53C0BC9Qeg"; // from your web config
const char* device_email  = "esp32@laser-control.com";
const char* device_pass   = "StrongPass123";   // the password you set in Firebase Auth

// ========== APN list ==========
const char* apn_list[] = {"jionet", "airtelgprs.com", "www", "internet"};
const int apn_count = 4;

String idToken = "";
unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;
int failCount = 0;

// -------------- AT helpers (same as before) --------------
String readSimResponse(unsigned long timeoutMs = 5000) {
    String resp = "";
    unsigned long start = millis();
    while (millis() - start < timeoutMs) {
        while (sim.available()) {
            char c = sim.read();
            resp += c;
            if (resp.endsWith("\r\nOK\r\n") || resp.endsWith("\r\nERROR\r\n"))
                return resp;
        }
    }
    return resp;
}

bool sendAT(const String& cmd, const String& expected, unsigned long timeoutMs = 5000) {
    sim.println(cmd);
    String resp = readSimResponse(timeoutMs);
    Serial.println("→ " + cmd);
    Serial.println("← " + resp);
    return (resp.indexOf(expected) != -1);
}

void powerOnEC200U() {
    pinMode(EC200U_PWRKEY, OUTPUT);
    digitalWrite(EC200U_PWRKEY, LOW);
    delay(1000);
    digitalWrite(EC200U_PWRKEY, HIGH);
    delay(2000);
    Serial.println("[EC200U] Power toggled");
}

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

bool activatePDP(const String& apn) {
    Serial.printf("[NET] Trying APN: %s\n", apn.c_str());
    sendAT("AT+QIDEACT=1", "OK", 5000);
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
    return false;
}

bool setupInternet() {
    Serial.println("=== EC200U Setup ===");
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

    for (int i = 0; i < apn_count; i++) {
        if (activatePDP(apn_list[i])) return true;
        delay(1000);
    }
    return false;
}

// ---------- HTTPS request using AT+QHTTP ----------
String httpsRequest(const String& url, const String& method, const String& authToken = "", const String& body = "") {
    sendAT("AT+QHTTPCFG=\"contextid\",1", "OK", 2000);
    sendAT("AT+QHTTPCFG=\"responseheader\",0", "OK", 2000);
    sendAT("AT+QHTTPCFG=\"sslctxid\",1", "OK", 2000);
    sendAT("AT+QSSLCFG=\"seclevel\",1,0", "OK", 2000);   // ignore cert errors
    if (method == "POST" || method == "PATCH") {
        sendAT("AT+QHTTPCFG=\"contenttype\",1", "OK", 2000);
    }

    sim.println("AT+QHTTPURL=" + String(url.length()) + ",80");
    String resp = readSimResponse(5000);
    if (resp.indexOf("CONNECT") == -1) {
        Serial.println("[HTTPS] URL CONNECT failed");
        return "";
    }
    sim.print(url);
    readSimResponse(2000);

    // Build HTTP request line (simplified)
    String request = method + " " + url.substring(url.indexOf('/', 8)) + " HTTP/1.1\r\n";
    request += "Host: " + String(firebase_host) + "\r\n";
    if (authToken.length() > 0) request += "Authorization: Bearer " + authToken + "\r\n";
    request += "Content-Type: application/json\r\n";
    if (body.length() > 0) request += "Content-Length: " + String(body.length()) + "\r\n";
    request += "Connection: close\r\n\r\n";
    if (body.length() > 0) request += body;

    sim.println("AT+QHTTPPOST=" + String(request.length()) + ",30,30");
    resp = readSimResponse(5000);
    if (resp.indexOf("CONNECT") == -1) {
        Serial.println("[HTTPS] POST CONNECT failed");
        return "";
    }
    sim.print(request);
    resp = readSimResponse(35000);
    if (resp.indexOf("+QHTTPPOST: 0,200") == -1) {
        Serial.println("[HTTPS] Request failed");
        return "";
    }

    sim.println("AT+QHTTPREAD=30");
    resp = readSimResponse(10000);
    int start = resp.indexOf('{');
    int end = resp.lastIndexOf('}');
    if (start != -1 && end != -1 && end > start) {
        return resp.substring(start, end + 1);
    }
    return "";
}

// ---------- Firebase Authentication ----------
bool authenticateFirebase() {
    String url = "https://" + String(auth_host) + "/v1/accounts:signInWithPassword?key=" + String(web_api_key);
    String body = "{\"email\":\"" + String(device_email) + "\",\"password\":\"" + String(device_pass) + "\",\"returnSecureToken\":true}";
    String response = httpsRequest(url, "POST", "", body);
    if (response.length() == 0) return false;
    DynamicJsonDocument doc(512);
    deserializeJson(doc, response);
    if (doc.containsKey("idToken")) {
        idToken = doc["idToken"].as<String>();
        Serial.println("[FIREBASE] Authenticated");
        return true;
    }
    return false;
}

// ---------- Poll command ----------
String pollCommand(String& cmdId) {
    if (idToken.length() == 0) return "";
    String url = "https://" + String(firebase_host) + "/commands/esp32_001.json?orderBy=\"$key\"&limitToFirst=1&auth=" + idToken;
    String response = httpsRequest(url, "GET", idToken);
    if (response.length() == 0 || response == "null") return "";
    DynamicJsonDocument doc(256);
    deserializeJson(doc, response);
    JsonObject obj = doc.as<JsonObject>();
    for (JsonPair kv : obj) {
        cmdId = kv.key().c_str();
        String cmdObj = kv.value().as<String>();
        return cmdObj;
    }
    return "";
}

void deleteCommand(const String& cmdId) {
    String url = "https://" + String(firebase_host) + "/commands/esp32_001/" + cmdId + ".json?auth=" + idToken;
    httpsRequest(url, "DELETE", idToken);
    Serial.println("[FIREBASE] Deleted command " + cmdId);
}

void updateStatus(const String& key, const String& value) {
    String url = "https://" + String(firebase_host) + "/status/esp32_001.json?auth=" + idToken;
    String body = "{\"" + key + "\":\"" + value + "\"}";
    httpsRequest(url, "PATCH", idToken, body);
}

// ---------- HMI command execution ----------
void executeCommand(const String& cmdJson) {
    DynamicJsonDocument doc(256);
    DeserializationError err = deserializeJson(doc, cmdJson);
    String cmd;
    if (!err && doc.containsKey("cmd")) {
        cmd = doc["cmd"].as<String>();
    } else {
        cmd = cmdJson;
    }
    Serial.print("[HMI] Execute: ");
    Serial.println(cmd);

    if (cmd == "START") {
        uint8_t frame[] = {0x02, 0x07, 0x73, 0x74, 0x61, 0x72, 0x74, 0x3A, 0x03};
        hmi.write(frame, sizeof(frame));
    } else if (cmd == "STOP") {
        uint8_t frame[] = {0x02, 0x06, 0x73, 0x74, 0x6F, 0x70, 0x3A, 0x03};
        hmi.write(frame, sizeof(frame));
    } else if (cmd == "CONNECT") {
        // optional: store HMI IP/port
    } else if (cmd == "SEND" && doc.containsKey("data")) {
        hmi.println(doc["data"].as<String>());
    }
    updateStatus("lastCommandResult", cmd + "_OK");
}

// ---------- Setup ----------
void setup() {
    Serial.begin(115200);
    hmi.begin(115200, SERIAL_8N1, HMI_RX, HMI_TX);
    sim.begin(115200, SERIAL_8N1, SIM_RX, SIM_TX);
    delay(2000);
    Serial.println("\n=== ESP32 Firebase Poller ===");

    if (!setupInternet()) {
        Serial.println("[FATAL] No internet – restarting");
        delay(5000);
        ESP.restart();
    }
    if (!authenticateFirebase()) {
        Serial.println("[FATAL] Auth failed – restarting");
        delay(5000);
        ESP.restart();
    }
    updateStatus("online", "true");
    updateStatus("hmiConnected", "false");
    updateStatus("lastHeartbeat", String(millis() / 1000));
    lastPoll = millis() - 3000;
    lastHeartbeat = millis();
    Serial.println("[OK] Ready");
}

// ---------- Loop ----------
void loop() {
    if (idToken.length() == 0) {
        if (!authenticateFirebase()) {
            delay(10000);
            return;
        }
    }
    if (millis() - lastPoll > 3000) {
        String cmdId;
        String cmdJson = pollCommand(cmdId);
        if (cmdJson.length() > 0) {
            executeCommand(cmdJson);
            deleteCommand(cmdId);
        }
        lastPoll = millis();
    }
    if (millis() - lastHeartbeat > 30000) {
        updateStatus("lastHeartbeat", String(millis() / 1000));
        lastHeartbeat = millis();
    }
    delay(10);
}