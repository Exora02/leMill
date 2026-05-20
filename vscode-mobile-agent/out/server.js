"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
exports.stopServer = stopServer;
const express = require("express");
const http = __importStar(require("http"));
const ws_1 = require("ws");
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const crypto = __importStar(require("crypto"));
const agent_1 = require("./agent");
let isHub = false;
let hubServer = null;
let wss = null;
let workerWs = null;
// Unique ID for this specific VS Code window session
const sessionId = crypto.randomUUID();
function getWorkspaceName() {
    return vscode.workspace.name || 'Untitled Workspace';
}
const activeSessions = new Map();
const phoneClients = new Set();
function startServer(context) {
    attemptBecomeHub(context);
}
function attemptBecomeHub(context) {
    const app = express();
    app.use(express.static(path.join(context.extensionPath, 'public')));
    app.use(express.json());
    const port = 8333;
    const server = http.createServer(app);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log('Port 8333 in use. Becoming a Worker.');
            becomeWorker(context);
        }
    });
    server.listen(port, '0.0.0.0', () => {
        console.log(`Became Hub on port ${port}.`);
        isHub = true;
        hubServer = server;
        wss = new ws_1.WebSocketServer({ server });
        // Register self as local session
        activeSessions.set(sessionId, { ws: 'local', name: getWorkspaceName() });
        wss.on('connection', (ws, req) => {
            if (req.url === '/worker') {
                handleWorkerConnection(ws);
            }
            else {
                handlePhoneConnection(ws);
            }
        });
        vscode.window.showInformationMessage(`Mobile Agent Hub started on port ${port}.`);
    });
}
function broadcastSessionList() {
    const list = Array.from(activeSessions.entries()).map(([id, s]) => ({ id, name: s.name }));
    const msg = JSON.stringify({ type: 'sessionList', sessions: list });
    phoneClients.forEach(c => {
        if (c.readyState === ws_1.WebSocket.OPEN)
            c.send(msg);
    });
}
function handleWorkerConnection(ws) {
    let workerId = '';
    ws.on('message', (msgStr) => {
        try {
            const msg = JSON.parse(msgStr.toString());
            if (msg.type === 'register') {
                workerId = msg.sessionId;
                activeSessions.set(workerId, { ws, name: msg.name });
                broadcastSessionList();
            }
            else if (msg.type === 'forwardToPhone') {
                // Forward directly to all phone clients
                phoneClients.forEach(c => {
                    if (c.readyState === ws_1.WebSocket.OPEN)
                        c.send(JSON.stringify(msg.payload));
                });
            }
        }
        catch (e) { }
    });
    ws.on('close', () => {
        if (workerId)
            activeSessions.delete(workerId);
        broadcastSessionList();
    });
}
function handlePhoneConnection(ws) {
    phoneClients.add(ws);
    // Send immediate session list
    const list = Array.from(activeSessions.entries()).map(([id, s]) => ({ id, name: s.name }));
    ws.send(JSON.stringify({ type: 'sessionList', sessions: list }));
    ws.on('message', async (msgStr) => {
        try {
            const msg = JSON.parse(msgStr.toString());
            const targetSessionId = msg.sessionId;
            if (!targetSessionId || !activeSessions.has(targetSessionId)) {
                ws.send(JSON.stringify({ type: 'error', text: 'Invalid or disconnected session selected.' }));
                return;
            }
            const session = activeSessions.get(targetSessionId);
            if (session.ws === 'local') {
                // Handle locally in this window (The Hub's own workspace)
                if (msg.type === 'chat') {
                    await (0, agent_1.handleAgentMessage)(msg.text, (chunk) => {
                        ws.send(JSON.stringify({ type: 'chunk', text: chunk }));
                    });
                    ws.send(JSON.stringify({ type: 'done' }));
                }
                else if (msg.type === 'getHistory') {
                    ws.send(JSON.stringify({ type: 'history', history: (0, agent_1.getConversationHistory)() }));
                }
            }
            else {
                // Forward to the specific worker
                session.ws.send(JSON.stringify({ type: 'forwardToWorker', payload: msg }));
            }
        }
        catch (e) { }
    });
    ws.on('close', () => phoneClients.delete(ws));
}
function becomeWorker(context) {
    isHub = false;
    workerWs = new ws_1.WebSocket('ws://localhost:8333/worker');
    workerWs.on('open', () => {
        console.log('Connected to Hub as Worker.');
        workerWs.send(JSON.stringify({ type: 'register', sessionId, name: getWorkspaceName() }));
    });
    workerWs.on('message', async (msgStr) => {
        try {
            const msg = JSON.parse(msgStr.toString());
            if (msg.type === 'forwardToWorker') {
                const payload = msg.payload;
                if (payload.type === 'chat') {
                    await (0, agent_1.handleAgentMessage)(payload.text, (chunk) => {
                        workerWs.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'chunk', text: chunk } }));
                    });
                    workerWs.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'done' } }));
                }
                else if (payload.type === 'getHistory') {
                    workerWs.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'history', history: (0, agent_1.getConversationHistory)() } }));
                }
            }
        }
        catch (e) { }
    });
    workerWs.on('close', () => {
        console.log('Lost connection to Hub. Attempting to become Hub...');
        workerWs = null;
        // Wait a random short delay to prevent collisions if multiple workers try to become Hub at once
        setTimeout(() => {
            attemptBecomeHub(context);
        }, 1000 + Math.random() * 2000);
    });
    workerWs.on('error', () => {
        // Error will trigger close anyway
    });
}
function stopServer() {
    if (workerWs) {
        workerWs.close();
        workerWs = null;
    }
    if (wss) {
        wss.close();
        wss = null;
    }
    if (hubServer) {
        hubServer.close();
        hubServer = null;
    }
}
//# sourceMappingURL=server.js.map