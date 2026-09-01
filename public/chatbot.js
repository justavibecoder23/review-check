(() => {
  const contactButton = document.querySelector('.header-contact');
  if (!contactButton || document.querySelector('[data-realview-chatbot]')) return;
  const siteHeader = document.querySelector('.site-header');
  const navToggle = document.querySelector('.nav-toggle');
  const navToggleLabel = document.querySelector('.nav-toggle-label');

  const headerActions = document.createElement('div');
  headerActions.className = 'header-actions';
  contactButton.parentNode.insertBefore(headerActions, contactButton);

  const trigger = document.createElement('button');
  trigger.className = 'chatbot-trigger';
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'realview-chatbot');
  trigger.setAttribute('aria-label', 'Mở Trợ lý RealView');
  trigger.innerHTML = '<img class="chatbot-logo" src="/assets/realview-rv.png" alt="" aria-hidden="true"><span>Trợ lý</span><i aria-hidden="true"></i>';
  headerActions.append(trigger, contactButton);

  const panel = document.createElement('section');
  panel.id = 'realview-chatbot';
  panel.className = 'chatbot-panel';
  panel.hidden = true;
  panel.dataset.realviewChatbot = '';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'chatbot-title');
  panel.innerHTML = `
    <header class="chatbot-header">
      <span class="chatbot-avatar" aria-hidden="true">
        <img src="/assets/realview-rv.png" alt="" />
      </span>
      <div><h2 id="chatbot-title">Trợ lý RealView</h2><p><i aria-hidden="true"></i> Hỗ trợ thông tin về website</p></div>
      <button class="chatbot-close" type="button" aria-label="Đóng Trợ lý RealView">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div class="chatbot-messages" role="log" aria-live="polite" aria-relevant="additions">
      <article class="chatbot-message chatbot-message--assistant">
        <span class="chatbot-message-avatar" aria-hidden="true">R</span>
        <div><p>Xin chào! Mình có thể giải thích cách dùng RealView, ý nghĩa của TrustScore và tiêu chí lọc review.</p><time>Trợ lý RealView</time></div>
      </article>
      <div class="chatbot-suggestions" aria-label="Câu hỏi gợi ý">
        <button type="button">RealView hoạt động thế nào?</button>
        <button type="button">TrustScore là gì?</button>
        <button type="button">Review bị loại theo tiêu chí nào?</button>
      </div>
    </div>
    <form class="chatbot-form">
      <label class="sr-only" for="chatbot-input">Câu hỏi dành cho Trợ lý RealView</label>
      <div class="chatbot-input-shell">
        <textarea id="chatbot-input" rows="1" maxlength="500" placeholder="Hỏi về RealView..." required></textarea>
        <button type="submit" aria-label="Gửi câu hỏi">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>
        </button>
      </div>
      <p>Chỉ trả lời từ thông tin chính thức của RealView.</p>
    </form>`;
  document.body.append(panel);

  const closeButton = panel.querySelector('.chatbot-close');
  const messagesRoot = panel.querySelector('.chatbot-messages');
  const suggestions = panel.querySelector('.chatbot-suggestions');
  const form = panel.querySelector('.chatbot-form');
  const input = panel.querySelector('#chatbot-input');
  const submitButton = form.querySelector('button[type="submit"]');
  const conversation = [];
  let isSending = false;

  function setOpen(open, restoreFocus = true) {
    if (open) {
      siteHeader?.classList.remove('is-menu-open');
      navToggle?.setAttribute('aria-expanded', 'false');
      if (navToggleLabel) navToggleLabel.textContent = 'Mở menu';
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('is-open'));
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-label', 'Đóng Trợ lý RealView');
      document.body.classList.add('chatbot-open');
      window.setTimeout(() => input.focus(), 180);
    } else {
      panel.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-label', 'Mở Trợ lý RealView');
      document.body.classList.remove('chatbot-open');
      window.setTimeout(() => {
        if (!panel.classList.contains('is-open')) panel.hidden = true;
      }, 180);
      if (restoreFocus) trigger.focus();
    }
  }

  function scrollToLatest() {
    messagesRoot.scrollTo({ top: messagesRoot.scrollHeight, behavior: 'smooth' });
  }

  function addMessage(role, content) {
    const message = document.createElement('article');
    message.className = `chatbot-message chatbot-message--${role}`;
    if (role === 'assistant') {
      const avatar = document.createElement('span');
      avatar.className = 'chatbot-message-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = 'R';
      message.append(avatar);
    }
    const body = document.createElement('div');
    const text = document.createElement('p');
    text.textContent = content;
    body.append(text);
    if (role === 'assistant') {
      const label = document.createElement('time');
      label.textContent = 'Trợ lý RealView';
      body.append(label);
    }
    message.append(body);
    messagesRoot.append(message);
    scrollToLatest();
    return message;
  }

  function addLoadingMessage() {
    const message = addMessage('assistant', '');
    message.classList.add('is-loading');
    const text = message.querySelector('p');
    text.setAttribute('aria-label', 'Trợ lý đang trả lời');
    text.innerHTML = '<i></i><i></i><i></i>';
    return message;
  }

  async function sendQuestion(value) {
    const question = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!question || isSending) return;
    isSending = true;
    input.value = '';
    input.style.height = '';
    input.disabled = true;
    submitButton.disabled = true;
    suggestions?.remove();
    addMessage('user', question);
    conversation.push({ role: 'user', content: question });
    const loading = addLoadingMessage();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: conversation.slice(-8) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Không thể kết nối Trợ lý RealView.');
      const answer = String(data.answer || 'Mình chưa có thông tin này trong kho dữ liệu RealView. Bạn có thể liên hệ đội ngũ để được hỗ trợ.');
      loading.remove();
      addMessage('assistant', answer);
      conversation.push({ role: 'assistant', content: answer });
      if (conversation.length > 8) conversation.splice(0, conversation.length - 8);
    } catch {
      loading.remove();
      addMessage('assistant', 'Hiện mình chưa thể kết nối. Bạn vui lòng thử lại sau hoặc liên hệ đội ngũ RealView.');
    } finally {
      isSending = false;
      input.disabled = false;
      submitButton.disabled = false;
      input.focus();
    }
  }

  trigger.addEventListener('click', () => setOpen(trigger.getAttribute('aria-expanded') !== 'true'));
  navToggle?.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') setOpen(false, false);
  });
  closeButton.addEventListener('click', () => setOpen(false));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendQuestion(input.value);
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  panel.querySelectorAll('.chatbot-suggestions button').forEach((button) => {
    button.addEventListener('click', () => sendQuestion(button.textContent));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && trigger.getAttribute('aria-expanded') === 'true') setOpen(false);
  });
})();

