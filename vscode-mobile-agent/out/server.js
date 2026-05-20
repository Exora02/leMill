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
const WebSocket = __importStar(require("ws"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const agent_1 = require("./agent");
let server = null;
let wss = null;
function startServer(context) {
    if (server) {
        vscode.window.showInformationMessage('Mobile Agent Server is already running.');
        return server.address().port;
    }
    const app = express();
    app.use(express.static(path.join(context.extensionPath, 'public')));
    app.use(express.json());
    server = http.createServer(app);
    wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
        console.log('Mobile Agent connected.');
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'chat') {
                    // Send message to the agent, providing a callback to stream chunks back to the client
                    await (0, agent_1.handleAgentMessage)(data.text, (chunk) => {
                        ws.send(JSON.stringify({ type: 'chunk', text: chunk }));
                    });
                    // Signal the end of the stream
                    ws.send(JSON.stringify({ type: 'done' }));
                }
            }
            catch (err) {
                console.error('Error handling message:', err);
                ws.send(JSON.stringify({ type: 'error', text: err.message }));
            }
        });
        ws.on('close', () => {
            console.log('Mobile Agent disconnected.');
        });
    });
    const port = 8333; // Fixed port for ease of use, or we can use 0 for random
    server.listen(port, '0.0.0.0', () => {
        vscode.window.showInformationMessage(`Mobile Agent Server started on port ${port}. Connect via http://<YOUR_IP>:${port}`);
    });
    return port;
}
function stopServer() {
    if (wss) {
        wss.close();
        wss = null;
    }
    if (server) {
        server.close();
        server = null;
        vscode.window.showInformationMessage('Mobile Agent Server stopped.');
    }
}
//# sourceMappingURL=server.js.map