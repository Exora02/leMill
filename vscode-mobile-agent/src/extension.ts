import * as vscode from 'vscode';
import { startServer, stopServer } from './server';
import { initializeAuth, showQRCodeWebview } from './auth';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Mobile Agent Extension is now active!');
    
    await initializeAuth(context);

    let startCmd = vscode.commands.registerCommand('vscode-mobile-agent.startServer', () => {
        startServer(context).catch(console.error);
    });

    let qrCmd = vscode.commands.registerCommand('vscode-mobile-agent.showQRCode', () => {
        showQRCodeWebview(context).catch(console.error);
    });

    context.subscriptions.push(startCmd, qrCmd);
    
    // Auto-start server for convenience
    startServer(context).catch(console.error);
}

export function deactivate() {
    stopServer();
}
