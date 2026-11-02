/**
 * Yerel ajan sistemi — tool-calling döngüsü.
 *
 * Tasarım:
 *  - Planlayıcı (planner) bulut ya da yerel bir LLM'den olabilir
 *  - Araçlar (tools) gerçek komut çalıştırır (terminal, dosya okuma, HTTP, model çağrısı)
 *  - Döngü: LLM tool çağrısı ister -> çalıştır -> sonucu geri ver -> tekrar
 *  - Güvenlik: her tool çağrısı allowlist + timeout ile sınırlı
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getProvider } from './providers.js';

const execFileAsync = promisify(execFile);

/**
 * Araç kayıt defteri.
 * Her araç: { name, description, parameters, execute(args, ctx) }
 * execute -> { ok, result } | { ok:false, error }
 */
export const tools = new Map();

export function registerTool(tool) {
  tools.set(tool.name, tool);
  return tool;
}

// ── Terminal aracı ────────────────────────────────────────────────────
// Windows'ta `dir`, `echo`, `type`, `cd` cmd.exe builtin'larıdır; execFile
// bunları çalıştıramaz. Bu yüzden builtin listesinde cmd.exe /c kullanırız.
const CMD_BUILTINS = new Set(['dir', 'echo', 'type', 'cd']);
const REAL_BINARIES = new Set([
  'node', 'npm', 'npx', 'python', 'python3', 'py', 'git', 'curl', 'ffmpeg', 'ffprobe',
  'ollama', 'date', 'whoami', 'hostname', 'systeminfo', 'where', 'which',
  'tasklist', 'netstat', 'ipconfig', 'ping', 'nslookup', 'robocopy',
  'df', 'ls', 'cat', 'grep', 'find', 'wc', 'head', 'tail', 'ps', 'top', 'du',
]);

registerTool({
  name: 'run_command',
  description:
    'Komut çalıştırır. Sadece beyaz listedeki komutlar çalışır: ' +
    'dir, echo, type, cd, node, npm, python, git, curl, ffmpeg, ffprobe, ollama, ' +
    'date, whoami, hostname, systeminfo, where, which, tasklist, ipconfig, ping. ' +
    '{"command": "ollama", "args": ["list"]}. Tehlikeli komutlar reddedilir.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Çalıştırılacak komut (beyaz listede olmalı)' },
      args: { type: 'array', items: { type: 'string' }, description: 'Komut argümanları' },
    },
    required: ['command'],
  },
  async execute({ command, args = [] }) {
    // LLM bazen "ollama list" gibi komut+argümanı tek string olarak verir
    let cmd = String(command).trim();
    let argv = args.map(String);
    if (argv.length === 0 && /\s/.test(cmd)) {
      const parts = cmd.split(/\s+/);
      cmd = parts[0];
      argv = parts.slice(1);
    }

    const base = cmd.toLowerCase().replace(/\.exe$/, '');
    if (!CMD_BUILTINS.has(base) && !REAL_BINARIES.has(base)) {
      return { ok: false, error: `Komut beyaz listede değil: ${cmd}. İzin verilenler: ${[...CMD_BUILTINS, ...REAL_BINARIES].join(', ')}` };
    }

    try {
      let stdout, stderr;
      if (CMD_BUILTINS.has(base)) {
        // cmd builtin → cmd.exe /c ile
        const quoted = argv.map((a) => `"${a.replace(/"/g, '')}"`).join(' ');
        const full = `${cmd}${quoted ? ' ' + quoted : ''}`;
        ({ stdout, stderr } = await execFileAsync('cmd.exe', ['/c', full], {
          timeout: 30000, maxBuffer: 1024 * 1024, cwd: process.cwd(),
        }));
      } else {
        ({ stdout, stderr } = await execFileAsync(cmd, argv, {
          timeout: 30000, maxBuffer: 1024 * 1024, cwd: process.cwd(),
        }));
      }
      return { ok: true, result: (stdout || stderr || '').slice(0, 8000) };
    } catch (e) {
      return { ok: false, error: `${e.code || 'ERR'}: ${(e.stderr || e.message).toString().slice(0, 500)}` };
    }
  },
});

