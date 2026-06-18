// A dependency-free MCP server (JSON-RPC 2.0 over Streamable HTTP), mounted at
// /mcp/:token. The token identifies the acting user, so the same connector
// surfaces the right tools for a candidate vs an interviewer. The tools map onto
// exactly the operations the web UI uses — so an assistant can drive Parley:
// post jobs, browse & apply, manage a résumé/profile, read the chat logs, DM,
// and schedule a call. Required fields are declared in each tool's inputSchema,
// so the model asks the user for anything missing before it calls a tool.

import type { Request, Response } from 'express';
import { id, now, store } from './store.ts';
import { postJob, saveCandidateProfile, saveEmployerProfile } from './agents.ts';
import { createSource, sourceView } from './sources.ts';
import { getProvider } from './provider.ts';
import { scoreJobForCandidate } from './match.ts';
import { runParley } from './orchestrator.ts';
import { tierOf, TIER_LABEL } from './claims.ts';
import type { Conversation, Job, ParleyRequest, Role, User } from './types.ts';

const PROTOCOL = '2024-11-05';

// ── projections ──────────────────────────────────────────────────────────────

function jobSummary(j: Job) {
  return {
    id: j.id, title: j.title, company: j.company,
    salary: `${j.currency} ${j.salaryMin.toLocaleString()}–${j.salaryMax.toLocaleString()}`,
    workMode: j.remote, location: j.location, visaSponsorship: j.visaSponsorship, requirements: j.requirements,
  };
}

function convSummary(c: Conversation) {
  const job = store.getJob(c.jobId);
  const cand = store.getAgent(c.candidateAgentId);
  const unread = store.dmsByConversation(c.id).length;
  return { id: c.id, status: c.status, jobTitle: job?.title, company: job?.company, candidate: cand?.principalName, turns: c.turns.length, messages: unread, createdAt: c.createdAt };
}

function participantRole(c: Conversation, userId: string): Role | null {
  if (store.getAgent(c.candidateAgentId)?.userId === userId) return 'candidate';
  if (store.getAgent(c.employerAgentId)?.userId === userId) return 'employer';
  return null;
}

function reqRole(r: ParleyRequest, userId: string): Role | null {
  if (store.getAgent(r.candidateAgentId)?.userId === userId) return 'candidate';
  if (store.getAgent(r.employerAgentId)?.userId === userId) return 'employer';
  return null;
}

function convDetail(c: Conversation, role: Role) {
  const job = store.getJob(c.jobId);
  const r = c.reports[role];
  return {
    id: c.id, status: c.status, endedReason: c.endedReason,
    job: job && { title: job.title, company: job.company },
    transcript: c.turns.map((t) => ({ speaker: store.getAgent(t.agentId)?.displayName ?? t.role, text: t.text })),
    report: r ? { read: r.read, learned: store.getClaims(r.learnedClaimIds).map((cl) => ({ statement: cl.statement, tier: TIER_LABEL[tierOf(cl)] })) } : null,
    messages: store.dmsByConversation(c.id).map((m) => ({ from: store.getUser(m.fromUserId)?.displayName, kind: m.kind, text: m.text, callUrl: m.callUrl, at: m.createdAt })),
  };
}

function requireParticipant(userId: string, conversationId: string): { c: Conversation; role: Role } {
  const c = store.getConversation(conversationId);
  const role = c ? participantRole(c, userId) : null;
  if (!c || !role) throw new Error('Conversation not found, or you are not a participant.');
  return { c, role };
}

// ── tools ───────────────────────────────────────────────────────────────────

type Args = Record<string, any>;
interface Tool {
  name: string;
  description: string;
  roles?: Role[]; // omit = available to both
  inputSchema: Record<string, unknown>;
  run: (user: User, args: Args) => unknown | Promise<unknown>;
}

const S = (description: string) => ({ type: 'string', description });
const ARR = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const NUM = (description: string) => ({ type: 'number', description });

