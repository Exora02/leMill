import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';

let extensionContext: vscode.ExtensionContext | null = null;
let cachedModels: any[] = [];

// Pending Actions Map
const pendingActions = new Map<string, (approved: boolean) => void>();

export function handleActionResponse(actionId: string, approved: boolean) {
    const resolver = pendingActions.get(actionId);
    if (resolver) {
        resolver(approved);
        pendingActions.delete(actionId);
    }
}

export interface ChatHistoryItem {
    role: 'user' | 'assistant';
    text: string;
}

export let conversationHistory: ChatHistoryItem[] = [];

export async function initializeAgent(context: vscode.ExtensionContext) {
    extensionContext = context;
    // Load history
    const savedHistory = context.workspaceState.get<ChatHistoryItem[]>('agentConversationHistory');
    if (savedHistory) {
        conversationHistory = savedHistory;
    }
    
    // Fetch OpenRouter Models
    try {
        const config = vscode.workspace.getConfiguration('vscode-mobile-agent');
        const apiKey = config.get<string>('apiKey');
        if (apiKey) {
            const resp = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (resp.ok) {
                const data: any = await resp.json();
                cachedModels = data.data
                    .filter((m: any) => 
                        m.id.startsWith('openai/') || 
                        m.id.startsWith('anthropic/') || 
                        m.id.startsWith('google/') || 
                        m.id.startsWith('deepseek/') ||
                        m.id.startsWith('meta-llama/')
                    )
                    .slice(0, 25)
                    .map((m: any) => ({
                        id: m.id,
                        name: m.name.replace(' (beta)', '').substring(0, 30) // shorten long names
                    }));
            }
        }
    } catch(e) {
        console.error('Failed to fetch models:', e);
    }
}

export function getCachedModels() {
    return cachedModels;
}

export function getConversationHistory() {
    return conversationHistory;
}

function saveConversationHistory() {
    if (extensionContext) {
        extensionContext.workspaceState.update('agentConversationHistory', conversationHistory);
    }
}

function getSystemPrompt(): string {
    let workspaceInfo = "No workspace folders opened.";
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceInfo = "Available workspace folders (use these absolute paths!):\n" + 
            vscode.workspace.workspaceFolders.map(f => `- ${f.uri.fsPath}`).join('\n');
    }

    return `You are a powerful AI agent running inside the user's VS Code editor. 
The user is talking to you from their phone.

${workspaceInfo}

You have access to the following tools:
1. <call_tool name="readFile">absolute_path_here</call_tool> - Reads a file's content.
2. <call_tool name="listDirectory">absolute_path_here</call_tool> - Lists contents of a directory.
3. <call_tool name="findFiles">glob_pattern</call_tool> - Finds files (e.g. **/*.ts, src/app.js).
4. <call_tool name="createFile">absolute_path|content</call_tool> - Creates a new file with the given content.
5. <call_tool name="replaceLines">absolute_path|startLine|endLine|newContent</call_tool> - Replaces specific lines (1-indexed, inclusive) with new content.
6. <call_tool name="runTerminalCommand">command_here</call_tool> - Runs a shell command. The user will be prompted to approve it on their phone.
7. <call_tool name="getGitDiff"></call_tool> - Gets git status and uncommitted diffs for the workspace.
8. <call_tool name="getDiagnostics"></call_tool> - Gets all compiler/linting errors currently in the workspace.
9. <call_tool name="getCurrentSelection"></call_tool> - Gets the text currently highlighted by the user in their active editor.

To call a tool, output exactly the XML tag above and NOTHING else. Wait for the tool result before continuing.
Do not hallucinate paths like /workspace. ALWAYS use the absolute paths from the Available workspace folders listed above.
If you have the answer, just respond normally.`;
}

