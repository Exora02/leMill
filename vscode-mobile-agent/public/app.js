const chatContainer = document.getElementById('chat-container');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const statusIndicator = document.getElementById('status-indicator');
const typingIndicator = document.getElementById('typing-indicator');
const sessionSelect = document.getElementById('session-select');
const sessionWrapper = document.getElementById('session-wrapper');
const modelSelect = document.getElementById('model-select');
const modelWrapper = document.getElementById('model-wrapper');

// Modal Elements
const modal = document.getElementById('action-modal');
const modalCmdText = document.getElementById('modal-command-text');
const btnApprove = document.getElementById('btn-approve');
const btnDeny = document.getElementById('btn-deny');

// Settings Elements
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const providerSelect = document.getElementById('provider-select');
const apikeyInput = document.getElementById('apikey-input');
const btnClear = document.getElementById('btn-clear');

// PWA Install
const btnInstall = document.getElementById('btn-install');

let ws;
let currentAgentMessageDiv = null;
let currentMessageRaw = '';
let currentSessionId = null;
let pendingActionId = null;
let authToken = localStorage.getItem('agentAuthToken') || '';

// Check URL for new token
const urlParams = new URLSearchParams(window.location.search);
const urlToken = urlParams.get('token');
if (urlToken) {
    authToken = urlToken;
    localStorage.setItem('agentAuthToken', authToken);
    window.history.replaceState({}, document.title, window.location.pathname);
}

function escapeHtml(unsafe) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// Configure Marked.js
if (typeof marked !== 'undefined') {
    const renderer = new marked.Renderer();
    
    // Custom Code Block Renderer
    renderer.code = function(code, language) {
        if (typeof code === 'object') {
            language = code.lang;
            code = code.text;
        }
        
        const lang = (language || 'text').toLowerCase();
        let highlighted = code;
        if (typeof hljs !== 'undefined') {
            try {
                highlighted = language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
            } catch (e) {}
        }
        
        // Use a safe ID for the copy button
        const id = 'code-' + Math.random().toString(36).substr(2, 9);
        const escapedCode = escapeHtml(code).replace(/'/g, "\\'").replace(/\n/g, "\\n");
        
        return `<div class="code-block">
            <div class="code-header">
                <span>${lang}</span>
                <button onclick="navigator.clipboard.writeText('${escapedCode}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    Copy
                </button>
            </div>
            <pre><code class="hljs language-${lang}">${highlighted}</code></pre>
        </div>`;
    };

    marked.setOptions({ renderer });
}

function formatAgentMessage(rawText) {
    try {
        // Strip the JSON tool calls even if they are unclosed
        let cleanedText = rawText.replace(/```tool_call\s*([\s\S]*?)(?:```\s*|$)/g, '');
        
        // Strip any leaked incomplete tool blocks that are immediately followed by a tool pill
        cleanedText = cleanedText.replace(/```[\w_]*\s*(?=\[Agent is running tool:)/g, '');
        
        // Convert Tool Logs into UI Pills
        cleanedText = cleanedText.replace(/\[Agent is running tool: ([^(]+)\(([^)]*)\)\]/g, (match, name, arg) => {
            return `<div class="tool-pill" title="${escapeHtml(arg)}">
                <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
                <strong>${escapeHtml(name)}</strong>
                <span class="arg">${escapeHtml(arg)}</span>
            </div>`;
        });

        // Replace the `<think>` block for DeepSeek with an elegant Details dropdown
        cleanedText = cleanedText.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (match, thoughtProcess) => {
            return `<details class="thought-process">
                <summary>
                    <svg class="brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v.733m-5.736.668l.518.518m-4.39 5.736h.733m20.15 0h.733M3.824 15.244l.518-.518m16.834.668l-.518-.518M14.25 3.104v.733M18.896 4.505l-.518.518M9.75 20.896v-.733m4.5 0v.733M4.5 12c0 4.142 3.358 7.5 7.5 7.5s7.5-3.358 7.5-7.5-3.358-7.5-7.5-7.5-7.5 3.358-7.5 7.5z"></path>
                    </svg>
                    Thought Process
                </summary>
                <div class="content">${marked.parse(thoughtProcess)}</div>
            </details>`;
        });

        if (typeof marked !== 'undefined') {
            return marked.parse(cleanedText);
        }
        return escapeHtml(cleanedText);
    } catch (e) {
        console.error("Format error:", e);
        return `<div style="color:var(--ctp-red); border:1px solid var(--ctp-red); padding:8px; border-radius:4px; margin-bottom:8px;">Render Error: ${escapeHtml(e.message)}</div><pre style="white-space:pre-wrap; font-size:0.8rem;">${escapeHtml(rawText)}</pre>`;
    }
}

function connect() {
    if (!authToken) {
        statusIndicator.textContent = 'Missing Token';
        statusIndicator.className = 'status disconnected';
        appendMessage('system', 'Error: No authentication token found. Please scan the QR Code from VS Code.');
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}?token=${authToken}`);

    ws.onopen = () => {
        statusIndicator.textContent = 'Connected';
        statusIndicator.className = 'status';
    };

    ws.onclose = () => {
        statusIndicator.textContent = 'Disconnected. Retrying...';
        statusIndicator.className = 'status disconnected';
        sessionWrapper.style.display = 'none';
        setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'sessionList') {
                updateSessionList(data.sessions);
            } else if (data.type === 'modelList') {
                updateModelList(data.models);
            } else if (data.type === 'history') {
                renderHistory(data.history);
            } else if (data.type === 'chunk') {
                hideTyping();
                if (!currentAgentMessageDiv) {
                    currentAgentMessageDiv = appendMessage('agent', '', true);
                    currentMessageRaw = '';
                }
                currentMessageRaw += data.text;
                try {
                    currentAgentMessageDiv.innerHTML = formatAgentMessage(currentMessageRaw);
                } catch (e) {
                    console.error("DOM Error", e);
                }
                scrollToBottom();
            } else if (data.type === 'promptAction') {
                hideTyping();
                showActionModal(data.actionId, data.command);
            } else if (data.type === 'done') {
                currentAgentMessageDiv = null;
                hideTyping();
            } else if (data.type === 'error') {
                appendMessage('system', 'Error: ' + data.text);
                currentAgentMessageDiv = null;
                hideTyping();
            }
        } catch (e) {
            console.error('Failed to parse message', e);
        }
    };
}

