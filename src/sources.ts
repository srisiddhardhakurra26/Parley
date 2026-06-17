// Uploaded documents (résumé, certificates, company docs …). A source is owned
// by a user; its text is chunked and minted into document-backed Claims on the
// user's current agent. Those claims flow through the normal pipeline — the
// agent can retrieve and cite them in the parley, and they surface, with a link
// back to the file, in the report. Re-minting onto a fresh agent (on rebuild /
// new posting) keeps the documents attached across the agent's lifecycle.

import { makeClaim } from './claims.ts';
import { id, now, store } from './store.ts';
import type { Claim, Source, SourceKind } from './types.ts';

const MAX_CHUNKS = 8;
const MAX_CHUNK_CHARS = 600;

/** Split document text into retrievable, roughly paragraph-sized chunks. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\s*\n+/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    if (p.length > MAX_CHUNK_CHARS) {
      flush();
      for (let i = 0; i < p.length; i += MAX_CHUNK_CHARS) chunks.push(p.slice(i, i + MAX_CHUNK_CHARS).trim());
      continue;
    }
    if ((buf + ' ' + p).length > MAX_CHUNK_CHARS) flush();
    buf = buf ? `${buf}\n${p}` : p;
  }
  flush();
  return chunks.slice(0, MAX_CHUNKS);
}

export interface SourceInput {
  title?: string;
  kind?: SourceKind;
  text?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
}

const KIND_LABEL: Record<SourceKind, string> = {
  resume: 'Résumé', certificate: 'Certificate', portfolio: 'Portfolio',
  reference: 'Reference', other: 'Document',
};

/** Mint document-backed claims from a source's chunks onto one agent. */
function mintOnto(source: Source, agentId: string): Claim[] {
  const claims = source.chunks.map((chunk) =>
    makeClaim({
      subjectId: agentId,
      statement: chunk,
      source: 'document',
      evidence: [{ kind: 'document', ref: `source:${source.id}`, label: source.title }],
    }),
  );
  store.putClaims(claims);
  source.claimIds = source.claimIds.filter((cid) => store.getClaim(cid)); // drop ids killed by a rebuild
  source.claimIds.push(...claims.map((c) => c.id));
  return claims;
}

/** Create a source from an upload and mint it onto the user's current agent (if any). */
export function createSource(ownerUserId: string, agentId: string | undefined, input: SourceInput): Source {
  const text = (input.text ?? '').trim();
  const kind: SourceKind = input.kind ?? 'other';
  const title = (input.title ?? '').trim() || input.fileName || KIND_LABEL[kind];

  const source: Source = {
    id: id('src'),
    ownerUserId,
    title,
    kind,
    fileName: input.fileName,
    mimeType: input.mimeType,
    dataBase64: input.dataBase64,
    text,
    chunks: chunkText(text),
    claimIds: [],
    createdAt: now(),
  };
  if (agentId && source.chunks.length) mintOnto(source, agentId);
  return store.putSource(source);
}

/** Re-mint every source a user owns onto a (freshly created) agent. */
export function mintUserSourcesOntoAgent(userId: string, agentId: string): void {
  for (const s of store.sourcesByUser(userId)) {
    if (!s.chunks.length) continue;
    mintOnto(s, agentId);
    store.putSource(s);
  }
}

/** Mint one source onto an agent (e.g. a new employer upload onto each posting). */
export function mintSourceOntoAgent(sourceId: string, agentId: string): void {
  const s = store.getSource(sourceId);
  if (!s || !s.chunks.length) return;
  mintOnto(s, agentId);
  store.putSource(s);
}

export function sourceView(s: Source) {
  return {
    id: s.id, title: s.title, kind: s.kind, fileName: s.fileName, mimeType: s.mimeType,
    hasFile: Boolean(s.dataBase64), chars: s.text.length, chunks: s.chunks.length, createdAt: s.createdAt,
  };
}
