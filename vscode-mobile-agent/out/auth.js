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
exports.authToken = void 0;
exports.initializeAuth = initializeAuth;
exports.validateToken = validateToken;
exports.showQRCodeWebview = showQRCodeWebview;
const vscode = __importStar(require("vscode"));
const crypto = __importStar(require("crypto"));
const QRCode = __importStar(require("qrcode"));
const os = __importStar(require("os"));
const server_1 = require("./server");
exports.authToken = '';
async function initializeAuth(context) {
    let savedToken = context.globalState.get('mobileAgentAuthToken');
    if (!savedToken) {
        savedToken = crypto.randomBytes(32).toString('hex');
        await context.globalState.update('mobileAgentAuthToken', savedToken);
    }
    exports.authToken = savedToken;
}
function validateToken(token) {
    return token === exports.authToken;
}
function getLocalIPAddresses() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        if (!iface)
            continue;
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                ips.push(alias.address);
            }
        }
    }
    return ips.length > 0 ? ips : ['127.0.0.1'];
}
async function showQRCodeWebview(context) {
    const ips = getLocalIPAddresses();
    // Prioritize standard local networks over VPNs like Tailscale
    const primaryIp = ips.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.')) || ips[0];
    // Prioritize HTTPS tunnel for Web Speech API
    const baseUrl = server_1.activeTunnelUrl ? server_1.activeTunnelUrl : `http://${primaryIp}:8333`;
    const url = `${baseUrl}?token=${exports.authToken}`;
    const panel = vscode.window.createWebviewPanel('mobileAgentQR', 'Mobile Agent Pairing', vscode.ViewColumn.One, { enableScripts: true });
    try {
        const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#09090b', light: '#f4f4f5' } });
        panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Mobile Agent Pairing</title>
                <style>
                    body {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        font-family: var(--vscode-font-family);
                    }
                    .qr-container {
                        background: #f4f4f5;
                        padding: 16px;
                        border-radius: 12px;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                        margin-bottom: 24px;
                    }
                    h2 { margin-bottom: 8px; }
                    p { margin-bottom: 24px; opacity: 0.8; text-align: center; max-width: 400px; }
                </style>
            </head>
            <body>
                <h2>Scan to Connect</h2>
                <p>Scan this QR code with your phone's camera to securely pair it with your VS Code environment.</p>
                <div class="qr-container">
                    <img src="${qrDataUrl}" alt="QR Code" />
                </div>
                <div style="font-size: 0.9em; text-align: center;">
                    <p style="margin-bottom: 8px;">Or visit manually:</p>
                    ${server_1.activeTunnelUrl ? `<a href="${url}" style="color: var(--vscode-textLink-foreground); display: block; margin-bottom: 4px; word-break: break-all;">${url}</a>` : ''}
                    ${ips.map(ip => `<a href="http://${ip}:8333?token=${exports.authToken}" style="color: var(--vscode-textLink-foreground); display: block; margin-bottom: 4px; word-break: break-all;">http://${ip}:8333?token=${exports.authToken}</a>`).join('')}
                </div>
            </body>
            </html>
        `;
    }
    catch (err) {
        vscode.window.showErrorMessage('Failed to generate QR Code.');
    }
}
//# sourceMappingURL=auth.js.map