import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const PORT = parseInt(process.env.PORT || '3002', 10);
const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10);
const SHARED_SECRET = process.env.AI_SHARED_SECRET || '';
const MAX_TEXT_BYTES = 50 * 1024;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const CONFIG_PATH = process.env.AI_CONFIG_PATH || './ai-config.json';

// Whitelist of acceptable Host header values to mitigate DNS rebinding.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `host.docker.internal:${PORT}`,
]);

// Known CLI candidates. Detection runs at startup and is exposed via /status.
const KNOWN_CLIS = ['claude', 'codex', 'gemini', 'chatgpt'];

const DEFAULT_PROMPTS = Object.freeze({
  summarize: '次のレビューコメントを日本語で簡潔に要約してください。重要な指摘事項のみを箇条書きで、3項目以内で答えてください。',
  summarizePr: '次の Pull Request を日本語で簡潔に要約してください。何を実装/修正しているか、影響範囲、注意点を箇条書きで答えてください。',
});

// Mutable runtime config (loaded from file at startup, overridable via PUT /config).
let runtimeConfig = {
  cli: process.env.AI_CLI || 'claude',
  cliArgs: (process.env.AI_CLI_ARGS || '').split(' ').filter(Boolean),
  prompts: { ...DEFAULT_PROMPTS },
};
let availableClis = {}; // populated at startup

function detectCli(name) {
  return new Promise((resolve) => {
    const child = spawn('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        resolve({ available: true, path: out.trim() });
      } else {
        resolve({ available: false });
      }
    });
    child.on('error', () => resolve({ available: false }));
  });
}

async function detectAllClis() {
  const entries = await Promise.all(KNOWN_CLIS.map(async (name) => [name, await detectCli(name)]));
  return Object.fromEntries(entries);
}

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.cli && typeof parsed.cli === 'string') runtimeConfig.cli = parsed.cli;
    if (Array.isArray(parsed.cliArgs)) runtimeConfig.cliArgs = parsed.cliArgs.filter((a) => typeof a === 'string');
    if (parsed.prompts) {
      if (typeof parsed.prompts.summarize === 'string') runtimeConfig.prompts.summarize = parsed.prompts.summarize;
      if (typeof parsed.prompts.summarizePr === 'string') runtimeConfig.prompts.summarizePr = parsed.prompts.summarizePr;
    }
    console.log(`Loaded config from ${CONFIG_PATH}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Failed to read ${CONFIG_PATH}: ${err.message}. Using defaults.`);
    }
  }
}

async function saveConfig() {
  const payload = {
    cli: runtimeConfig.cli,
    cliArgs: runtimeConfig.cliArgs,
    prompts: runtimeConfig.prompts,
  };
  await writeFile(CONFIG_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > MAX_TEXT_BYTES) reject(new Error('payload too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function runCLI(prompt) {
  return new Promise((resolve, reject) => {
    const args = [...runtimeConfig.cliArgs, prompt];
    const child = spawn(runtimeConfig.cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      reject(new Error(`CLI timeout (${TIMEOUT_MS}ms)`));
    }, TIMEOUT_MS);

    const guardOverflow = (label) => {
      if (killed) return;
      killed = true;
      child.kill('SIGTERM');
      clearTimeout(timer);
      reject(new Error(`CLI ${label} exceeded ${MAX_OUTPUT_BYTES} bytes`));
    };

    child.stdout.on('data', (d) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) return guardOverflow('stdout');
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderrBytes += d.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) return guardOverflow('stderr');
      stderr += d;
    });
    child.on('error', (err) => { clearTimeout(timer); if (!killed) reject(err); });
    child.on('close', (code) => {
      if (killed) return;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `CLI exited with code ${code}`));
    });
  });
}

