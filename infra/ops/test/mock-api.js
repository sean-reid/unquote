// Canned netcup SCP + Cloudflare API for provision-netcup.sh tests.
// Scenario comes from MOCK_SCENARIO: happy | badtoken | existingkey | dnsconflict.
// Serves everything on one port; the script points NETCUP_API_BASE,
// NETCUP_TOKEN_URL, and CF_API_BASE here.
import { createServer } from 'node:http';

const scenario = process.env.MOCK_SCENARIO ?? 'happy';
const port = Number(process.env.MOCK_PORT ?? 8975);

// A structurally valid JWT whose payload carries the SCP user id as sub.
const payload = Buffer.from(
  JSON.stringify({ sub: 'u-123', preferred_username: '9000001' }),
).toString('base64url');
const jwt = `eyJhbGciOiJub25lIn0.${payload}.sig`;

const uploadedKeys = [];
let taskPolls = 0;

const PUBKEY_MARKER = process.env.MOCK_EXISTING_KEY ?? '';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks).toString() : '';
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // Keycloak
    if (p.endsWith('/token')) {
      if (scenario === 'badtoken') {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Token is not active' });
      }
      return json(res, 200, { access_token: jwt, expires_in: 300 });
    }

    // SCP
    if (p === '/api/v1/users/u-123') return json(res, 200, { id: 'u-123', username: '9000001' });
    if (p === '/api/v1/users/u-123/ssh-keys' && req.method === 'GET') {
      const keys = [...uploadedKeys];
      if (scenario === 'existingkey' && PUBKEY_MARKER) {
        keys.push({
          id: 77,
          name: 'unquote-deploy',
          key: `ssh-ed25519 ${PUBKEY_MARKER} unquote-deploy`,
        });
      }
      return json(res, 200, keys);
    }
    if (p === '/api/v1/users/u-123/ssh-keys' && req.method === 'POST') {
      const key = { id: 42, ...JSON.parse(body) };
      uploadedKeys.push(key);
      return json(res, 200, key);
    }
    if (p === '/api/v1/servers' && req.method === 'GET') {
      return json(res, 200, [{ id: 5001, name: 'v9000001', hostname: null, nickname: null }]);
    }
    if (p === '/api/v1/servers/5001' && req.method === 'GET') {
      return json(res, 200, {
        id: 5001,
        name: 'v9000001',
        hostname: null,
        nickname: null,
        ipv4Addresses: ['203.0.113.10'],
        ipv6Addresses: [],
      });
    }
    if (p === '/api/v1/servers/5001/imageflavours') {
      return json(res, 200, [
        { id: 9, name: 'Debian 12', alias: 'bookworm' },
        { id: 14, name: 'Ubuntu 24.04 LTS', alias: 'noble' },
      ]);
    }
    if (p === '/api/v1/servers/5001/image' && req.method === 'POST') {
      return json(res, 200, { uuid: 'task-abc', state: 'running' });
    }
    if (p === '/api/v1/tasks' && req.method === 'GET') return json(res, 200, []);
    if (p === '/api/v1/tasks/task-abc') {
      taskPolls += 1;
      return json(res, 200, { uuid: 'task-abc', state: taskPolls < 2 ? 'running' : 'done' });
    }

    // Cloudflare
    if (p === '/zones') {
      return json(res, 200, { success: true, result: [{ id: 'zone-1', name: 'dwainosaur.com' }] });
    }
    if (p === '/zones/zone-1/dns_records' && req.method === 'GET') {
      if (scenario === 'dnsconflict') {
        return json(res, 200, {
          success: true,
          result: [
            {
              id: 'rec-9',
              type: 'A',
              name: 'unquote.dwainosaur.com',
              content: '198.51.100.7',
              proxied: true,
            },
          ],
        });
      }
      return json(res, 200, { success: true, result: [] });
    }
    if (p === '/zones/zone-1/dns_records' && req.method === 'POST') {
      return json(res, 200, { success: true, result: { id: 'rec-new', ...JSON.parse(body) } });
    }
    if (p.startsWith('/zones/zone-1/dns_records/') && req.method === 'PUT') {
      return json(res, 200, { success: true, result: { id: 'rec-9', ...JSON.parse(body) } });
    }

    json(res, 404, { error: `no mock for ${req.method} ${p}` });
  });
}).listen(port, () => console.log(`mock api (${scenario}) on ${port}`));
