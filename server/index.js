/** HTTP sunucusu — Node http, dependency yok.
 * 
 * Rotalar:
 *   GET  /api/health              → durum
 *   GET  /api/models              → provider + model listesi
 *   GET  /api/conversations       → sohbet listesi
 *   POST /api/conversations       → yeni sohbet
 *   PATCH /api/conversations/:id→ yeniden adlandır
 *   DELETE /api/conversations/:id→ sil
 *   GET  /api/conversations/:id/messages → mesajlar
 *   POST /api/chat               → SSE streaming yanıt
 *   GET  /api/tools              → ajan araçları
 *   POST /api/upload             → dosya yükleme (multipart/form-data)
 *   GET  /api/uploads            → yüklü dosya listesi
 *   GET  /api/uploads/:id        → dosya içeriği
 *   DELETE /api/uploads/:id      → dosyayı sil
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProvider, listProviderNames } from './providers.js';
import { runAgent, tools } from './agents.js';
import { parseMultipart, storeFilePart, listUploads, readUpload, deleteUpload } from './uploads.js';
import {
  createConversation, listConversations, getConversation,
  renameConversation, deleteConversation, getMessages,
  addMessage, autoTitle,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// ── API anahtarı koruması (dışarı açarken) ───────────────────────────
// PUBLIC_MODE=1 ise erişim parola ister (x-access-key header veya ?key=)
// Loopback (localhost) istekleri serbest — yerel kullanımda anahtar girmeye
// gerek kalmasın.
// Cloudflare tunnel istekleri sunucuya kendi IP'sinden proxy'ler, bu yüzden
// remoteAddress her zaman loopback görünür. Gerçek istemci IP'si
// x-forwarded-for başlığında gelir — ona bakmazsak koruma delinir.
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const ACCESS_KEY = process.env.ACCESS_KEY || '';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '']);

function clientIp(req) {
  // Proxy başlıkları: en soldaki gerçek istemci IP'si
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return String(cfIp).trim();
  return req.socket.remoteAddress || '';
}

function isLocal(req) {
  const addr = clientIp(req);
  if (LOOPBACK.has(addr)) return true;
  // IPv6 loopback varyantları
  return addr.startsWith('127.') || addr === '::1' || addr.startsWith('::ffff:127.');
}

function authorized(req, url) {
  if (!PUBLIC_MODE) return true;
  if (isLocal(req)) return true;
  const headerKey = req.headers['x-access-key'];
  const queryKey = url.searchParams.get('key');
  return Boolean(ACCESS_KEY) && (headerKey === ACCESS_KEY || queryKey === ACCESS_KEY);
}

// ── Basit rate limiter (public modda koruma) ──────────────────────────
// IP başına kayan pencere: dakikada N istek
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 30);
const hits = new Map();

function rateLimited(req) {
  if (!PUBLIC_MODE) return false;
  if (isLocal(req)) return false;
  const ip = clientIp(req) || 'unknown';
  const now = Date.now();
  const win = 60000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now);
  hits.set(ip, list);
  // Bellek temizliği
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < win)) hits.delete(k);
    }
  }
  return list.length > RATE_LIMIT;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS — public mode dışında sadece aynı origin
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(req, res, url);
  }

  if (!authorized(req, url)) {
    return sendJson(res, 401, { error: 'Yetkisiz erişim. ACCESS_KEY gerekli.' });
  }

  // Rate limit (API rotaları için)
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
    if (rateLimited(req)) {
      return sendJson(res, 429, { error: 'Çok fazla istek. Biraz bekleyin.' });
    }
  }

  try {
    // ── Modeller ──
    if (url.pathname === '/api/models' && req.method === 'GET') {
      const out = [];
      for (const name of listProviderNames()) {
        const p = getProvider(name);
        const models = await p.listModels();
        // Embedding modelleri ayrı listede
        const embeds = typeof p.listEmbedModels === 'function' ? p.listEmbedModels() : [];
        out.push({ provider: name, label: p.label, models, embeds });
      }
      return sendJson(res, 200, { providers: out });
    }

    // ── Sağlık ──
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const ollamaUp = await fetch('http://127.0.0.1:11434/api/tags')
        .then((r) => r.ok).catch(() => false);
      const nvidiaUp = !!process.env.NVIDIA_API_KEY;
      return sendJson(res, 200, {
        ok: true,
        ollama: ollamaUp,
        nvidia: nvidiaUp,
        publicMode: PUBLIC_MODE,
        uptime: Math.round(process.uptime()),
      });
    }

    // ── Araçlar ──
    if (url.pathname === '/api/tools' && req.method === 'GET') {
      return sendJson(res, 200, {
        tools: [...tools.values()].map((t) => ({
          name: t.name, description: t.description, parameters: t.parameters,
        })),
      });
    }

    // ── Sohbetler ──
    if (url.pathname === '/api/conversations' && req.method === 'GET') {
      return sendJson(res, 200, { conversations: listConversations() });
    }

    if (url.pathname === '/api/conversations' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 201, { conversation: createConversation(body.title) });
    }

    const convMatch = url.pathname.match(/^\/api\/conversations\/([\w-]+)(\/messages)?$/);
    if (convMatch) {
      const id = convMatch[1];
      if (convMatch[2] && req.method === 'GET') {
        return sendJson(res, 200, { messages: getMessages(id) });
      }
      if (!convMatch[2] && req.method === 'GET') {
        const c = getConversation(id);
        if (!c) return sendJson(res, 404, { error: 'Bulunamadı' });
        return sendJson(res, 200, { conversation: c });
      }
      if (!convMatch[2] && req.method === 'PATCH') {
        const body = await readBody(req);
        if (!body.title) return sendJson(res, 400, { error: 'title gerekli' });
        return sendJson(res, 200, { conversation: renameConversation(id, body.title) });
      }
      if (!convMatch[2] && req.method === 'DELETE') {
        deleteConversation(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Chat (SSE stream) ──
    // ── Chat (SSE stream) ──
        if (url.pathname === '/api/chat' && req.method === 'POST') {
          const body = await readBody(req);
          const {
            message, conversationId, provider = 'ollama',
            model = 'mistral:latest', agent = false, temperature = 0.7,
            attachments = [],
          } = body;

          if (!message) return sendJson(res, 400, { error: 'message gerekli' });

          let convId = conversationId;
          if (!convId) {
            convId = createConversation().id;
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          const send = (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          };

          const ac = new AbortController();
          req.on('close', () => ac.abort());

          // Geçmişi yükle (system hariç)
          const history = getMessages(convId)
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.content }));

          // ── Attachments processing ──────────────────────────────────────
          // attachments: [uploadId, ...] dizisi
          // - Images: data URI olarak vision modüllerine gönderilir
          // - Text files: içeriği message'e eklenir
          const imageUris = [];
          let textFileContents = [];

          for (const attachment of attachments) {
            // Frontend obje ({id,name,type}) ya da string id gönderebilir
            const uploadId = typeof attachment === 'string'
              ? attachment
              : attachment?.id;
            if (!uploadId) continue;

            const fileData = await readUpload(uploadId);
            if (!fileData) continue;

            const ext = path.extname(uploadId).toLowerCase();
            const textExts = new Set(['.txt', '.md', '.json', '.csv']);

            if (textExts.has(ext)) {
              // Text file: içeriği al ve message'e ekle
              const rawText = fileData.toString('utf8');
              const MAX_TEXT = 50 * 1024;
              const truncated = rawText.length > MAX_TEXT
                ? rawText.slice(0, MAX_TEXT) + '\n...\n[truncated]'
                : rawText;
              textFileContents.push(truncated);
            } else if (
              ext === '.jpg' || ext === '.jpeg' || ext === '.png' ||
              ext === '.gif' || ext === '.webp'
            ) {
              // Image: base64 data URI oluştur
              const base64 = fileData.toString('base64');
              const mimeType = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
              }[ext];
              imageUris.push(`data:${mimeType};base64,${base64}`);
            }
          }

          // Kullanıcı mesajını hazırla — text dosyalarını içine kat
          let userMessageContent = message;
          if (textFileContents.length > 0) {
            const textBlock = textFileContents.join('\n\n---\n\n');
            userMessageContent = message + '\n\n---\n\n' + textBlock;
          }

          // Kullanıcı mesajını kaydet (processing değişkenleri içerir)
          addMessage({ conversationId: convId, role: 'user', content: userMessageContent });
          send({ type: 'conversation', conversationId: convId });

          let finalText = '';
          let reasoningText = '';
          let toolCalls = [];

          try {
            if (agent) {
              const result = await runAgent({
                providerName: provider,
                model,
                messages: history,
                userPrompt: userMessageContent,
                temperature,
                onEvent: (ev) => {
                  if (ev.type === 'delta') finalText += ev.text;
                  if (ev.type === 'reasoning') reasoningText += ev.text;
                  if (ev.type === 'tool_start') toolCalls.push({ tool: ev.tool, ok: null });
                  send(ev);
                },
                signal: ac.signal,
              });
              finalText = result.text || finalText;
              toolCalls = result.toolHistory;
            } else {
              const p = getProvider(provider);
              p.model = model;
              // Reasoning modelleri token bütçesini düşünmeye harcamak için daha fazla bütçe ver
              const maxTokens = provider === 'nvidia' ? 8192 : 4096;

              // Mesajları multimodal formata dönüştür (NVIDIA için) veya düz metin (Ollama için)
              let streamMessages;
              if (provider === 'nvidia' && imageUris.length > 0) {
                // NVIDIA vision modeli: multimodal mesajlar
                streamMessages = [
                  ...history,
                  { role: 'user', content: [
                    { type: 'text', text: userMessageContent },
                    ...imageUris.map((uri) => ({
                      type: 'image_url',
                      image_url: { url: uri },
                    })),
                  ]},
                ];
              } else {
                // Ollama veya text-only: düz metin
                streamMessages = [
                  ...history,
                  { role: 'user', content: userMessageContent },
                ];
              }

              for await (const chunk of p.stream(
                streamMessages,
                { temperature, maxTokens, signal: ac.signal }
              )) {
                if (chunk.reasoning) {
                  reasoningText += chunk.reasoning;
                  send({ type: 'reasoning', text: chunk.reasoning });
                }
                if (chunk.delta) {
                  finalText += chunk.delta;
                  send({ type: 'delta', text: chunk.delta });
                }
              }
              send({ type: 'done', text: finalText });
            }

            addMessage({
              conversationId: convId, role: 'assistant', content: finalText,
              provider, model, toolCalls: toolCalls.length ? toolCalls : null,
              reasoning: reasoningText || null,
            });
            const title = autoTitle(convId);
            send({ type: 'saved', conversationId: convId, title });
          } catch (e) {
            send({ type: 'error', error: e.message || String(e) });
          }

          res.end();
          return;
        }

    // ── Yükleme API rotaları ───────────────────────────────────────────

    // POST /api/upload — multipart/form-data kabul et, dosyayı kaydet
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      try {
        const { parts } = await parseMultipart(req);
        if (!parts.length) {
          return sendJson(res, 400, { error: 'Dosya parçası bulunamadı' });
        }

        // İlk parçayı store et (name='file' veya 'upload' beklenir)
        const part = parts.find((p) => p.name === 'file' || p.name === 'upload');
        if (!part) {
          // Fallback: first part with a filename
          const withFile = parts.find((p) => p.filename);
          if (!withFile) {
            return sendJson(res, 400, { error: 'Dosya ismi bulunamadı — multipart parçası "name" ve "filename" içermeli' });
          }
          // use withFile directly
        }

        const result = await storeFilePart(part);
        return sendJson(res, 201, result);
      } catch (e) {
        console.error('[upload error]', e);
        return sendJson(res, 400, { error: e.message || 'Yükleme hatası' });
      }
    }

    // GET /api/uploads — listedeki dosyaları döndür
    if (url.pathname === '/api/uploads' && req.method === 'GET') {
      try {
        const files = await listUploads();
        return sendJson(res, 200, { files, uploads: files });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || 'Listeleme hatası' });
      }
    }

    // GET /api/uploads/:id — dosya içeriğini Content-Type ile döndür
    // id = uuid + uzantı (örn. 6f4c0408-....png) → nokta regex'e dahil
    if (url.pathname.match(/^\/api\/uploads\/[\w.-]+$/) && req.method === 'GET') {
      try {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const data = await readUpload(id);
        if (!data) {
          return sendJson(res, 404, { error: 'Dosya bulunamadı' });
        }
        // Determine content type from extension
        const ext = path.extname(id).toLowerCase();
        const mimeMap = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
          '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
          '.csv': 'text/csv', '.js': 'application/javascript', '.ts': 'application/typescript',
          '.py': 'text/x-python', '.java': 'text/x-java', '.go': 'text/x-go',
          '.c': 'text/x-c', '.cpp': 'text/x-cpp',
        };
        const contentType = mimeMap[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: e.message || 'Dosya okuma hatası' });
        else res.end();
      }
    }

    // DELETE /api/uploads/:id — dosyayı sil
    if (url.pathname.match(/^\/api\/uploads\/[\w.-]+$/) && req.method === 'DELETE') {
      try {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const ok = await deleteUpload(id);
        if (!ok) {
          return sendJson(res, 404, { error: 'Dosya bulunamadı' });
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || 'Silme hatası' });
      }
    }

    sendJson(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || 'Sunucu hatası' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Chatbot sunucusu → http://localhost:${PORT}`);
  console.log(`  Ollama:  http://127.0.0.1:11434`);
  console.log(`  NVIDIA: ${process.env.NVIDIA_API_KEY ? 'API key var ✓' : 'API key YOK ✗'}`);
  console.log(`  Public mod: ${PUBLIC_MODE ? 'AÇIK (ACCESS_KEY gerekli)' : 'kapalı (sadece localhost)'}`);
  console.log(`  Statik dosyalar: ${PUBLIC_DIR}\n`);
});

export { server };