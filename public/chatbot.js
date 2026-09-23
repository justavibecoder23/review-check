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
  trigger.innerHTML = '<img class="chatbot-logo" src="/assets/realview-logo-v1.webp" alt="" width="128" height="75" aria-hidden="true"><span>Trợ lý</span><i aria-hidden="true"></i>';
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
      <span class="chatbot-avatar" aria-hidden="true"><span class="realviewee-sprite" data-mascot-state="happy"></span></span>
      <div><h2 id="chatbot-title">Chat with RealViewee</h2><p><i aria-hidden="true"></i> Your AI shopping &amp; review assistant</p></div>
      <button class="chatbot-close" type="button" aria-label="Đóng trợ lý RealViewee">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div class="chatbot-context" data-chatbot-context hidden><span></span><button type="button" aria-label="Bỏ chọn sản phẩm">×</button></div>
    <div class="chatbot-messages" role="log" aria-live="polite" aria-relevant="additions">
      <article class="chatbot-message chatbot-message--assistant">
        <span class="chatbot-message-avatar chatbot-message-avatar--realviewee" aria-hidden="true"><span class="realviewee-sprite" data-mascot-state="happy"></span></span>
        <div><p>Xin chào! Mình có thể giải thích cách dùng RealView, ý nghĩa của TrustScore và tiêu chí lọc review.</p><time>RealViewee</time></div>
      </article>
      <div class="chatbot-suggestions" aria-label="Câu hỏi gợi ý">
        <button type="button">RealView hoạt động thế nào?</button>
        <button type="button">TrustScore là gì?</button>
        <button type="button">Review bị loại theo tiêu chí nào?</button>
      </div>
    </div>
    <form class="chatbot-form">
      <label class="sr-only" for="chatbot-input">Câu hỏi dành cho RealViewee</label>
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
  const contextBar = panel.querySelector('[data-chatbot-context]');
  const contextClearButton = contextBar.querySelector('button');
  const conversation = [];
  let isSending = false;
  let selectedHistoryContext = null;
  let resultReadiness = { resultId: '', state: 'idle', timer: null };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const allowedMascotStates = new Set(['default', 'happy', 'curious', 'surprised', 'confident', 'excited', 'concerned', 'running']);
  let mascotTimers = [];
  let mascotBubbleTimer;

  function safeMascotState(state, fallback = 'default') {
    return allowedMascotStates.has(state) ? state : fallback;
  }

  function setHomeMascotState(homeMascot, state) {
    if (!homeMascot?.sprite) return;
    homeMascot.sprite.dataset.mascotState = safeMascotState(state);
  }

  function clearMascotCycle() {
    mascotTimers.forEach((timer) => window.clearTimeout(timer));
    mascotTimers = [];
  }

  function queueMascotCycle(homeMascot) {
    clearMascotCycle();
    const companion = homeMascot?.companion;
    if (!companion || companion.classList.contains('is-interacting') || companion.classList.contains('is-chat-open')) return;
    if (reducedMotion.matches) {
      companion.classList.remove('is-patrolling');
      setHomeMascotState(homeMascot, 'default');
      return;
    }
    companion.classList.add('is-patrolling');
    const steps = [[0, 'running'], [4300, 'default'], [6100, 'default'], [8400, 'default'], [10600, 'running'], [14200, 'default']];
    steps.forEach(([delay, state]) => mascotTimers.push(window.setTimeout(() => setHomeMascotState(homeMascot, state), delay)));
    mascotTimers.push(window.setTimeout(() => queueMascotCycle(homeMascot), 16800));
  }

  function createHomepageMascot() {
    const homeHost = document.querySelector('.hero-copy');
    const isHome = Boolean(homeHost && document.querySelector('#analyze-form'));
    if (!isHome) return null;

    const stage = document.createElement('aside');
    stage.className = 'realviewee-stage realviewee-stage--home';
    stage.setAttribute('aria-label', 'Trợ lý mua sắm RealViewee');
    stage.innerHTML = `
      <div class="realviewee-companion is-patrolling">
        <span class="realviewee-speech" role="status" aria-live="polite">Mình giúp bạn check review nhé?</span>
        <button class="realviewee-character" type="button" aria-label="Mở Chat with RealViewee">
          <span class="realviewee-sprite" data-mascot-state="running" aria-hidden="true"></span>
        </button>
      </div>`;

    homeHost.classList.add('has-realviewee-stage');
    homeHost.append(stage);

    const companion = stage.querySelector('.realviewee-companion');
    const character = stage.querySelector('.realviewee-character');
    const speech = stage.querySelector('.realviewee-speech');
    const sprite = stage.querySelector('.realviewee-sprite');
    const homeMascot = { stage, companion, character, speech, sprite };

    const pauseForInteraction = (state = 'default') => {
      clearMascotCycle();
      companion.classList.add('is-interacting');
      setHomeMascotState(homeMascot, state);
    };
    const resumePatrol = () => {
      companion.classList.remove('is-interacting');
      companion.style.removeProperty('--mascot-lean');
      queueMascotCycle(homeMascot);
    };

    character.addEventListener('pointerenter', () => pauseForInteraction('default'));
    character.addEventListener('pointermove', (event) => {
      const bounds = character.getBoundingClientRect();
      const ratio = bounds.width ? (event.clientX - bounds.left) / bounds.width : .5;
      companion.style.setProperty('--mascot-lean', `${Math.max(-5, Math.min(5, (ratio - .5) * 10))}deg`);
    });
    character.addEventListener('pointerleave', () => {
      if (speech.classList.contains('is-visible') || panel.classList.contains('is-open')) return;
      resumePatrol();
    });
    character.addEventListener('focus', () => pauseForInteraction('default'));
    character.addEventListener('blur', () => {
      if (!panel.classList.contains('is-open')) resumePatrol();
    });
    character.addEventListener('click', () => {
      window.clearTimeout(mascotBubbleTimer);
      pauseForInteraction('happy');
      speech.classList.add('is-visible');
      mascotBubbleTimer = window.setTimeout(() => {
        speech.classList.remove('is-visible');
        setOpen(true, false);
      }, 650);
    });

    queueMascotCycle(homeMascot);
    return homeMascot;
  }

  function createStaticMascot(host, state, placement, label, before = null) {
    if (!host || !allowedMascotStates.has(state)) return null;
    const button = document.createElement('button');
    button.className = `realviewee-static realviewee-static--${placement}`;
    button.type = 'button';
    button.setAttribute('aria-label', `${label}. Mở Chat with RealViewee`);
    button.innerHTML = `<span class="realviewee-sprite" data-mascot-state="${state}" aria-hidden="true"></span>`;
    button.addEventListener('click', () => setOpen(true, false));
    if (before) host.insertBefore(button, before);
    else host.append(button);
    return button;
  }

  function createResultMascots() {
    if (!document.body.classList.contains('results-page')) return [];
    const mascots = [];
    const progressHead = document.querySelector('.analysis-progress-head');
    mascots.push(createStaticMascot(progressHead, 'curious', 'loading', 'RealViewee đang xem xét sản phẩm'));

    const trustPanel = document.querySelector('#trust-card .trust-score-panel');
    mascots.push(createStaticMascot(trustPanel, 'confident', 'trust', 'RealViewee tự tin với kết quả TrustScore'));

    const keptSummary = document.querySelector('#danh-gia-giu-lai > summary');
    mascots.push(createStaticMascot(keptSummary, 'surprised', 'kept', 'RealViewee bất ngờ với các đánh giá đáng tham khảo', keptSummary?.querySelector('.accordion-count')));

    const excludedSummary = document.querySelector('#danh-gia-da-loai > summary');
    mascots.push(createStaticMascot(excludedSummary, 'concerned', 'excluded', 'RealViewee lưu ý các đánh giá đã bị loại', excludedSummary?.querySelector('.accordion-count')));

    const counterpartHeading = document.querySelector('#counterpart-section .counterpart-heading');
    mascots.push(createStaticMascot(counterpartHeading, 'excited', 'counterpart', 'RealViewee hào hứng với sản phẩm đối chiếu'));
    return mascots.filter(Boolean);
  }

  const mascot = createHomepageMascot();
  createResultMascots();

  function currentResultAccess() {
    if (!/(?:\/results\.html|\/ket-qua)$/i.test(window.location.pathname)) return null;
    try {
      const result = JSON.parse(sessionStorage.getItem('realview:last-analysis') || 'null');
      const context = result?.chatContext;
      return context?.available && context?.resultId && context?.accessToken
        ? { type: 'current_result', resultId: context.resultId, accessToken: context.accessToken }
        : null;
    } catch {
      return null;
    }
  }

  function currentResultTitle() {
    try {
      return JSON.parse(sessionStorage.getItem('realview:last-analysis') || 'null')?.product?.title || 'sản phẩm này';
    } catch {
      return 'sản phẩm này';
    }
  }

  function syncResultMode() {
    const currentContext = currentResultAccess();
    const currentUnavailable = currentContext && resultReadiness.resultId === currentContext.resultId
      && resultReadiness.state === 'unavailable';
    const activeContext = selectedHistoryContext || (currentUnavailable ? null : currentContext);
    const hasResult = Boolean(activeContext);
    const helper = form.querySelector(':scope > p');
    input.placeholder = hasResult ? 'Hỏi thêm về kết quả này...' : 'Hỏi về RealView...';
    if (helper) helper.textContent = hasResult
      ? 'Câu trả lời chỉ dựa trên kết quả và review đã phân tích.'
      : 'Chỉ trả lời từ thông tin chính thức của RealView.';
    contextBar.hidden = !selectedHistoryContext && !currentContext;
    contextBar.dataset.state = 'ready';
    contextClearButton.hidden = !selectedHistoryContext;
    if (selectedHistoryContext) {
      contextBar.querySelector('span').textContent = `Đang hỏi về: ${selectedHistoryContext.title}`;
    } else if (currentContext) {
      const state = resultReadiness.resultId === currentContext.resultId ? resultReadiness.state : 'syncing';
      contextBar.dataset.state = state;
      contextBar.querySelector('span').textContent = state === 'syncing'
        ? 'Đang đồng bộ dữ liệu sản phẩm…'
        : state === 'unavailable'
          ? 'Chưa thể đọc dữ liệu sản phẩm này'
          : `Đang hỏi về: ${currentResultTitle()}`;
    }
    const syncing = Boolean(currentContext && !selectedHistoryContext
      && resultReadiness.resultId === currentContext.resultId && resultReadiness.state === 'syncing');
    input.disabled = isSending || syncing;
    submitButton.disabled = isSending || syncing;
  }

  function scheduleResultReadinessCheck(delay = 450, attempt = 0) {
    clearTimeout(resultReadiness.timer);
    resultReadiness.timer = window.setTimeout(async () => {
      const context = currentResultAccess();
      if (!context || context.resultId !== resultReadiness.resultId) return;
      try {
        const response = await fetch('/api/result-context-status', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resultId: context.resultId, accessToken: context.accessToken }),
          signal: AbortSignal.timeout(2_500)
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.status === 'ready') resultReadiness.state = 'ready';
        else if (response.status === 409 && data.code === 'RESULT_CONTEXT_PREPARING' && attempt < 1) {
          scheduleResultReadinessCheck(700, attempt + 1);
          return;
        } else if (response.status === 409) resultReadiness.state = 'deferred';
        else resultReadiness.state = 'unavailable';
      } catch {
        // Đây chỉ là phép kiểm tra UX. Nếu request này lỗi, /api/chat vẫn giữ
        // cơ chế retry để chatbot không bị vô hiệu hóa vì một lần probe hỏng.
        resultReadiness.state = 'deferred';
      }
      syncResultMode();
    }, delay);
  }

  function beginResultReadinessCheck() {
    const context = currentResultAccess();
    if (!context) return;
    if (resultReadiness.resultId === context.resultId && ['syncing', 'ready', 'deferred'].includes(resultReadiness.state)) return;
    clearTimeout(resultReadiness.timer);
    resultReadiness = { resultId: context.resultId, state: 'syncing', timer: null };
    syncResultMode();
    scheduleResultReadinessCheck();
  }

  function setOpen(open, restoreFocus = true) {
    if (open) {
      beginResultReadinessCheck();
      syncResultMode();
      siteHeader?.classList.remove('is-menu-open');
      navToggle?.setAttribute('aria-expanded', 'false');
      if (navToggleLabel) navToggleLabel.textContent = 'Mở menu';
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('is-open'));
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-label', 'Đóng Trợ lý RealView');
      document.body.classList.add('chatbot-open');
      if (mascot?.companion) {
        clearMascotCycle();
        mascot.companion.classList.add('is-chat-open');
        mascot.speech.classList.remove('is-visible');
        setHomeMascotState(mascot, 'happy');
      }
      window.setTimeout(() => input.focus(), 180);
    } else {
      panel.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-label', 'Mở Trợ lý RealView');
      document.body.classList.remove('chatbot-open');
      if (mascot?.companion) {
        mascot.companion.classList.remove('is-chat-open');
        setHomeMascotState(mascot, 'default');
        queueMascotCycle(mascot);
      }
      window.setTimeout(() => {
        if (!panel.classList.contains('is-open')) panel.hidden = true;
      }, 180);
      if (restoreFocus) trigger.focus();
    }
  }

  function scrollToLatest() {
    messagesRoot.scrollTo({ top: messagesRoot.scrollHeight, behavior: 'smooth' });
  }

  function addMessage(role, content, engine, citations = []) {
    const message = document.createElement('article');
    message.className = `chatbot-message chatbot-message--${role}`;
    if (role === 'assistant') {
      const avatar = document.createElement('span');
      avatar.className = 'chatbot-message-avatar chatbot-message-avatar--realviewee';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.innerHTML = '<span class="realviewee-sprite" data-mascot-state="happy"></span>';
      message.append(avatar);
    }
    const body = document.createElement('div');
    const text = document.createElement('p');
    text.textContent = content;
    body.append(text);
    if (role === 'assistant') {
      if (Array.isArray(citations) && citations.length) {
        const evidence = document.createElement('small');
        evidence.className = 'chatbot-citations';
        evidence.textContent = `Đối chiếu review: ${citations.join(', ')}`;
        body.append(evidence);
      }
      const label = document.createElement('time');
      label.textContent = engine === 'knowledge-base' ? 'Kho dữ liệu RealView' : 'RealViewee';
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
      const context = selectedHistoryContext
        ? { type: 'history_item', historyItemId: selectedHistoryContext.historyItemId }
        : resultReadiness.state === 'unavailable' ? null : currentResultAccess();
      let response;
      let data;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch('/api/chat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: conversation.slice(-8), ...(context ? { context } : {}) }),
          signal: AbortSignal.timeout(15_000)
        });
        data = await response.json().catch(() => ({}));
        if (response.status !== 409 || data.code !== 'RESULT_CONTEXT_PREPARING' || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 350 + attempt * 250));
      }
      if (!response.ok) throw new Error(data.error || 'Không thể kết nối Trợ lý RealView.');
      const answer = String(data.answer || 'Mình chưa có thông tin này trong kho dữ liệu RealView. Bạn có thể liên hệ đội ngũ để được hỗ trợ.');
      loading.remove();
      addMessage('assistant', answer, data.engine, data.citations);
      conversation.push({ role: 'assistant', content: answer });
      if (conversation.length > 8) conversation.splice(0, conversation.length - 8);
    } catch {
      loading.remove();
      addMessage('assistant', 'Hiện mình chưa thể kết nối. Bạn vui lòng thử lại sau hoặc liên hệ đội ngũ RealView.');
    } finally {
      isSending = false;
      syncResultMode();
      input.focus();
    }
  }

  trigger.addEventListener('click', () => setOpen(trigger.getAttribute('aria-expanded') !== 'true'));
  navToggle?.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') setOpen(false, false);
  });
  closeButton.addEventListener('click', () => setOpen(false));
  contextClearButton.addEventListener('click', () => {
    selectedHistoryContext = null;
    conversation.splice(0);
    syncResultMode();
  });
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
  window.addEventListener('realview:chat-history-select', (event) => {
    const historyItemId = String(event.detail?.historyItemId || '');
    if (!historyItemId) return;
    selectedHistoryContext = { historyItemId, title: String(event.detail?.title || 'Sản phẩm trong lịch sử') };
    conversation.splice(0);
    setOpen(true);
  });
  window.addEventListener('realview:analysis-result', () => {
    clearTimeout(resultReadiness.timer);
    resultReadiness = { resultId: '', state: 'idle', timer: null };
    if (trigger.getAttribute('aria-expanded') === 'true') beginResultReadinessCheck();
    syncResultMode();
  });
  window.addEventListener('realview:auth-changed', (event) => {
    if (!event.detail?.user) {
      selectedHistoryContext = null;
      conversation.splice(0);
      syncResultMode();
    }
  });
})();
