import './env.ts'; // load .env before any module reads process.env
import express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimView, tierOf, TIER_LABEL } from './claims.ts';
import { postJob, saveCandidateProfile, saveEmployerProfile } from './agents.ts';
import { createSource, mintSourceOntoAgent, sourceView } from './sources.ts';
import { handleMcp } from './mcp.ts';
import { scoreJobForCandidate } from './match.ts';
import { runParley } from './orchestrator.ts';
import { getProvider } from './provider.ts';
import { id, now, store } from './store.ts';
import { seed, DEMO } from './seed.ts';
import {
  clearSession, createAccount, currentUser, googleConfigured, publicUser,
  setSession, verifyGoogleIdToken, verifyPassword,
} from './auth.ts';
import type { Agent, Claim, Conversation, DM, ParleyRequest, Role, Turn, User } from './types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const app = express();
app.use(express.json({ limit: '12mb' })); // allow base64 file uploads

// ── auth guards ───────────────────────────────────────────────────────────────

function auth(req: Request, res: Response): User | null {
  const u = currentUser(req);
  if (!u) { res.status(401).json({ error: 'not signed in' }); return null; }
  return u;
}
function roled(req: Request, res: Response, role: Role): User | null {
  const u = auth(req, res);
  if (!u) return null;
  if (u.role !== role) { res.status(403).json({ error: `this action needs a ${role} account` }); return null; }
  return u;
}

/** Which side of a parley a user is on (or null if they're not a participant). */
function convParticipant(conv: Conversation, userId: string): Role | null {
  if (store.getAgent(conv.candidateAgentId)?.userId === userId) return 'candidate';
  if (store.getAgent(conv.employerAgentId)?.userId === userId) return 'employer';
  return null;
}
/** Have these two users met across the table in some parley? (gates source access) */
function sharesConversation(a: string, b: string): boolean {
  return store.listConversations().some((c) => {
    const cu = store.getAgent(c.candidateAgentId)?.userId;
    const eu = store.getAgent(c.employerAgentId)?.userId;
    return (cu === a && eu === b) || (cu === b && eu === a);
  });
}
function viewDM(m: DM, meId: string) {
  const from = store.getUser(m.fromUserId);
  return {
    id: m.id, kind: m.kind, text: m.text, callUrl: m.callUrl, callTime: m.callTime,
    fromRole: m.fromRole, fromName: from?.displayName ?? 'Someone', mine: m.fromUserId === meId, createdAt: m.createdAt,
  };
}

// ── serializers ───────────────────────────────────────────────────────────────

function viewClaim(c: Claim) {
  const subject = store.getAgent(c.subjectId);
  return { ...claimView(c), subjectRole: subject?.role, subjectName: subject?.displayName };
}

function viewTurn(t: Turn, agent?: Agent) {
  return {
    id: t.id, role: t.role, text: t.text, audioTs: t.audioTs, intents: t.intents, note: t.note,
    speaker: agent ? { displayName: agent.displayName, avatar: agent.avatar, voice: agent.voice } : null,
  };
}

function viewConversation(conv: Conversation, viewerRole?: Role) {
  const job = store.getJob(conv.jobId);
  const candidate = store.getAgent(conv.candidateAgentId);
  const employer = store.getAgent(conv.employerAgentId);

  const turns = conv.turns.map((t) => viewTurn(t, store.getAgent(t.agentId)));
  const claims = store.getClaims(conv.claimIds).map(viewClaim);
  const report = (role: Role) => {
    const r = conv.reports[role];
    if (!r) return null;
    return { ...r, learned: store.getClaims(r.learnedClaimIds).map(viewClaim) };
  };
  // Each human only sees their OWN agent's report; the transcript + claims are shared.
  const reports = viewerRole
    ? { [viewerRole]: report(viewerRole) }
    : { candidate: report('candidate'), employer: report('employer') };

  return {
    id: conv.id, status: conv.status, endedReason: conv.endedReason, createdAt: conv.createdAt,
    job,
    candidate: candidate && { displayName: candidate.displayName, avatar: candidate.avatar, voice: candidate.voice, principalName: candidate.principalName },
    employer: employer && { displayName: employer.displayName, avatar: employer.avatar, voice: employer.voice, principalName: employer.principalName },
    turns, claims, openAgenda: conv.openAgenda, followups: conv.followups, reports,
    practice: conv.practice, coaching: conv.coaching,
  };
}

