/* PromHub Capturer — overlay logic */

const TYPE_META = {
  items:   { label: 'Редагування товарів', badge: 'ph-badge-items',   action: 'Зберегти шаблон товарів',   gold: false },
  payment: { label: 'Зміна способу оплати', badge: 'ph-badge-payment', action: 'Зберегти шаблон оплати',   gold: false },
  receipt: { label: 'Прив\'язка чека',     badge: 'ph-badge-receipt', action: 'Зберегти шаблон чека',     gold: true  },
};

const body = document.getElementById('ph-body');
const statusEl = document.getElementById('ph-status');

let currentCandidates = {};

function render() {
  const types = ['items', 'payment', 'receipt'];
  const hasAny = types.some(t => currentCandidates[t]);

  if (!hasAny) {
    body.innerHTML = `
      <div class="ph-empty">
        <div class="ph-empty-ic">🔍</div>
        <div>Запитів поки не перехоплено.</div>
        <div style="font-size:12px;margin-top:8px">Відкрийте замовлення на my.prom.ua і виконайте:
          <br>• Зміну товарів
          <br>• Зміну способу оплати
          <br>• Прив'язку чека
          <br>Запити автоматично з'являться тут.
        </div>
      </div>
    `;
    statusEl.textContent = 'Очікування запитів my.prom.ua...';
    return;
  }

  body.innerHTML = types
    .filter(t => currentCandidates[t])
    .map(t => renderCard(t, currentCandidates[t]))
    .join('');

  // Прив'язка обробників кнопок
  types.forEach(t => {
    if (!currentCandidates[t]) return;
    const saveBtn = document.getElementById('ph-save-' + t);
    if (saveBtn) saveBtn.addEventListener('click', () => saveTemplate(t));
    const dismissBtn = document.getElementById('ph-dismiss-' + t);
    if (dismissBtn) dismissBtn.addEventListener('click', () => dismiss(t));
  });

  statusEl.innerHTML = '<span class="ph-status-dot"></span>Готовий до збереження ' +
    types.filter(t => currentCandidates[t]).length + ' шаблон(ів)';
}

function renderCard(type, c) {
  const meta = TYPE_META[type];
  const method = c.method || 'POST';
  const urlShort = (c.url || '').slice(0, 60) + ((c.url || '').length > 60 ? '…' : '');
  let extra = '';

  if (type === 'items' || type === 'payment') {
    extra += `<div class="ph-field"><span class="ph-field-k">№ замовлення:</span> <span class="ph-field-v">${c.orderId || '—'}</span></div>`;
  }
  if (type === 'payment') {
    extra += `<div class="ph-field"><span class="ph-field-k">ID оплати:</span> <span class="ph-field-v">${c.paymentOptionId || '—'}</span></div>`;
  }
  if (type === 'receipt') {
    extra += `<div class="ph-field"><span class="ph-field-k">Посилання чека:</span> <span class="ph-field-v mono">${c.receiptUrl || '—'}</span></div>`;
  }
  if (c.accountId) {
    extra += `<div class="ph-field"><span class="ph-field-k">Аккаунт:</span> <span class="ph-field-v mono">${c.accountId}</span></div>`;
  }

  return `
    <div class="ph-card">
      <div class="ph-card-head">
        <div class="ph-card-title">${meta.label}</div>
        <span class="ph-badge ${meta.badge}">${method}</span>
      </div>
      <div class="ph-field"><span class="ph-field-k">URL:</span> <span class="ph-field-v mono">${escapeHtml(urlShort)}</span></div>
      <div class="ph-field"><span class="ph-field-k">Захоплено:</span> <span class="ph-field-v">${new Date(c.capturedAt).toLocaleTimeString('uk-UA')}</span></div>
      ${extra}
      <div class="ph-actions">
        <button class="ph-btn ph-btn-primary ${meta.gold ? 'ph-btn-gold' : ''}" id="ph-save-${type}">${meta.action}</button>
        <button class="ph-btn ph-btn-ghost" id="ph-dismiss-${type}">Відхилити</button>
      </div>
      <div id="ph-result-${type}"></div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function saveTemplate(type) {
  const c = currentCandidates[type];
  if (!c) return;
  const btn = document.getElementById('ph-save-' + type);
  const resultEl = document.getElementById('ph-result-' + type);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Збереження...'; }

  const payload = {
    action: 'save',
    template_type: type,
    curl_text: c.curl,
    account_id: c.accountId || '',
    example_order_id: c.orderId || 0,
    example_receipt_url: c.receiptUrl || '',
    example_option_id: c.paymentOptionId || 0,
  };

  window.parent.postMessage({ type: 'promhub_save', payload }, '*');

  // Слухаємо результат через window.message
  window.addEventListener('message', function onResp(ev) {
    if (ev.data && ev.data.type === 'promhub_save_result') {
      window.removeEventListener('message', onResp);
      const r = ev.data.result;
      if (btn) { btn.disabled = false; btn.textContent = TYPE_META[type].action; }
      if (r && r.ok) {
        if (resultEl) resultEl.innerHTML = `<div class="ph-result ph-result-ok">${escapeHtml(r.message || '✓ Збережено')}</div>`;
        // Через 2 сек прибрати карточку
        setTimeout(() => {
          currentCandidates[type] = null;
          render();
        }, 2000);
      } else {
        const errMsg = (r && r.error) || 'невідома помилка';
        const hint = (r && r.hint) ? `<br><span style="font-size:11.5px;color:#64748b">${escapeHtml(r.hint)}</span>` : '';
        if (resultEl) resultEl.innerHTML = `<div class="ph-result ph-result-err">✗ ${escapeHtml(errMsg)}${hint}</div>`;
      }
    }
  });
}

function dismiss(type) {
  window.parent.postMessage({ type: 'promhub_dismiss', candidateType: type }, '*');
}

document.getElementById('ph-close').addEventListener('click', () => {
  window.parent.postMessage({ type: 'promhub_close' }, '*');
});

// Приймаємо оновлення стану від content-script
window.addEventListener('message', function (ev) {
  if (ev.data && ev.data.type === 'promhub_update') {
    currentCandidates = ev.data.candidates || {};
    render();
  }
});

// Сигналізуємо що готові приймати дані
window.parent.postMessage({ type: 'promhub_ready' }, '*');