const TOOLS: Tool[] = [
  {
    name: 'whoami',
    description: 'Who you are on Parley. Your account can BOTH seek jobs and hire — use any tool. Tells you what is set up.',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => ({
      name: u.displayName, email: u.email, defaultRole: u.role,
      candidateProfile: u.agentId ? 'set up' : 'not set up (use update_candidate_profile / import_resume)',
      postings: store.jobsByEmployerUser(u.id).length,
      note: 'You can both apply to jobs and post jobs — every tool is available.',
    }),
  },
  {
    name: 'list_open_jobs',
    description: 'List all open job postings on Parley (id, title, company, salary band, work mode, requirements).',
    inputSchema: { type: 'object', properties: {} },
    run: () => store.listJobs().map(jobSummary),
  },
  {
    name: 'find_matching_jobs',
    description: 'List open jobs ranked by how well they fit your profile — a 0-100 match score plus which requirements you meet and miss. Use this to choose which roles are worth a parley request.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: { minScore: NUM('Only return jobs at or above this match score (0-100).') } },
    run: (u, a) => {
      if (!u.agentId) throw new Error('Set up your candidate profile first with update_candidate_profile.');
      const min = typeof a.minScore === 'number' ? a.minScore : 0;
      return store.listJobs()
        .map((j) => { const m = scoreJobForCandidate(j, u.agentId!); return { ...jobSummary(j), match: m.score, meets: m.met, missing: m.missing }; })
        .filter((j) => j.match >= min)
        .sort((x, y) => y.match - x.match);
    },
  },
  {
    name: 'find_candidates',
    description: 'List candidates ranked by fit to one of your postings — a 0-100 match score plus requirements met/missing. Use with request_parley to invite the strongest matches.',
    roles: ['employer'],
    inputSchema: { type: 'object', properties: { jobId: S('Your posting to rank candidates against.') }, required: ['jobId'] },
    run: (u, a) => {
      const job = store.getJob(a.jobId);
      if (!job || store.getAgent(job.employerAgentId)?.userId !== u.id) throw new Error('Not your posting.');
      return store.listAgents('candidate').filter((c) => c.userId && c.userId !== u.id)
        .map((c) => { const m = scoreJobForCandidate(job, c.id); return { candidateAgentId: c.id, name: c.principalName, match: m.score, meets: m.met, missing: m.missing }; })
        .sort((x, y) => y.match - x.match);
    },
  },
  {
    name: 'request_parley',
    description: 'Send a parley request — the consent step before the agents talk. As a candidate: request a job (the interviewer accepts). As an interviewer: invite a specific candidate to your posting (the candidate accepts). The recipient runs the parley by accepting. Returns the requestId.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: S('Job id (from find_matching_jobs, list_open_jobs, or your own posting).'),
        candidateAgentId: S('Interviewer only: the candidate to invite, from find_candidates.'),
        message: S('Optional note to send with the request.'),
      },
      required: ['jobId'],
    },
    run: (u, a) => {
      const job = store.getJob(a.jobId);
      if (!job) throw new Error('No job with that id.');
      const mk = (candidateAgentId: string, fromRole: Role) => {
        const existing = store.findRequest(job.id, candidateAgentId);
        if (existing) return existing;
        return store.putRequest({ id: id('req'), jobId: job.id, candidateAgentId, employerAgentId: job.employerAgentId, fromRole, status: 'pending', message: a.message, createdAt: now(), updatedAt: now() });
      };
      if (u.role === 'candidate') {
        if (!u.agentId) throw new Error('Set up your profile first with update_candidate_profile.');
        const r = mk(u.agentId, 'candidate');
        return { ok: true, requestId: r.id, status: r.status, note: 'Request sent — the interviewer accepts it to start the parley.' };
      }
      if (store.getAgent(job.employerAgentId)?.userId !== u.id) throw new Error('Not your posting.');
      const cand = a.candidateAgentId ? store.getAgent(a.candidateAgentId) : undefined;
      if (!cand || cand.role !== 'candidate') throw new Error('candidateAgentId required — see find_candidates.');
      const r = mk(cand.id, 'employer');
      return { ok: true, requestId: r.id, status: r.status, note: 'Invite sent — the candidate accepts it to start the parley.' };
    },
  },
  {
    name: 'list_requests',
    description: 'List your parley requests — ones you sent and ones sent to you, with their status. Accept the ones addressed to you with accept_request.',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => store.listRequests().filter((r) => reqRole(r, u.id)).map((r) => {
      const job = store.getJob(r.jobId);
      const myRole = reqRole(r, u.id);
      return { id: r.id, status: r.status, jobTitle: job?.title, company: job?.company, candidate: store.getAgent(r.candidateAgentId)?.principalName, fromRole: r.fromRole, sentByMe: myRole === r.fromRole, canAccept: myRole !== r.fromRole && r.status === 'pending', conversationId: r.conversationId };
    }),
  },
  {
    name: 'accept_request',
    description: 'Accept a pending parley request addressed to you — this runs the parley between the two agents (in the background, ~1-2 min). Returns a conversationId; read it later with get_conversation.',
    inputSchema: { type: 'object', properties: { requestId: S('Request id from list_requests.') }, required: ['requestId'] },
    run: (u, a) => {
      const r = store.getRequest(a.requestId);
      if (!r) throw new Error('No such request.');
      const role = reqRole(r, u.id);
      if (!role || role === r.fromRole) throw new Error('Only the recipient can accept this request.');
      if (r.status === 'declined') throw new Error('That request was declined.');
      if (r.conversationId) return { ok: true, conversationId: r.conversationId, note: 'This parley already ran.' };
      let conversationId = '';
      void runParley(r.jobId, r.candidateAgentId, { onStart: (cid) => { conversationId = cid; } })
        .then((conv) => { r.status = 'accepted'; r.conversationId = conv.id; r.updatedAt = now(); store.putRequest(r); })
        .catch((e) => console.warn('[mcp] accept parley failed:', e instanceof Error ? e.message : e));
      return { ok: true, conversationId, status: 'running', note: 'Accepted — the agents are talking now. Call get_conversation with this id in ~1-2 minutes.' };
    },
  },
  {
    name: 'decline_request',
    description: 'Decline a pending parley request addressed to you.',
    inputSchema: { type: 'object', properties: { requestId: S('Request id from list_requests.') }, required: ['requestId'] },
    run: (u, a) => {
      const r = store.getRequest(a.requestId);
      if (!r || !reqRole(r, u.id)) throw new Error('No such request of yours.');
      if (r.status === 'pending') { r.status = 'declined'; r.updatedAt = now(); store.putRequest(r); }
      return { ok: true };
    },
  },
  {
    name: 'list_my_applications',
    description: 'List the jobs you have applied to and the status of each parley.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: {} },
    run: (u) => store.conversationsForUser(u.id, 'candidate').map(convSummary),
  },
  {
    name: 'get_my_profile',
    description: 'Read your current candidate profile (years, skills, education, experience, projects, GitHub, agent instructions, withheld topics) and your uploaded documents. Call this before update_candidate_profile so you can preserve what is already there.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: {} },
    run: (u) => {
      const i = u.candidateInputs ?? {};
      const agent = u.agentId ? store.getAgent(u.agentId) : undefined;
      return {
        hasAgent: Boolean(u.agentId),
        years: i.years, skills: i.skills ?? [], education: i.education ?? '',
        experience: i.experience ?? [], projects: i.projects ?? [], github: i.github,
        instructions: agent?.instructions ?? i.instructions ?? '',
        withhold: i.disclosure?.withhold ?? [],
        documents: store.sourcesByUser(u.id).map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
      };
    },
  },
  {
    name: 'update_candidate_profile',
    description: 'Create or update your candidate profile. Pass only the fields you want to change — the rest are preserved. To ADD to a list without losing existing items, use addSkills / addProjects / addExperience (these append). Use the plain skills/projects/experience fields only to REPLACE the whole list. Rebuilds the claim store your agent speaks from.',
    roles: ['candidate'],
    inputSchema: {
      type: 'object',
      properties: {
        years: NUM('Years of professional experience.'),
        skills: ARR('REPLACE the whole skills list.'),
        addSkills: ARR('APPEND these skills to the existing list.'),
        education: S('Education, e.g. "MS Computer Science, Georgia Tech".'),
        experience: ARR('REPLACE the whole experience list.'),
        addExperience: ARR('APPEND these experience items.'),
        projects: ARR('REPLACE the whole projects list.'),
        addProjects: ARR('APPEND these projects to the existing list.'),
        github: S('GitHub handle (optional).'),
        instructions: S('How your agent should talk & what to emphasise (style/strategy only).'),
        withhold: ARR('Topics your agent must never disclose, e.g. ["current salary"].'),
      },
    },
    run: (u, a) => {
      const cur = u.candidateInputs ?? {};
      const merge = (replace?: string[], add?: string[], base?: string[]) => replace ?? (add && add.length ? [...(base ?? []), ...add] : base);
      const agent = saveCandidateProfile(u.id, {
        principalName: u.displayName,
        years: a.years ?? cur.years ?? 0,
        skills: merge(a.skills, a.addSkills, cur.skills) ?? [],
        education: a.education ?? cur.education ?? '',
        experience: merge(a.experience, a.addExperience, cur.experience) ?? [],
        projects: merge(a.projects, a.addProjects, cur.projects) ?? [],
        github: a.github ?? cur.github,
        githubVerifiedSkills: a.githubVerifiedSkills ?? cur.githubVerifiedSkills,
        instructions: a.instructions ?? cur.instructions,
        voice: cur.voice,
        avatar: cur.avatar,
        disclosure: {
          freelyShare: ['skills', 'experience', 'education', 'projects', 'availability'],
          withhold: a.withhold ?? cur.disclosure?.withhold ?? ['current salary'],
          revealOnReciprocity: ['target compensation', 'competing offers'],
        },
      });
      return { ok: true, agentId: agent.id, projects: merge(a.projects, a.addProjects, cur.projects), message: 'Candidate profile saved and claim store rebuilt.' };
    },
  },
  {
    name: 'import_resume',
    description: 'Parse a résumé (full text) and merge the extracted fields — years, skills, education, experience, projects, GitHub — into your candidate profile. Use this when the user shares a résumé and wants their profile filled or refreshed from it.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: { text: S('The full résumé text.') }, required: ['text'] },
    run: async (u, a) => {
      if (!String(a.text ?? '').trim()) throw new Error('Provide the résumé text.');
      const f = await getProvider().extractResume(a.text);
      const cur = u.candidateInputs ?? {};
      saveCandidateProfile(u.id, {
        principalName: u.displayName,
        years: f.years ?? cur.years ?? 0,
        skills: f.skills ?? cur.skills ?? [],
        education: f.education ?? cur.education ?? '',
        experience: f.experience ?? cur.experience ?? [],
        projects: f.projects ?? cur.projects ?? [],
        github: f.github ?? cur.github,
        instructions: cur.instructions,
        voice: cur.voice,
        avatar: cur.avatar,
        disclosure: cur.disclosure ?? { freelyShare: ['skills', 'experience', 'education', 'projects', 'availability'], withhold: ['current salary'], revealOnReciprocity: ['target compensation', 'competing offers'] },
      });
      return { ok: true, extracted: f, message: 'Résumé parsed and profile updated.' };
    },
  },
  {
    name: 'suggest_agent_instructions',
    description: 'Draft a short "how my agent should talk & answer" steering instruction from your profile. Returns the text — pass it to update_candidate_profile (instructions) to save it.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: {} },
    run: async (u) => {
      const i = u.candidateInputs ?? {};
      const summary = [
        i.years != null ? `Years of experience: ${i.years}` : '',
        i.skills?.length ? `Skills: ${i.skills.join(', ')}` : '',
        i.education ? `Education: ${i.education}` : '',
        i.experience?.length ? `Experience:\n- ${i.experience.join('\n- ')}` : '',
        i.projects?.length ? `Projects:\n- ${i.projects.join('\n- ')}` : '',
      ].filter(Boolean).join('\n');
      if (!summary.trim()) throw new Error('Set up your profile first (use update_candidate_profile or import_resume).');
      return { instructions: await getProvider().suggestInstructions(summary) };
    },
  },
  {
    name: 'list_documents',
    description: 'List the documents (résumé, certificates, references…) attached to your candidate agent.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: {} },
    run: (u) => store.sourcesByUser(u.id).map(sourceView),
  },
  {
    name: 'delete_document',
    description: 'Delete one of your uploaded documents by id (from list_documents).',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: { documentId: S('Document id.') }, required: ['documentId'] },
    run: (u, a) => {
      const s = store.getSource(a.documentId);
      if (!s || s.ownerUserId !== u.id) throw new Error('No such document of yours.');
      store.deleteSource(s.id);
      return { ok: true, message: 'Document deleted.' };
    },
  },
  {
    name: 'add_document',
    description: 'Attach a document (résumé, certificate, reference…) to your candidate agent. Its text is chunked and becomes document-backed claims your agent can quote in a parley, with a link in the report.',
    roles: ['candidate'],
    inputSchema: {
      type: 'object',
      properties: {
        title: S('A label, e.g. "Maya\'s résumé".'),
        text: S('The full text of the document.'),
        kind: { type: 'string', enum: ['resume', 'certificate', 'portfolio', 'reference', 'other'], description: 'Document type (default resume).' },
      },
      required: ['text'],
    },
    run: (u, a) => {
      if (!String(a.text ?? '').trim()) throw new Error('Provide the document text.');
      const src = createSource(u.id, u.agentId, { title: a.title, kind: a.kind ?? 'resume', text: a.text });
      return { ok: true, sourceId: src.id, chunks: src.chunks.length, message: 'Document added and attached to your agent.' };
    },
  },
  {
    name: 'create_job_posting',
    description: 'Post a new job as the interviewer. Ask the user for any required field you do not have before calling this.',
    roles: ['employer'],
    inputSchema: {
      type: 'object',
      properties: {
        title: S('Job title, e.g. "Staff Backend Engineer".'),
        salaryMin: NUM('Minimum salary (number).'),
        salaryMax: NUM('Maximum salary (number).'),
        location: S('Location, e.g. "New York".'),
        requirements: ARR('Requirements, e.g. ["Go","distributed systems","7+ years"].'),
        visaSponsorship: { type: 'boolean', description: 'Whether visa sponsorship is available (default false).' },
        remote: { type: 'string', enum: ['remote', 'hybrid', 'onsite'], description: 'Work mode (default hybrid).' },
        notes: ARR('Extra facts your recruiting agent can answer from (stack, team size…).'),
        instructions: S('How your recruiting agent should steer the conversation.'),
        company: S('Company name (defaults to your saved company).'),
      },
      required: ['title', 'salaryMin', 'salaryMax', 'location', 'requirements'],
    },
    run: (u, a) => {
      const { job } = postJob(u.id, {
        title: a.title, salaryMin: a.salaryMin, salaryMax: a.salaryMax,
        visaSponsorship: a.visaSponsorship ?? false, remote: a.remote ?? 'hybrid', location: a.location,
        requirements: a.requirements ?? [], notes: a.notes, instructions: a.instructions, company: a.company,
      });
      return { ok: true, jobId: job.id, title: job.title, message: 'Job posted and live for candidates.' };
    },
  },
  {
    name: 'get_my_recruiting_agent',
    description: 'Read your recruiting-agent defaults: company, persona/tone, and steering instructions (applied to every posting).',
    roles: ['employer'],
    inputSchema: { type: 'object', properties: {} },
    run: (u) => { const p = u.profile ?? {}; return { company: p.company ?? '', persona: p.persona ?? '', instructions: p.instructions ?? '' }; },
  },
  {
    name: 'update_recruiting_agent',
    description: 'Update your recruiting-agent defaults. Pass only the fields you want to change. Applies to future postings.',
    roles: ['employer'],
    inputSchema: {
      type: 'object',
      properties: {
        company: S('Company name.'),
        persona: S('Tone/persona — style only, never changes facts.'),
        instructions: S('How your recruiting agent should steer conversations (what to probe, how warm, etc.).'),
      },
    },
    run: (u, a) => {
      const patch: { company?: string; persona?: string; instructions?: string } = {};
      if (a.company != null) patch.company = String(a.company);
      if (a.persona != null) patch.persona = String(a.persona);
      if (a.instructions != null) patch.instructions = String(a.instructions);
      saveEmployerProfile(u.id, patch);
      return { ok: true, message: 'Recruiting-agent defaults updated. Applies to new postings.' };
    },
  },
  {
    name: 'list_my_postings',
    description: 'List the jobs you have posted.',
    roles: ['employer'],
    inputSchema: { type: 'object', properties: {} },
    run: (u) => store.jobsByEmployerUser(u.id).map(jobSummary),
  },
  {
    name: 'list_applicants',
    description: 'List candidates who have applied to your postings and the status of each parley.',
    roles: ['employer'],
    inputSchema: { type: 'object', properties: {} },
    run: (u) => store.conversationsForUser(u.id, 'employer').map(convSummary),
  },
  {
    name: 'get_conversation',
    description: 'Read the full log of one parley: the transcript, your agent\'s report (claims + read), and any direct messages.',
    inputSchema: { type: 'object', properties: { conversationId: S('Conversation id from list_my_applications / list_applicants.') }, required: ['conversationId'] },
    run: (u, a) => { const { c, role } = requireParticipant(u.id, a.conversationId); return convDetail(c, role); },
  },
  {
    name: 'send_message',
    description: 'Send a direct message to the human on the other side of a parley.',
    inputSchema: { type: 'object', properties: { conversationId: S('Conversation id.'), text: S('Message text.') }, required: ['conversationId', 'text'] },
    run: (u, a) => {
      const { c, role } = requireParticipant(u.id, a.conversationId);
      if (!String(a.text ?? '').trim()) throw new Error('Message text required.');
      if (store.dmsByConversation(c.id).length === 0) {
        store.addDM({ id: id('dm'), conversationId: c.id, fromUserId: u.id, fromRole: role, kind: 'system', text: `${u.displayName} started a direct conversation.`, createdAt: now() });
      }
      store.addDM({ id: id('dm'), conversationId: c.id, fromUserId: u.id, fromRole: role, kind: 'message', text: a.text, createdAt: now() });
      return { ok: true };
    },
  },
  {
    name: 'schedule_call',
    description: 'Send the other side a link to hop on a live video call.',
    inputSchema: { type: 'object', properties: { conversationId: S('Conversation id.') }, required: ['conversationId'] },
    run: (u, a) => {
      const { c, role } = requireParticipant(u.id, a.conversationId);
      const callUrl = `https://meet.jit.si/Parley-${c.id}`;
      store.addDM({ id: id('dm'), conversationId: c.id, fromUserId: u.id, fromRole: role, kind: 'call', text: `${u.displayName} sent a link to hop on a live video call.`, callUrl, callTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(), createdAt: now() });
      return { ok: true, callUrl };
    },
  },
];

