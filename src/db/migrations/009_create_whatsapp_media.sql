CREATE TABLE whatsapp_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),
  message_id UUID NOT NULL REFERENCES whatsapp_messages(id),

  media_type TEXT NOT NULL
    CHECK (media_type IN ('image', 'video', 'audio', 'voice_note', 'document', 'sticker')),
  mime_type TEXT,
  file_name TEXT,
  file_size BIGINT,
  sha256 TEXT,
  duration_seconds INTEGER,
  width INTEGER,
  height INTEGER,

  storage_provider TEXT NOT NULL DEFAULT 'pending'
    CHECK (storage_provider IN ('pending', 'local', 's3', 'gcs')),
  storage_reference TEXT,

  download_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (download_status IN ('pending', 'downloading', 'downloaded', 'failed', 'unavailable')),
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'skipped')),

  transcript TEXT,
  ai_interpretation JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_media_message_idx ON whatsapp_media (message_id);
