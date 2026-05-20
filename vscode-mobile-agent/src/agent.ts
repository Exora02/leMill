import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';

// Pending Actions Map
const pendingActions = new Map<string, (approved: boolean) => void>();

export function handleActionResponse(actionId: string, approved: boolean) {
    const resolver = pendingActions.get(actionId);
    if (resolver) {
        resolver(approved);
        pendingActions.delete(actionId);
    }
}

// System prompt instructing the model how to use tools
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
3. <call_tool name="findFiles">glob_pattern</call_tool> - Finds files in the workspace (e.g. **/*.ts, src/app.js).
4. <call_tool name="editFile">absolute_path|exact_text_to_replace|new_text</call_tool> - Edits a file by replacing an exact string with a new string. Use the pipe symbol | as a separator.
5. <call_tool name="runTerminalCommand">command_here</call_tool> - Runs a shell command. The user will be prompted to approve it on their phone.
6. <call_tool name="getDiagnostics"></call_tool> - Gets all compiler/linting errors (red squiggly lines) currently in the workspace.
7. <call_tool name="getCurrentSelection"></call_tool> - Gets the text currently highlighted by the user in their active editor.

To call a tool, output exactly the XML tag above and NOTHING else. Wait for the tool result before continuing.
Do not hallucinate paths like /workspace. ALWAYS use the absolute paths from the Available workspace folders listed above.
If you have the answer, just respond normally.`;
}

async function executeTool(name: string, arg: string, onEvent: (evt: any) => void): Promise<string> {
    try {
        if (name === 'readFile') {
            const data = await fs.readFile(arg.trim(), 'utf-8');
            return data.slice(0, 5000); // Limit size
        } else if (name === 'listDirectory') {
            const files = await fs.readdir(arg.trim());
            return files.join('\n');
        } else if (name === 'findFiles') {
            const uris = await vscode.workspace.findFiles(arg.trim(), '**/node_modules/**', 50);
            if (uris.length === 0) return 'No files found matching that pattern.';
            return uris.map(u => u.fsPath).join('\n');
        } else if (name === 'editFile') {
            const parts = arg.split('|');
            if (parts.length !== 3) return 'Error: editFile requires exactly 3 parts separated by | (path|target|replacement)';
            const [filePath, target, replacement] = parts;
            const content = await fs.readFile(filePath.trim(), 'utf-8');
            if (!content.includes(target)) return 'Error: Target string not found in file.';
            const newContent = content.replace(target, replacement);
            await fs.writeFile(filePath.trim(), newContent, 'utf-8');
            return 'File edited successfully.';
        } else if (name === 'runTerminalCommand') {
            const actionId = crypto.randomUUID();
            
            // Ask for UI confirmation
            onEvent({ type: 'promptAction', actionId, command: arg.trim() });
            
            // Wait for user to tap Approve or Deny
            const approved = await new Promise<boolean>((resolve) => {
                pendingActions.set(actionId, resolve);
            });
            
            if (!approved) {
                return 'User DENIED the execution of this command.';
            }
            
            // Execute command
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

export interface ChatHistoryItem {
    role: 'user' | 'assistant';
    text: string;
}

export const conversationHistory: ChatHistoryItem[] = [];

export function getConversationHistory() {
    return conversationHistory;
}

export async function handleAgentMessage(userText: string, onEvent: (evt: any) => void) {
    try {
        const config = vscode.workspace.getConfiguration('vscode-mobile-agent');
        const apiKey = config.get<string>('apiKey');
        const apiEndpoint = config.get<string>('apiEndpoint') || 'https://openrouter.ai/api/v1/chat/completions';
        const apiModel = config.get<string>('apiModel') || 'google/gemini-pro';

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
        
        // Push user message to history
        conversationHistory.push({ role: 'user', text: userText });

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(getSystemPrompt()),
        ];
        
        // Add history
        for (let i = 0; i < conversationHistory.length; i++) {
            const msg = conversationHistory[i];
            if (msg.role === 'user') {
                if (i === conversationHistory.length - 1) {
                    // Inject context into latest user message
                    messages.push(vscode.LanguageModelChatMessage.User(`Workspace Context:\n${contextInfo}\n\nUser: ${msg.text}`));
                } else {
                    messages.push(vscode.LanguageModelChatMessage.User(msg.text));
                }
            } else {
                messages.push(vscode.LanguageModelChatMessage.Assistant(msg.text));
            }
        }

        let maxLoops = 10; // Increased loop limit for complex tool chains
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

        // Save AI response to history
        conversationHistory.push({ role: 'assistant', text: finalAssistantText });

    } catch (err: any) {
        onEvent({ type: 'chunk', text: `\nError communicating with LM API: ${err.message}` });
    }
}
