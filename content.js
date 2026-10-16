/* PromHub Capturer — content script
 * Перехоплює всі fetch/XMLHttpRequest на my.prom.ua, аналізує їх
 * і при спрацюванні подій (зміна товарів/оплати/чеку) показує overlay
 * з пропозицією зберегти шаблон для promv2.
 */

(function () {
  'use strict';

  // Уникаємо повторної ініціалізації
  if (window.__promhubCapturerInit) return;
  window.__promhubCapturerInit = true;

  // Стан: зібрані запити-кандидати за сесію
  const candidates = {
    items: null,
    payment: null,
    receipt: null,
    messages_send: null,
    messages_get: null,
    buyer_rating: null,
  };

  // Патерни для класифікації запитів
  const PATTERNS = {
    // Редагування товарів: URL містить order, метод POST/PUT, тіло з products/items
    items: {
      urlPatterns: [/\/orders?\/\d+/, /\/orders?\/edit/, /order.*item/i, /order.*product/i],
      methodMatch: ['POST', 'PUT', 'PATCH'],
      bodyKeys: ['products', 'items', 'order_items', 'product_items'],
    },
    // Зміна оплати: URL або тіло з payment
    payment: {
      urlPatterns: [/payment/i, /\/orders?\/\d+/, /order.*payment/i],
      methodMatch: ['POST', 'PUT', 'PATCH'],
      bodyKeys: ['payment_option', 'payment_method', 'payment_id', 'payment_option_id'],
    },
    // Прив'язка чека: URL або тіло з receipt/check/fiscal
    receipt: {
      urlPatterns: [/receipt/i, /check/i, /fiscal/i, /order.*document/i, /order.*file/i],
      methodMatch: ['POST', 'PUT', 'PATCH'],
      bodyKeys: ['receipt', 'receipt_url', 'check_url', 'fiscal_code', 'document_url', 'url'],
    },
    // Відправка повідомлення в чат: URL містить chat/message, метод POST, тіло з text/body/message
    messages_send: {
      urlPatterns: [/chat/i, /message/i, /conversation/i],
      methodMatch: ['POST', 'PUT'],
      bodyKeys: ['body', 'text', 'message', 'content'],
      excludeBodyKeys: ['products', 'items'], // щоб не плутати з items
    },
    // Отримання повідомлень: URL з chat/message, метод GET (або POST з пустим тілом)
    messages_get: {
      urlPatterns: [/chat/i, /message/i, /conversation/i, /messages\/list/i],
      methodMatch: ['GET', 'POST'],
      bodyKeys: [], // для GET-запитів тіла нема
      isGet: true,
    },
    // Рейтинг клієнта: URL з clients/ або buyer, метод GET
    buyer_rating: {
      urlPatterns: [/\/clients?\/\d+/i, /client.*rating/i, /buyer.*rating/i, /reliability/i, /\/crm\/clients/i],
      methodMatch: ['GET'],
      bodyKeys: [],
      isGet: true,
    },
  };

  // Перевірити, чи URL належить до доменів prom
  function isPromHost(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return ['prom.ua', 'bigl.ua', 'satu.kz', 'deal.by'].some(d =>
        host === d || host.endsWith('.' + d)
      );
    } catch {
      return false;
    }
  }

  // Розібрати тіло запиту в об'єкт (якщо JSON)
  function parseBody(body) {
    if (!body) return null;
    if (typeof body === 'object') return body;
    try {
      return JSON.parse(body);
    } catch {
      // Спробуємо form-urlencoded
      try {
        const params = new URLSearchParams(body);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        return Object.keys(obj).length ? obj : null;
      } catch {
        return null;
      }
    }
  }

  // Перевірити, чи запит відповідає патерну типу
  function matchType(method, url, bodyObj) {
    const m = method.toUpperCase();
    for (const [type, pat] of Object.entries(PATTERNS)) {
      if (!pat.methodMatch.includes(m)) continue;
      const urlMatches = pat.urlPatterns.some(p => p.test(url));

      // GET-запити (messages_get, buyer_rating) — перевіряємо тільки URL
      if (pat.isGet && urlMatches && m === 'GET') {
        return type;
      }

      // POST/PUT — перевіряємо тіло
      if (!pat.isGet && pat.bodyKeys.length) {
        const bodyMatches = bodyObj && pat.bodyKeys.some(k =>
          Object.prototype.hasOwnProperty.call(bodyObj, k) ||
          (typeof bodyObj === 'object' && containsKeyDeep(bodyObj, k))
        );
        // Перевірка виключень (щоб messages_send не спрацьовувало на items)
        if (pat.excludeBodyKeys && pat.excludeBodyKeys.some(k => containsKeyDeep(bodyObj, k))) {
          continue;
        }
        if (urlMatches && bodyMatches) return type;
        // Для receipt — достатньо тіла з url
        if (type === 'receipt' && bodyMatches && !pat.excludeBodyKeys) return type;
        // Для messages_send — достатньо URL з chat + тіло з text/body
        if (type === 'messages_send' && bodyMatches && (urlMatches || /chat|message/i.test(url))) return type;
      }
    }
    return null;
  }

  function containsKeyDeep(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return false;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
    for (const v of Object.values(obj)) {
      if (typeof v === 'object' && containsKeyDeep(v, key, depth + 1)) return true;
    }
    return false;
  }

  // Витягнути order_id з URL /orders/123456... або з тіла
  function extractOrderId(url, bodyObj) {
    const m = url.match(/\/orders?\/(\d+)/);
    if (m) return parseInt(m[1], 10);
    if (bodyObj) {
      if (bodyObj.id) return parseInt(bodyObj.id, 10);
      if (bodyObj.order_id) return parseInt(bodyObj.order_id, 10);
      if (bodyObj.order && bodyObj.order.id) return parseInt(bodyObj.order.id, 10);
    }
    return 0;
  }

  // Витягнути receipt_url з тіла
  function extractReceiptUrl(bodyObj) {
    if (!bodyObj) return '';
    const keys = ['receipt_url', 'check_url', 'url', 'document_url', 'fiscal_code'];
    for (const k of keys) {
      if (typeof bodyObj[k] === 'string' && bodyObj[k].startsWith('http')) return bodyObj[k];
      if (typeof bodyObj[k] === 'string' && bodyObj[k].length > 10) return bodyObj[k];
    }
    return '';
  }

  // Витягнути client_id з URL /clients/123456... або з тіла
  function extractClientId(url, bodyObj) {
    const m = url.match(/\/clients?\/(\d+)/);
    if (m) return m[1];
    if (bodyObj) {
      if (bodyObj.client_id) return String(bodyObj.client_id);
      if (bodyObj.id) return String(bodyObj.id);
    }
    return '';
  }

  // Витягнути текст повідомлення з тіла (для messages_send)
  function extractMessageText(bodyObj) {
    if (!bodyObj) return '';
    const keys = ['body', 'text', 'message', 'content'];
    for (const k of keys) {
      if (typeof bodyObj[k] === 'string' && bodyObj[k].trim() !== '') {
        return bodyObj[k].slice(0, 100);
      }
    }
    return '';
  }

  // Витягнути payment_option_id з тіла
  function extractPaymentOptionId(bodyObj) {
    if (!bodyObj) return 0;
    const keys = ['payment_option_id', 'payment_option', 'payment_id', 'payment_method_id'];
    for (const k of keys) {
      if (bodyObj[k] && !isNaN(parseInt(bodyObj[k], 10))) return parseInt(bodyObj[k], 10);
    }
    return 0;
  }

  // Знайти account_id: з URL my.prom.ua/cabinet/orders/ID?shop=shop_kyiv або з cookie
  function extractAccountId(url) {
    try {
      const u = new URL(url);
      // З шляху: /cabinet/.../shop_kyiv/...
      const m = u.pathname.match(/\/(?:cabinet|shops?|stores?)\/([a-z0-9_-]+)/i);
      if (m) return m[1];
      // З query: ?shop=reohimik
      const shop = u.searchParams.get('shop') || u.searchParams.get('account');
      if (shop) return shop;
      // Спробуємо взяти з cookie session (UAPROMSID)
      const cookies = document.cookie.split('; ');
      const accCookie = cookies.find(c => c.startsWith('selected_shop=') || c.startsWith('account_id='));
      if (accCookie) return accCookie.split('=')[1];
    } catch {}
    return '';
  }

  // Побудувати cURL-команду з деталей запиту
  function buildCurl(req) {
    let cmd = "curl '" + req.url + "'";
    if (req.method && req.method !== 'GET') {
      cmd += " -X " + req.method;
    }
    // Заголовки
    if (req.headers && req.headers.length) {
      for (const h of req.headers) {
        if (h && h.trim()) cmd += " -H '" + h.replace(/'/g, "'\\''") + "'";
      }
    }
    // Cookie (якщо не в заголовках)
    if (req.cookie && (!req.headers || !req.headers.some(h => /^cookie:/i.test(h)))) {
      cmd += " -b '" + req.cookie + "'";
    }
    // Тіло
    if (req.body) {
      cmd += " --data-raw '" + req.body.replace(/'/g, "'\\''") + "'";
    }
    return cmd;
  }

  // Записати кандидата
  function recordCandidate(type, details) {
    const bodyObj = parseBody(details.body);
    const orderId = extractOrderId(details.url, bodyObj);
    const receiptUrl = type === 'receipt' ? extractReceiptUrl(bodyObj) : '';
    const paymentOpt = type === 'payment' ? extractPaymentOptionId(bodyObj) : 0;
    const clientId = (type === 'buyer_rating') ? extractClientId(details.url, bodyObj) : '';
    const msgText = (type === 'messages_send') ? extractMessageText(bodyObj) : '';
    const accountId = extractAccountId(details.url);

    // Валідація по типу
    if (type === 'items' && !orderId) return;
    if (type === 'receipt' && !receiptUrl) return;
    if (type === 'payment' && !paymentOpt) return;
    if (type === 'buyer_rating' && !clientId) return;
    // messages_send / messages_get — order_id необов'язковий (може бути глобальний чат)

    candidates[type] = {
      type,
      capturedAt: new Date().toISOString(),
      method: details.method,
      url: details.url,
      headers: details.headers || [],
      cookie: details.cookie || '',
      body: details.body || '',
      accountId,
      orderId,
      receiptUrl,
      paymentOptionId: paymentOpt,
      clientId,
      messageText: msgText,
      curl: buildCurl(details),
    };

    console.log('[PromHub Capturer] Захоплено кандидат ' + type + ':', candidates[type]);
    showOverlay();
  }

  // ───────────────────────────────────────────────────────────
  //  ПЕРЕХОПЛЕННЯ FETCH
  // ───────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const init = args[1] || {};

    let url = '', method = 'GET', headers = [], body = '', cookie = '';
    try {
      if (typeof req === 'string') {
        url = req;
        method = (init.method || 'GET').toUpperCase();
        if (init.headers) {
          if (init.headers instanceof Headers) {
            headers = [];
            init.headers.forEach((v, k) => headers.push(k + ': ' + v));
          } else if (Array.isArray(init.headers)) {
            headers = init.headers.map(h => Array.isArray(h) ? h.join(': ') : h);
          } else {
            headers = Object.entries(init.headers).map(([k, v]) => k + ': ' + v);
          }
        }
        if (init.body) {
          body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        }
        cookie = document.cookie;
      } else if (req instanceof Request) {
        url = req.url;
        method = (req.method || 'GET').toUpperCase();
        if (req.headers) {
          headers = [];
          req.headers.forEach((v, k) => headers.push(k + ': ' + v));
        }
        cookie = req.credentials === 'include' ? document.cookie : '';
        if (req.body) {
          try {
            body = await req.clone().text();
          } catch {}
        }
      }
    } catch {}

    if (url && isPromHost(url)) {
      const bodyObj = parseBody(body);
      const type = matchType(method, url, bodyObj);
      if (type) {
        recordCandidate(type, { method, url, headers, body, cookie });
      }
    }

    return origFetch.apply(this, args);
  };

  // ───────────────────────────────────────────────────────────
  //  ПЕРЕХОПЛЕННЯ XMLHttpRequest
  // ───────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._phMethod = (method || 'GET').toUpperCase();
    this._phUrl = url || '';
    this._phHeaders = [];
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._phHeaders) this._phHeaders.push(name + ': ' + value);
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._phUrl && isPromHost(this._phUrl)) {
      const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
      const bodyObj = parseBody(bodyStr);
      const type = matchType(this._phMethod, this._phUrl, bodyObj);
      if (type) {
        recordCandidate(type, {
          method: this._phMethod,
          url: this._phUrl,
          headers: this._phHeaders || [],
          cookie: document.cookie,
          body: bodyStr,
        });
      }
    }
    return origSend.call(this, body);
  };

  // ───────────────────────────────────────────────────────────
  //  OVERLAY — показати вспливаюче вікно з пропозицією зберегти
  // ───────────────────────────────────────────────────────────
  let overlayEl = null;
  let overlayIframe = null;

  function showOverlay() {
    // Створюємо iframe з нашим UI (щоб стилі my.prom.ua не заважали)
    if (overlayEl) {
      // Оновити контент
      overlayIframe.contentWindow.postMessage({ type: 'promhub_update', candidates }, '*');
      return;
    }

    overlayEl = document.createElement('div');
    overlayEl.id = 'promhub-capturer-root';
    overlayEl.style.cssText = 'position:fixed;top:0;right:0;width:380px;height:100vh;z-index:2147483647;border-left:1px solid #d4a017;box-shadow:-4px 0 24px rgba(0,0,0,.15);background:#fff;';
    document.documentElement.appendChild(overlayEl);

    overlayIframe = document.createElement('iframe');
    overlayIframe.src = chrome.runtime.getURL('overlay.html');
    overlayIframe.style.cssText = 'width:100%;height:100%;border:0;';
    overlayEl.appendChild(overlayIframe);

    // Слухаємо повідомлення від overlay
    window.addEventListener('message', function (ev) {
      if (ev.source !== overlayIframe.contentWindow) return;
      if (ev.data && ev.data.type === 'promhub_ready') {
        overlayIframe.contentWindow.postMessage({ type: 'promhub_update', candidates }, '*');
      }
      if (ev.data && ev.data.type === 'promhub_save') {
        // Переслати на background для збереження
        chrome.runtime.sendMessage({ action: 'save_template', payload: ev.data.payload }, function (resp) {
          overlayIframe.contentWindow.postMessage({ type: 'promhub_save_result', result: resp }, '*');
        });
      }
      if (ev.data && ev.data.type === 'promhub_close') {
        hideOverlay();
      }
      if (ev.data && ev.data.type === 'promhub_dismiss') {
        // Відхилити конкретного кандидата
        if (ev.data.candidateType && candidates[ev.data.candidateType]) {
          candidates[ev.data.candidateType] = null;
          overlayIframe.contentWindow.postMessage({ type: 'promhub_update', candidates }, '*');
          if (!candidates.items && !candidates.payment && !candidates.receipt) hideOverlay();
        }
      }
    });

    // Анімація появи
    setTimeout(() => { overlayEl.style.transform = 'translateX(0)'; }, 50);
  }

  function hideOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
      overlayIframe = null;
    }
  }

  console.log('[PromHub Capturer] ініціалізовано на', location.host);
})();
