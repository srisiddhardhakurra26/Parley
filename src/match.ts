// A cheap, embedding-free fit score between a job's requirements and a
// candidate's claim store. Used as a pre-filter — show the strongest matches
// first, and let a scheduled agent pick which roles are worth a parley.

import { store } from './store.ts';
import type { Job } from './types.ts';

const STOP = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'with', 'years',
  'year', 'experience', 'strong', 'plus', 'using', 'work', 'working', 'including',
]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9+# ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}
/** Shared 4+ char prefix — kubernetes~kubernete, distribut~distributed. */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 4;
}

export interface MatchResult { score: number; met: string[]; missing: string[]; }

export function scoreMatch(job: Job, candidateText: string): MatchResult {
  const ck = [...new Set(tokens(candidateText))];
  // the candidate's max stated years of experience (for "N+ years" requirements)
  const candYears = Math.max(0, ...[...candidateText.matchAll(/(\d{1,2})\+?\s*years?/gi)].map((m) => Number(m[1])));
  const met: string[] = [];
  const missing: string[] = [];
  for (const req of job.requirements) {
    const ym = req.match(/(\d{1,2})\+?\s*years?/i);
    if (ym) { (candYears >= Number(ym[1]) ? met : missing).push(req); continue; }
    const rk = tokens(req);
    if (!rk.length) continue;
    const hits = rk.filter((r) => ck.some((c) => tokenMatch(r, c))).length;
    (hits / rk.length >= 0.5 ? met : missing).push(req);
  }
  const total = met.length + missing.length;
  const score = total ? Math.round((met.length / total) * 100) : 0;
  return { score, met, missing };
}

/** The candidate's searchable text — everything their agent may assert. */
export function candidateText(agentId: string): string {
  return store.claimsBySubject(agentId).map((c) => c.statement).join('. ');
}

export function scoreJobForCandidate(job: Job, candidateAgentId: string): MatchResult {
  return scoreMatch(job, candidateText(candidateAgentId));
}
