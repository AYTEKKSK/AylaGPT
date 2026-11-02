 /**
  * Provider soyutlaması — Ollama (yerel) + NVIDIA NIM (bulut) + gelecek için genişletilebilir.
 /** Provider soyutlaması — Ollama (yerel) + NVIDIA NIM (bulut) + gelecek için genişletilebilir.
  * Hepsi aynı arayüzü uygular: stream(messages, opts) -> AsyncGenerator<{delta, done}>
  *
  * Msg tipi: {role:'user'|'assistant'|'system'|'tool', content:string|string[], images?:string[],
  *           fileText?:string}
  * - images: base64 data URI'ler (e.g. "data:image/jpeg;base64,...")
  * - fileText: text dosyalarının içeriği (metin dosyalarına sadece)
  */
 import { NVIDIA_WORKING_MODELS, NVIDIA_EMBED_MODELS } from './nvidia-models.js';

 const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
 const NVIDIA_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
 const NVIDIA_KEY = process.env.NVIDIA_API_KEY || '';

 /** @typedef {{role:'user'|'assistant'|'system'|'tool', content:string|string[], images?:string[], fileText?:string}} Msg */
 /** Ollama yerel model — /api/chat, NDJSON stream */
 export class OllamaProvider {
   constructor({ host = OLLAMA_HOST, model = 'mistral:latest' } = {}) {
     this.name = 'ollama';
     this.host = host;
     this.model = model;
   }

   get label() { return `Ollama · ${this.model}`; }

   async listModels() {
     try {
       const r = await fetch(`${this.host}/api/tags`);
       if (!r.ok) return [];
       const j = await r.json();
       return (j.models || []).map((m) => ({
         id: m.name,
         label: `${m.name} (${(m.size / 1e9).toFixed(1)}GB)`,
         local: true,
       }));
     } catch {
       return [];
     }
   }

   async *stream(messages, { temperature = 0.7, maxTokens = 2048, signal } = {}) {
     // Messages zaten işlenmiş formda geliyor — içerik dizisi veya string olabilir
     // NVIDIAya göndermeden önce proper formata dönüştürülüyor
     const processed = messages.map((m) => this._prepareMessage(m));
    
     const res = await fetch(`${this.host}/api/chat`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       signal,
       body: JSON.stringify({
         model: this.model,
         messages: processed,
         stream: true,
         options: { temperature, num_predict: maxTokens },
       }),
     });

     if (!res.ok || !res.body) {
       const errText = await res.text().catch(() => '');
       throw new Error(`Ollama ${res.status}: ${errText}`);
     }

     const reader = res.body.getReader();
     const decoder = new TextDecoder();
     let buf = '';
     let full = '';

     const handleLine = (line) => {
       if (!line) return null;
       try {
         const j = JSON.parse(line);
         const piece = j.message?.content ?? '';
         if (piece) {
           full += piece;
           return { delta: piece };
         }
         if (j.done) return { delta: '', done: true, raw: j };
       } catch { /* bozuk parça — atla */ }
       return null;
     };

     while (true) {
       const { done, value } = await reader.read();
       if (done) break;
       buf += decoder.decode(value, { stream: true });

       let idx;
       while ((idx = buf.indexOf('\n')) !== -1) {
         const line = buf.slice(0, idx).trim();
         buf = buf.slice(idx + 1);
         const ev = handleLine(line);
         if (ev) {
           yield ev;
           if (ev.done) return;
         }
       }
     }
     // Stream bitti — son parçada newline olmayan satır kalmış olabilir
     const tail = handleLine(buf.trim());
     if (tail) yield tail;
     if (full) yield { delta: '', done: true };
   }

   /**
    * Mesajı Ollama formatına hazırla.
    * - images: base64 data URI olarak tutulur, Ollama bunu natively destekler
    * - fileText: text içerikini content alanına ekler
    */
   _prepareMessage(m) {
     const { role, content, images, fileText } = m;
     let contentStr = String(content || '');
    
     // Eğer content bir dizi ise (çoklu içerik), Ollama bunu kabul eder
     // Ancak standart Ollama API'si sadece string content desteklediği için
     // images'ı ayrı subject olarak değil, content içinde base64 ile birlikte gönderiyoruz
     if (Array.isArray(content)) {
       // content dizisi varsa, görsellerle birleştir
       const imageUris = images || [];
       if (imageUris.length > 0) {
         // Görselleri text içine data URI formatında ekle
         const imgDescs = imageUris.map((uri) => `[Görsel: ${uri}]`).join(' ');
         contentStr = imgDescs + ' ' + contentStr;
       } else {
         contentStr = contentStr.join ? contentStr.join(' ') : String(contentStr);
       }
     }
    
     // fileText'i content'e ekle (sadece text dosyaları için)
     if (fileText && typeof fileText === 'string') {
       contentStr += '\n\n---\n\n' + fileText;
     }
    
     return { role, content: contentStr };
   }
 }

 /** NVIDIA NIM — OpenAI-uyumlu /v1/chat/completions, SSE stream */
 export class NvidiaProvider {
   constructor({ model = 'nvidia/nemotron-3-ultra-550b-a55b', key = NVIDIA_KEY, base = NVIDIA_BASE } = {}) {
     this.name = 'nvidia';
     this.model = model;
     this.key = key;
     this.base = base;
   }

   get label() { return `NVIDIA · ${this.model.split('/').pop()}`; }

   async listModels() {
     if (!this.key) return [];
     // Doğrulanmış liste — /v1/models hesaba deploy edilmemiş modelleri de
     // listelediği için kullanıcıya çalışmayan modelleri göstermek yerine
     // sabit liste dönyoruz. (audit: scripts/audit-nvidia.mjs)
     return NVIDIA_WORKING_MODELS.map((m) => ({
       id: m.id,
       label: m.label,
       tag: m.tag,
       speed: m.speed,
       local: false,
       cloud: true,
     }));
   }

   /** Embedding modelleri — ayrı endpoint (/v1/embeddings) */
   listEmbedModels() {
     if (!this.key) return [];
     return NVIDIA_EMBED_MODELS.map((m) => ({
       id: m.id,
       label: m.label,
       tag: `Embedding · ${m.dim}d`,
       local: false,
       cloud: true,
       embed: true,
     }));
   }

   /** Metin → vektör */
   async embed(texts, { model = NVIDIA_EMBED_MODELS[0].id } = {}) {
     if (!this.key) throw new Error('NVIDIA_API_KEY tanımlı değil');
     const res = await fetch(`${this.base}/embeddings`, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         Authorization: `Bearer ${this.key}`,
       },
       body: JSON.stringify({
         model,
         input: Array.isArray(texts) ? texts : [texts],
         encoding_format: 'float',
       }),
     });
     if (!res.ok) {
       throw new Error(`NVIDIA embeddings ${res.status}: ${await res.text().catch(() => '')}`);
     }
     const j = await res.json();
     return j.data.map((d) => d.embedding);
   }

   async *stream(messages, { temperature = 0.7, maxTokens = 4096, signal } = {}) {
     if (!this.key) throw new Error('NVIDIA_API_KEY tanımlı değil');

     // Messages -> OpenAI formatına dönüştür (multimodal destek)
     const openAIMessages = this._prepareMessagesForNvidia(messages);

     const res = await fetch(`${this.base}/chat/completions`, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         Authorization: `Bearer ${this.key}`,
       },
       signal,
       body: JSON.stringify({
         model: this.model,
         messages: openAIMessages,
         stream: true,
         temperature,
         max_tokens: maxTokens,
       }),
     });

     if (!res.ok || !res.body) {
       throw new Error(`NVIDIA ${res.status}: ${await res.text().catch(() => '')}`);
     }

     const reader = res.body.getReader();
     const decoder = new TextDecoder();
     let buf = '';

     const handleLine = (line) => {
       if (!line || !line.startsWith('data:')) return null;
       const data = line.slice(5).trim();
       if (data === '[DONE]') return { done: true };
       try {
         const j = JSON.parse(data);
         const ch = j.choices?.[0]?.delta ?? {};
         // Reasoning modelleri düşünmeyi reasoning_content'te döner — ayrı yay
         const out = [];
         if (ch.reasoning_content) out.push({ reasoning: ch.reasoning_content });
         if (ch.content) out.push({ delta: ch.content });
         return out;
       } catch { return null; }
     };

     while (true) {
       const { done, value } = await reader.read();
       if (done) break;
       buf += decoder.decode(value, { stream: true });

       let idx;
       while ((idx = buf.indexOf('\n')) !== -1) {
         const line = buf.slice(0, idx).trim();
         buf = buf.slice(idx + 1);
         const ev = handleLine(line);
         if (ev?.done) {
           yield { delta: '', done: true };
           return;
         }
         for (const e of ev ?? []) yield e;
       }
     }
     // Stream bitti — son parçada newline olmayan SSE satırı kalmış olabilir
     for (const e of handleLine(buf.trim()) ?? []) yield e;
     yield { delta: '', done: true };
   }

   /**
    * NVIDIA vision modeli için mesajları OpenAI multimodal formatına dönüştür.
    * - images: base64 data URI dizisi olarak gönderilir
    * - text file content'leri content alanına eklenir
    * - Her mesaj: {role, content: [{type:'text'}, {type:'image_url', image_url:{url:'data:...'}}]}
    */
   _prepareMessagesForNvidia(messages) {
     return messages.map((m) => {
       const { role, content, images, fileText } = m;
       const hasImages = Array.isArray(images) && images.length > 0;
       const hasFileText = typeof fileText === 'string' && fileText.trim().length > 0;
      
       let contentArray;
      
       if (hasImages || hasFileText) {
         // Multimodal içerik: text + image_url parts
         const parts = [];
        
         // Text content
         if (typeof content === 'string' && content.trim()) {
           parts.push({ type: 'text', text: content });
         } else if (typeof content === 'object' && content !== null) {
           // Eğer content zaten bir objeler diziysa, parçaları koru
           parts.push(...content);
         }
        
         // Image parts
         if (hasImages) {
           for (const imgUri of images) {
             // Data URI'nin zaten base64 formatında olduğundan emin ol
             parts.push({
               type: 'image_url',
               image_url: { url: imgUri.startsWith('data:') ? imgUri : `data:image/jpeg;base64,${imgUri}` },
             });
           }
         }
        
         // File text — text görseli olarak değil, text content olarak eklenir
         if (hasFileText) {
           // Eğer zaten text part varsa birleştir, yoksa ekle
           if (parts.some(p => p.type === 'text')) {
             // Mevcut text partinin sonuna ekle
             const textPart = parts.find(p => p.type === 'text');
             if (textPart) {
               textPart.text += ' ' + fileText;
             }
           } else {
             parts.push({ type: 'text', text: fileText });
           }
         }
        
         contentArray = parts;
         } else if (typeof content === 'string') {
         contentArray = [{ type: 'text', text: content }];
         } else if (Array.isArray(content)) {
         // Zaten multimodal dizi (text/image_url parçaları) → olduğu gibi geçir.
         // Düz metin dizisi ise her elemanı text parçasına çevir.
         const isMultimodal = content.some(
           (c) => c && typeof c === 'object' && (c.type === 'image_url' || c.type === 'text'),
         );
         contentArray = isMultimodal
           ? content
           : content.map((c) => ({ type: 'text', text: String(c) }));
         } else {
         contentArray = [{ type: 'text', text: '' }];
         }
      
       return { role, content: contentArray };
     });
   }
 }

 /** Provider kayıt defteri — istenen id'ye göre örnek döndürür */
 const registry = new Map();
 export function registerProvider(p) { registry.set(p.name, p); return p; }
 export function getProvider(name) {
   if (!registry.has(name)) throw new Error(`Bilinmeyen provider: ${name}`);
   return registry.get(name);
 }
 export function listProviderNames() { return [...registry.keys()]; }
 registerProvider(new OllamaProvider());
 registerProvider(new NvidiaProvider());
