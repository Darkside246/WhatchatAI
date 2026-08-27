import http from 'node:http';

const host = process.env.GOOSE_PROXY_HOST ?? '127.0.0.1';
const port = Number(process.env.GOOSE_PROXY_PORT ?? 3284);
const upstream = (process.env.GOOSE_UPSTREAM_URL ?? 'http://127.0.0.1:3285').replace(/\/$/, '');
const apiKey = process.env.GOOSE_SERVICE_API_KEY?.trim() || null;
const maxBodyBytes = 256 * 1024;

function authorised(req: http.IncomingMessage): boolean {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

async function upstreamRequest(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${upstream}${path}`, init);
}

const server = http.createServer(async (req, res) => {
  if (!authorised(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      const response = await upstreamRequest('/status', { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
      res.writeHead(response.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: response.ok ? 'ok' : 'unavailable' }));
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/generate') {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBodyBytes) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'REQUEST_TOO_LARGE' }));
          return;
        }
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      JSON.parse(body);
      const response = await upstreamRequest('/ask', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ prompt: JSON.parse(body).systemInstruction + '\n\n' + JSON.parse(body).contents.map((c: { role: string; parts: Array<{ text: string }> }) => `${c.role}: ${c.parts.map(p => p.text).join('\n')}`).join('\n\n') }),
      });
      const text = await response.text();
      if (!response.ok) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'GOOSE_UPSTREAM_FAILED', upstreamStatus: response.status }));
        return;
      }
      const parsed = JSON.parse(text) as { response?: unknown };
      const generated = typeof parsed.response === 'string' ? parsed.response.trim() : '';
      if (!generated) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'GOOSE_EMPTY_RESPONSE' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: generated }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'GOOSE_PROXY_FAILED', reason: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
});

server.listen(port, host, () => {
  console.log(`Goose failover adapter listening on http://${host}:${port}`);
  console.log(`Upstream Goose service: ${upstream}`);
});