// Every account can both seek and hire, so all tools are available. (The `roles`
// hint is kept only to document a tool's typical side; it no longer gates.)
function toolsFor(_user: User): Tool[] {
  return TOOLS;
}

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────────

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(user: User, msg: any): Promise<unknown> {
  const { id: rid, method, params } = msg;
  if (method === 'initialize') {
    return ok(rid, {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'parley', version: '0.1.0' },
      instructions: `You are connected to Parley as ${user.displayName}. This account can BOTH seek jobs and hire — every tool is available. ` +
        'Seeking: find/apply to jobs, manage the candidate profile & résumé, practice, read logs. ' +
        'Hiring: post jobs (create_job_posting), browse candidates (find_candidates), invite them (request_parley), review applicants. ' +
        'Either side can message and schedule calls. Before calling a tool, ask the user for any required field you are missing.',
    });
  }
  if (method === 'tools/list') {
    return ok(rid, { tools: toolsFor(user).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = toolsFor(user).find((t) => t.name === params?.name);
    if (!tool) return rpcErr(rid, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.run(user, params?.arguments ?? {});
      return ok(rid, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return ok(rid, { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    }
  }
  if (method === 'ping') return ok(rid, {});
  return rpcErr(rid, -32601, `method not found: ${method}`);
}

/** Express handler for /mcp/:token (POST = JSON-RPC; GET/DELETE = not offered). */
export async function handleMcp(req: Request, res: Response): Promise<void> {
  const user = store.getUserByConnectorToken(req.params.token ?? '');
  if (!user) { res.status(401).json(rpcErr(null, -32001, 'invalid connector token')); return; }
  if (req.method !== 'POST') { res.status(405).json(rpcErr(null, -32000, 'use POST (Streamable HTTP)')); return; }

  const msg = Array.isArray(req.body) ? req.body[0] : req.body;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    res.status(400).json(rpcErr(null, -32600, 'invalid JSON-RPC request')); return;
  }
  // Notifications (no id) get acknowledged with 202 and no body.
  if (msg.id === undefined || msg.id === null) { res.status(202).end(); return; }

  const payload = await dispatch(user, msg);

  // Content negotiation: SSE only if the client won't take plain JSON.
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
  } else {
    res.json(payload);
  }
}