async function executeTool(name: string, arg: string, onEvent: (evt: any) => void): Promise<string> {
    try {
        if (name === 'readFile') {
            const data = await fs.readFile(arg.trim(), 'utf-8');
            return data.slice(0, 8000); // Limit size
        } else if (name === 'listDirectory') {
            const files = await fs.readdir(arg.trim());
            return files.join('\n');
        } else if (name === 'findFiles') {
            const uris = await vscode.workspace.findFiles(arg.trim(), '**/node_modules/**', 50);
            if (uris.length === 0) return 'No files found matching that pattern.';
            return uris.map(u => u.fsPath).join('\n');
        } else if (name === 'createFile') {
            const parts = arg.split('|');
            if (parts.length < 2) return 'Error: createFile requires path|content';
            const filePath = parts[0].trim();
            const content = parts.slice(1).join('|'); // Re-join if content had pipes
            await fs.writeFile(filePath, content, 'utf-8');
            return 'File created successfully.';
        } else if (name === 'replaceLines') {
            const parts = arg.split('|');
            if (parts.length < 4) return 'Error: replaceLines requires path|startLine|endLine|newContent';
            const filePath = parts[0].trim();
            const startLine = parseInt(parts[1].trim(), 10);
            const endLine = parseInt(parts[2].trim(), 10);
            const newContent = parts.slice(3).join('|');
            
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            if (startLine < 1 || endLine > lines.length || startLine > endLine) {
                return `Error: Invalid line range. File has ${lines.length} lines.`;
            }
            
            lines.splice(startLine - 1, endLine - startLine + 1, newContent);
            await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
            return 'Lines replaced successfully.';
        } else if (name === 'getGitDiff') {
            return await new Promise<string>((resolve) => {
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                cp.exec('git status -s && git diff', { cwd }, (error, stdout, stderr) => {
                    if (error && !stdout) {
                        resolve(`Git error: ${error.message}\nStderr: ${stderr}`);
                    } else {
                        resolve(stdout ? stdout.slice(0, 8000) : 'No uncommitted changes.');
                    }
                });
            });
        } else if (name === 'runTerminalCommand') {
            const actionId = crypto.randomUUID();
            onEvent({ type: 'promptAction', actionId, command: arg.trim() });
            
            const approved = await new Promise<boolean>((resolve) => {
                pendingActions.set(actionId, resolve);
            });
            
            if (!approved) return 'User DENIED the execution of this command.';
            
            return await new Promise<string>((resolve) => {
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                cp.exec(arg.trim(), { cwd }, (error, stdout, stderr) => {
                    if (error) {
                        resolve(`Command failed: ${error.message}\nStderr: ${stderr}\nStdout: ${stdout}`.slice(0, 5000));
                    } else {
                        resolve(`Command succeeded.\nStdout: ${stdout}`.slice(0, 5000));
                    }
                });
            });
        } else if (name === 'getDiagnostics') {
            const diags = vscode.languages.getDiagnostics();
            let result = '';
            for (const [uri, fileDiags] of diags) {
                if (fileDiags.length > 0) {
                    result += `File: ${uri.fsPath}\n`;
                    for (const d of fileDiags) {
                        result += `  - Line ${d.range.start.line + 1}: ${d.message}\n`;
                    }
                }
            }
            return result || 'No errors or warnings found in the workspace.';
        } else if (name === 'getCurrentSelection') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return 'No active text editor.';
            const selection = editor.selection;
            if (selection.isEmpty) return 'No text is currently highlighted.';
            const text = editor.document.getText(selection);
            return `Highlighted text in ${editor.document.uri.fsPath}:\n${text}`;
        }
    } catch (e: any) {
        return `Error executing ${name}: ${e.message}`;
    }
    return `Unknown tool: ${name}`;
}

