/**
 * Yerel Asistan — frontend
 * Vanilla ESM, dependency yok.
 */

// ═══ State ═══
const state = {
  conversations: [],
  currentId: null,
  providers: [],
  provider: 'ollama',
  model: 'mistral:latest',
  modelTab: 'all',
  agentMode: false,
  streaming: false,
  controller: null,
  models: [],
  attachments: [],
};

const $ = (sel) => document.querySelector(sel);
const el = {
  sidebar: $('#sidebar'),
  history: $('#history'),
  messages: $('#messages'),
  empty: $('#emptyState'),
  input: $('#input'),
  composer: $('#composer'),
  sendBtn: $('#sendBtn'),
  scroll: $('#chatScroll'),
  modelDrawer: $('#modelDrawer'),
  modelList: $('#modelList'),
  settingsDrawer: $('#settingsDrawer'),
  backdrop: $('#drawerBackdrop'),
  toast: $('#toast'),
  statusDot: $('#statusDot'),
  currentModelLabel: $('#currentModelLabel'),
  topModelName: $('#topModelName'),
  agentToggle: $('#agentToggle'),
  agentSwitch: $('#agentSwitch'),
  fileInput: $('#fileInput'),
  attachStrip: $('#attachStrip'),
};

// ═══ Yardımcılar ═══
function esc(s) {
  return String(s).replace(/[&<>"'']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": "'"
  })[c]);
}

function toast(msg, dur = 2500) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(el.toast._timer);
  el.toast._timer = setTimeout(() => { el.toast.hidden = true; }, dur);
}

function openDrawer(drawerEl) {
  closeDrawers();
  if (!drawerEl) return;
  drawerEl.hidden = false;
  if (el.backdrop) el.backdrop.hidden = false;
}

function closeDrawers() {
  if (el.modelDrawer) el.modelDrawer.hidden = true;
  if (el.settingsDrawer) el.settingsDrawer.hidden = true;
  if (el.backdrop) el.backdrop.hidden = true;
}

function newChat() {
  state.currentId = null;
  el.messages.innerHTML = '';
  el.empty.hidden = false;
  state.attachments = [];
  updateAttachStrip();
  renderHistory();
  el.input.value = '';
  autoGrow();
  el.input.focus();
}

async function selectConversation(id) {
  if (state.currentId === id) return;
  state.currentId = id;
  renderHistory();
  await loadMessages(id);
}

async function deleteConversation(id) {
  if (!confirm('Bu sohbeti silmek istediğinize emin misiniz?')) return;
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.currentId === id) {
      newChat();
    }
    await loadConversations();
    toast('Sohbet silindi');
  } catch (e) {
    toast(`Silinemedi: ${e.message}`);
  }
}

