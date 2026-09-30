import Database from 'better-sqlite3';

function cos(a: number[], b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${process.env.OLLAMA_URL ?? 'http://localhost:11434'}/api/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-embedding:8b', input: text }),
  });
  const j = await r.json() as { embeddings: number[][] };
  return j.embeddings[0];
}

const db = new Database('data/memory.db', { readonly: true });
const rows = db.prepare("SELECT text, embedding FROM memory_chunks WHERE source = 'webindex'").all() as Array<{ text: string; embedding: Buffer }>;
console.log('webindex chunks:', rows.length);

const queries = [
  ['OFF  ', 'NYSE stocks volatility index above 15'],
  ['OFF  ', 'top gaining US stocks August 2026'],
  ['OFF  ', 'best pasta recipes for dinner'],
  ['ON   ', 'qwen model release'],
  ['ON   ', 'NVIDIA AI compute announcement'],
];
for (const [tag, q] of queries) {
  const qe = await embed(q);
  const scores = rows.map(r => cos(qe, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4))).sort((a, b) => b - a);
  console.log(tag, JSON.stringify(q.slice(0, 40)), 'top4:', scores.slice(0, 4).map(s => s.toFixed(3)).join(' '), 'p50:', scores[Math.floor(scores.length / 2)]?.toFixed(3));
}
db.close();
