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
exports.conversationHistory = void 0;
exports.getConversationHistory = getConversationHistory;
exports.handleAgentMessage = handleAgentMessage;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs/promises"));
// System prompt instructing the model how to use tools
function getSystemPrompt() {
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

To call a tool, output exactly the XML tag above and NOTHING else. Wait for the tool result before continuing.
Do not hallucinate paths like /workspace. ALWAYS use the absolute paths from the Available workspace folders listed above.
If you have the answer, just respond normally.`;
}
async function executeTool(name, arg) {
    try {
        if (name === 'readFile') {
            const data = await fs.readFile(arg.trim(), 'utf-8');
            return data.slice(0, 5000); // Limit size
        }
        else if (name === 'listDirectory') {
            const files = await fs.readdir(arg.trim());
            return files.join('\n');
        }
        else if (name === 'findFiles') {
            const uris = await vscode.workspace.findFiles(arg.trim(), '**/node_modules/**', 50);
            if (uris.length === 0)
                return 'No files found matching that pattern.';
            return uris.map(u => u.fsPath).join('\n');
        }
    }
    catch (e) {
        return `Error executing ${name}: ${e.message}`;
    }
    return `Unknown tool: ${name}`;
}
exports.conversationHistory = [];
function getConversationHistory() {
    return exports.conversationHistory;
}
async function handleAgentMessage(userText, onChunk) {
    try {
        const config = vscode.workspace.getConfiguration('vscode-mobile-agent');
        const apiKey = config.get('apiKey');
        const apiEndpoint = config.get('apiEndpoint') || 'https://openrouter.ai/api/v1/chat/completions';
        const apiModel = config.get('apiModel') || 'google/gemini-pro';
        let chatModel = null;
        let useRestApi = false;
        if (apiKey) {
            useRestApi = true;
        }
        else {
            const allModels = await vscode.lm.selectChatModels({});
            if (allModels.length === 0) {
                onChunk('No AI models found in your VS Code, and no API Key is configured.\n\nPlease open VS Code Settings, search for "Mobile Agent", and add an API Key (e.g., OpenRouter) to use Bring-Your-Own-Key (BYOK).');
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
        exports.conversationHistory.push({ role: 'user', text: userText });
        const messages = [
            vscode.LanguageModelChatMessage.User(getSystemPrompt()),
        ];
        // Add history
        for (let i = 0; i < exports.conversationHistory.length; i++) {
            const msg = exports.conversationHistory[i];
            if (msg.role === 'user') {
                if (i === exports.conversationHistory.length - 1) {
                    // Inject context into latest user message
                    messages.push(vscode.LanguageModelChatMessage.User(`Workspace Context:\n${contextInfo}\n\nUser: ${msg.text}`));
                }
                else {
                    messages.push(vscode.LanguageModelChatMessage.User(msg.text));
                }
            }
            else {
                messages.push(vscode.LanguageModelChatMessage.Assistant(msg.text));
            }
        }
        let maxLoops = 5;
        let finalAssistantText = '';
        while (maxLoops > 0) {
            maxLoops--;
            let fullResponseText = '';
            if (useRestApi) {
                const apiMessages = messages.map((m, i) => ({
                    role: i === 0 ? 'system' :
                        (m instanceof vscode.LanguageModelChatMessage && m.role ?
                            (m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant') :
                            (m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant')),
                    content: m.content instanceof Array ? m.content.map((c) => c.value).join('') : typeof m.content === 'string' ? m.content : ''
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
                    onChunk(`API Error: ${response.status} ${response.statusText}\nDetails: ${errText}`);
                    break;
                }
                const reader = response.body?.getReader();
                const decoder = new TextDecoder("utf-8");
                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
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
                                            onChunk(content);
                                            finalAssistantText += content;
                                        }
                                    }
                                }
                                catch (e) { }
                            }
                        }
                    }
                }
            }
            else {
                const response = await chatModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                for await (const chunk of response.text) {
                    fullResponseText += chunk;
                    if (!fullResponseText.includes('<call_tool')) {
                        onChunk(chunk);
                        finalAssistantText += chunk;
                    }
                }
            }
            const toolMatch = fullResponseText.match(/<call_tool name="([^"]+)">([^<]+)<\/call_tool>/);
            if (toolMatch) {
                const toolName = toolMatch[1];
                const toolArg = toolMatch[2];
                const toolLog = `\n[Agent is running tool: ${toolName}(${toolArg})]\n`;
                onChunk(toolLog);
                finalAssistantText += toolLog;
                const toolResult = await executeTool(toolName, toolArg);
                messages.push(vscode.LanguageModelChatMessage.Assistant(fullResponseText));
                messages.push(vscode.LanguageModelChatMessage.User(`Tool Result:\n${toolResult}\nContinue your response.`));
                continue;
            }
            if (fullResponseText.includes('<call_tool')) {
                onChunk(fullResponseText);
                finalAssistantText += fullResponseText;
            }
            break;
        }
        // Save AI response to history
        exports.conversationHistory.push({ role: 'assistant', text: finalAssistantText });
    }
    catch (err) {
        onChunk(`\nError communicating with LM API: ${err.message}`);
    }
}
//# sourceMappingURL=agent.js.map