function updateSessionList(sessions) {
    if (sessions.length === 0) {
        sessionWrapper.style.display = 'none';
        return;
    }
    
    sessionWrapper.style.display = 'inline-block';
    const oldVal = sessionSelect.value;
    sessionSelect.innerHTML = '';
    
    let foundOld = false;
    sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sessionSelect.appendChild(opt);
        if (s.id === oldVal) foundOld = true;
    });
    
    if (foundOld) {
        sessionSelect.value = oldVal;
    } else {
        sessionSelect.value = sessions[0].id;
        currentSessionId = sessions[0].id;
        requestHistory();
    }
}

sessionSelect.addEventListener('change', () => {
    currentSessionId = sessionSelect.value;
    requestHistory();
});

function updateModelList(models) {
    if (!models || models.length === 0) {
        modelWrapper.style.display = 'none';
        return;
    }
    
    modelWrapper.style.display = 'inline-block';
    const oldVal = modelSelect.value || localStorage.getItem('selectedModel');
    modelSelect.innerHTML = '';
    
    let foundOld = false;
    
    // Add default blank option
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default Model';
    modelSelect.appendChild(defaultOpt);

    // Hardcode Copilot and Antigravity if available
    const copilotOpt = document.createElement('option');
    copilotOpt.value = 'copilot';
    copilotOpt.textContent = 'GitHub Copilot';
    modelSelect.appendChild(copilotOpt);

    const antigravityOpt = document.createElement('option');
    antigravityOpt.value = 'antigravity';
    antigravityOpt.textContent = 'Antigravity (Gemini)';
    modelSelect.appendChild(antigravityOpt);
    
    models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        modelSelect.appendChild(opt);
        if (m.id === oldVal) foundOld = true;
    });
    
    if (foundOld) {
        modelSelect.value = oldVal;
    } else if (oldVal === 'copilot' || oldVal === 'antigravity') {
        modelSelect.value = oldVal;
    }
}

