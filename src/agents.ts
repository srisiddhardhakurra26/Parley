// Builds agents and their claim stores from human setup. This is where the
// "assertion vs verification" split first shows up: setup produces self-stated
// assertions, and the (simulated) GitHub connector attaches corroboration as a
// separate event — raising tier without the model ever being involved.

import { attachVerification, makeClaim } from './claims.ts';
import { id, now, store } from './store.ts';
import type { Agent, Claim, DisclosurePolicy, Job, Role } from './types.ts';
import type { User, UserProfile } from './types.ts';
import type { Fact } from './provider.ts';
import { tierOf, TIER_LABEL } from './claims.ts';

export const DEFAULT_AGENDA: Record<Role, string[]> = {
  candidate: [
    'What is the salary range for this role',
    'Is visa sponsorship available',
    'What is the day-to-day tech stack',
    'How large is the engineering team',
    'Is the position remote or onsite',
  ],
  employer: [
    'How many years of experience does the candidate have',
    "What are the candidate's strongest skills",
    "What is the candidate's education background",
    "What is the candidate's notice period",
  ],
};

const DEFAULT_DISCLOSURE: Record<Role, DisclosurePolicy> = {
  candidate: {
    freelyShare: ['skills', 'experience', 'education', 'projects', 'availability'],
    withhold: ['current salary'],
    revealOnReciprocity: ['target compensation', 'competing offers'],
  },
  employer: {
    freelyShare: ['company', 'role', 'requirements', 'visa', 'remote', 'salary range'],
    withhold: [],
    revealOnReciprocity: [],
  },
};

export interface CandidateSetup {
  principalName: string;
  displayName?: string;
  persona?: string;
  voice?: Agent['voice'];
  avatar?: Agent['avatar'];
  years: number;
  skills: string[];
  education: string;
  experience: string[];
  projects: string[];
  github?: string;
  githubVerifiedSkills?: string[]; // what the connector "found" — simulated
  disclosure?: DisclosurePolicy;
  agenda?: string[];
}

export interface EmployerSetup {
  principalName: string;
  displayName?: string;
  persona?: string;
  voice?: Agent['voice'];
  avatar?: Agent['avatar'];
  company: string;
  title: string;
  salaryMin: number;
  salaryMax: number;
  currency?: string;
  visaSponsorship: boolean;
  remote: Job['remote'];
  location: string;
  requirements: string[];
  notes?: string[]; // extra company facts the agent can answer from (stack, team, why-open…)
  disclosure?: DisclosurePolicy;
  agenda?: string[];
}

function baseAgent(role: Role, s: { principalName: string; displayName?: string; persona?: string; voice?: Agent['voice']; avatar?: Agent['avatar']; disclosure?: DisclosurePolicy; agenda?: string[] }, userId?: string): Agent {
  return {
    id: id('agt'),
    userId,
    role,
    principalName: s.principalName,
    displayName: s.displayName ?? `${s.principalName}'s agent`,
    avatar: s.avatar ?? (role === 'candidate' ? { emoji: '🧑‍💻', color: '#6c8cff' } : { emoji: '🏢', color: '#27c498' }),
    voice: s.voice ?? (role === 'candidate' ? { name: 'candidate', rate: 1, pitch: 1 } : { name: 'employer', rate: 0.95, pitch: 0.85 }),
    persona: s.persona ?? (role === 'candidate' ? 'warm and straightforward' : 'professional and friendly'),
    disclosure: s.disclosure ?? DEFAULT_DISCLOSURE[role],
    agenda: s.agenda ?? DEFAULT_AGENDA[role],
    createdAt: now(),
  };
}

export function createCandidate(s: CandidateSetup, userId?: string): { agent: Agent; claims: Claim[] } {
  const agent = baseAgent('candidate', s, userId);
  store.putAgent(agent);

  const claims: Claim[] = [];
  claims.push(makeClaim({ subjectId: agent.id, statement: `${s.years} years of professional experience`, source: 'self_stated' }));
  claims.push(makeClaim({ subjectId: agent.id, statement: `Education: ${s.education}`, source: 'self_stated' }));
  for (const skill of s.skills) {
    claims.push(makeClaim({ subjectId: agent.id, statement: `Skilled in ${skill}`, source: 'self_stated' }));
  }
  for (const e of s.experience) {
    claims.push(makeClaim({ subjectId: agent.id, statement: e, source: 'self_stated' }));
  }
  for (const p of s.projects) {
    claims.push(makeClaim({ subjectId: agent.id, statement: `Project: ${p}`, source: 'self_stated' }));
  }

  // Simulated GitHub connector — a third-party assertion plus corroboration of
  // matching skills. In a real build this calls the GitHub API.
  if (s.github) {
    const found = s.githubVerifiedSkills ?? [];
    claims.push(
      makeClaim({
        subjectId: agent.id,
        statement: `GitHub @${s.github}: public repos show sustained activity${found.length ? ` in ${found.join(', ')}` : ''}`,
        source: 'third_party',
        evidence: [{ kind: 'url', ref: `https://github.com/${s.github}`, label: `github.com/${s.github}` }],
      }),
    );
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i]!;
      if (c.source === 'self_stated' && found.some((sk) => c.statement.toLowerCase().includes(sk.toLowerCase()))) {
        claims[i] = attachVerification(
          c,
          'corroborated',
          [{ kind: 'connector', ref: `github:${s.github}`, label: 'GitHub connector' }],
          'commit history consistent with this skill',
        );
      }
    }
  }

  store.putClaims(claims);
  return { agent, claims };
}

