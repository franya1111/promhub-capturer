/* PromHub Capturer — popup logic */

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await chrome.storage.sync.get(['serverUrl', 'secret']);
  document.getElementById('serverUrl').value = cfg.serverUrl || 'https://promv2.franya.dev/api/ajax_cabinet_template.php';
  document.getElementById('secret').value = cfg.secret || '';

  document.getElementById('save').addEventListener('click', saveSettings);
  document.getElementById('test').addEventListener('click', testConnection);
});

async function saveSettings() {
  const serverUrl = document.getElementById('serverUrl').value.trim();
  const secret = document.getElementById('secret').value.trim();
  await chrome.storage.sync.set({ serverUrl, secret });
  showStatus('ok', '✓ Налаштування збережено. Тепер відкрийте my.prom.ua → замовлення.');
}

async function testConnection() {
  showStatus('', '⏳ Перевіряємо з\'єднання...');
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'ping_server' });
    if (resp && resp.ok) {
      showStatus('ok', '✓ З\'єднання OK. Сервер час: ' + (resp.server_time || 'невідомо'));
    } else {
      showStatus('err', '✗ ' + (resp?.error || 'невідома помилка'));
    }
  } catch (err) {
    showStatus('err', '✗ Помилка: ' + err.message);
  }
}

function showStatus(kind, text) {
  const el = document.getElementById('status');
  el.className = 'status show' + (kind ? ' status-' + kind : '');
  el.innerHTML = text;
}
