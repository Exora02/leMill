const chatContainer = document.getElementById('chat-container');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const statusIndicator = document.getElementById('status-indicator');
const typingIndicator = document.getElementById('typing-indicator');
const sessionSelect = document.getElementById('session-select');

// Modal Elements
const modal = document.getElementById('action-modal');
const modalCmdText = document.getElementById('modal-command-text');
const btnApprove = document.getElementById('btn-approve');
const btnDeny = document.getElementById('btn-deny');

let ws;
let currentAgentMessageDiv = null;
let currentSessionId = null;
let pendingActionId = null;

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        statusIndicator.textContent = 'Connected';
        statusIndicator.className = 'status';
    };

    ws.onclose = () => {
        statusIndicator.textContent = 'Disconnected. Retrying...';
        statusIndicator.className = 'status disconnected';
        sessionSelect.style.display = 'none';
        setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'sessionList') {
                updateSessionList(data.sessions);
            } else if (data.type === 'history') {
                renderHistory(data.history);
            } else if (data.type === 'chunk') {
                hideTyping();
                if (!currentAgentMessageDiv) {
                    currentAgentMessageDiv = appendMessage('agent', '');
                }
                currentAgentMessageDiv.textContent += data.text;
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
        sessionSelect.style.display = 'none';
        return;
    }
    
    sessionSelect.style.display = 'inline-block';
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
        appendMessage(msg.role, msg.text);
    });
    scrollToBottom();
}

function appendMessage(sender, text) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.textContent = text;
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
    
    ws.send(JSON.stringify({ type: 'chat', sessionId: currentSessionId, text: text }));
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

// Init
connect();