export function createEmployer(s: EmployerSetup, userId?: string): { agent: Agent; job: Job; claims: Claim[] } {
  const agent = baseAgent('employer', s, userId);
  store.putAgent(agent);

  const job: Job = {
    id: id('job'),
    employerAgentId: agent.id,
    company: s.company,
    title: s.title,
    salaryMin: s.salaryMin,
    salaryMax: s.salaryMax,
    currency: s.currency ?? 'USD',
    visaSponsorship: s.visaSponsorship,
    remote: s.remote,
    location: s.location,
    requirements: s.requirements,
    createdAt: now(),
  };
  store.putJob(job);

  const claims: Claim[] = [];
  claims.push(makeClaim({ subjectId: agent.id, statement: `${s.company} is hiring a ${s.title}`, source: 'self_stated' }));
  // Comp band reads as document-backed (from a comp policy) — a higher tier the
  // candidate side can see at a glance.
  claims.push(
    makeClaim({
      subjectId: agent.id,
      statement: `Salary band is ${job.currency} ${s.salaryMin.toLocaleString()}–${s.salaryMax.toLocaleString()}`,
      source: 'document',
      evidence: [{ kind: 'document', ref: 'comp-band-policy#row', label: 'comp band policy' }],
    }),
  );
  claims.push(makeClaim({ subjectId: agent.id, statement: `Visa sponsorship is ${s.visaSponsorship ? 'available' : 'not available'} for this role`, source: 'self_stated' }));
  claims.push(makeClaim({ subjectId: agent.id, statement: `Work mode is ${s.remote}: ${s.remote === 'remote' ? 'fully remote' : s.remote === 'onsite' ? `onsite in ${s.location}` : `partly remote, partly onsite in ${s.location}`}`, source: 'self_stated' }));
  for (const r of s.requirements) {
    claims.push(makeClaim({ subjectId: agent.id, statement: `Requires ${r}`, source: 'self_stated' }));
  }
  for (const n of s.notes ?? []) {
    claims.push(makeClaim({ subjectId: agent.id, statement: n, source: 'self_stated' }));
  }

  store.putClaims(claims);
  return { agent, job, claims };
}

// ── account-aware operations ─────────────────────────────────────────────────

/** Create or replace a candidate user's single standing agent + claim store. */
export function saveCandidateProfile(userId: string, s: CandidateSetup): Agent {
  const user = store.getUser(userId);
  if (!user || user.role !== 'candidate') throw new Error('not a candidate account');
  if (user.agentId) store.deleteAgent(user.agentId); // re-save replaces the old store

  const setup: CandidateSetup = {
    ...s,
    principalName: user.displayName,
    displayName: `${user.displayName}'s agent`,
  };
  const { agent } = createCandidate(setup, userId);
  user.agentId = agent.id;
  store.putUser(user);
  return agent;
}

/** Save an employer user's recruiting-agent defaults (applied to each posting). */
export function saveEmployerProfile(userId: string, profile: UserProfile): User {
  const user = store.getUser(userId);
  if (!user || user.role !== 'employer') throw new Error('not an employer account');
  user.profile = { ...user.profile, ...profile };
  return store.putUser(user);
}

export interface JobSetup {
  title: string;
  salaryMin: number;
  salaryMax: number;
  currency?: string;
  visaSponsorship: boolean;
  remote: Job['remote'];
  location: string;
  requirements: string[];
  notes?: string[];
  company?: string; // optional per-posting override of the profile company
}

/** Post a job: spins up a recruiting agent for it from the employer's defaults. */
export function postJob(userId: string, j: JobSetup): { agent: Agent; job: Job } {
  const user = store.getUser(userId);
  if (!user || user.role !== 'employer') throw new Error('not an employer account');
  const p: UserProfile = user.profile ?? {};
  const company = j.company || p.company || user.displayName;

  const setup: EmployerSetup = {
    principalName: user.displayName,
    displayName: `${company} recruiting agent`,
    persona: p.persona,
    voice: p.voice,
    avatar: p.avatar,
    disclosure: p.disclosure,
    company,
    title: j.title,
    salaryMin: j.salaryMin,
    salaryMax: j.salaryMax,
    currency: j.currency,
    visaSponsorship: j.visaSponsorship,
    remote: j.remote,
    location: j.location,
    requirements: j.requirements,
    notes: j.notes,
  };
  const { agent, job } = createEmployer(setup, userId);
  return { agent, job };
}

/** The readable store an agent speaks from — its own claims, projected to facts. */
export function factsFor(agentId: string): Fact[] {
  return store
    .claimsBySubject(agentId)
    .map((c) => ({ id: c.id, statement: c.statement, tier: TIER_LABEL[tierOf(c)] }));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
