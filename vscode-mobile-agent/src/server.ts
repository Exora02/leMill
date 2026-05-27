import express = require('express');
import * as http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { handleAgentMessage, getConversationHistory, handleActionResponse, initializeAgent, getCachedModels, handleSettings } from './agent';
import { validateToken } from './auth';
import localtunnel from 'localtunnel';

let isHub = false;
let hubServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let workerWs: WebSocket | null = null;
export let activeTunnelUrl: string | null = null;
let tunnel: localtunnel.Tunnel | null = null;

// Unique ID for this specific VS Code window session
const sessionId = crypto.randomUUID();

function getWorkspaceName() {
    return vscode.workspace.name || 'Untitled Workspace';
}

const activeSessions = new Map<string, { ws: WebSocket | 'local', name: string }>();
const phoneClients = new Set<WebSocket>();

export async function startServer(context: vscode.ExtensionContext) {
    await initializeAgent(context);
    attemptBecomeHub(context);
}

function attemptBecomeHub(context: vscode.ExtensionContext) {
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
        } catch (e) {
            res.status(500).send('Error loading UI');
        }
    });

    app.use(express.static(path.join(context.extensionPath, 'public')));
    app.use(express.json());

    const port = 8333;
    const server = http.createServer(app);
    
    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
            console.log('Port 8333 in use. Becoming a Worker.');
            becomeWorker(context);
        }
    });

    server.listen(port, '0.0.0.0', async () => {
        console.log(`Became Hub on port ${port}.`);
        isHub = true;
        hubServer = server;
        wss = new WebSocketServer({ server });
        
        // Register self as local session
        activeSessions.set(sessionId, { ws: 'local', name: getWorkspaceName() });

        wss.on('connection', (ws, req) => {
            const url = new URL(req.url || '', 'http://localhost');
            if (url.pathname === '/worker') {
                handleWorkerConnection(ws);
            } else {
                const token = url.searchParams.get('token');
                if (!token || !validateToken(token)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Authentication failed. Please scan the QR code from VS Code.' }));
                    ws.close(1008, 'Authentication Failed');
                    return;
                }
                handlePhoneConnection(ws);
            }
        });
        
        try {
            tunnel = await localtunnel({ port });
            activeTunnelUrl = tunnel.url;
            vscode.window.showInformationMessage(`Mobile Agent Hub started. Tunnel active: ${tunnel.url}`);
        } catch (err: any) {
            console.error('Tunnel failed', err);
            vscode.window.showWarningMessage('Failed to establish HTTPS tunnel. Microphone STT features may be blocked on mobile.');
        }
    });
}

function broadcastSessionList() {
    const list = Array.from(activeSessions.entries()).map(([id, s]) => ({ id, name: s.name }));
    const msg = JSON.stringify({ type: 'sessionList', sessions: list });
    phoneClients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
    });
}

function handleWorkerConnection(ws: WebSocket) {
    let workerId = '';
    ws.on('message', (msgStr: string) => {
        try {
            const msg = JSON.parse(msgStr.toString());
            if (msg.type === 'register') {
                workerId = msg.sessionId;
                activeSessions.set(workerId, { ws, name: msg.name });
                broadcastSessionList();
            } else if (msg.type === 'forwardToPhone') {
                // Forward directly to all phone clients
                phoneClients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg.payload));
                });
            }
        } catch(e) {}
    });
    
    ws.on('close', () => {
        if (workerId) activeSessions.delete(workerId);
        broadcastSessionList();
    });
}

function handlePhoneConnection(ws: WebSocket) {
    phoneClients.add(ws);
    
    // Send immediate session list and model list
    const list = Array.from(activeSessions.entries()).map(([id, s]) => ({ id, name: s.name }));
    ws.send(JSON.stringify({ type: 'sessionList', sessions: list }));
    ws.send(JSON.stringify({ type: 'modelList', models: getCachedModels() }));

    ws.on('message', async (msgStr: string) => {
        try {
            const msg = JSON.parse(msgStr.toString());
            const targetSessionId = msg.sessionId;
            
            if (!targetSessionId || !activeSessions.has(targetSessionId)) {
                ws.send(JSON.stringify({ type: 'error', text: 'Invalid or disconnected session selected.' }));
                return;
            }
            
            const session = activeSessions.get(targetSessionId)!;
            
            if (session.ws === 'local') {
                // Handle locally in this window (The Hub's own workspace)
                if (msg.type === 'chat') {
                    await handleAgentMessage(msg.text, msg.model, (evt: any) => {
                        phoneClients.forEach(c => {
                            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(evt));
                        });
                    });
                    phoneClients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'done' }));
                    });
                } else if (msg.type === 'getHistory') {
                    const agent = require('./agent');
                    ws.send(JSON.stringify({ type: 'history', history: agent.getConversationHistory(), isGenerating: agent.isGenerating, ongoingText: agent.ongoingAssistantMessage }));
                } else if (msg.type === 'actionResponse') {
                    handleActionResponse(msg.actionId, msg.approved);
                } else if (msg.type === 'saveSettings') {
                    handleSettings(msg.provider, msg.apiKey);
                } else if (msg.type === 'clear') {
                    require('./agent').clearConversationHistory();
                }
            } else {
                // Forward to the specific worker
                session.ws.send(JSON.stringify({ type: 'forwardToWorker', payload: msg }));
            }
        } catch(e) {}
    });

    ws.on('close', () => phoneClients.delete(ws));
}

function becomeWorker(context: vscode.ExtensionContext) {
    isHub = false;
    workerWs = new WebSocket('ws://localhost:8333/worker');
    
    workerWs!.on('open', () => {
        console.log('Connected to Hub as Worker.');
        workerWs!.send(JSON.stringify({ type: 'register', sessionId, name: getWorkspaceName() }));
    });
    
    workerWs!.on('message', async (msgStr: string) => {
        try {
            const msg = JSON.parse(msgStr.toString());
            if (msg.type === 'forwardToWorker') {
                const payload = msg.payload;
                if (payload.type === 'chat') {
                    await handleAgentMessage(payload.text, payload.model, (evt: any) => {
                        workerWs!.send(JSON.stringify({ type: 'forwardToPhone', payload: evt }));
                    });
                    workerWs!.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'done' } }));
                } else if (payload.type === 'getHistory') {
                    const agent = require('./agent');
                    workerWs!.send(JSON.stringify({ type: 'forwardToPhone', payload: { type: 'history', history: agent.getConversationHistory(), isGenerating: agent.isGenerating, ongoingText: agent.ongoingAssistantMessage } }));
                } else if (payload.type === 'actionResponse') {
                    handleActionResponse(payload.actionId, payload.approved);
                } else if (payload.type === 'saveSettings') {
                    handleSettings(payload.provider, payload.apiKey);
                } else if (payload.type === 'clear') {
                    require('./agent').clearConversationHistory();
                }
            }
        } catch(e) {}
    });
    
    workerWs!.on('close', () => {
        console.log('Lost connection to Hub. Attempting to become Hub...');
        workerWs = null;
        // Wait a random short delay to prevent collisions if multiple workers try to become Hub at once
        setTimeout(() => {
            attemptBecomeHub(context);
        }, 1000 + Math.random() * 2000);
    });
    
    workerWs!.on('error', () => {
        // Error will trigger close anyway
    });
}

export function stopServer() {
    if (tunnel) {
        tunnel.close();
        tunnel = null;
    }
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