export async function handleAgentMessage(userText: string, requestedModel: string, onEvent: (evt: any) => void) {
    try {
        const config = vscode.workspace.getConfiguration('vscode-mobile-agent');
        const apiKey = config.get<string>('apiKey');
        const apiEndpoint = config.get<string>('apiEndpoint') || 'https://openrouter.ai/api/v1/chat/completions';
        
        // Use requestedModel from UI if available and valid, otherwise fallback to settings
        const apiModel = requestedModel || config.get<string>('apiModel') || 'google/gemini-pro';

        let chatModel: any = null;
        let useRestApi = false;

        if (apiKey) {
            useRestApi = true;
        } else {
            const allModels = await vscode.lm.selectChatModels({});
            if (allModels.length === 0) {
                onEvent({ type: 'chunk', text: 'No AI models found in your VS Code, and no API Key is configured.\n\nPlease open VS Code Settings, search for "Mobile Agent", and add an API Key (e.g., OpenRouter) to use Bring-Your-Own-Key (BYOK).' });
                return;
            }
            chatModel = allModels.find(m => m.name.includes('gpt-4') || m.family.includes('gpt-4')) || allModels[0];
        }

        let contextInfo = '';
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            contextInfo += `Currently active file: ${editor.document.uri.fsPath}\n`;
        }
        
        conversationHistory.push({ role: 'user', text: userText });
        saveConversationHistory();

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(getSystemPrompt()),
        ];
        
        for (let i = 0; i < conversationHistory.length; i++) {
            const msg = conversationHistory[i];
            if (msg.role === 'user') {
                if (i === conversationHistory.length - 1) {
                    messages.push(vscode.LanguageModelChatMessage.User(`Workspace Context:\n${contextInfo}\n\nUser: ${msg.text}`));
                } else {
                    messages.push(vscode.LanguageModelChatMessage.User(msg.text));
                }
            } else {
                messages.push(vscode.LanguageModelChatMessage.Assistant(msg.text));
            }
        }

        let maxLoops = 10;
        let finalAssistantText = '';
        
        while (maxLoops > 0) {
            maxLoops--;
            
            let fullResponseText = '';

            if (useRestApi) {
                const apiMessages = messages.map((m, i) => ({
                    role: i === 0 ? 'system' : 
                          (m instanceof vscode.LanguageModelChatMessage && m.role ? 
                          (m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant') : 
                          ((m as any).role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant')),
                    content: m.content instanceof Array ? m.content.map((c:any) => c.value).join('') : typeof m.content === 'string' ? m.content : ''
                }));

                const response = await fetch(apiEndpoint, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'http://localhost:8333',
                        'X-Title': 'VSCode Mobile Agent'
                    },
                    body: JSON.stringify({
                        model: apiModel,
                        messages: apiMessages,
                        stream: true
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    onEvent({ type: 'chunk', text: `API Error: ${response.status} ${response.statusText}\nDetails: ${errText}` });
                    break;
                }

                const reader = response.body?.getReader();
                const decoder = new TextDecoder("utf-8");
                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunkStr = decoder.decode(value);
                        const lines = chunkStr.split('\n');
                        for (const line of lines) {
                            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    const content = data.choices[0]?.delta?.content || '';
                                    if (content) {
                                        fullResponseText += content;
                                        if (!fullResponseText.includes('<call_tool')) {
                                            onEvent({ type: 'chunk', text: content });
                                            finalAssistantText += content;
                                        }
                                    }
                                } catch(e){}
                            }
                        }
                    }
                }
            } else {
                const response = await chatModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                for await (const chunk of response.text) {
                    fullResponseText += chunk;
                    if (!fullResponseText.includes('<call_tool')) {
                        onEvent({ type: 'chunk', text: chunk });
                        finalAssistantText += chunk;
                    }
                }
            }
            
            const toolMatch = fullResponseText.match(/<call_tool name="([^"]+)">([^<]*)<\/call_tool>/);
            if (toolMatch) {
                const toolName = toolMatch[1];
                const toolArg = toolMatch[2];
                const toolLog = `\n[Agent is running tool: ${toolName}(${toolArg})]\n`;
                onEvent({ type: 'chunk', text: toolLog });
                finalAssistantText += toolLog;
                
                const toolResult = await executeTool(toolName, toolArg, onEvent);
                
                messages.push(vscode.LanguageModelChatMessage.Assistant(fullResponseText));
                messages.push(vscode.LanguageModelChatMessage.User(`Tool Result:\n${toolResult}\nContinue your response.`));
                continue; 
            }
            
            if (fullResponseText.includes('<call_tool')) {
                onEvent({ type: 'chunk', text: fullResponseText });
                finalAssistantText += fullResponseText;
            }
            break;
        }

        conversationHistory.push({ role: 'assistant', text: finalAssistantText });
        saveConversationHistory();

    } catch (err: any) {
        onEvent({ type: 'chunk', text: `\nError communicating with LM API: ${err.message}` });
    }
}