/** Minimal markdown -> HTML (kod blokları, satır sonu, listeler, başlıklar) */
function renderMarkdown(src) {
  const blocks = [];
  // Kod bloklarını çıkar
  let text = String(src).replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(
      `<div class="code-block"><div class="code-block-head">` +
      `<span class="lang">${esc(lang || 'kod')}</span>` +
      `<button class="code-copy" data-copy-code="${i}">Kopyala</button></div>` +
      `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`
    );
    return '\u0000BLOCK' + i + '\u0000';
  });

  text = esc(text);

  // Satır içi kod
  text = text.replace(/`([^\`\n]+)`/g, '<code>$1</code>');

  // Başlıklar
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blok alıntı
  text = text.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Yatay çizgi
  text = text.replace(/^---+$/gm, '<hr>');

  // Listeler
  text = text.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  text = text.replace(/^\s*\d+\\. (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');

  // Linkler
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Paragraf
  text = text.split(/\n{2,}/).map((p) => {
    const t = p.trim();
    if (!t) return '';
    if (/^<(h[1-3]|ul|ol|blockquote|hr|pre|div)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  // Kod bloklarını geri koy
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return text || '';
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
}

function scrollToBottom(force = false) {
  const near = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 160;
  if (force || near) {
    el.scroll.scrollTop = el.scroll.scrollHeight;
  }
}

// ═══ Mesaj render ═══
function addMessage(role, content, { model = null, avatar = null, streaming = false, reasoning = '' } = {}) {
  const wrap = document.createElement('article');
  wrap.className = `msg ${role}`;
  const av = avatar || (role === 'user' ? 'S' : 'A');
  wrap.innerHTML = `
    <div class="msg-avatar">${esc(av)}</div>
    <div class="msg-body">
      ${role === 'assistant' && model ? `<div class="msg-model">${esc(model)}</div>` : ''}
      <div class="msg-content"></div>
    </div>`;
  const body = wrap.querySelector('.msg-body');
  const contentEl = wrap.querySelector('.msg-content');

  // Reasoning paneli (varsa veya streaming sırasında)
  let reasoningPanel = null, reasoningBody = null;
  if (role === 'assistant' && (reasoning || streaming)) {
    reasoningPanel = document.createElement('div');
    reasoningPanel.className = 'reasoning-panel' + (streaming ? ' streaming' : '');
    reasoningPanel.innerHTML = `
      <button class="reasoning-toggle" type="button">
        <svg viewBox="0 0 24 24" class="chev"><path d="M9 18l6-6-6-6"/></svg>
        <span class="pulse"></span>
        <span class="label">Düşünüyor…</span>
      </button>
      <div class="reasoning-body"></div>`;
    reasoningBody = reasoningPanel.querySelector('.reasoning-body');
    if (reasoning) reasoningBody.textContent = reasoning;
    reasoningPanel.querySelector('.reasoning-toggle').addEventListener('click', () => {
      reasoningPanel.classList.toggle('open');
    });
    body.insertBefore(reasoningPanel, contentEl);
  }

  if (streaming) {
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  } else {
    contentEl.innerHTML = renderMarkdown(content);
  }
  el.messages.appendChild(wrap);
  scrollToBottom(true);
  return { wrap, contentEl, reasoningPanel, reasoningBody };
}

function addActions(wrap, text) {
  const body = wrap.querySelector('.msg-body');
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = `
    <button title="Kopyala" data-act="copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
    <button title="Yeniden üret" data-act="regen"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6"/></svg></button>
    <button title="Beğendim" data-act="up"><svg viewBox="0 0 24 24"><path d="M7 10v12M15 5.9L14 10h5.8a2 2 0 012 2.3l-1.4 7A2 2 0 0118.5 21H4a2 2 0 01-2-2v-7a2 2 0 012-2h2.5L7 5.9A2 2 0 0110 4z"/></svg></button>
    <button title="Beğenmedim" data-act="down"><svg viewBox="0 0 24 24"><path d="M17 14V2M9 18.1L10 14H4.2a2 2 0 01-2-2.3l1.4-7A2 2 0 015.5 3H20a2 2 0 012 2v7a2 2 0 01-2 2h-2.5L9 18.1a2 2 0 01-4-1z"/></svg></button>`;
  actions.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'copy') {
      navigator.clipboard.writeText(text).then(() => toast('Kopyalandı'));
    } else if (act === 'regen') {
      const prevUser = [...el.messages.querySelectorAll('.msg.user')].pop();
      const prevText = prevUser?.querySelector('.msg-content')?.innerText;
      if (prevText) {
        prevUser.remove();
        wrap.remove();
        el.input.value = prevText;
        send();
      }
    } else {
      toast(act === 'up' ? 'Teşekkürler' : 'Geri bildirim kaydedildi');
    }
  });
  body.appendChild(actions);
}

// ═══ API ═══
const URL_KEY = new URLSearchParams(location.search).get('key') || '';
const STORED_KEY = localStorage.getItem('accessKey') || '';
const ACCESS_KEY = URL_KEY || STORED_KEY;

if (URL_KEY) localStorage.setItem('accessKey', URL_KEY);

const IS_LOCAL = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);

function authHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (ACCESS_KEY) h['x-access-key'] = ACCESS_KEY;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: authHeaders(opts.headers || {}),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function loadModels() {
  try {
    const data = await api('/api/models');
    state.providers = data.providers;
    state.models = [];
    for (const p of data.providers) {
      for (const m of p.models) {
        state.models.push({ ...m, provider: p.provider });
      }
    }
    if (!state.models.find((m) => m.id === state.model && m.provider === state.provider)) {
      const sameProvider = state.models.find((m) => m.provider === state.provider);
      const local = state.models.find((m) => m.provider === 'ollama');
      const first = sameProvider || local || state.models[0];
      if (first) {
        state.provider = first.provider;
        state.model = first.id;
      }
    }
    renderModelList();
    updateModelLabels();
  } catch (e) {
    console.error('Model yükleme hatası', e);
  }
}

