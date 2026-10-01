-- Tabela de log dos eventos de rastreamento.
-- Rode no SQL Editor do seu projeto Supabase.

CREATE TABLE IF NOT EXISTS site_tracking_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  site text NOT NULL,
  event_name text NOT NULL,
  event_id text,

  -- Dados pessoais normalizados (o hash é feito no Worker antes de ir ao Meta).
  -- Atenção à LGPD: defina retenção e acesso restrito a esta tabela.
  email text,
  phone text,
  first_name text,
  last_name text,

  -- UTMs (capturadas na URL e persistidas na sessão)
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,

  -- Contexto técnico (melhora o EMQ no Meta)
  page_url text,
  user_agent text,
  ip text,
  fbp text,          -- cookie _fbp (browser ID do Meta)
  fbc text,          -- cookie _fbc (click ID do Meta, quando vem de anúncio)
  ga_client_id text, -- cookie _ga

  -- Compra (preenchido pelo webhook)
  platform text,     -- hotmart | kiwify
  product_name text,
  order_id text,
  order_value numeric,
  currency text DEFAULT 'BRL',

  -- Resposta do Meta CAPI (útil para auditar)
  meta_response jsonb,

  created_at timestamptz DEFAULT now()
);

-- RLS ligado e sem políticas para anon/authenticated:
-- só a service_role (usada pelo Worker) consegue gravar e ler.
ALTER TABLE site_tracking_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_ste_event_name ON site_tracking_events (event_name);
CREATE INDEX IF NOT EXISTS idx_ste_created_at ON site_tracking_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ste_utm_source ON site_tracking_events (utm_source);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_purchase_event
  ON site_tracking_events (event_id) WHERE event_name = 'purchase';
