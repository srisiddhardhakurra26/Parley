// A tiny JSON-file-backed repository. Deliberately behind a narrow interface so
// it can be swapped for SQLite/Postgres later without touching callers. For a
// prototype demonstrating the architecture, a single JSON file is plenty and
// has zero native-module / build risk.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Claim, Conversation, Job, User } from './types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'db.json');

interface DB {
  users: Record<string, User>;
  agents: Record<string, Agent>;
  jobs: Record<string, Job>;
  claims: Record<string, Claim>;
  conversations: Record<string, Conversation>;
}

const empty: DB = { users: {}, agents: {}, jobs: {}, claims: {}, conversations: {} };

function load(): DB {
  if (!existsSync(DB_PATH)) return structuredClone(empty);
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, 'utf8')) as Partial<DB>;
    return { ...structuredClone(empty), ...parsed };
  } catch {
    return structuredClone(empty);
  }
}

let db = load();

function persist(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't corrupt the db.
  const tmp = `${DB_PATH}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

export const id = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = (): string => new Date().toISOString();

export const store = {
  // users
  putUser(u: User): User { db.users[u.id] = u; persist(); return u; },
  getUser(userId: string): User | undefined { return db.users[userId]; },
  getUserByEmail(email: string): User | undefined {
    const e = email.trim().toLowerCase();
    return Object.values(db.users).find((u) => u.email === e);
  },
  getUserByGoogleSub(sub: string): User | undefined {
    return Object.values(db.users).find((u) => u.googleSub === sub);
  },

  // agents
  putAgent(a: Agent): Agent { db.agents[a.id] = a; persist(); return a; },
  getAgent(agentId: string): Agent | undefined { return db.agents[agentId]; },
  listAgents(role?: Agent['role']): Agent[] {
    const all = Object.values(db.agents);
    return role ? all.filter((a) => a.role === role) : all;
  },
  deleteAgent(agentId: string): void {
    delete db.agents[agentId];
    for (const c of Object.values(db.claims)) if (c.subjectId === agentId) delete db.claims[c.id];
    persist();
  },

  // jobs
  putJob(j: Job): Job { db.jobs[j.id] = j; persist(); return j; },
  getJob(jobId: string): Job | undefined { return db.jobs[jobId]; },
  listJobs(): Job[] { return Object.values(db.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
  jobsByEmployerUser(userId: string): Job[] {
    return store.listJobs().filter((j) => db.agents[j.employerAgentId]?.userId === userId);
  },

  // claims
  putClaim(c: Claim): Claim { db.claims[c.id] = c; persist(); return c; },
  putClaims(cs: Claim[]): Claim[] { for (const c of cs) db.claims[c.id] = c; persist(); return cs; },
  getClaim(claimId: string): Claim | undefined { return db.claims[claimId]; },
  claimsBySubject(subjectId: string): Claim[] {
    return Object.values(db.claims).filter((c) => c.subjectId === subjectId);
  },
  getClaims(ids: string[]): Claim[] {
    return ids.map((i) => db.claims[i]).filter((c): c is Claim => Boolean(c));
  },

  // conversations
  putConversation(c: Conversation): Conversation { db.conversations[c.id] = c; persist(); return c; },
  getConversation(convId: string): Conversation | undefined { return db.conversations[convId]; },
  listConversations(): Conversation[] {
    return Object.values(db.conversations).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  /** Parleys a user participates in — as candidate (initiator) or employer (job owner). */
  conversationsForUser(userId: string, role: Agent['role']): Conversation[] {
    return store.listConversations().filter((c) => {
      if (role === 'candidate') return db.agents[c.candidateAgentId]?.userId === userId;
      return db.agents[c.employerAgentId]?.userId === userId;
    });
  },

  // test/dev helpers
  reset(): void { db = structuredClone(empty); persist(); },
};
