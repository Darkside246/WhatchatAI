-- Takes WhatsApp Channels back out of the human-handoff state they should
-- never have been put into.
--
-- WHAT WENT WRONG. A channel (newsletter JID) is a broadcast feed: only its
-- owner can post to it, and nothing an operator or the AI writes can reach
-- it. Nothing in the ingestion path knew that, so every post from every
-- channel an account follows was handled as an inbound customer message -
-- it scheduled a real AI call, and any failure along the way (no agent
-- configured, the provider unavailable, a blocked keyword) set the chat to
-- HUMAN_TAKEOVER. That is the state the urgent-handover pill and the "What
-- to do next" list both read, so an operator was shown a queue of football,
-- news and takeaway feeds described as conversations waiting on a person -
-- none of which could be answered even in principle.
--
-- The code fix stops new ones arriving (see isBroadcastFeed in
-- incomingMessagesWorker.ts, plus the chat_type filters in
-- whatsappChatRepository.ts). This repairs the rows already in that state,
-- which would otherwise sit there forever: the lists now hide them, but
-- hiding a wrong value is not the same as correcting it, and anything else
-- reading ai_mode would still see it.
--
-- WHY AI_PAUSED AND NOT AI_ACTIVE. None of the three modes really fits a
-- feed, but AI_ACTIVE would assert the AI is working this chat, which is
-- now deliberately untrue - it is skipped before any reply is considered.
-- AI_PAUSED says the AI is not acting here, which is exactly right, and it
-- keeps the row out of every HUMAN_TAKEOVER-scoped query.
--
-- DELIBERATELY NARROW. Only newsletter chats, and only ones currently in
-- HUMAN_TAKEOVER. A channel an operator has left alone keeps whatever it
-- has, and no ordinary conversation is touched - a real chat sitting in
-- HUMAN_TAKEOVER is a person genuinely waiting, and silently clearing those
-- would lose real work.

UPDATE whatsapp_chats
SET ai_mode = 'AI_PAUSED',
    ai_mode_source = 'channel_not_a_conversation',
    ai_mode_set_at = now(),
    updated_at = now()
WHERE chat_type = 'newsletter'
  AND ai_mode = 'HUMAN_TAKEOVER';