async function loadConversations() {
  try {
    const { conversations } = await api('/api/conversations');
    state.conversations = conversations;
    renderHistory();
  } catch (e) { /* yoksay */ }
}

async function loadMessages(id) {
  try {
    const { messages } = await api(`/api/conversations/${id}/messages`);
    el.messages.innerHTML = '';
    el.empty.hidden = messages.length > 0;
    for (const m of messages) {
      const { wrap } = addMessage(m.role, m.content, {
        model: m.model, reasoning: m.reasoning || '',
      });
      if (m.role === 'assistant') addActions(wrap, m.content);
    }
    scrollToBottom(true);
  } catch (e) { console.error(e); }
}

// ═══ Render ═══
function renderHistory() {
  el.history.innerHTML = '';
  const now = Date.now();
  const buckets = {
    'Bugün': [], 'Dün': [], 'Son 7 gün': [],
    'Son 30 gün': [], 'Daha eski': [],
  };

  for (const c of state.conversations) {
    const age = now - c.updated_at;
    const day = 86400000;
    let key = 'Daha eski';
    if (age < day) key = 'Bugün';
    else if (age < day * 2) key = 'Dün';
    else if (age < day * 7) key = 'Son 7 gün';
    else if (age < day * 30) key = 'Son 30 gün';
    buckets[key].push(c);
  }

  for (const [group, items] of Object.entries(buckets)) {
    if (!items.length) continue;
    const div = document.createElement('div');
    div.className = 'history-group';
    const h = document.createElement('h3');
    h.textContent = group;
    div.appendChild(h);
    for (const c of items) {
      const item = document.createElement('button');
      item.className = 'history-item' + (c.id === state.currentId ? ' active' : '');
      item.innerHTML = `<span class="title">${esc(c.title)}</span>
        <span class="del" data-del="${esc(c.id)}" title="Sil">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </span>`;
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) {
          e.stopPropagation();
          deleteConversation(c.id);
          return;
        }
        selectConversation(c.id);
        el.sidebar.classList.remove('open');
      });
      div.appendChild(item);
    }
    el.history.appendChild(div);
  }
}

