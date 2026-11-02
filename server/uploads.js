/**
 * dependency-free multipart/form-data parser + upload store
 *
 * - multipart parser: finds boundary from Content-Type header,
 *   splits the body Buffer on "--boundary", parses headers + body per part
 * - upload store: saves under data/uploads/<uuid><ext>, validates size/type
 * - functions: listUploads, readUpload(id), deleteUpload(id)
 *
 * 2-space indent, named exports, Turkish JSDoc yorumları uyumu.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------
// Multipart /forem-data parser (dependency-free)
// ---------------------------------------------------------------

/**
 * Multipart/form-data parçalarını ayrıştırır.
 * req: Node http request objesi (body Buffer'ları toplanmış).
 * Dönüş: { parts: Array<{ name: string, filename?: string, contentType?: string, body: Buffer }> }
 *
 * Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...
 */
export async function parseMultipart(req, bodyBuffer) {
  // İki kullanım: (a) http request nesnesi, (b) doğrudan Buffer + boundary
  let boundary;
  let body;

  if (Buffer.isBuffer(req)) {
    // req = body Buffer, bodyBuffer = boundary string
    body = req;
    boundary = String(bodyBuffer || '').trim();
  } else {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) return { parts: [] };
    boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  if (!boundary) return { parts: [] };

  const parts = [];
  const sep = Buffer.from(`--${boundary}`);

  // Her part'ı Buffer olarak ayır — binary güvenliği için string'e çevirme
  let idx = body.indexOf(sep);
  while (idx !== -1) {
    const after = idx + sep.length;
    // Son marker: "--boundary--"
    if (body.slice(after, after + 2).toString() === '--') break;
    // Part başında CRLF var
    const start = body.indexOf('\r\n', after);
    if (start === -1) break;
    const next = body.indexOf(sep, start);
    if (next === -1) break;

    const raw = body.slice(start + 2, next);
    // Sondaki CRLF part'ın gövdesine dahil değil
    const content = raw.slice(0, raw.length - 2);

    const sepIdx = content.indexOf('\r\n\r\n');
    if (sepIdx !== -1) {
      const headersStr = content.slice(0, sepIdx).toString('utf8');
      const partBody = content.slice(sepIdx + 4);
      parsePart(headersStr, partBody, parts);
    }

    idx = next;
  }

  return { parts };
}

/**
 * Tek bir multipart parçasının headers ve body'sını ayrıştırır.
 * @param {string} headersStr - Parça headers'ı (CRLF ile ayrılmış)
 * @param {Buffer} bodyBuf - Parça body'sı (binary güvenli)
 * @param {Array} parts - Toplanan parçalar dizisi (dolaylı olarak güncellenir)
 */
function parsePart(headersStr, body, parts) {
  // Content-Disposition: form-data; name="file"; filename="foo.jpeg"  or  name="field"
  const discMatch = headersStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]*?)"(?:\s*;\s*filename="([^"]*)")?/i);
  if (!discMatch) return; // field-only part, body text olarak kaydedilecek

  const name = discMatch[1];
  const filename = discMatch[2]; // optionally

  // Content-Type
  const contentTypeMatch = headersStr.match(/Content-Type:\s*(.+)/i);
  const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : undefined;

  // Body zaten Buffer (binary güvenli) — string'e çevirme
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');

  parts.push({ name, filename, contentType, body: bodyBuf });
}

// ---------------------------------------------------------------
// Upload store: disk üzerinde dosya depolama + validation
// ---------------------------------------------------------------

const UPLOADS_DIR = path.join(path.dirname(path.dirname(__filename)), 'data', 'uploads');

// env'den max boyut (MB) oku, varsayılan 10
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || '10');
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Enable/Disable Turkish chars in filenames — safe with path.join
// We still sanitize but allow them since path.join handles UTF-8.

/**
 * Geçersiz dosya karakterlerinden arındırır, "_" ile boşlukları değiştirir.
 * @param {string} name - Orijinal dosya adı
 * @returns {string} - Güvenli disk adı
 */
function sanitizeFilename(name) {
  if (!name) return 'upload';
  // Yalnızca dosya adı — dizin bileşenlerini at
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length);

  const safeStem = stem
    .replace(/^\.+/, '')                       // baştaki noktalar (gizli dosya, "..")
    .replace(/[<>:"/\\|?*]/g, '_')             // filesystem yasaklı karakterler
    .replace(/\s+/g, '_')                      // boşluklar
    .replace(/[^\w-]/g, '_')                  // geri kalan non-word
    .replace(/^\.+/, '')                       // tekrar güvenlik
    .slice(0, 80);

  return (safeStem || 'upload') + ext;
}

/** Uzantı allowed listesi (küçük harf) */
const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',    // images
  '.pdf',                                      // pdf
  '.txt', '.md', '.json', '.csv',              // text/doc
  '.js', '.ts', '.py', '.java', '.go', '.c', '.cpp', '.h', '.hpp', // code files
]);

