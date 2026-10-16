/* PromHub Capturer — background service worker
 * Обробляє збереження шаблонів: приймає від content-script,
 * шле POST на сервер promv2 (api/ajax_cabinet_template.php)
 */

const DEFAULT_SERVER_URL = 'https://promv2.franya.dev/api/ajax_cabinet_template.php';

// Дефолтні налаштування
chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await chrome.storage.sync.get(['serverUrl', 'secret']);
  if (!cfg.serverUrl) {
    await chrome.storage.sync.set({ serverUrl: DEFAULT_SERVER_URL });
  }
  console.log('[PromHub Capturer] встановлено. serverUrl:', cfg.serverUrl || DEFAULT_SERVER_URL);
});

// Прийом повідомлень від content-script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'save_template') {
    saveTemplate(msg.payload)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // тримати sendResponse активним
  }

  if (msg.action === 'ping_server') {
    pingServer()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function getConfig() {
  const cfg = await chrome.storage.sync.get(['serverUrl', 'secret']);
  return {
    serverUrl: cfg.serverUrl || DEFAULT_SERVER_URL,
    secret: cfg.secret || '',
  };
}

async function saveTemplate(payload) {
  const cfg = await getConfig();
  if (!cfg.secret) {
    return {
      ok: false,
      error: 'Не налаштований Secret. Відкрийте налаштування розширення (клік по іконці) і вставте секрет з config.local.php.',
    };
  }

  const body = JSON.stringify({
    action: 'save',
    secret: cfg.secret,
    account_id: payload.account_id || '',
    template_type: payload.template_type,
    curl_text: payload.curl_text,
    example_order_id: payload.example_order_id || 0,
    example_receipt_url: payload.example_receipt_url || '',
    example_option_id: payload.example_option_id || 0,
  });

  try {
    const resp = await fetch(cfg.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await resp.json();
    return data;
  } catch (err) {
    return { ok: false, error: 'Помилка з\'єднання з сервером: ' + err.message };
  }
}

async function pingServer() {
  const cfg = await getConfig();
  if (!cfg.secret) {
    return { ok: false, error: 'Не налаштований Secret' };
  }
  try {
    const resp = await fetch(cfg.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping', secret: cfg.secret }),
    });
    const data = await resp.json();
    return data;
  } catch (err) {
    return { ok: false, error: 'Помилка з\'єднання: ' + err.message };
  }
}