modelSelect.addEventListener('change', () => {
    localStorage.setItem('selectedModel', modelSelect.value);
});

function requestHistory() {
    if (!currentSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'getHistory', sessionId: currentSessionId }));
}

function renderHistory(historyArray) {
    const sysMsg = chatContainer.querySelector('.message.system');
    chatContainer.innerHTML = '';
    if (sysMsg) chatContainer.appendChild(sysMsg);
    chatContainer.appendChild(typingIndicator);
    
    historyArray.forEach(msg => {
        appendMessage(msg.role, msg.text, msg.role === 'agent');
    });
    scrollToBottom();
}

function appendMessage(sender, text, isHtml = false) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    if (sender === 'agent' || isHtml) {
        div.innerHTML = formatAgentMessage(text);
    } else {
        div.textContent = text;
    }
    chatContainer.insertBefore(div, typingIndicator);
    scrollToBottom();
    return div;
}

function showTyping() {
    typingIndicator.classList.add('visible');
    scrollToBottom();
}

function hideTyping() {
    typingIndicator.classList.remove('visible');
}

function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN || !currentSessionId) return;
    
    appendMessage('user', text);
    msgInput.value = '';
    
    ws.send(JSON.stringify({ 
        type: 'chat', 
        sessionId: currentSessionId, 
        text: text,
        model: modelSelect.value || undefined
    }));
    showTyping();
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// Modal Logic
function showActionModal(actionId, commandText) {
    pendingActionId = actionId;
    modalCmdText.textContent = commandText;
    modal.classList.add('visible');
}

function hideActionModal() {
    modal.classList.remove('visible');
    pendingActionId = null;
}

btnApprove.addEventListener('click', () => {
    if (pendingActionId && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'actionResponse', sessionId: currentSessionId, actionId: pendingActionId, approved: true }));
        appendMessage('system', `Approved command: ${modalCmdText.textContent}`);
        showTyping();
    }
    hideActionModal();
});

btnDeny.addEventListener('click', () => {
    if (pendingActionId && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'actionResponse', sessionId: currentSessionId, actionId: pendingActionId, approved: false }));
        appendMessage('system', `Denied command: ${modalCmdText.textContent}`);
        showTyping();
    }
    hideActionModal();
});

// Settings Logic
btnSettings.addEventListener('click', () => {
    const provider = localStorage.getItem('agentProvider') || 'openrouter';
    providerSelect.value = provider;
    apikeyInput.value = localStorage.getItem(`agentApiKey_${provider}`) || '';
    settingsModal.style.display = 'flex';
});

providerSelect.addEventListener('change', () => {
    const provider = providerSelect.value;
    apikeyInput.value = localStorage.getItem(`agentApiKey_${provider}`) || '';
});

btnCancelSettings.addEventListener('click', () => {
    settingsModal.style.display = 'none';
});

btnSaveSettings.addEventListener('click', () => {
    const provider = providerSelect.value;
    const apiKey = apikeyInput.value;
    
    localStorage.setItem('agentProvider', provider);
    localStorage.setItem(`agentApiKey_${provider}`, apiKey);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'saveSettings', provider, apiKey }));
        appendMessage('system', `Settings saved for provider: ${provider}`);
    }
    
    settingsModal.style.display = 'none';
});

// Init
connect();

// Clear Chat Logic
if (btnClear) {
    btnClear.addEventListener('click', () => {
        if (confirm('Clear chat history?')) {
            chatContainer.innerHTML = '<div class="message system">Chat cleared.</div>';
            chatContainer.appendChild(typingIndicator);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'clear', sessionId: currentSessionId }));
            }
        }
    });
}

// PWA Installation Logic
let deferredPrompt;

// Unconditionally show the button
btnInstall.style.display = 'flex';

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

btnInstall.addEventListener('click', async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            btnInstall.style.display = 'none';
        }
        deferredPrompt = null;
    } else {
        // Fallback for when the automatic prompt isn't allowed (e.g. insecure origin or iOS)
        alert("To install this app:\n\nAndroid/Chrome: Tap the 3-dot menu and select 'Add to Home screen'.\n\niOS/Safari: Tap the 'Share' icon at the bottom, then select 'Add to Home Screen'.");
    }
});