function buildStatus() {
  return {
    cli: runtimeConfig.cli,
    cliArgs: runtimeConfig.cliArgs,
    available: availableClis,
    prompts: runtimeConfig.prompts,
    defaults: DEFAULT_PROMPTS,
    timeoutMs: TIMEOUT_MS,
    maxTextBytes: MAX_TEXT_BYTES,
    secretConfigured: !!SHARED_SECRET,
    knownClis: KNOWN_CLIS,
  };
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  if (!host || !ALLOWED_HOSTS.has(host)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden host' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cli: runtimeConfig.cli }));
    return;
  }

  if (SHARED_SECRET) {
    const provided = req.headers['x-ai-secret'];
    if (provided !== SHARED_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildStatus()));
    return;
  }

  if (req.method === 'PUT' && req.url === '/config') {
    try {
      const body = await readBody(req);
      const update = JSON.parse(body);

      if (update.cli !== undefined) {
        if (typeof update.cli !== 'string' || !update.cli.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'cli must be a non-empty string' }));
          return;
        }
        if (!availableClis[update.cli]?.available) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `CLI '${update.cli}' is not installed on host` }));
          return;
        }
        runtimeConfig.cli = update.cli;
      }
      if (update.cliArgs !== undefined) {
        if (!Array.isArray(update.cliArgs) || update.cliArgs.some((a) => typeof a !== 'string')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'cliArgs must be an array of strings' }));
          return;
        }
        runtimeConfig.cliArgs = update.cliArgs;
      }
      if (update.prompts !== undefined) {
        if (typeof update.prompts !== 'object' || update.prompts === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompts must be an object' }));
          return;
        }
        if (update.prompts.summarize !== undefined) {
          if (typeof update.prompts.summarize !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'prompts.summarize must be a string' }));
            return;
          }
          runtimeConfig.prompts.summarize = update.prompts.summarize;
        }
        if (update.prompts.summarizePr !== undefined) {
          if (typeof update.prompts.summarizePr !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'prompts.summarizePr must be a string' }));
            return;
          }
          runtimeConfig.prompts.summarizePr = update.prompts.summarizePr;
        }
      }

      await saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildStatus()));
    } catch (err) {
      console.error('Config update failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/summarize-pr') {
    try {
      const body = await readBody(req);
      const { title, body: prBody, files } = JSON.parse(body);
      if (!title || typeof title !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }

      const fileLines = Array.isArray(files)
        ? files.map((f) => `- ${f.filename} (+${f.additions ?? 0} / -${f.deletions ?? 0})`).join('\n')
        : '';
      const composed = `# Title\n${title}\n\n# Body\n${prBody || '(no description)'}\n\n# Changed files\n${fileLines || '(none)'}`;

      if (Buffer.byteLength(composed, 'utf8') > MAX_TEXT_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'PR data exceeds 50KB limit' }));
        return;
      }

      const prompt = `${runtimeConfig.prompts.summarizePr}\n\n---\n${composed}`;

      console.log(`[${new Date().toISOString()}] Summarizing PR (${composed.length} chars) via ${runtimeConfig.cli}`);
      const summary = await runCLI(prompt);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary, cli: runtimeConfig.cli }));
    } catch (err) {
      console.error('Summarize PR error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/summarize') {
    try {
      const body = await readBody(req);
      const { text } = JSON.parse(body);
      if (!text || typeof text !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text is required' }));
        return;
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text exceeds 50KB limit' }));
        return;
      }

      const prompt = `${runtimeConfig.prompts.summarize}\n\n---\n${text}`;

      console.log(`[${new Date().toISOString()}] Summarizing ${text.length} chars via ${runtimeConfig.cli}`);
      const summary = await runCLI(prompt);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary, cli: runtimeConfig.cli }));
    } catch (err) {
      console.error('Summarize error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end();
});

await loadConfig();
availableClis = await detectAllClis();
const installed = Object.entries(availableClis).filter(([, v]) => v.available).map(([k]) => k);
console.log(`Detected CLIs: ${installed.join(', ') || '(none)'}`);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI server listening on http://127.0.0.1:${PORT}`);
  console.log(`Active CLI: ${runtimeConfig.cli} ${runtimeConfig.cliArgs.join(' ')}`);
  console.log(`Config path: ${CONFIG_PATH}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms`);
  if (!SHARED_SECRET) {
    console.warn('WARNING: AI_SHARED_SECRET is not set - all requests will be accepted!');
  }
});
