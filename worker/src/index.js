// Server-side tracking Worker (Cloudflare)
// Rotas:
//   POST /track/event    → eventos client-side (tracking.js) → Meta CAPI + GA4 MP + Supabase
//   POST /track/webhook  → compra aprovada (Hotmart / Kiwify) → Meta CAPI + GA4 MP + Supabase
//
// Toda configuração vem de variáveis de ambiente (wrangler.toml [vars] + wrangler secret).
// Veja README.md.

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const cfg = config(env)

    if (request.method === 'OPTIONS') return cors(cfg, null, 204)
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    let body
    try {
      body = await request.json()
    } catch {
      return cors(cfg, { error: 'invalid_json' }, 400)
    }

    try {
      if (url.pathname === '/track/event') {
        const result = await processEvent(body, cfg, env, request)
        return cors(cfg, { ok: true, meta: result }, 200)
      }

      if (url.pathname === '/track/webhook') {
        if (!isAuthorizedWebhook(request, url, env)) return cors(cfg, { error: 'unauthorized' }, 401)
        const result = await processWebhook(body, cfg, env, request)
        return cors(cfg, { ok: true, meta: result }, 200)
      }

      return new Response('Not found', { status: 404 })
    } catch (err) {
      console.error(err)
      return cors(cfg, { error: 'internal_error' }, 500)
    }
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

function config(env) {
  return {
    siteUrl: env.SITE_URL || '',
    productName: env.PRODUCT_NAME || 'Produto',
    productId: env.PRODUCT_ID || 'produto',
    currency: env.CURRENCY || 'BRL',
    countryCode: env.PHONE_COUNTRY_CODE || '55',
    table: env.SUPABASE_TABLE || 'site_tracking_events',
    graphVersion: env.META_GRAPH_VERSION || 'v21.0',
    allowedOrigin: env.ALLOWED_ORIGIN || '*',
    testEventCode: env.META_TEST_EVENT_CODE || null,
  }
}

function cors(cfg, body, status) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': cfg.allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  })
}

// Hotmart envia o token no header X-HOTMART-HOTTOK.
// Para outras plataformas, use ?token=... na URL do webhook.
function isAuthorizedWebhook(request, url, env) {
  if (!env.WEBHOOK_TOKEN) return true // sem token configurado = sem validação (não recomendado)
  const provided = request.headers.get('X-HOTMART-HOTTOK') || url.searchParams.get('token')
  return provided === env.WEBHOOK_TOKEN
}

// ─── Normalização / hash ──────────────────────────────────────────────────────

async function sha256(str) {
  if (!str) return null
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const normText = s => (s ? String(s).toLowerCase().trim() : null)

// Só dígitos; adiciona DDI quando o número vem sem ele (10 ou 11 dígitos no BR).
export function normalizePhone(phone, countryCode = '55') {
  if (!phone) return null
  const d = String(phone).replace(/\D/g, '')
  if (!d) return null
  if (d.length === 10 || d.length === 11) return countryCode + d
  return d
}

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean)
  return { first: parts[0] || null, last: parts.slice(1).join(' ') || null }
}

const META_EVENTS = {
  page_view: 'PageView',
  view_content: 'ViewContent',
  initiate_checkout: 'InitiateCheckout',
  generate_lead: 'Lead',
  contact: 'Contact',
}

const GA4_EVENTS = {
  page_view: 'page_view',
  view_content: 'view_item',
  initiate_checkout: 'begin_checkout',
  generate_lead: 'generate_lead',
  contact: 'contact',
}

// ─── /track/event — eventos client-side ───────────────────────────────────────

async function processEvent(body, cfg, env, request) {
  const {
    event_name, email, phone, first_name, last_name,
    fbp, fbc, ga_client_id, page_url, event_id,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    value, currency
  } = body

  if (!event_name) throw new Error('event_name obrigatório')

  const client_ip = request.headers.get('CF-Connecting-IP')
  const user_agent = request.headers.get('User-Agent')
  const timestamp = Math.floor(Date.now() / 1000)

  const normEmail = normText(email)
  const normPhone = normalizePhone(phone, cfg.countryCode)
  const normFn = normText(first_name)
  const normLn = normText(last_name)

  const [hem, hph, hfn, hln] = await Promise.all([
    sha256(normEmail), sha256(normPhone), sha256(normFn), sha256(normLn)
  ])

  const metaEventName = META_EVENTS[event_name] || event_name
  const ga4EventName = GA4_EVENTS[event_name] || event_name
  const item = { id: cfg.productId, name: cfg.productName }

  // 1. Meta Conversions API
  const metaJson = await sendMeta(cfg, env, {
    event_name: metaEventName,
    event_time: timestamp,
    event_id: event_id || null,
    action_source: 'website',
    event_source_url: page_url || cfg.siteUrl,
    user_data: {
      ...(hem && { em: [hem] }),
      ...(hph && { ph: [hph] }),
      ...(hfn && { fn: [hfn] }),
      ...(hln && { ln: [hln] }),
      ...(fbp && { fbp }),
      ...(fbc && { fbc }),
      client_ip_address: client_ip || undefined,
      client_user_agent: user_agent || undefined,
    },
    custom_data: {
      ...(value && { value, currency: currency || cfg.currency }),
      ...(metaEventName === 'ViewContent' || metaEventName === 'InitiateCheckout'
        ? { contents: [{ id: item.id, quantity: 1 }], content_name: item.name, content_type: 'product' }
        : {}),
    },
  })

  // 2. GA4 Measurement Protocol
  // page_view não vai pelo servidor: o gtag do navegador já registra (mesmo client_id),
  // e enviar dos dois lados duplicava as visualizações de página no GA4.
  if (ga4EventName !== 'page_view') await sendGa4(env, {
    client_id: ga_client_id || `${timestamp}.${crypto.getRandomValues(new Uint32Array(1))[0]}`,
    events: [{
      name: ga4EventName,
      params: {
        page_location: page_url,
        engagement_time_msec: '100',
        ...(utm_source && { campaign_source: utm_source }),
        ...(utm_medium && { campaign_medium: utm_medium }),
        ...(utm_campaign && { campaign_name: utm_campaign }),
        ...(utm_content && { campaign_content: utm_content }),
        ...(utm_term && { campaign_term: utm_term }),
        ...(ga4EventName === 'view_item' || ga4EventName === 'begin_checkout'
          ? { currency: cfg.currency, value: 0, items: [{ item_id: item.id, item_name: item.name }] }
          : {}),
        ...(ga4EventName === 'generate_lead' ? { value: 0, currency: cfg.currency } : {}),
      }
    }]
  })

  // 3. Log no Supabase
  await logSupabase(cfg, env, {
    site: cfg.siteUrl,
    event_name,
    event_id: event_id || null,
    email: normEmail,
    phone: normPhone,
    first_name: normFn,
    last_name: normLn,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    page_url, user_agent, ip: client_ip,
    fbp, fbc, ga_client_id,
    meta_response: metaJson,
  })

  return metaJson
}

