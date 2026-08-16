/**
 * Tiny mock OpenAI-compatible server for integration testing the browser/
 * session HTTP path without needing a real LLM (or hitting rate limits).
 * Serves POST /v1/chat/completions and returns a plausible DM JSON judgment.
 * Start with `node tests/mock-llm-server.js [port]` (default 9999).
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2]) || 9999;

const server = createServer((req, res) => {
  // CORS for all responses (real OpenAI-compatible APIs send these headers;
  // Ollama sends them when OLLAMA_ORIGINS includes the app origin).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let messages = [];
      try { messages = JSON.parse(body).messages || []; } catch {}
      const user = messages.filter((m) => m.role === 'user').pop() || { content: '' };
      const rollMatch = user.content.match(/got: (\d+)/);
      const roll = rollMatch ? Number(rollMatch[1]) : 15;

      const narrative =
        roll >= 20
          ? 'Outstanding success: the public statement is clear, staff are aligned, and community voices amplify the reassurance.'
          : roll <= 1
          ? 'Disaster: internal messages leak and contradict the public line, alarming members and the regulator.'
          : `Mixed result: the statement steadies most members, but a follow-up rumour about a "cheese audit" keeps the story alive.`;

      const delta =
        roll >= 20 ? { reputation: 6, morale: 4, member_confidence: 5 }
        : roll <= 1 ? { reputation: -12, risk: 10 }
        : { member_confidence: -2, risk: 2 };

      const reply = JSON.stringify({ narrative, state_delta: delta });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`Mock OpenAI-compatible LLM on :${PORT}`));
