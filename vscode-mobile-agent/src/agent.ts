import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as os from 'os';

let extensionContext: vscode.ExtensionContext | null = null;
let cachedModels: any[] = [];
let activeProvider: string = 'openrouter';

// Pending Actions Map
const pendingActions = new Map<string, (approved: boolean) => void>();

export function handleActionResponse(actionId: string, approved: boolean) {
    const resolver = pendingActions.get(actionId);
    if (resolver) {
        resolver(approved);
        pendingActions.delete(actionId);
    }
}

export async function handleSettings(provider: string, apiKey: string) {
    if (!extensionContext) return;
    activeProvider = provider;
    await extensionContext.globalState.update('agentProvider', provider);
    if (apiKey) {
        await extensionContext.secrets.store(`agentApiKey_${provider}`, apiKey);
    }
    
    // Refresh models if provider changed
    if (provider === 'openrouter') {
        fetchOpenRouterModels(apiKey);
    } else if (provider === 'openai') {
        cachedModels = [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' }];
    } else if (provider === 'anthropic') {
        cachedModels = [{ id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet' }];
    } else if (provider === 'gemini') {
        cachedModels = [{ id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro' }];
    }
}

export interface ChatHistoryItem {
    role: 'user' | 'assistant';
    text: string;
}

export let conversationHistory: ChatHistoryItem[] = [];

async function fetchOpenRouterModels(key: string) {
    try {
        const resp = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` }
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
                    name: m.name.replace(' (beta)', '').substring(0, 30)
                }));
        }
    } catch(e) {}
}

export async function initializeAgent(context: vscode.ExtensionContext) {
    extensionContext = context;
    const savedHistory = context.workspaceState.get<ChatHistoryItem[]>('agentConversationHistory');
    if (savedHistory) {
        conversationHistory = savedHistory;
    }
    
    activeProvider = context.globalState.get<string>('agentProvider') || 'openrouter';
    let apiKey = await context.secrets.get(`agentApiKey_${activeProvider}`);
    
    if (!apiKey) {
        // Fallback to legacy VS Code settings
        const config = vscode.workspace.getConfiguration('vscode-mobile-agent');
        apiKey = config.get<string>('apiKey');
        if (apiKey) {
            // Migrate it securely to SecretStorage
            await context.secrets.store(`agentApiKey_${activeProvider}`, apiKey);
            await config.update('apiKey', undefined, true);
        }
    }
    
    if (activeProvider === 'openrouter' && apiKey) {
        fetchOpenRouterModels(apiKey);
    } else {
        // Just initialize fallback lists
        handleSettings(activeProvider, apiKey || '');
    }
}

export function getCachedModels() {
    return cachedModels;
}

export function clearConversationHistory() {
    conversationHistory = [];
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

    return `You are a powerful AI assistant running inside the user's VS Code editor. 
The user is commanding you from their phone.

${workspaceInfo}

You have the ability to interact with the workspace using the following tools:
- readFile: arg is absolute_path_here
- listDirectory: arg is absolute_path_here
- findFiles: arg is glob_pattern
- createFile: arg is absolute_path|content
- replaceLines: arg is absolute_path|startLine|endLine|newContent
- runTerminalCommand: arg is command_here
- getGitDiff: arg is empty
- getDiagnostics: arg is empty
- getCurrentSelection: arg is empty

CRITICAL INSTRUCTIONS:
- DO NOT attempt to use native API function calling.
- To execute a tool, you MUST output a markdown JSON block exactly like this:
\`\`\`tool_call
{
  "name": "readFile",
  "arg": "absolute_path_here"
}
\`\`\`
- If you need to perform an action, YOU MUST ACTUALLY CALL THE TOOL. Do not just say "I will read the file". You must immediately output the JSON block!
- You can only call ONE tool at a time. After outputting the block, stop and wait for the tool result.
- ALWAYS use the absolute paths from the Available workspace folders listed above. Do not hallucinate paths like /workspace.

EXAMPLE INTERACTION:
User: Can you read my main.py file?
Assistant: I will read the file to understand its contents.
\`\`\`tool_call
{
  "name": "readFile",
  "arg": "c:\\\\Users\\\\antoi\\\\Desktop\\\\leMill\\\\main.py"
}
\`\`\`
User: Tool Result: print("Hello World")
Assistant: The file contains a simple print statement.`;
}

async function executeTool(name: string, arg: string, onEvent: (evt: any) => void): Promise<string> {
    try {
        if (name === 'readFile') {
            const data = await fs.readFile(arg.trim(), 'utf-8');
            return data.slice(0, 8000);
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
            const content = parts.slice(1).join('|');
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
        let apiKey = await extensionContext?.secrets.get(`agentApiKey_${activeProvider}`);
        
        if (!apiKey) {
            // Fallback to legacy VS Code settings
            const config = vscode.workspace.getConfiguration('vscode-mobile-agent');
            apiKey = config.get<string>('apiKey');
        }

        let chatModel: any = null;

        // Native VS Code models (Copilot & Antigravity)
        if (requestedModel === 'copilot' || requestedModel === 'antigravity' || !apiKey) {
            const allModels = await vscode.lm.selectChatModels({});
            if (allModels.length === 0) {
                onEvent({ type: 'chunk', text: 'No AI models found in VS Code, and no API Key is configured in the mobile app settings.' });
                return;
            }
            if (requestedModel === 'copilot') {
                chatModel = allModels.find(m => m.name.toLowerCase().includes('copilot') || m.id.toLowerCase().includes('copilot')) || allModels[0];
            } else if (requestedModel === 'antigravity') {
                chatModel = allModels.find(m => m.name.toLowerCase().includes('antigravity') || m.id.toLowerCase().includes('gemini')) || allModels[0];
            } else {
                chatModel = allModels[0];
            }
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

        let maxLoops = 20; // Increased for background tasks
        let finalAssistantText = '';
        
        while (maxLoops > 0) {
            maxLoops--;
            let fullResponseText = '';

            let isGeneratingTool = false;

            if (chatModel) {
                const response = await chatModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                for await (const chunk of response.text) {
                    fullResponseText += chunk;
                    finalAssistantText += chunk;
                    if (fullResponseText.includes('```tool_call')) {
                        isGeneratingTool = true;
                    }
                    if (!isGeneratingTool) {
                        onEvent({ type: 'chunk', text: chunk });
                    }
                }
            } else {
                // REST API handling for OpenRouter, OpenAI, Anthropic, Gemini
                let endpoint = '';
                let headers: any = { 'Content-Type': 'application/json' };
                let body: any = {};

                const apiMessages = messages.map((m, i) => ({
                    role: i === 0 ? 'system' : 
                          (m instanceof vscode.LanguageModelChatMessage && m.role ? 
                          (m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant') : 
                          ((m as any).role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant')),
                    content: m.content instanceof Array ? m.content.map((c:any) => c.value).join('') : typeof m.content === 'string' ? m.content : ''
                }));

                if (activeProvider === 'openrouter' || activeProvider === 'openai') {
                    endpoint = activeProvider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
                    headers['Authorization'] = `Bearer ${apiKey}`;
                    if (activeProvider === 'openrouter') headers['HTTP-Referer'] = 'http://localhost:8333';
                    
                    body = { model: requestedModel || 'gpt-4o', messages: apiMessages, stream: true };
                } else {
                    onEvent({ type: 'chunk', text: `Provider ${activeProvider} REST integration is not fully implemented yet.` });
                    break;
                }

                const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
                if (!response.ok) {
                    onEvent({ type: 'chunk', text: `API Error: ${response.status} ${await response.text()}` });
                    break;
                }

                const reader = response.body?.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = '';
                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            const trimmedLine = line.trim();
                            if (trimmedLine.startsWith('data: ') && trimmedLine !== 'data: [DONE]') {
                                try {
                                    const data = JSON.parse(trimmedLine.slice(6));
                                    
                                    if (data.error) {
                                        const errStr = `\n[Stream Error]: ${data.error.message}`;
                                        fullResponseText += errStr;
                                        onEvent({ type: 'chunk', text: errStr });
                                        break;
                                    }

                                    const content = data.choices?.[0]?.delta?.content || '';
                                    if (content) {
                                        fullResponseText += content;
                                        finalAssistantText += content;
                                        if (fullResponseText.includes('```tool_call')) {
                                            isGeneratingTool = true;
                                        }
                                        if (!isGeneratingTool) {
                                            onEvent({ type: 'chunk', text: content });
                                        }
                                    }
                                } catch(e){}
                            }
                        }
                    }
                }
            }

            // DEBUG LOGGING
            try {
                const fs = require('fs').promises;
                const path = require('path');
                const os = require('os');
                const debugPath = path.join(os.homedir(), 'Desktop', 'agent_debug.log');
                const logData = `\n[REQUEST]\n${JSON.stringify(messages.map((m: any) => ({ role: m.role, content: m.content })), null, 2)}\n\n[RESPONSE]\n${fullResponseText}\n=================================\n`;
                await fs.appendFile(debugPath, logData, 'utf-8');
            } catch (e) {}

            let toolName = '';
            let toolArg = '';
            let validToolCall = false;

            const blockMatch = fullResponseText.match(/```tool_call\s*([\s\S]*)/);
            if (blockMatch) {
                try {
                    let jsonStr = blockMatch[1].replace(/```\s*$/, '').trim();
                    const toolCall = JSON.parse(jsonStr);
                    toolName = toolCall.name;
                    toolArg = toolCall.arg;
                    validToolCall = true;
                } catch (e: any) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(fullResponseText));
                    messages.push(vscode.LanguageModelChatMessage.User(`Failed to parse tool call JSON: ${e.message}. Make sure you output a single valid JSON object inside the tool_call block.`));
                }
            }

            if (validToolCall) {
                try {
                    const toolLog = `\n[Agent is running tool: ${toolName}(${toolArg})]\n`;
                    onEvent({ type: 'chunk', text: toolLog });
                    finalAssistantText += toolLog;
                    
                    const toolResult = await executeTool(toolName, toolArg, onEvent);
                    
                    messages.push(vscode.LanguageModelChatMessage.Assistant(fullResponseText));
                    messages.push(vscode.LanguageModelChatMessage.User(`Tool Result:\n${toolResult}\nContinue your response.`));
                    continue; 
                } catch(e) {
                    const errLog = `\n[Agent Tool Error: Invalid JSON in tool call]\n`;
                    onEvent({ type: 'chunk', text: errLog });
                    finalAssistantText += errLog;
                }
            }
            
            break;
        }

        conversationHistory.push({ role: 'assistant', text: finalAssistantText });
        saveConversationHistory();

    } catch (err: any) {
        onEvent({ type: 'chunk', text: `\nError communicating with API: ${err.message}` });
    }
}