// ── Dosya okuma aracı ─────────────────────────────────────────────────
registerTool({
  name: 'read_file',
  description: 'Dosya okur. {"path": "server/providers.js"}. Proje kökü dışına çıkamaz.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute({ path: p }) {
    try {
      const root = process.cwd();
      const full = path.resolve(root, p);
      if (!full.startsWith(root)) return { ok: false, error: 'Proje dışına erişilemez' };
      const stat = await readFile(full, 'utf8');
      return { ok: true, result: stat.slice(0, 12000) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
});

// ── Dizin listeleme ───────────────────────────────────────────────────
registerTool({
  name: 'list_dir',
  description: 'Dizin içeriğini listeler. {"path": "."}',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  async execute({ path: p = '.' }) {
    try {
      let target = String(p);
      // ~ ve ~\\ kullanıcı dizinine çöz
      if (target.startsWith('~')) {
        target = path.join(process.env.USERPROFILE || process.env.HOME || '', target.slice(1));
      }
      const items = await readdir(path.resolve(target), { withFileTypes: true });
      return {
        ok: true,
        result: items
          .map((i) => `${i.isDirectory() ? '[D]' : '[F]'} ${i.name}`)
          .join('\n')
          .slice(0, 6000),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
});

// ── Dosya yazma (sadece data/ ve output/ altında) ─────────────────────
registerTool({
  name: 'write_file',
  description:
    'Dosya yazar. Sadece "data/" ve "output/" klasörlerine izin verilir. ' +
    '{"path": "data/sonuc.txt", "content": "..."}',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute({ path: p, content }) {
    const root = process.cwd();
    const full = path.resolve(root, p);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (!/^(data|output)\//.test(rel)) {
      return { ok: false, error: 'Sadece data/ ve output/ altına yazılabilir' };
    }
    try {
      // Hedef klasör yoksa oluştur
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, String(content), 'utf8');
      return { ok: true, result: `Yazıldı: ${rel} (${String(content).length} karakter)` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
});

// ── Yerel model çağrısı (ajan-in-ajan) ────────────────────────────────
registerTool({
  name: 'ask_local_model',
  description:
    'Yerel Ollama modeline soru sorar. {"prompt": "...", "model": "mistral:latest"}. ' +
    'Uzun analizler ve özetler için kullan.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      model: { type: 'string' },
      maxTokens: { type: 'number' },
    },
    required: ['prompt'],
  },
  async execute({ prompt, model, maxTokens = 1024 }) {
    try {
      const provider = getProvider('ollama');
      provider.model = model || provider.model;
      let out = '';
      for await (const chunk of provider.stream(
        [{ role: 'user', content: String(prompt) }],
        { maxTokens },
      )) {
        if (chunk.delta) out += chunk.delta;
      }
      provider.model = 'mistral:latest';
      return { ok: true, result: out.slice(0, 8000) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
});

/**
 * Araç şemasını OpenAI/Ollama uyumlu biçimde döndürür.
 */
export function toolSchemas() {
  return [...tools.values()].map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Ajan döngüsü.
 * @param {object} opts
 * @param {string} opts.providerName  'ollama' | 'nvidia'
 * @param {string} opts.model         model id
 * @param {Msg[]} opts.messages      konuşma geçmişi
 * @param {string} opts.userPrompt    yeni kullanıcı mesajı
 * @param {(ev:object)=>void} opts.onEvent  olay yayıncısı (SSE)
 * @param {number} opts.maxSteps
 */
export async function runAgent({
  providerName,
  model,
  messages = [],
  userPrompt,
  onEvent = () => {},
  maxSteps = 6,
  temperature = 0.5,
  signal,
}) {
  const provider = getProvider(providerName);
  provider.model = model;

  const history = [
    {
      role: 'system',
      content:
        `Sen bir yerel asistansın ve araç kullanabilen bir ajansın.\n` +
        `Elindeki araçlar: ${[...tools.keys()].join(', ')}.\n` +
        `Kullanıcı isteğini yerine getirmek için gerektiğinde araç çağır. ` +
        `Araç çağrısı yapacaksan SADECE şu JSON biçiminde yanıt ver:\n` +
        `{"tool":"araç_adı","args":{...}}\n` +
        `Araç çağrısı yapmayacaksan normal Türkçe metin olarak cevap ver.`,
    },
    ...messages,
    { role: 'user', content: userPrompt },
  ];

  const toolHistory = [];

  for (let step = 0; step < maxSteps; step++) {
    let assistantText = '';

    for await (const chunk of provider.stream(history, {
      temperature,
      // Reasoning modelleri token bütçesini düşünmeye harcar
      maxTokens: providerName === 'nvidia' ? 8192 : 2048,
      signal,
    })) {
      if (chunk.reasoning) {
        onEvent({ type: 'reasoning', text: chunk.reasoning });
      }
      if (chunk.delta) {
        assistantText += chunk.delta;
        onEvent({ type: 'delta', text: chunk.delta });
      }
    }

    // Araç çağrısı var mı?
    const m = assistantText.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (m) {
      const name = m[1];
      let args = {};
      try { args = JSON.parse(m[2]); } catch { /* bozuk JSON -> metin olarak devam */ }

      const tool = tools.get(name);
      if (!tool) {
        onEvent({ type: 'tool_error', tool: name, error: 'Bilinmeyen araç' });
        history.push({ role: 'assistant', content: assistantText });
        history.push({ role: 'user', content: `Araç bulunamadı: ${name}. Farklı bir yol dene veya araçsız cevap ver.` });
        continue;
      }

      onEvent({ type: 'tool_start', tool: name, args });
      const res = await tool.execute(args, { step });
      onEvent({
        type: 'tool_result',
        tool: name,
        ok: res.ok,
        preview: String(res.ok ? res.result : res.error).slice(0, 600),
      });

      toolHistory.push({ tool: name, ok: res.ok });

      history.push({ role: 'assistant', content: assistantText });
      history.push({
        role: 'user',
        content: `Araç sonucu (${name}): ${String(res.ok ? res.result : res.error).slice(0, 6000)}`,
      });
      continue;
    }

    // Araç yok — normal cevap
    onEvent({ type: 'done', text: assistantText, steps: step + 1, toolCalls: toolHistory.length });
    return { text: assistantText, toolHistory };
  }

  onEvent({ type: 'done', text: '(maks adım sayısına ulaşıldı)', steps: maxSteps });
  return { text: '(maks adım sayısına ulaşıldı)', toolHistory };
}