// ─── /track/webhook — Purchase server-side (Hotmart / Kiwify) ─────────────────

export function parsePurchase(body) {
  // Hotmart: PURCHASE_COMPLETE / PURCHASE_APPROVED
  if (body?.data?.buyer) {
    const { first, last } = splitName(body.data.buyer.name)
    return {
      platform: 'hotmart',
      email: body.data.buyer.email,
      phone: body.data.buyer.checkout_phone || null,
      first_name: first,
      last_name: last,
      order_id: body.data.purchase?.transaction || null,
      order_value: Number(body.data.purchase?.price?.value) || 0,
      currency: body.data.purchase?.price?.currency_value || null,
    }
  }
  // Kiwify: order_approved / order.paid
  if (body?.Customer) {
    const { first, last } = splitName(body.Customer.full_name)
    return {
      platform: 'kiwify',
      email: body.Customer.email,
      phone: body.Customer.mobile || null,
      first_name: first,
      last_name: last,
      order_id: body.order_id || null,
      order_value: parseFloat(body.order_value ?? body.Commissions?.charge_amount / 100) || 0,
      currency: null,
    }
  }
  return null
}

async function processWebhook(body, cfg, env, request) {
  const p = parsePurchase(body)
  if (!p) return { error: 'plataforma_nao_reconhecida' }

  const timestamp = Math.floor(Date.now() / 1000)
  const currency = p.currency || cfg.currency

  const normEmail = normText(p.email)
  const normPhone = normalizePhone(p.phone, cfg.countryCode)
  const normFn = normText(p.first_name)
  const normLn = normText(p.last_name)

  const [hem, hph, hfn, hln] = await Promise.all([
    sha256(normEmail), sha256(normPhone), sha256(normFn), sha256(normLn)
  ])

  const event_id = p.order_id ? `purchase_${p.order_id}` : `purchase_${timestamp}`

  // 1. Meta CAPI — Purchase
  // Observação: o IP/User-Agent da requisição são do servidor da plataforma, não do comprador,
  // por isso não são enviados aqui.
  const metaJson = await sendMeta(cfg, env, {
    event_name: 'Purchase',
    event_time: timestamp,
    event_id,
    action_source: 'website',
    event_source_url: cfg.siteUrl,
    user_data: {
      ...(hem && { em: [hem] }),
      ...(hph && { ph: [hph] }),
      ...(hfn && { fn: [hfn] }),
      ...(hln && { ln: [hln] }),
    },
    custom_data: {
      value: p.order_value,
      currency,
      contents: [{ id: cfg.productId, quantity: 1 }],
      content_name: cfg.productName,
      content_type: 'product',
      ...(p.order_id && { order_id: p.order_id }),
    },
  })

  // 2. GA4 — purchase
  await sendGa4(env, {
    client_id: `webhook.${timestamp}`,
    events: [{
      name: 'purchase',
      params: {
        transaction_id: p.order_id,
        value: p.order_value,
        currency,
        items: [{ item_id: cfg.productId, item_name: cfg.productName }],
        engagement_time_msec: '100',
      }
    }]
  })

  // 3. Log no Supabase
  await logSupabase(cfg, env, {
    site: cfg.siteUrl,
    event_name: 'purchase',
    event_id,
    platform: p.platform,
    product_name: cfg.productName,
    email: normEmail,
    phone: normPhone,
    first_name: normFn,
    last_name: normLn,
    order_id: p.order_id,
    order_value: p.order_value,
    currency,
    ip: request.headers.get('CF-Connecting-IP'),
    user_agent: request.headers.get('User-Agent'),
    meta_response: metaJson,
  })

  return metaJson
}

// ─── Destinos ─────────────────────────────────────────────────────────────────

async function sendMeta(cfg, env, event) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return { skipped: 'meta_not_configured' }
  const payload = { data: [event], ...(cfg.testEventCode && { test_event_code: cfg.testEventCode }) }
  const res = await fetch(
    `https://graph.facebook.com/${cfg.graphVersion}/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  )
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : { status: res.status, events_received: 0 }
  } catch {
    return { status: res.status, raw: text.slice(0, 500) }
  }
}

async function sendGa4(env, payload) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) return
  await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  )
}

async function logSupabase(cfg, env, data) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${cfg.table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data)
  })
  if (!res.ok) console.error('supabase_insert_failed', res.status, await res.text())
}
