// A dependency-free MCP server (JSON-RPC 2.0 over Streamable HTTP), mounted at
// /mcp/:token. The token identifies the acting user, so the same connector
// surfaces the right tools for a candidate vs an interviewer. The tools map onto
// exactly the operations the web UI uses — so an assistant can drive Parley:
// post jobs, browse & apply, manage a résumé/profile, read the chat logs, DM,
// and schedule a call. Required fields are declared in each tool's inputSchema,
// so the model asks the user for anything missing before it calls a tool.

import type { Request, Response } from 'express';
import { id, now, store } from './store.ts';
import { postJob, saveCandidateProfile } from './agents.ts';
import { createSource } from './sources.ts';
import { runParley } from './orchestrator.ts';
import { tierOf, TIER_LABEL } from './claims.ts';
import type { Conversation, Job, Role, User } from './types.ts';

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
  run: (user: User, args: Args) => unknown;
}

const S = (description: string) => ({ type: 'string', description });
const ARR = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const NUM = (description: string) => ({ type: 'number', description });

const TOOLS: Tool[] = [
  {
    name: 'whoami',
    description: 'Who you are acting as on Parley, and whether a candidate profile / employer profile is set up.',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => ({ name: u.displayName, email: u.email, role: u.role, hasCandidateAgent: Boolean(u.agentId) }),
  },
  {
    name: 'list_open_jobs',
    description: 'List all open job postings on Parley (id, title, company, salary band, work mode, requirements).',
    inputSchema: { type: 'object', properties: {} },
    run: () => store.listJobs().map(jobSummary),
  },
  {
    name: 'apply_to_job',
    description: 'Apply to a job as the candidate. This kicks off a live "parley" where your agent and the employer\'s agent talk and exchange verifiable info. Returns a conversationId immediately; the parley runs in the background (~1–2 min) — call get_conversation with that id to read the transcript and report.',
    roles: ['candidate'],
    inputSchema: { type: 'object', properties: { jobId: S('Job id from list_open_jobs.') }, required: ['jobId'] },
    run: (u, a) => {
      if (!u.agentId) throw new Error('Set up your candidate profile first with update_candidate_profile.');
      if (!store.getJob(a.jobId)) throw new Error('No job with that id — call list_open_jobs for valid ids.');
      let conversationId = '';
      void runParley(a.jobId, u.agentId, { onStart: (cid) => { conversationId = cid; } })
        .catch((e) => console.warn('[mcp] apply parley failed:', e instanceof Error ? e.message : e));
      return { conversationId, status: 'running', note: 'Your agents are talking now. Call get_conversation with this id in ~1–2 minutes for the transcript and report.' };
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
    name: 'update_candidate_profile',
    description: 'Create or update your candidate profile. Only pass the fields you want to change — the rest are preserved. Rebuilds the claim store your agent speaks from.',
    roles: ['candidate'],
    inputSchema: {
      type: 'object',
      properties: {
        years: NUM('Years of professional experience.'),
        skills: ARR('Skills, e.g. ["Go","Kubernetes"].'),
        education: S('Education, e.g. "MS Computer Science, Georgia Tech".'),
        experience: ARR('Experience highlights, one per item.'),
        projects: ARR('Notable projects, one per item.'),
        github: S('GitHub handle (optional).'),
        instructions: S('How your agent should talk & what to emphasise (style/strategy only).'),
        withhold: ARR('Topics your agent must never disclose, e.g. ["current salary"].'),
      },
    },
    run: (u, a) => {
      const cur = u.candidateInputs ?? {};
      const agent = saveCandidateProfile(u.id, {
        principalName: u.displayName,
        years: a.years ?? cur.years ?? 0,
        skills: a.skills ?? cur.skills ?? [],
        education: a.education ?? cur.education ?? '',
        experience: a.experience ?? cur.experience ?? [],
        projects: a.projects ?? cur.projects ?? [],
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
      return { ok: true, agentId: agent.id, message: 'Candidate profile saved and claim store rebuilt.' };
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

function toolsFor(user: User): Tool[] {
  return TOOLS.filter((t) => !t.roles || t.roles.includes(user.role));
}

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────────

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function dispatch(user: User, msg: any): unknown {
  const { id: rid, method, params } = msg;
  if (method === 'initialize') {
    return ok(rid, {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'parley', version: '0.1.0' },
      instructions: `You are connected to Parley as ${user.displayName} (${user.role}). ` +
        (user.role === 'candidate'
          ? 'You can browse and apply to jobs, manage the candidate profile and résumé, read parley logs, message interviewers, and schedule calls.'
          : 'You can post jobs, review applicants, read parley logs, message candidates, and schedule calls.') +
        ' Before calling a tool, ask the user for any required field you are missing.',
    });
  }
  if (method === 'tools/list') {
    return ok(rid, { tools: toolsFor(user).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = toolsFor(user).find((t) => t.name === params?.name);
    if (!tool) return rpcErr(rid, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = tool.run(user, params?.arguments ?? {});
      return ok(rid, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return ok(rid, { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    }
  }
  if (method === 'ping') return ok(rid, {});
  return rpcErr(rid, -32601, `method not found: ${method}`);
}

/** Express handler for /mcp/:token (POST = JSON-RPC; GET/DELETE = not offered). */
export function handleMcp(req: Request, res: Response): void {
  const user = store.getUserByConnectorToken(req.params.token ?? '');
  if (!user) { res.status(401).json(rpcErr(null, -32001, 'invalid connector token')); return; }
  if (req.method !== 'POST') { res.status(405).json(rpcErr(null, -32000, 'use POST (Streamable HTTP)')); return; }

  const msg = Array.isArray(req.body) ? req.body[0] : req.body;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    res.status(400).json(rpcErr(null, -32600, 'invalid JSON-RPC request')); return;
  }
  // Notifications (no id) get acknowledged with 202 and no body.
  if (msg.id === undefined || msg.id === null) { res.status(202).end(); return; }

  const payload = dispatch(user, msg);

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