function renderModelList(filter = '') {
  const q = filter.toLowerCase();
  const tab = state.modelTab || 'all';
  el.modelList.innerHTML = '';

  const PROVIDER_LABELS = {
    ollama: 'Yerel · Ollama',
    nvidia: 'Bulut · NVIDIA NIM',
  };

  for (const provider of ['ollama', 'nvidia']) {
    if (tab !== 'all' && tab !== provider) continue;
    const models = state.models.filter((m) => m.provider === provider);
    if (!models.length) continue;

    const sec = document.createElement('div');
    sec.className = 'model-section';
    sec.innerHTML = `<h3>${esc(PROVIDER_LABELS[provider] || provider)} · ${models.length}</h3>`;
    for (const m of models) {
      const hay = `${m.id} ${m.label || ''} ${m.tag || ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const btn = document.createElement('button');
      btn.className = 'model-item' + (m.id === state.model && m.provider === state.provider ? ' active' : '');
      const tag = m.local ? 'local' : 'cloud';
      const slow = m.speed === 'yavaş' ? '<span class="m-tag slow">Yavaş</span>' : '';
      btn.innerHTML = `
        <span class="m-name">
          ${esc(m.label || m.id)}
          ${m.tag ? `<span class="m-sub">${esc(m.tag)}</span>` : ''}
        </span>
        ${slow}${tag ? `<span class="m-tag ${tag}">${tag === 'local' ? 'Yerel' : 'Bulut'}</span>` : ''}`;
      btn.title = m.id;
      btn.addEventListener('click', () => {
        state.provider = m.provider;
        state.model = m.id;
        rememberModel();
        updateModelLabels();
        renderModelList($('#modelSearch').value);
        closeDrawers();
      });
      sec.appendChild(btn);
    }
    el.modelList.appendChild(sec);
  }

  if (!el.modelList.children.length) {
    el.modelList.innerHTML = '<p style="padding:20px;color:var(--text-tertiary);font-size:13px">Eşleşen model yok</p>';
  }
}

function updateModelLabels() {
  const m = state.models.find((x) => x.id === state.model && x.provider === state.provider);
  const name = m?.label || state.model.split('/').pop();
  el.currentModelLabel.textContent = name;
  el.topModelName.textContent = name;
  const badge = state.provider === 'nvidia' ? '☁' : '🖥';
  el.currentModelLabel.title = `${badge} ${state.provider} · ${state.model}`;
  el.topModelName.title = `${badge} ${state.provider} · ${state.model}`;
}

function rememberModel() {
  localStorage.setItem('lastModel', JSON.stringify({
    provider: state.provider, model: state.model,
  }));
}

function recallModel() {
  try {
    const saved = JSON.parse(localStorage.getItem('lastModel') || 'null');
    if (saved?.model) {
      state.provider = saved.provider;
      state.model = saved.model;
    }
  } catch { /* bozuk veri — yoksay */ }
}

// ═══ Sohbet akışı ═══
async function send() {
  const text = el.input.value.trim();
  if (!text || state.streaming) return;

  el.input.value = '';
  autoGrow();
  el.empty.hidden = true;

  addMessage('user', text);
  const { wrap, contentEl, reasoningPanel, reasoningBody } = addMessage('assistant', '', {
    model: state.model, streaming: true,
  });

  state.streaming = true;
  el.sendBtn.classList.add('stopping');
  el.sendBtn.disabled = false;
  state.controller = new AbortController();

  let full = '';
  let reasoning = '';
  let toolBlocks = [];

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders(),
      signal: state.controller.signal,
      body: JSON.stringify({
        message: text,
        conversationId: state.currentId,
        provider: state.provider,
        model: state.model,
        agent: state.agentMode,
        attachments: state.attachments.map((a) => ({ id: a.id, name: a.name, type: a.type })),
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(res.status === 401
        ? 'Erişim anahtarı gerekli — ?key=... ile bağlan'
        : `Sunucu hatası ${res.status}: ${err.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        if (ev.type === 'conversation') {
          state.currentId = ev.conversationId;
          loadConversations();
        } else if (ev.type === 'reasoning') {
          reasoning += ev.text;
          if (reasoningBody) reasoningBody.textContent = reasoning;
          if (full === '') contentEl.innerHTML = '';
          scrollToBottom();
        } else if (ev.type === 'delta') {
          if (full === '') contentEl.innerHTML = '';
          full += ev.text;
          contentEl.innerHTML = renderMarkdown(full);
          scrollToBottom();
        } else if (ev.type === 'tool_start') {
          const div = document.createElement('div');
          div.className = 'tool-call';
          div.innerHTML = `<div class="tool-name">⚙ ${esc(ev.tool)}</div>
            <div class="tool-detail">${esc(JSON.stringify(ev.args || {}))}</div>`;
          wrap.querySelector('.msg-body').insertBefore(div, contentEl);
          toolBlocks.push(div);
        } else if (ev.type === 'tool_result') {
          const div = toolBlocks[toolBlocks.length - 1];
          if (div) {
            div.querySelector('.tool-detail').textContent =
              `${ev.ok ? '✓' : '✗'} ${String(ev.preview || '').slice(0, 500)}`;
          }
        } else if (ev.type === 'saved') {
          loadConversations();
        } else if (ev.type === 'error') {
          contentEl.innerHTML = `<p style="color:var(--danger)">Hata: ${esc(ev.error)}</p>`;
        }
      }
    }

    if (full) addActions(wrap, full);

    if (reasoningPanel) {
      reasoningPanel.classList.remove('streaming');
      const label = reasoningPanel.querySelector('.label');
      const pulse = reasoningPanel.querySelector('.pulse');
      if (pulse) pulse.remove();
      if (reasoning) {
        label.textContent = 'Akıl yürütme';
        reasoningPanel.querySelector('.reasoning-toggle').title = 'Modelin düşünme sürecini göster';
      } else {
        reasoningPanel.remove();
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      contentEl.innerHTML = `<p style="color:var(--danger)">Bağlantı hatası: ${esc(e.message)}</p>`;
    }
  } finally {
    state.streaming = false;
    el.sendBtn.classList.remove('stopping');
    el.sendBtn.disabled = !el.input.value.trim();
    scrollToBottom();
  }
}

// ═══ Dosya/ekstraksiyon olayları ═══
function formatBytes(bytes, decimals = 1) {
  if (0 === bytes) return '0 Byte';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Byte', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

function addAttachmentToStrip(file) {
  const strip = $('#attachStrip');
  if (!strip) return;

  const isImage = file.type.startsWith('image/');
  const thumbnail = isImage ? `<img class="attach-thumbnail" src="${file.url}" alt="${file.name}"> : ` : '';

  const chip = document.createElement('div');
  chip.className = `attach-chip${file.remove ? ' remove' : ''}`;
  chip.innerHTML = `
    ${thumbnail}
    <span class="attach-filename">${esc(file.name)}</span>
    <span class="attach-size">${esc(formatBytes(file.size))}</span>`;

  const removeBtn = document.createElement('span');
  removeBtn.innerHTML = '✕';
  removeBtn.style.cssText = 'cursor:pointer;color:var(--danger);font-size:12px;';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chip.remove();
    const idx = state.attachments.indexOf(file);
    if (idx > -1) state.attachments.splice(idx, 1);
    updateAttachStrip();
  });

  chip.appendChild(removeBtn);
  strip.prepend(chip);
  updateAttachStrip();
}

