# Server-side tracking com Cloudflare Workers

Rastreamento **server-side** para landing pages e infoprodutos, sem GTM e sem servidor para manter: um Cloudflare Worker recebe os eventos do site e o webhook da plataforma de vendas e envia tudo para:

- **Meta Conversions API** (com deduplicação por `event_id` com o Pixel)
- **GA4 Measurement Protocol**
- **Supabase** (log de cada evento + resposta do Meta, para auditoria)

É a arquitetura que uso em produção no meu curso **Dominando o Rastreamento**, aqui em versão genérica e configurável.

## Como funciona

```
 Navegador                          Cloudflare Worker                    Destinos
 ─────────                          ─────────────────                    ────────
 tracking.js ── POST /track/event ─▶ normaliza + SHA-256 ──┬──▶ Meta CAPI
   (Pixel + gtag com o mesmo         + IP / User-Agent      ├──▶ GA4 Measurement Protocol
    event_id, para dedup)                                   └──▶ Supabase (log)

 Hotmart / Kiwify ─ POST /track/webhook ─▶ valida token ─▶ Purchase ─▶ Meta CAPI · GA4 · Supabase
```

### Eventos

| Ação na página | Meta Pixel (navegador) | Meta CAPI (servidor) | GA4 |
|---|---|---|---|
| Carregamento | PageView | PageView | page_view |
| Scroll de 50% | ViewContent | ViewContent | view_item |
| Envio do formulário | Lead + InitiateCheckout | Lead + InitiateCheckout | generate_lead + begin_checkout |
| Clique no WhatsApp | Contact | Contact | contact |
| Compra aprovada (webhook) | — | Purchase | purchase |

### Destaques

- **Deduplicação Pixel ↔ CAPI**: cada evento sai do navegador e do servidor com o mesmo `event_id`.
- **EMQ alto**: e-mail, telefone e nome normalizados e com hash SHA-256, mais `fbp`, `fbc`, IP e User-Agent.
- **UTMs persistidas na sessão** e repassadas ao GA4 server-side.
- **Captura de formulário genérica**: detecta e-mail, telefone e nome por tipo, `name`, `id` ou `placeholder` (funciona com formulários do Lovable, Elementor etc.).
- **Webhook protegido** por token (`X-HOTMART-HOTTOK` ou `?token=`).
- **Nenhum segredo no código**: tudo via `wrangler secret`.

## Estrutura

```
worker/src/index.js        Worker: rotas /track/event e /track/webhook
worker/wrangler.toml       configuração (vars públicas; segredos via wrangler secret)
public/tracking.js         script do navegador
examples/head-snippet.html snippet do <head> (Pixel, GA4 e configuração)
supabase/migration.sql     tabela de log
```

## Instalação

**1. Supabase** — rode `supabase/migration.sql` no SQL Editor do projeto.

**2. Worker** — ajuste as `[vars]` em `worker/wrangler.toml` e publique:

```bash
cd worker
npx wrangler login
npx wrangler deploy

npx wrangler secret put META_PIXEL_ID
npx wrangler secret put META_CAPI_TOKEN      # token de System User (não expira)
npx wrangler secret put GA4_MEASUREMENT_ID
npx wrangler secret put GA4_API_SECRET       # GA4 → Admin → Fluxo de dados → Measurement Protocol
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put WEBHOOK_TOKEN        # hottok da Hotmart ou um token seu
```

> Dica: publique o Worker numa rota do seu próprio domínio (`seudominio.com.br/track/*`) para ter coleta first-party e escapar de bloqueadores.

**3. Site** — copie `public/tracking.js` para a pasta pública do site e cole `examples/head-snippet.html` no `<head>`, trocando os IDs.

**4. Webhook** — na Hotmart, cadastre `https://seudominio.com.br/track/webhook` com o evento de compra aprovada. Na Kiwify, use `https://seudominio.com.br/track/webhook?token=SEU_TOKEN`.

## Validação

1. Defina `META_TEST_EVENT_CODE` em `[vars]` e acompanhe em **Gerenciador de Eventos → Testar eventos**.
2. Confira os eventos no Supabase:

```sql
SELECT event_name, event_id, utm_source, meta_response, created_at
FROM site_tracking_events
ORDER BY created_at DESC
LIMIT 20;
```

3. Remova o `META_TEST_EVENT_CODE` depois de validar.

## Testes

```bash
node --test tests/*.test.mjs
```

## Privacidade

O Worker grava e-mail, telefone e nome **normalizados (sem hash)** no Supabase para auditoria. Use isso de acordo com a LGPD: base legal, aviso de cookies/consentimento, retenção definida e acesso restrito à tabela. Se não precisar do log, deixe `SUPABASE_URL` sem configurar e ele é ignorado.

---

Feito por **[André Brága](https://andrericardobraga.com.br)**, tráfego pago, rastreamento e automação. Mais sobre rastreamento no [YouTube](https://www.youtube.com/@andre_ricardo_braga).

Licença MIT.
