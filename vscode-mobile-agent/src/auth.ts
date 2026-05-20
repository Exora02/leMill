import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';
import * as os from 'os';

export let authToken: string = '';

export async function initializeAuth(context: vscode.ExtensionContext) {
    let savedToken = context.globalState.get<string>('mobileAgentAuthToken');
    if (!savedToken) {
        savedToken = crypto.randomBytes(32).toString('hex');
        await context.globalState.update('mobileAgentAuthToken', savedToken);
    }
    authToken = savedToken;
}

export function validateToken(token: string): boolean {
    return token === authToken;
}

function getLocalIPAddresses(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        if (!iface) continue;
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                ips.push(alias.address);
            }
        }
    }
    return ips.length > 0 ? ips : ['127.0.0.1'];
}

export async function showQRCodeWebview(context: vscode.ExtensionContext) {
    const ips = getLocalIPAddresses();
    // Prioritize standard local networks over VPNs like Tailscale
    const primaryIp = ips.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.')) || ips[0];
    const url = `http://${primaryIp}:8333?token=${authToken}`;

    const panel = vscode.window.createWebviewPanel(
        'mobileAgentQR',
        'Mobile Agent Pairing',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

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
                    ${ips.map(ip => `<a href="http://${ip}:8333?token=${authToken}" style="color: var(--vscode-textLink-foreground); display: block; margin-bottom: 4px; word-break: break-all;">http://${ip}:8333?token=${authToken}</a>`).join('')}
                </div>
            </body>
            </html>
        `;
    } catch (err) {
        vscode.window.showErrorMessage('Failed to generate QR Code.');
    }
}
