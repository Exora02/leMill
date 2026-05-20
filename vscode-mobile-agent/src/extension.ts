import * as vscode from 'vscode';
import { startServer, stopServer } from './server';

export function activate(context: vscode.ExtensionContext) {
    console.log('Mobile Agent Extension is now active!');

    let startCmd = vscode.commands.registerCommand('vscode-mobile-agent.startServer', () => {
        startServer(context).catch(console.error);
    });

    context.subscriptions.push(startCmd);
    
    // Auto-start server for convenience
    startServer(context).catch(console.error);
}

export function deactivate() {
    stopServer();
}
