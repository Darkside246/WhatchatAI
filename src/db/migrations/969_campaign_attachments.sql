-- Section 27-30: campaigns were text-only - message_text was the only real
-- content column this table ever had, even though the exact same outbound
-- pipeline every campaign send already reuses (whatsappOutboundMessageService.send())
-- has supported real media attachments (image/video/document, base64
-- upload, real encrypted storage via storeMedia()) since it was built for
-- the ordinary 1:1 composer. This is the schema half of wiring that same,
-- already-working capability into a broadcast.
ALTER TABLE campaigns
  ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'document')),
  ADD COLUMN media_storage_reference TEXT,
  ADD COLUMN media_mime_type TEXT,
  ADD COLUMN media_file_name TEXT;
