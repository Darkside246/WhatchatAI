-- Emergency "Stop All Agents" kill switch (AURA Master Engineering Prompt
-- section 32: "These must work server-side. Do not rely on hiding a button
-- in the frontend."). Enforced in agentGuard.ts's guardToolInvocation -
-- the one gate every AI tool call already passes through - not scattered
-- across individual tool call sites, so it can never be bypassed by a
-- future tool that forgets to check it.
ALTER TABLE businesses ADD COLUMN ai_actions_paused BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE businesses ADD COLUMN ai_actions_paused_at TIMESTAMPTZ;
