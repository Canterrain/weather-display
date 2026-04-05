function formatAdminMessageTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

async function loadTargets() {
  const select = document.getElementById('msg-target');
  if (!select) return;

  try {
    const response = await fetch('/api/message-targets', { cache: 'no-store' });
    const data = await response.json();
    const targets = Array.isArray(data.targets) ? data.targets : [{ id: 'all', label: 'All clocks' }];
    select.replaceChildren();

    targets.forEach((target) => {
      const option = document.createElement('option');
      option.value = target.id;
      option.textContent = target.label;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load message targets:', error);
  }
}

function setComposeStatus(text, isError = false) {
  const status = document.getElementById('compose-status');
  if (!status) return;
  status.textContent = text;
  status.style.color = isError ? 'rgba(255, 164, 164, 0.96)' : 'rgba(232, 239, 251, 0.72)';
}

async function loadActiveMessages() {
  const list = document.getElementById('active-messages');
  if (!list) return;

  try {
    const response = await fetch('/api/messages?deviceId=all&includeDismissed=true', { cache: 'no-store' });
    const data = await response.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    list.replaceChildren();

    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'admin-message-meta';
      empty.textContent = 'No active messages.';
      list.appendChild(empty);
      return;
    }

    messages.forEach((message) => {
      const item = document.createElement('div');
      item.className = 'admin-message';

      const metaBits = [];
      if (message.target === 'all') {
        metaBits.push('All clocks');
      } else {
        metaBits.push(message.target);
      }
      if (message.sender) {
        metaBits.push(`from ${message.sender}`);
      }
      if (message.createdAt) {
        metaBits.push(formatAdminMessageTime(message.createdAt));
      }

      item.innerHTML = `
        <div class="admin-message-text">${message.text}</div>
        <div class="admin-message-meta">${metaBits.join(' · ')}</div>
        <div class="admin-message-actions">
          <button type="button" data-id="${message.id}">Deactivate</button>
        </div>
      `;

      list.appendChild(item);
    });

    list.querySelectorAll('button[data-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const response = await fetch(`/api/messages/${encodeURIComponent(button.dataset.id)}/deactivate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            setComposeStatus(data.error || 'Failed to deactivate message', true);
            return;
          }
          await loadActiveMessages();
        } catch (error) {
          console.error('Failed to deactivate message:', error);
          setComposeStatus('Failed to deactivate message', true);
        }
      });
    });
  } catch (error) {
    console.error('Failed to load active messages:', error);
    setComposeStatus('Failed to load active messages', true);
  }
}

function setupMessageForm() {
  const button = document.getElementById('send-message');
  if (!button) return;

  button.addEventListener('click', async () => {
    const text = document.getElementById('msg-text');
    const sender = document.getElementById('msg-sender');
    const target = document.getElementById('msg-target');
    const priority = document.getElementById('msg-priority');
    const expires = document.getElementById('msg-expires');

    const payload = {
      text: text?.value || '',
      sender: sender?.value || '',
      target: target?.value || 'all',
      priority: priority?.value || 'normal',
      expiresAt: expires?.value ? new Date(expires.value).toISOString() : null
    };

    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        setComposeStatus(data.error || 'Failed to send message', true);
        return;
      }

      if (text) text.value = '';
      if (sender) sender.value = '';
      if (expires) expires.value = '';
      if (priority) priority.value = 'normal';

      setComposeStatus('Message sent.');
      await loadActiveMessages();
    } catch (error) {
      console.error('Failed to send message:', error);
      setComposeStatus('Failed to send message', true);
    }
  });
}

async function initializeMessagesAdmin() {
  await loadTargets();
  setupMessageForm();
  await loadActiveMessages();
}

initializeMessagesAdmin();
