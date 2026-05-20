const chatContainer = document.getElementById('chat-container');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const statusIndicator = document.getElementById('status-indicator');
const typingIndicator = document.getElementById('typing-indicator');

let ws;
let currentAgentMessageDiv = null;

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
        setTimeout(connect, 3000);
    };

    ws.onerror = () => {
        ws.close();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'chunk') {
                hideTyping();
                if (!currentAgentMessageDiv) {
                    currentAgentMessageDiv = appendMessage('agent', '');
                }
                currentAgentMessageDiv.textContent += data.text;
                scrollToBottom();
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
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    
    appendMessage('user', text);
    msgInput.value = '';
    
    ws.send(JSON.stringify({ type: 'chat', text: text }));
    showTyping();
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// Init
connect();
