import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { normalizePhone, parsePurchase } from '../worker/src/index.js'

const env = {
  SITE_URL: 'https://exemplo.com.br', PRODUCT_NAME: 'Curso', PRODUCT_ID: 'curso',
  META_PIXEL_ID: '123', META_CAPI_TOKEN: 'tok', GA4_MEASUREMENT_ID: 'G-TEST', GA4_API_SECRET: 's',
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', WEBHOOK_TOKEN: 'segredo',
}

function mockFetch() {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
    return new Response(String(url).includes('graph.facebook') ? '{"events_received":1}' : '', { status: 200 })
  }
  return calls
}

const req = (path, body, headers = {}) => new Request('https://exemplo.com.br' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers },
  body: JSON.stringify(body),
})

test('normalizePhone', () => {
  assert.equal(normalizePhone('(11) 98888-7777'), '5511988887777')
  assert.equal(normalizePhone('+55 11 98888-7777'), '5511988887777')
  assert.equal(normalizePhone(''), null)
})

test('parsePurchase hotmart e kiwify', () => {
  const h = parsePurchase({ data: { buyer: { email: 'A@B.com', name: 'Ana Maria Silva' }, purchase: { transaction: 'HP1', price: { value: 297 } } } })
  assert.equal(h.platform, 'hotmart'); assert.equal(h.first_name, 'Ana'); assert.equal(h.last_name, 'Maria Silva'); assert.equal(h.order_value, 297)
  const k = parsePurchase({ order_id: 'K1', order_value: '97.5', Customer: { email: 'x@y.com', full_name: 'João' } })
  assert.equal(k.platform, 'kiwify'); assert.equal(k.order_value, 97.5)
  assert.equal(parsePurchase({ foo: 1 }), null)
})

test('/track/event envia Meta, GA4 e Supabase com hash', async () => {
  const calls = mockFetch()
  const res = await worker.fetch(req('/track/event', { event_name: 'generate_lead', event_id: 'e1', email: ' Ana@X.com ', phone: '11988887777' }), env)
  assert.equal(res.status, 200)
  assert.equal(calls.length, 3)
  const meta = calls[0].body.data[0]
  assert.equal(meta.event_name, 'Lead'); assert.equal(meta.event_id, 'e1')
  assert.match(meta.user_data.em[0], /^[0-9a-f]{64}$/)
  assert.equal(calls[1].body.events[0].name, 'generate_lead')
  assert.equal(calls[2].body.email, 'ana@x.com'); assert.equal(calls[2].body.phone, '5511988887777')
})

test('/track/webhook exige token', async () => {
  mockFetch()
  const body = { data: { buyer: { email: 'a@b.com', name: 'A B' }, purchase: { transaction: 'T1', price: { value: 10 } } } }
  assert.equal((await worker.fetch(req('/track/webhook', body), env)).status, 401)
  const calls = mockFetch()
  const ok = await worker.fetch(req('/track/webhook', body, { 'X-HOTMART-HOTTOK': 'segredo' }), env)
  assert.equal(ok.status, 200)
  const meta = calls[0].body.data[0]
  assert.equal(meta.event_name, 'Purchase'); assert.equal(meta.event_id, 'purchase_T1'); assert.equal(meta.custom_data.value, 10)
})

test('JSON inválido → 400, GET → 405', async () => {
  const bad = new Request('https://exemplo.com.br/track/event', { method: 'POST', body: '{' })
  assert.equal((await worker.fetch(bad, env)).status, 400)
  assert.equal((await worker.fetch(new Request('https://exemplo.com.br/track/event'), env)).status, 405)
})
