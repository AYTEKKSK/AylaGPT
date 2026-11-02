/**
 * NVIDIA NIM — çalışan model listesi.
 *
 * `GET /v1/models` 85 model listeler ama hesabına deploy edilmemiş olanlar
 * chat isteğinde "Function '<uuid>': Not found for account" döner.
 *
 * 2026-11-01 denetimi (scripts/audit-nvidia.mjs, 85 modelin tamamı probe edildi):
 *   ✅ 18 hızlı çalışıyor    → listeye girdi
 *   ⏳ 18 yavaş/kuyrukta      → çalışıyor, 5+ dk sürüyor → ayrı bölüm
 *   ⬜ 49 deploy edilmemiş    → erişilemez
 *
 * Yeni model denemek için: scripts/audit-nvidia.mjs
 */

export const NVIDIA_WORKING_MODELS = [
  // ── Hızlı / anında yanıt ──
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra 550B', tag: 'En güçlü', speed: 'hızlı' },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning 30B', tag: 'Hızlı', speed: 'hızlı' },
  { id: 'nvidia/nemotron-3.5-bolt-e4b', label: 'Nemotron 3.5 Bolt 4B', tag: 'En hızlı', speed: 'hızlı' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni 30B', tag: 'Akıl yürütme', speed: 'hızlı' },
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', label: 'Nemotron 3.5 Super VL 120B', tag: 'Görsel', speed: 'hızlı' },
  { id: 'minimaxai/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', tag: 'Hızlı', speed: 'hızlı' },
  { id: 'stepfun-ai/step-5-preview', label: 'Step 5 Preview', tag: 'Genel', speed: 'hızlı' },
  { id: 'mistralai/mistral-large-4-1t-a52b', label: 'Mistral Large 4 1T A52B', tag: 'Büyük', speed: 'hızlı' },
  { id: 'meta/muse-glimmer-30b', label: 'Muse Glimmer 30B', tag: 'Multimodal', speed: 'hızlı' },
  { id: 'poolside/laguna-xs-2.1', label: 'Laguna XS 2.1', tag: 'Kod', speed: 'hızlı' },
  { id: 'google/diffusiongemma-26b-a4b-it', label: 'DiffusionGemma 26B', tag: 'Diffusion', speed: 'hızlı' },

  // ── Çalışıyor ama kuyrukta (5-6 dk) ──
  { id: 'deepseek-ai/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', tag: 'Çok dilli · yavaş', speed: 'yavaş' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', tag: 'Çok dilli · yavaş', speed: 'yavaş' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', tag: 'Açık ağırlık · yavaş', speed: 'yavaş' },
  { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B', tag: 'Genel · yavaş', speed: 'yavaş' },
  { id: 'meta/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision', tag: 'Görsel · yavaş', speed: 'yavaş' },

  // ── Uzman / yardımcı ──
  { id: 'nvidia/riva-translate-4b-instruct-v2', label: 'Riva Translate 4B v2', tag: 'Çeviri', speed: 'hızlı' },
  { id: 'nvidia/llama-3.1-nemotron-safety-guard-8b-v3', label: 'Nemotron Safety Guard 8B', tag: 'Güvenlik', speed: 'hızlı' },
  { id: 'meta/llama-guard-4-12b', label: 'Llama Guard 4 12B', tag: 'Güvenlik', speed: 'hızlı' },
  { id: 'nvidia/ising-calibration-1.5-31b', label: 'Ising Calibration 31B', tag: 'Uzman', speed: 'hızlı' },
];

/** Embedding modelleri — ayrı endpoint (/v1/embeddings) */
export const NVIDIA_EMBED_MODELS = [
  { id: 'nvidia/nemotron-3-embed-1b', label: 'Nemotron 3 Embed 1B', dim: 2048 },
];

/**
 * Çalışmayan modeller (deploy edilmemiş) — teşhis için.
 * Bu listedeki bir model seçilirse API "Function not found" döner.
 */
export const NVIDIA_NOT_DEPLOYED = [
  '01-ai/yi-large', 'adept/fuyu-8b', 'ai21labs/jamba-1.5-large-instruct',
  'aisingapore/sea-lion-7b-instruct', 'databricks/dbrx-instruct',
  'deepseek-ai/deepseek-coder-6.7b-instruct', 'google/codegemma-1.1-7b',
  'google/codegemma-7b', 'google/deplot', 'google/gemma-2b', 'google/gemma-3-12b-it',
  'google/gemma-3-4b-it', 'google/recurrentgemma-2b', 'ibm/granite-3.0-3b-a800m-instruct',
  'ibm/granite-3.0-8b-instruct', 'ibm/granite-34b-code-instruct', 'ibm/granite-8b-code-instruct',
  'meta/codellama-70b', 'meta/llama-3.2-11b-vision-instruct', 'meta/llama2-70b',
  'microsoft/kosmos-2', 'microsoft/phi-3-vision-128k-instruct', 'microsoft/phi-3.5-moe-instruct',
  'mistralai/codestral-22b-instruct-v0.1', 'mistralai/mistral-7b-instruct-v0.3',
  'mistralai/mistral-large', 'mistralai/mistral-large-2-instruct', 'mistralai/mixtral-8x22b-v0.1',
  'moonshotai/kimi-k2.6', 'nv-mistralai/mistral-nemo-12b-instruct',
  'nvidia/cosmos-reason2-8b', 'nvidia/llama-3.1-nemotron-51b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'nvidia/llama3-chatqa-1.5-70b', 'nvidia/mistral-nemo-minitron-8b-8k-instruct',
  'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3.5-content-safety',
  'nvidia/nemotron-4-340b-instruct', 'nvidia/nemotron-4-340b-reward',
  'nvidia/nemotron-nano-3-30b-a3b', 'nvidia/neva-22b', 'nvidia/riva-translate-4b-instruct',
  'nvidia/vila', 'writer/palmyra-creative-122b', 'writer/palmyra-fin-70b-32k',
  'writer/palmyra-med-70b', 'writer/palmyra-med-70b-32k', 'zyphra/zamba2-7b-instruct',
];