/** MIME allowlist (anahtar = ext) */
const MIME_ALLOWLIST = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv',
  '.js': 'application/javascript', '.ts': 'application/typescript',
  '.py': 'text/x-python', '.java': 'text/x-java', '.go': 'text/x-go',
  '.c': 'text/x-c', '.cpp': 'text/x-cpp', '.h': 'text/x-c', '.hpp': 'text/x-c++',
};

/**
 * Yüklenen parçayı disk üzerinde kaydeder ve result objesi döndürür.
 * @param {{ name: string, filename?: string, contentType?: string, body: Buffer }} part - ayrıştırılmışmultipart parçası
 * @returns {Promise<{id:string, name:string, size:number, type:string, url:string, text?:string}>}
 * - text: text-like dosyalar için extracted UTF-8 content (kısaltılmış)
 */
export async function storeFilePart(part) {
  const { name, filename, contentType, body } = part;

  if (!filename) {
    throw new Error('Dosya adı belirtilmedi');
  }

  // Uzantı kontrolü (dosya ismindeki ext)
  const ext = path.extname(filename).toLowerCase();

  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Desteklenmeyen dosya türü: ${ext}. İzin verilenler: ${[...ALLOWED_EXT].join(', ')}`);
  }

  // MIME type kontrolü (istemci göndermişse)
  if (contentType && !MIME_ALLOWLIST[ext] || contentType !== MIME_ALLOWLIST[ext]) {
    // Strict eşleşme yerine, contentType'in içerdiği türle uyumu kontrol et
    const allowedMime = MIME_ALLOWLIST[ext];
    if (contentType && !allowedMime.includes(contentType.split('/')[0])) {
       // content type uzantıyla uyuşmuyor ama uzantı izin verilmişse
       // uyarı ver ama engellememek
    }
  }

  // Boyut kontrolü
  if (body.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Dosya too large: ${body.length} bytes (max: ${MAX_UPLOAD_MB} MB)`);
  }

  // Güvenli dosya adı oluştur
  const safeName = sanitizeFilename(filename);
  const uuid = crypto.randomUUID();
  const diskName = `${uuid}${ext}`;  // uuid + orijinal uzantı

  // Kaydedilecek tam yol: data/uploads/<uuid><ext>
  const outPath = path.join(UPLOADS_DIR, diskName);

  // Klasörü garantiye al
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  // Dosyayı kaydet
  await fs.writeFile(outPath, body);

  // Text-like dosyalar için içeriği oku (truncate)
  let textContent = undefined;
  const textExts = new Set(['.txt', '.md', '.json', '.csv']);
  if (textExts.has(ext)) {
    const rawText = body.toString('utf8');
    // 50KB limit — daha uzun kısalt
    const MAX_TEXT = 50 * 1024;
    textContent = rawText.length > MAX_TEXT ? rawText.slice(0, MAX_TEXT) + '\n...\n[truncated]' : rawText;
  }

  const url = `/api/uploads/${diskName}`;

  return {
    id: diskName,
    name: safeName,
    size: body.length,
    type: ext,
    url,
    text: textContent,
  };
}

/** Kaydedilmiş tüm uploadları listeler (disk üzerinden) */
export async function listUploads() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const files = await fs.readdir(UPLOADS_DIR);
  return files
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return ALLOWED_EXT.has(ext);
    })
    .map((f) => {
      const fullPath = path.join(UPLOADS_DIR, f);
      // Basit stat — fs.promises.stat gerektirir ama synchronous okumak daha kolay
      // instead, just return filename+url; size info optional
      const ext = path.extname(f).toLowerCase();
      const allowedMime = MIME_ALLOWLIST[ext];
      return {
        id: f,
        name: f.replace(/^[a-f0-9]*/, ''),  // strip uuid prefix to show original-ish
        size: '?',  // could stat, but keeping lightweight
        type: ext,
        url: `/api/uploads/${f}`,
      };
    });
}

/** ID'ye göre dosyayı diskten okur, Buffer döndürür */
export async function readUpload(id) {
  // Hem string id hem {id} nesnesi kabul et
  const fileId = typeof id === 'string' ? id : id?.id;
  if (!fileId) return null;
  // Yol kaçışı koruması — sadece dosya adı
  const safeId = path.basename(fileId);
  const fullPath = path.join(UPLOADS_DIR, safeId);
  try {
    return await fs.readFile(fullPath);
  } catch {
    return null;
  }
}

/** ID'ye göre dosyayı diskten siler */
export async function deleteUpload(id) {
  const fileId = typeof id === 'string' ? id : id?.id;
  if (!fileId) return false;
  const safeId = path.basename(fileId);
  const fullPath = path.join(UPLOADS_DIR, safeId);
  try {
    await fs.unlink(fullPath);
    return true;
  } catch {
    return false;
  }
}

// Helper: path.extname benzeri (eğer zaten içeri aktarılmışsa)
// Kullanım: const pathExt = (p) => path.posix.extname(p); // zaten path modülü var