function updateAttachStrip() {
  const strip = $('#attachStrip');
  if (!strip) return;

  strip.innerHTML = '';
  strip.classList.remove('visible', 'strip-active', 'hidden');

  if (state.attachments.length > 0) {
    strip.classList.add('visible');
    state.attachments.forEach((file, idx) => {
      const isImage = file.type.startsWith('image/');
      const thumbnail = isImage ? `<img class="attach-thumbnail" src="${file.url}" alt="${file.name}"> : ` : '';

      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      chip.innerHTML = `
        ${thumbnail}
        <span class="attach-filename">${esc(file.name)}</span>
        <span class="attach-size">${esc(formatBytes(file.size))}</span>
        <span class="remove-btn" title="Kaldır">✕</span>`;

      const removeBtn = chip.querySelector('.remove-btn');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = state.attachments.indexOf(file);
        if (idx > -1) state.attachments.splice(idx, 1);
        updateAttachStrip();
      });

      strip.appendChild(chip);
    });
    strip.classList.add('strip-active');
  }
}

// File input click handler
el.attachBtn.addEventListener('click', (e) => {
  e.preventDefault();
  el.fileInput.click();
});

// File input change handler
el.fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  for (const file of files) {
    if (state.attachments.length >= 10) {
      toast('En fazla 10 dosya aynı anda ekleyebilirsiniz');
      break;
    }

    const validTypes = ['image/', 'application/', 'text/'];
    const isValid = validTypes.some(t => file.type.startsWith(t)) || file.name.endsWith('.txt');
    if (!isValid && !file.type.startsWith('image/')) {
      toast(`Desteklenmeyen dosya türü: ${file.name}`);
      continue;
    }

    const fileDescriptor = {
      id: Date.now() + Math.random(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      url: URL.createObjectURL(file),
      uploading: false,
      remove: true,
    };
    state.attachments.push(fileDescriptor);
  }

  updateAttachStrip();
  el.fileInput.value = '';
});

// Drag and drop handlers
const chatPanel = $('.chat-scroll');
chatPanel.addEventListener('dragover', (e) => {
  e.preventDefault();
  chatPanel.classList.add('over');
});

chatPanel.addEventListener('dragleave', () => {
  chatPanel.classList.remove('over');
});

