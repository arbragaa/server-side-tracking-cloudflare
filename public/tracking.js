/**
 * tracking.js — script client-side (sem GTM)
 *
 * Eventos capturados:
 *   PageView          → carregamento
 *   ViewContent       → scroll de 50%
 *   Lead              → envio de formulário com e-mail ou telefone
 *   InitiateCheckout  → mesmo envio (junto com Lead)
 *   Contact           → clique em link/botão de WhatsApp
 *   Purchase          → NÃO passa aqui (vem do webhook, server-side)
 *
 * Cada evento vai para o Meta Pixel / gtag no navegador E para o Worker
 * com o mesmo event_id, para deduplicação no Meta.
 *
 * Configure antes de carregar o script:
 *   <script>
 *     window.SST_CONFIG = {
 *       endpoint: 'https://seu-dominio.com.br/track/event',
 *       productName: 'Meu Produto',
 *       productId: 'meu-produto',
 *       currency: 'BRL'
 *     };
 *   </script>
 *   <script defer src="/tracking.js"></script>
 */

(function () {
  'use strict';

  var CFG = window.SST_CONFIG || {};
  var ENDPOINT = CFG.endpoint || '/track/event';
  var PRODUCT_NAME = CFG.productName || 'Produto';
  var PRODUCT_ID = CFG.productId || 'produto';
  var CURRENCY = CFG.currency || 'BRL';
  var COUNTRY_CODE = CFG.phoneCountryCode || '55';

  /* ── UTMs (persistidas na sessão) ─────────────────────────────────────── */

  var _utms = (function () {
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var stored = {};
    try {
      var raw = sessionStorage.getItem('_sst_utms');
      if (raw) stored = JSON.parse(raw);
    } catch (e) {}

    var params = new URLSearchParams(window.location.search);
    var hasNew = false;
    keys.forEach(function (k) {
      if (params.get(k)) { stored[k] = params.get(k); hasNew = true; }
    });
    if (hasNew) {
      try { sessionStorage.setItem('_sst_utms', JSON.stringify(stored)); } catch (e) {}
    }
    return stored;
  })();

  /* ── Utilitários ───────────────────────────────────────────────────────── */

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // _ga = GA1.1.123456789.1700000000 → 123456789.1700000000
  function getGaClientId() {
    var ga = getCookie('_ga');
    if (!ga) return null;
    var parts = ga.split('.');
    return parts.length >= 4 ? parts[2] + '.' + parts[3] : ga;
  }

  function normalizePhone(p) {
    if (!p) return null;
    var d = p.replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10 || d.length === 11) d = COUNTRY_CODE + d;
    return d;
  }

  /* ── Meta Pixel ────────────────────────────────────────────────────────── */

  function fbTrack(event, params, eventId) {
    if (typeof window.fbq !== 'function') return;
    window.fbq('track', event, params || {}, eventId ? { eventID: eventId } : undefined);
  }

  /* ── GA4 (gtag direto) ─────────────────────────────────────────────────── */

  function ga4(eventName, params) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', eventName, params || {});
  }

  /* ── Envio para o Worker ───────────────────────────────────────────────── */

  function sendToWorker(data) {
    var payload = Object.assign({
      page_url: window.location.href,
      fbp: getCookie('_fbp'),
      fbc: getCookie('_fbc'),
      ga_client_id: getGaClientId(),
      utm_source: _utms.utm_source || null,
      utm_medium: _utms.utm_medium || null,
      utm_campaign: _utms.utm_campaign || null,
      utm_content: _utms.utm_content || null,
      utm_term: _utms.utm_term || null,
    }, data);

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function () {});
  }

  /* ── 1. PageView ───────────────────────────────────────────────────────── */
  // O snippet do <head> NÃO deve disparar fbq('track','PageView'):
  // o PageView sai daqui, com event_id, para deduplicar com o CAPI.

  var pvId = uuid();
  fbTrack('PageView', {}, pvId);
  sendToWorker({ event_name: 'page_view', event_id: pvId });

  /* ── 2. ViewContent — scroll 50% ───────────────────────────────────────── */

  var vcFired = false;
  function checkScroll() {
    if (vcFired) return;
    var pct = (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight;
    if (pct >= 0.5) {
      vcFired = true;
      window.removeEventListener('scroll', checkScroll);
      var vcId = uuid();
      fbTrack('ViewContent', {
        content_name: PRODUCT_NAME,
        content_ids: [PRODUCT_ID],
        content_type: 'product',
      }, vcId);
      ga4('view_item', {
        currency: CURRENCY,
        value: 0,
        items: [{ item_id: PRODUCT_ID, item_name: PRODUCT_NAME }]
      });
      sendToWorker({ event_name: 'view_content', event_id: vcId });
    }
  }
  window.addEventListener('scroll', checkScroll, { passive: true });

  /* ── 3. Envio de formulário — Lead + InitiateCheckout ──────────────────── */

  var leadFired = false;

  document.addEventListener('submit', function (e) {
    if (leadFired) return;
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;

    function val(selectors) {
      for (var i = 0; i < selectors.length; i++) {
        var el = form.querySelector(selectors[i]);
        if (el && el.value && el.value.trim()) return el.value.trim();
      }
      return '';
    }

    var email = val([
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[id*="email" i]',
      'input[name*="email" i]',
      'input[placeholder*="e-mail" i]',
      'input[placeholder*="email" i]',
    ]);
    var phone = val([
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      'input[id*="phone" i]',
      'input[name*="phone" i]',
      'input[name*="tel" i]',
      'input[name*="whatsapp" i]',
      'input[name*="telefone" i]',
      'input[placeholder*="telefone" i]',
      'input[placeholder*="celular" i]',
      'input[placeholder*="whatsapp" i]',
    ]);
    var fullName = val([
      'input[autocomplete="name"]',
      'input[id*="name" i]',
      'input[name*="name" i]',
      'input[name*="nome" i]',
      'input[placeholder*="nome" i]',
      'input[placeholder*="name" i]',
    ]);

    if (!email && !phone) return; // não é formulário de lead

    leadFired = true;

    var nameParts = fullName.split(/\s+/).filter(Boolean);
    var firstName = nameParts[0] || '';
    var lastName = nameParts.slice(1).join(' ') || '';
    var phoneDigits = normalizePhone(phone); // ex: 5511988887777
    var phoneE164 = phoneDigits ? '+' + phoneDigits : null;

    var leadId = uuid();
    var icId = uuid();

    // Advanced Matching no Pixel (o fbq faz o hash no navegador)
    if (typeof window.fbq === 'function' && CFG.pixelId) {
      window.fbq('init', CFG.pixelId, {
        em: email ? email.toLowerCase() : undefined,
        ph: phoneDigits || undefined,
        fn: firstName ? firstName.toLowerCase() : undefined,
        ln: lastName ? lastName.toLowerCase() : undefined,
      });
    }

    fbTrack('Lead', { content_name: PRODUCT_NAME, value: 0, currency: CURRENCY }, leadId);
    fbTrack('InitiateCheckout', {
      content_name: PRODUCT_NAME,
      content_ids: [PRODUCT_ID],
      num_items: 1,
      currency: CURRENCY,
    }, icId);

    // GA4 — dados para Enhanced Conversions (user_data é definido via 'set')
    if (typeof window.gtag === 'function') {
      window.gtag('set', 'user_data', {
        email: email || undefined,
        phone_number: phoneE164 || undefined,
        address: { first_name: firstName || undefined, last_name: lastName || undefined }
      });
    }
    ga4('generate_lead', { value: 0, currency: CURRENCY });
    ga4('begin_checkout', {
      currency: CURRENCY,
      value: 0,
      items: [{ item_id: PRODUCT_ID, item_name: PRODUCT_NAME }],
    });

    var pii = { email: email, phone: phone, first_name: firstName, last_name: lastName };
    sendToWorker(Object.assign({ event_name: 'generate_lead', event_id: leadId }, pii));
    sendToWorker(Object.assign({ event_name: 'initiate_checkout', event_id: icId }, pii));
  }, true);

  /* ── 4. WhatsApp — Contact ─────────────────────────────────────────────── */

  var contactFired = false;

  document.addEventListener('click', function (e) {
    if (contactFired) return;
    var el = e.target.closest && e.target.closest(
      'a[href*="wa.me"], a[href*="whatsapp.com/send"], [data-track="whatsapp"], [class*="whatsapp" i], [aria-label*="whatsapp" i]'
    );
    if (!el) return;

    contactFired = true;
    setTimeout(function () { contactFired = false; }, 5000);

    var ctId = uuid();
    fbTrack('Contact', { content_name: 'whatsapp' }, ctId);
    ga4('contact', { method: 'whatsapp' });
    sendToWorker({ event_name: 'contact', event_id: ctId });
  });

})();