function summarizeConv(c: Conversation) {
  const job = store.getJob(c.jobId);
  const cand = store.getAgent(c.candidateAgentId);
  const emp = store.getAgent(c.employerAgentId);
  return {
    id: c.id, status: c.status, createdAt: c.createdAt, turns: c.turns.length,
    jobTitle: job?.title, company: job?.company,
    candidateName: cand?.principalName, employerName: emp?.displayName,
  };
}

function viewJob(j: ReturnType<typeof store.getJob>) {
  if (!j) return null;
  const emp = store.getAgent(j.employerAgentId);
  return { ...j, employer: emp && { displayName: emp.displayName, avatar: emp.avatar, principalName: emp.principalName } };
}

// ── config / auth ─────────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  const p = getProvider();
  res.json({
    provider: p.name,
    hasKey: p.name !== 'mock',
    googleConfigured: googleConfigured(),
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? null,
    demo: DEMO,
  });
});

app.get('/api/auth/me', (req, res) => {
  const u = currentUser(req);
  res.json({ user: u ? publicUser(u) : null });
});

app.post('/api/auth/signup', (req, res) => {
  const { email, password, role, displayName } = req.body ?? {};
  try {
    const u = createAccount({ email, password, role, displayName });
    setSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const u = email ? store.getUserByEmail(email) : undefined;
  if (!u || !u.salt || !u.passwordHash || !verifyPassword(String(password ?? ''), u.salt, u.passwordHash)) {
    return res.status(401).json({ error: 'incorrect email or password' });
  }
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

// Real Google sign-in (active when GOOGLE_CLIENT_ID is set).
app.post('/api/auth/google', async (req, res) => {
  const { credential, role, displayName } = req.body ?? {};
  try {
    const info = await verifyGoogleIdToken(String(credential ?? ''));
    let u = store.getUserByGoogleSub(info.sub) ?? store.getUserByEmail(info.email);
    if (u) {
      if (!u.googleSub) { u.googleSub = info.sub; store.putUser(u); }
    } else {
      if (!role) return res.status(400).json({ error: 'pick a role to finish signup', needRole: true });
      u = createAccount({ email: info.email, role, displayName: displayName || info.name || info.email, googleSub: info.sub });
    }
    setSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

// Demo Google connect (only when real Google isn't configured): just a Gmail.
app.post('/api/auth/google-demo', (req, res) => {
  if (googleConfigured()) return res.status(400).json({ error: 'use real Google sign-in' });
  const { email, role, displayName } = req.body ?? {};
  try {
    let u = email ? store.getUserByEmail(email) : undefined;
    if (!u) {
      if (!role) return res.status(400).json({ error: 'pick a role to finish signup', needRole: true });
      u = createAccount({ email, role, displayName: displayName || String(email).split('@')[0], googleSub: `demo:${email}` });
    }
    setSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

// ── candidate ─────────────────────────────────────────────────────────────────

app.get('/api/me/agent', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const agent = u.agentId ? store.getAgent(u.agentId) : undefined;
  res.json({ agent: agent ?? null, inputs: u.candidateInputs ?? null, claims: agent ? store.claimsBySubject(agent.id).map(viewClaim) : [] });
});

app.put('/api/me/agent', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    const agent = saveCandidateProfile(u.id, req.body);
    res.json({ agent, claims: store.claimsBySubject(agent.id).map(viewClaim) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

// Parse a résumé into structured fields (LLM) so the profile form can autofill.
app.post('/api/me/parse-resume', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'no résumé text to parse' });
  try {
    const fields = await getProvider().extractResume(text);
    res.json({ fields });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

// Draft a "how should my agent talk & answer" instruction from the candidate's
// own details (résumé / skills / experience), for the human to tweak.
app.post('/api/me/suggest-instructions', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const b = req.body ?? {};
  const cur = u.candidateInputs ?? {};
  const years = b.years ?? cur.years;
  const skills: string[] = b.skills ?? cur.skills ?? [];
  const education = b.education ?? cur.education;
  const experience: string[] = b.experience ?? cur.experience ?? [];
  const projects: string[] = b.projects ?? cur.projects ?? [];
  const summary = [
    years != null && years !== '' ? `Years of experience: ${years}` : '',
    skills.length ? `Skills: ${skills.join(', ')}` : '',
    education ? `Education: ${education}` : '',
    experience.length ? `Experience:\n- ${experience.join('\n- ')}` : '',
    projects.length ? `Projects:\n- ${projects.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
  if (!summary.trim()) return res.status(400).json({ error: 'add some profile details first' });
  try {
    const instructions = await getProvider().suggestInstructions(summary);
    res.json({ instructions });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.get('/api/jobs', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const agentId = u.role === 'candidate' ? u.agentId : undefined;
  res.json(store.listJobs().map((j) => {
    const v = viewJob(j);
    if (v && agentId) (v as Record<string, unknown>).match = scoreJobForCandidate(j, agentId).score;
    return v;
  }));
});

// Run the parley and STREAM it turn-by-turn over Server-Sent Events, so whoever
// accepted watches the two agents actually talk. Shared by the request-run route.
async function streamParley(res: Response, jobId: string, candidateAgentId: string, onConversation?: (c: Conversation) => void, opts?: { practice?: boolean }) {
  const job = store.getJob(jobId);
  const employer = job ? store.getAgent(job.employerAgentId) : undefined;
  const candidate = store.getAgent(candidateAgentId);
  if (!job || !employer || !candidate) return res.status(404).json({ error: 'job or agent not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type: string, data: unknown) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  const agentView = (a: Agent) => ({ displayName: a.displayName, avatar: a.avatar, voice: a.voice, principalName: a.principalName });
  send('meta', { provider: getProvider().name, job: viewJob(job), candidate: agentView(candidate), employer: agentView(employer), practice: !!opts?.practice });

  try {
    const conv = await runParley(jobId, candidateAgentId, { onTurn: (t, speaker) => { send('turn', viewTurn(t, speaker)); } }, opts);
    onConversation?.(conv);
    send('done', { id: conv.id, status: conv.status, endedReason: conv.endedReason, coaching: conv.coaching });
  } catch (e) {
    send('error', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    res.end();
  }
}

app.get('/api/me/applications', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.conversationsForUser(u.id, 'candidate').filter((c) => !c.practice).map(summarizeConv));
});

// Practice mode — a private parley against a posting's recruiting agent, with coaching.
app.post('/api/practice', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!u.agentId) return res.status(400).json({ error: 'set up your agent first' });
  const job = req.body?.jobId ? store.getJob(String(req.body.jobId)) : undefined;
  if (!job) return res.status(404).json({ error: 'job not found' });
  await streamParley(res, job.id, u.agentId, undefined, { practice: true });
});

app.get('/api/me/practice', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.conversationsForUser(u.id, 'candidate').filter((c) => c.practice).map(summarizeConv));
});

// ── parley requests (consent before the agents talk) ───────────────────────────

function requestRole(r: ParleyRequest, userId: string): Role | null {
  if (store.getAgent(r.candidateAgentId)?.userId === userId) return 'candidate';
  if (store.getAgent(r.employerAgentId)?.userId === userId) return 'employer';
  return null;
}
function viewRequest(r: ParleyRequest, meId: string) {
  const job = store.getJob(r.jobId);
  const cand = store.getAgent(r.candidateAgentId);
  const myRole = requestRole(r, meId);
  return {
    id: r.id, status: r.status, jobId: r.jobId, jobTitle: job?.title, company: job?.company,
    candidateName: cand?.principalName, candidateAgentId: r.candidateAgentId, candidateAvatar: cand?.avatar,
    fromRole: r.fromRole, message: r.message, conversationId: r.conversationId,
    mine: myRole === r.fromRole,                                       // did I send it?
    canAccept: myRole != null && myRole !== r.fromRole && r.status === 'pending',
    createdAt: r.createdAt,
  };
}
function makeRequest(jobId: string, employerAgentId: string, candidateAgentId: string, fromRole: Role, message?: string): ParleyRequest {
  return store.putRequest({ id: id('req'), jobId, candidateAgentId, employerAgentId, fromRole, status: 'pending', message: message?.trim() || undefined, createdAt: now(), updatedAt: now() });
}

app.post('/api/requests', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const { jobId, candidateAgentId, message } = req.body ?? {};
  const job = jobId ? store.getJob(String(jobId)) : undefined;
  if (!job) return res.status(404).json({ error: 'job not found' });

  if (u.role === 'candidate') {
    if (!u.agentId) return res.status(400).json({ error: 'set up your agent first' });
    const existing = store.findRequest(job.id, u.agentId);
    const r = existing ?? makeRequest(job.id, job.employerAgentId, u.agentId, 'candidate', message);
    return res.json({ request: viewRequest(r, u.id) });
  }
  // employer requesting a specific candidate for their posting
  if (store.getAgent(job.employerAgentId)?.userId !== u.id) return res.status(403).json({ error: 'not your posting' });
  const cand = candidateAgentId ? store.getAgent(String(candidateAgentId)) : undefined;
  if (!cand || cand.role !== 'candidate') return res.status(400).json({ error: 'candidateAgentId required' });
  const existing = store.findRequest(job.id, cand.id);
  const r = existing ?? makeRequest(job.id, job.employerAgentId, cand.id, 'employer', message);
  res.json({ request: viewRequest(r, u.id) });
});

app.get('/api/me/requests', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.listRequests().filter((r) => requestRole(r, u.id) != null).map((r) => viewRequest(r, u.id)));
});

app.post('/api/requests/:id/decline', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const r = store.getRequest(req.params.id);
  if (!r || !requestRole(r, u.id)) return res.status(r ? 403 : 404).json({ error: r ? 'not your request' : 'not found' });
  if (r.status === 'pending') { r.status = 'declined'; r.updatedAt = now(); store.putRequest(r); }
  res.json({ ok: true });
});

// The recipient accepts → the parley runs and streams here.
app.post('/api/requests/:id/run', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const r = store.getRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  const role = requestRole(r, u.id);
  if (!role || role === r.fromRole) return res.status(403).json({ error: 'only the recipient can accept this request' });
  if (r.status === 'declined') return res.status(400).json({ error: 'this request was declined' });
  if (r.conversationId) return res.status(400).json({ error: 'this parley already ran' });
  await streamParley(res, r.jobId, r.candidateAgentId, (conv) => {
    r.status = 'accepted'; r.conversationId = conv.id; r.updatedAt = now(); store.putRequest(r);
  });
});

// Candidate directory — employers browse candidates (ranked by fit to a posting).
app.get('/api/candidates', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const jobId = String(req.query.jobId ?? '');
  const job = jobId ? store.getJob(jobId) : undefined;
  const out = store.listAgents('candidate').filter((a) => a.userId && a.userId !== u.id).map((a) => {
    const m = job ? scoreJobForCandidate(job, a.id) : null;
    const requested = job ? store.findRequest(job.id, a.id) : undefined;
    return {
      agentId: a.id, name: a.principalName, avatar: a.avatar,
      claims: store.claimsBySubject(a.id).length,
      match: m?.score ?? null, met: m?.met ?? [], missing: m?.missing ?? [],
      requestId: requested?.id, requestStatus: requested?.status,
    };
  });
  out.sort((x, y) => (y.match ?? -1) - (x.match ?? -1));
  res.json(out);
});

// ── employer ──────────────────────────────────────────────────────────────────

app.get('/api/me/profile', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json({ profile: u.profile ?? {}, displayName: u.displayName });
});

app.put('/api/me/profile', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    const updated = saveEmployerProfile(u.id, req.body ?? {});
    res.json({ profile: updated.profile ?? {} });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.post('/api/me/jobs', (req, res) => {
  const u = auth(req, res); if (!u) return;
  try {
    const { job } = postJob(u.id, req.body);
    res.json({ job: viewJob(job) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.get('/api/me/jobs', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.jobsByEmployerUser(u.id).map((j) => {
    const applicants = store.listConversations().filter((c) => c.jobId === j.id).length;
    return { ...viewJob(j), applicants };
  }));
});

app.get('/api/me/applicants', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.conversationsForUser(u.id, 'employer').filter((c) => !c.practice).map(summarizeConv));
});

// ── sources (uploaded documents → RAG in the parley + provenance in reports) ────

app.get('/api/me/sources', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.sourcesByUser(u.id).map(sourceView));
});

app.post('/api/me/sources', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const { title, kind, text, fileName, mimeType, dataBase64 } = req.body ?? {};
  if (!String(text ?? '').trim() && !dataBase64) return res.status(400).json({ error: 'add some text or attach a file' });
  try {
    if (u.role === 'candidate') {
      // Mints onto the candidate's standing agent (or waits for one to be created).
      const src = createSource(u.id, u.agentId, { title, kind, text, fileName, mimeType, dataBase64 });
      return res.json({ source: sourceView(src) });
    }
    // Employer: store once, attach to every current posting's recruiting agent.
    const src = createSource(u.id, undefined, { title, kind, text, fileName, mimeType, dataBase64 });
    for (const job of store.jobsByEmployerUser(u.id)) mintSourceOntoAgent(src.id, job.employerAgentId);
    res.json({ source: sourceView(src) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.delete('/api/me/sources/:id', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const s = store.getSource(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.ownerUserId !== u.id) return res.status(403).json({ error: 'not your source' });
  store.deleteSource(s.id);
  res.json({ ok: true });
});

app.get('/api/sources/:id/raw', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const s = store.getSource(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.ownerUserId !== u.id && !sharesConversation(u.id, s.ownerUserId)) return res.status(403).json({ error: 'not allowed' });
  if (s.dataBase64) {
    res.setHeader('Content-Type', s.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(s.fileName || s.title).replace(/["\r\n]/g, '')}"`);
    return res.end(Buffer.from(s.dataBase64, 'base64'));
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(s.text || '(no extracted text)');
});

// ── shared: a single parley (participants only, own report only) ───────────────

app.get('/api/conversations/:id', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const conv = store.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const isCand = store.getAgent(conv.candidateAgentId)?.userId === u.id;
  const isEmp = store.getAgent(conv.employerAgentId)?.userId === u.id;
  if (!isCand && !isEmp) return res.status(403).json({ error: 'not your parley' });
  res.json(viewConversation(conv, u.role));
});

// ── direct messages + live call (the humans connect after their agents parley) ──

app.get('/api/conversations/:id/dms', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const conv = store.getConversation(req.params.id);
  if (!conv || !convParticipant(conv, u.id)) return res.status(conv ? 403 : 404).json({ error: conv ? 'not your parley' : 'not found' });
  res.json(store.dmsByConversation(conv.id).map((m) => viewDM(m, u.id)));
});

app.post('/api/conversations/:id/dms', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const conv = store.getConversation(req.params.id);
  const role = conv ? convParticipant(conv, u.id) : null;
  if (!conv || !role) return res.status(conv ? 403 : 404).json({ error: conv ? 'not your parley' : 'not found' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'empty message' });
  // The first message opens the thread (a request to connect).
  if (store.dmsByConversation(conv.id).length === 0) {
    store.addDM({ id: id('dm'), conversationId: conv.id, fromUserId: u.id, fromRole: role, kind: 'system', text: `${u.displayName} started a direct conversation.`, createdAt: now() });
  }
  const m = store.addDM({ id: id('dm'), conversationId: conv.id, fromUserId: u.id, fromRole: role, kind: 'message', text, createdAt: now() });
  res.json({ message: viewDM(m, u.id) });
});

app.post('/api/conversations/:id/call', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const conv = store.getConversation(req.params.id);
  const role = conv ? convParticipant(conv, u.id) : null;
  if (!conv || !role) return res.status(conv ? 403 : 404).json({ error: conv ? 'not your parley' : 'not found' });
  const callUrl = `https://meet.jit.si/Parley-${conv.id}`; // a real, free, no-signup video room
  const raw = req.body?.time ? new Date(String(req.body.time)) : new Date(Date.now() + 30 * 60 * 1000);
  const callTime = isNaN(raw.getTime()) ? undefined : raw.toISOString();
  const m = store.addDM({
    id: id('dm'), conversationId: conv.id, fromUserId: u.id, fromRole: role, kind: 'call',
    text: `${u.displayName} sent a link to hop on a live video call.`, callUrl, callTime, createdAt: now(),
  });
  res.json({ message: viewDM(m, u.id) });
});

// Copilot — answer a question about the OTHER side, grounded in the parley evidence.
app.post('/api/conversations/:id/ask', async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const conv = store.getConversation(req.params.id);
  const role = conv ? convParticipant(conv, u.id) : null;
  if (!conv || !role) return res.status(conv ? 403 : 404).json({ error: conv ? 'not your parley' : 'not found' });
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'ask a question' });

  const counterAgentId = role === 'candidate' ? conv.employerAgentId : conv.candidateAgentId;
  const subjectName = store.getAgent(counterAgentId)?.principalName ?? 'the other side';
  const claims = store.getClaims(conv.claimIds).filter((c) => c.subjectId === counterAgentId && !c.protectedClass);
  const read = conv.reports[role]?.read;
  const evidence = [
    `Subject: ${subjectName}`,
    'CLAIMS (statement · tier):',
    ...claims.map((c) => `- ${c.statement} · ${TIER_LABEL[tierOf(c)]}`),
    '',
    'TRANSCRIPT:',
    ...conv.turns.map((t) => `${store.getAgent(t.agentId)?.displayName ?? t.role}: ${t.text}`),
    read ? `\nAGENT'S READ: ${read}` : '',
  ].join('\n');
  const history = Array.isArray(req.body?.history)
    ? (req.body.history as { role: string; content: string }[]).slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' as const : 'user' as const, content: String(h.content ?? '') }))
    : [];
  try {
    const answer = await getProvider().copilot(question, evidence, history);
    res.json({ answer });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

// ── notifications (unread direct messages) ─────────────────────────────────────

app.get('/api/notifications', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const convs = u.role === 'candidate' ? store.conversationsForUser(u.id, 'candidate') : store.conversationsForUser(u.id, 'employer');
  let total = 0;
  const items: unknown[] = [];
  for (const c of convs) {
    const dms = store.dmsByConversation(c.id);
    if (!dms.length) continue;
    const lastReadAt = store.lastRead(u.id, c.id) ?? '';
    const unread = dms.filter((m) => m.fromUserId !== u.id && m.kind !== 'system' && m.createdAt > lastReadAt);
    if (!unread.length) continue;
    total += unread.length;
    const last = dms[dms.length - 1]!;
    const role = convParticipant(c, u.id);
    const otherName = role === 'candidate' ? store.getAgent(c.employerAgentId)?.principalName : store.getAgent(c.candidateAgentId)?.principalName;
    items.push({
      kind: 'message', conversationId: c.id, jobTitle: store.getJob(c.jobId)?.title, otherName: otherName ?? 'Someone',
      unread: unread.length, lastText: last.kind === 'call' ? '📹 Sent a video-call link' : last.text, lastAt: last.createdAt,
    });
  }
  // Incoming pending parley requests (this user is the recipient).
  for (const r of store.listRequests()) {
    if (r.status !== 'pending') continue;
    const role = requestRole(r, u.id);
    if (!role || role === r.fromRole) continue;
    total += 1;
    const job = store.getJob(r.jobId);
    const fromName = r.fromRole === 'candidate' ? store.getAgent(r.candidateAgentId)?.principalName : store.getAgent(r.employerAgentId)?.principalName;
    items.push({
      kind: 'request', requestId: r.id, otherName: fromName ?? 'Someone', jobTitle: job?.title,
      unread: 1, lastText: r.fromRole === 'candidate' ? '🤝 Wants to parley about your role' : `🤝 Invited you to parley for ${job?.title ?? 'a role'}`, lastAt: r.createdAt,
    });
  }
  items.sort((a, b) => String((b as { lastAt: string }).lastAt).localeCompare(String((a as { lastAt: string }).lastAt)));
  res.json({ total, items });
});

app.post('/api/conversations/:id/read', (req, res) => {
  const u = auth(req, res); if (!u) return;
  const conv = store.getConversation(req.params.id);
  if (!conv || !convParticipant(conv, u.id)) return res.status(conv ? 403 : 404).json({ error: conv ? 'not your parley' : 'not found' });
  store.markRead(u.id, conv.id, now());
  res.json({ ok: true });
});

// ── MCP connector (per-user token + Streamable-HTTP endpoint) ───────────────────

const connectorUrl = (req: Request, token: string) => `${req.protocol}://${req.get('host')}/mcp/${token}`;

app.get('/api/me/connector', (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!u.connectorToken) { u.connectorToken = `pk_${randomUUID().replace(/-/g, '')}`; store.putUser(u); }
  res.json({ token: u.connectorToken, url: connectorUrl(req, u.connectorToken), role: u.role });
});

app.post('/api/me/connector/regenerate', (req, res) => {
  const u = auth(req, res); if (!u) return;
  u.connectorToken = `pk_${randomUUID().replace(/-/g, '')}`;
  store.putUser(u);
  res.json({ token: u.connectorToken, url: connectorUrl(req, u.connectorToken), role: u.role });
});

// The MCP endpoint itself (auth is the token in the path).
app.all('/mcp/:token', handleMcp);

// ── dev helpers ────────────────────────────────────────────────────────────────

app.post('/api/seed', (_req, res) => { res.json(seed()); });
app.post('/api/reset', (_req, res) => { store.reset(); clearSession(res); res.json({ ok: true }); });

// ── static frontend ────────────────────────────────────────────────────────────

app.use(express.static(join(ROOT, 'public')));
app.get('*', (_req, res) => res.sendFile(join(ROOT, 'public', 'index.html')));

const PORT = Number(process.env.PORT ?? 4505);
app.listen(PORT, () => {
  const p = getProvider();
  console.log(`\n  Parley running → http://localhost:${PORT}`);
  console.log(`  Provider: ${p.name}${p.name === 'mock' ? '  (set GROQ_API_KEY for live agents — see .env.example)' : ''}`);
  console.log(`  Demo logins → candidate ${DEMO.candidate.email} · interviewer ${DEMO.employer.email}  (pw demo1234, after Seed)\n`);
});
