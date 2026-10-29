/**
 * embed.js — Lazy, cached text embedding for the hybrid search pipeline.
 *
 * Uses all-MiniLM-L6-v2 (384-dim) via @xenova/transformers. The pipeline is
 * loaded ONCE on first use and cached; models are cached under
 * ~/.claude/mem/embeddings/ by the transformers cache layer.
 *
 * Why ONNX: it runs locally, no API key, no network per embedding, and the
 * 384-dim vectors are small enough for in-memory cosine similarity over a
 * few thousand memories.
 *
 * Env:
 *   MEM_EMBED_MODEL    override the HF model id (default: all-MiniLM-L6-v2)
 *   MEM_EMBED_DIR      cache dir for downloaded models (default: ~/.claude/mem/embeddings)
 */

import { pipeline, env } from '@xenova/transformers';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODEL = process.env.MEM_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIR = process.env.MEM_EMBED_DIR || `${homedir()}/.claude/mem/embeddings`;
const CACHE_FILE = join(EMBED_DIR, 'embeddings.jsonl'); // id -> {vector, text_hash}

mkdirSync(EMBED_DIR, { recursive: true });

// Transformers downloads to its own cache; point it at our dir so models
// survive and are reused across sessions.
env.cacheDir = EMBED_DIR;
// Never phone home for a model we already have locally.
env.allowRemoteModels = false;

let embedder = null;
let loading = null;

async function getEmbedder() {
  if (embedder) return embedder;
  if (loading) return loading;
  loading = pipeline('feature-extraction', MODEL, { quantized: true });
  embedder = await loading;
  loading = null;
  return embedder;
}

/**
 * Embed a single text string -> Float32Array(384).
 * The model returns a 1xN matrix; we mean-pool across the token dimension.
 */
export async function embed(text) {
  if (!text || !text.trim()) return null;
  const fn = await getEmbedder();
  const out = await fn(text.trim(), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

/**
 * Cosine similarity between two equal-length vectors. Both inputs are
 * already L2-normalized, so this is just a dot product.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// --- Persistent embedding cache (JSONL: id -> {v:[...], h:<hash of text>}) ---

function textHash(text) {
  // FNV-1a 32-bit — fast, no crypto import needed, good enough for cache keys.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function loadCache() {
  const map = new Map();
  if (!existsSync(CACHE_FILE)) return map;
  const lines = readFileSync(CACHE_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const { id, v, h } = JSON.parse(line);
      if (id && v) map.set(id, { v, h });
    } catch { /* corrupt line — skip */ }
  }
  return map;
}

export function saveCacheEntry(id, vector, text) {
  const line = JSON.stringify({ id, v: vector, h: textHash(text) }) + '\n';
  // Append-only; compaction is a future concern.
  writeFileSync(CACHE_FILE, line, { flag: 'a' });
}

/**
 * Get a cached embedding for (memoryId, text). Returns the vector or null
 * if it needs computing (or the text changed).
 */
export function getCached(id, text) {
  const map = loadCache();
  const entry = map.get(id);
  if (!entry || entry.h !== textHash(text)) return null;
  return entry.v;
}