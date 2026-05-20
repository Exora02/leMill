import express = require('express');
import * as http from 'http';
import * as WebSocket from 'ws';
import * as path from 'path';
import * as vscode from 'vscode';
import { handleAgentMessage } from './agent';

let server: http.Server | null = null;
let wss: WebSocket.Server | null = null;

export function startServer(context: vscode.ExtensionContext): number {
    if (server) {
        vscode.window.showInformationMessage('Mobile Agent Server is already running.');
        return (server.address() as any).port;
    }

    const app = express();
    app.use(express.static(path.join(context.extensionPath, 'public')));
    app.use(express.json());

    server = http.createServer(app);
    wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        console.log('Mobile Agent connected.');
        
        ws.on('message', async (message: string) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'chat') {
                    // Send message to the agent, providing a callback to stream chunks back to the client
                    await handleAgentMessage(data.text, (chunk: string) => {
                        ws.send(JSON.stringify({ type: 'chunk', text: chunk }));
                    });
                    
                    // Signal the end of the stream
                    ws.send(JSON.stringify({ type: 'done' }));
                }
            } catch (err: any) {
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

export function stopServer() {
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