chatPanel.addEventListener('drop', (e) => {
  e.preventDefault();
  chatPanel.classList.remove('over');
  const files = Array.from(e.dataTransfer.files);
  if (!files.length) return;

  for (const file of files) {
    if (state.attachments.length >= 10) {
      toast('En fazla 10 dosya aynı anda ekleyebilirsiniz');
      break;
    }

    const validTypes = ['image/', 'application/', 'text/'];
    const isValid = validTypes.some(t => file.type.startsWith(t)) || file.name.endsWith('.txt');
    if (!isValid && !file.type.startsWith('image/')) {
      toast(`Desteklenmeyen dosya türü: ${file.name}`);
      continue;
    }

    const fileDescriptor = {
      id: Date.now() + Math.random(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      url: URL.createObjectURL(file),
      uploading: false,
      remove: true,
    };
    state.attachments.push(fileDescriptor);
  }

  updateAttachStrip();
});

// Paste handler
el.input.addEventListener('paste', (e) => {
  const items = e.clipboardData.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/') || item.type === 'application/file') {
      const file = item.getAsFile();
      if (file) {
        if (state.attachments.length >= 10) {
          toast('En fazla 10 dosya aynı anda ekleyebilirsiniz');
          break;
        }

        const fileDescriptor = {
          id: Date.now() + Math.random(),
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          url: URL.createObjectURL(file),
          uploading: false,
          remove: true,
        };
        state.attachments.push(fileDescriptor);
      }
    }
  }

  updateAttachStrip();
});

// Remove all attachments on new chat
$('#newChatBtn').addEventListener('click', () => {
  state.attachments = [];
  updateAttachStrip();
  el.sidebar.classList.remove('open');
  newChat();
});

// ═══ Dosya yükleme olayları ═══════════════════════════════════════════════

