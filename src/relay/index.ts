import { createOpenClawRelayServer } from './openclawRelayServer.js';

/**
 * Real entrypoint for the relay's own Docker image (see the `relay-runtime`
 * Dockerfile stage) - `node dist/relay/index.js`. Every fixed upstream
 * identity comes from env vars set once at container-create time by
 * `DockerCellRuntime`, never from anything a request says.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to start the OpenClaw relay`);
  return value;
}

const port = Number(process.env.RELAY_PORT ?? '8080');
const mcpUpstreamUrl = requireEnv('RELAY_MCP_UPSTREAM_URL');
const geminiUpstreamHost = process.env.RELAY_GEMINI_UPSTREAM_HOST || undefined;

const server = createOpenClawRelayServer(
  geminiUpstreamHost ? { mcpUpstreamUrl, geminiUpstreamHost } : { mcpUpstreamUrl },
);

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ msg: 'openclaw relay listening', port, mcpUpstreamUrl, geminiUpstreamHost: geminiUpstreamHost ?? null }));
});
