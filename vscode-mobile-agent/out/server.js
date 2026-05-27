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
const fs = __importStar(require("fs"));
const agent_1 = require("./agent");
const auth_1 = require("./auth");
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
async function startServer(context) {
    await (0, agent_1.initializeAgent)(context);
    attemptBecomeHub(context);
}
function attemptBecomeHub(context) {
    const app = express();
    // Dynamically serve manifest to bake in the token for iOS PWA sandboxes
    app.get('/manifest.json', (req, res) => {
        const token = req.query.token || '';
        res.json({
            "name": "VS Code Mobile Agent",
            "short_name": "Mobile Agent",
            "description": "Control your VS Code workspace remotely with AI.",
            "start_url": `/?token=${token}`,
            "display": "standalone",
            "background_color": "#09090b",
            "theme_color": "#09090b",
            "icons": [
                {
                    "src": "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='192' height='192' viewBox='0 0 24 24' fill='none' stroke='%23ffffff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 2a10 10 0 1 0 10 10H12V2z'/></svg>",
                    "sizes": "192x192",
                    "type": "image/svg+xml",
                    "purpose": "any maskable"
                }
            ]
        });
    });
    // Dynamically serve index.html to inject the manifest token before browser parses it
    app.get('/', (req, res) => {
        try {
            let html = fs.readFileSync(path.join(context.extensionPath, 'public', 'index.html'), 'utf-8');
            const token = req.query.token || '';
            if (token) {
                html = html.replace('href="manifest.json"', `href="manifest.json?token=${token}"`);
            }
            res.send(html);
        }
        catch (e) {
            res.status(500).send('Error loading UI');
        }
    });
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
            const url = new URL(req.url || '', 'http://localhost');
            if (url.pathname === '/worker') {
                handleWorkerConnection(ws);
            }
            else {
                const token = url.searchParams.get('token');
                if (!token || !(0, auth_1.validateToken)(token)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Authentication failed. Please scan the QR code from VS Code.' }));
                    ws.close(1008, 'Authentication Failed');
                    return;
                }
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
    // Send immediate session list and model list
    const list = Array.from(activeSessions.entries()).map(([id, s]) => ({ id, name: s.name }));
    ws.send(JSON.stringify({ type: 'sessionList', sessions: list }));
    ws.send(JSON.stringify({ type: 'modelList', models: (0, agent_1.getCachedModels)() }));
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
                    await (0, agent_1.handleAgentMessage)(msg.text, msg.model, (evt) => {
                        phoneClients.forEach(c => {
                            if (c.readyState === ws_1.WebSocket.OPEN)
                                c.send(JSON.stringify(evt));
                        });
                    });
                    phoneClients.forEach(c => {
                        if (c.readyState === ws_1.WebSocket.OPEN)
                            c.send(JSON.stringify({ type: 'done' }));
                    });
                }
                else if (msg.type === 'getHistory') {
                    const agent = require('./agent');
                    ws.send(JSON.stringify({ type: 'history', history: agent.getConversationHistory(), isGenerating: agent.isGenerating, ongoingText: agent.ongoingAssistantMessage }));
                }
                else if (msg.type === 'actionResponse') {
                    (0, agent_1.handleActionResponse)(msg.actionId, msg.approved);
                }
                else if (msg.type === 'saveSettings') {
                    (0, agent_1.handleSettings)(msg.provider, msg.apiKey);
                }
                else if (msg.type === 'clear') {
                    require('./agent').clearConversationHistory();
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
                    await (0, agent_1.handleAgentMessage)(payload.text, payload.model, (evt) => {
                        workerWs.send(JSON.stringify({ type: 'forwardToPhone', payload: evt }));
                    });
                    workerWs.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'done' } }));
                }
                else if (payload.type === 'getHistory') {
                    const agent = require('./agent');
                    workerWs.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'history', history: agent.getConversationHistory(), isGenerating: agent.isGenerating, ongoingText: agent.ongoingAssistantMessage } }));
                }
                else if (payload.type === 'actionResponse') {
                    (0, agent_1.handleActionResponse)(payload.actionId, payload.approved);
                }
                else if (payload.type === 'saveSettings') {
                    (0, agent_1.handleSettings)(payload.provider, payload.apiKey);
                }
                else if (payload.type === 'clear') {
                    require('./agent').clearConversationHistory();
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