/** Dosyaları API'ye yükler, state.attachments'i günceller */
async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  for (const file of files) {
    if (state.attachments.length >= 10) {
      toast('En fazla 10 dosya aynı anda ekleyebilirsiniz');
      break;
    }
    const desc = {
      id: `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      url: URL.createObjectURL(file),
      uploading: true,
    };
    state.attachments.push(desc);
    updateAttachStrip();

    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: ACCESS_KEY ? { 'x-access-key': ACCESS_KEY } : {},
        body: fd,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(err.slice(0, 120));
      }
      const up = await res.json();
      Object.assign(desc, up, { uploading: false, remove: true });
    } catch (e) {
      state.attachments = state.attachments.filter((a) => a !== desc);
      toast(`Yükleme başarısız: ${e.message}`, 4000);
    }
  }
  updateAttachStrip();
}

// Dosya seçici
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.id = 'fileInput';
fileInput.hidden = true;
fileInput.addEventListener('change', () => {
  uploadFiles(fileInput.files);
  fileInput.value = '';
});
document.body.appendChild(fileInput);

$('#attachBtn').addEventListener('click', () => fileInput.click());

// Sürükle-bırak
const dropzone = document.createElement('div');
dropzone.className = 'dropzone';
dropzone.innerHTML = '<div class="dropzone-inner">Dosyaları buraya bırak</div>';
document.body.appendChild(dropzone);

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add('active');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('active');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('active');
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

// ═══ Sidebar & drawer olayları ════════════════════════════════════════════

$('#collapseBtn').addEventListener('click', () => el.sidebar.classList.toggle('collapsed'));
$('#menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  el.sidebar.classList.toggle('open');
});

// Mobilde sidebar dışına tıklandığında sidebar'ı kapat
document.addEventListener('click', (e) => {
  if (el.sidebar.classList.contains('open') &&
      !el.sidebar.contains(e.target) &&
      !$('#menuBtn').contains(e.target)) {
    el.sidebar.classList.remove('open');
  }
});
$('#modelPickerBtn').addEventListener('click', () => openDrawer(el.modelDrawer));
$('#topModelBtn').addEventListener('click', () => openDrawer(el.modelDrawer));
$('#drawerClose').addEventListener('click', closeDrawers);
if (el.backdrop) el.backdrop.addEventListener('click', closeDrawers);
$('#settingsBtn').addEventListener('click', () => openDrawer(el.settingsDrawer));
$('#settingsClose').addEventListener('click', closeDrawers);
$('#modelSearch').addEventListener('input', (e) => renderModelList(e.target.value));

// Model sekmeleri (Tümü / Yerel / Bulut)
$('#modelTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.drawer-tab');
  if (!tab) return;
  state.modelTab = tab.dataset.tab;
  document.querySelectorAll('.drawer-tab').forEach((t) => {
    t.classList.toggle('active', t === tab);
  });
  renderModelList($('#modelSearch').value);
});

// Arama
$('#searchInput').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  state.conversations.forEach((c) => {
    c._hidden = q && !c.title.toLowerCase().includes(q);
  });
  renderHistory();
});

// Tema
function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  $('#themeLabel').textContent = next === 'dark' ? 'Karanlık mod' : 'Aydınlık mod';
}
$('#themeBtn').addEventListener('click', toggleTheme);

// Ajan modu
function setAgent(on) {
  state.agentMode = on;
  el.agentSwitch.checked = on;
  el.agentToggle.classList.toggle('active', on);
}
el.agentSwitch.addEventListener('change', (e) => setAgent(e.target.checked));
el.agentToggle.addEventListener('click', () => setAgent(!state.agentMode));

// Erişim anahtarı
$('#accessKeySave').addEventListener('click', () => {
  const key = $('#accessKeyInput').value.trim();
  if (key) {
    localStorage.setItem('accessKey', key);
    $('#accessKeyStatus').textContent = '✓ Anahtar kaydedildi. Sayfa yenileniyor...';
  } else {
    localStorage.removeItem('accessKey');
    $('#accessKeyStatus').textContent = '✓ Anahtar temizlendi. Sayfa yenileniyor...';
  }
  setTimeout(() => location.reload(), 600);
});

// Tüm sohbetleri sil
$('#clearAllBtn').addEventListener('click', async () => {
  if (!confirm('Tüm sohbet geçmişi silinsin mi?')) return;
  for (const c of [...state.conversations]) {
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' }).catch(() => {});
  }
  await loadConversations();
  state.currentId = null;
  el.messages.innerHTML = '';
  el.empty.hidden = false;
  toast('Tüm sohbetler silindi');
});

// Öneri kartları
document.querySelectorAll('.suggestion').forEach((btn) => {
  btn.addEventListener('click', () => {
    el.input.value = btn.dataset.prompt;
    autoGrow();
    el.sendBtn.disabled = false;
    el.input.focus();
  });
});

// Kod kopyalama
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-code]');
  if (!btn) return;
  const blocks = [...document.querySelectorAll('.code-block pre code')];
  const i = Number(btn.dataset.copyCode);
  if (blocks[i]) {
    navigator.clipboard.writeText(blocks[i].textContent).then(() => toast('Kod kopyalandı'));
  }
});

// Klavye kısayolları
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#searchInput').focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    toggleTheme();
  }
  if (e.key === 'Escape') closeDrawers();
});

// ═══ Sağlık kontrolü ══════════════════════════════════════════════════════

async function checkHealth() {
  const ob = $('#ollamaBadge'), nb = $('#nvidiaBadge'), ab = $('#authBadge');
  try {
    const h = await api('/api/health');
    el.statusDot.className = 'status-dot ' + (h.ok ? 'online' : 'offline');
    ob.textContent = h.ollama ? 'aktif' : 'kapalı';
    ob.className = 'badge ' + (h.ollama ? 'ok' : 'bad');
    nb.textContent = h.nvidia ? 'aktif' : 'anahtar yok';
    nb.className = 'badge ' + (h.nvidia ? 'ok' : 'bad');
    ab.textContent = h.publicMode ? (ACCESS_KEY ? 'anahtarlı' : 'anahtar gerekli') : 'yerel';
    ab.className = 'badge ' + (h.publicMode && !ACCESS_KEY ? 'bad' : 'ok');
  } catch (e) {
    el.statusDot.className = 'status-dot offline';
    const auth = /401/.test(e.message);
    ob.textContent = nb.textContent = auth ? 'erişim anahtarı gerekli' : 'bağlantı yok';
    ob.className = nb.className = 'badge bad';
    ab.textContent = auth ? 'anahtar gerekli' : 'bağlantı yok';
    ab.className = 'badge bad';
  }
}

async function loadTools() {
  const b = $('#toolsBadge');
  try {
    const { tools } = await api('/api/tools');
    b.textContent = `${tools.length} araç`;
    b.className = 'badge ok';
  } catch {
    b.textContent = 'yok';
    b.className = 'badge bad';
  }
}

// ═══ Başlat ════════════════════════════════════════════════════════════════

(function init() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
    $('#themeLabel').textContent = saved === 'dark' ? 'Karanlık mod' : 'Aydınlık mod';
  }

  $('#accessKeyInput').value = ACCESS_KEY;
  recallModel();
  checkHealth();
  setInterval(checkHealth, 15000);
  loadTools();
  loadModels();
  loadConversations();
  autoGrow();
  el.input.focus();
})();