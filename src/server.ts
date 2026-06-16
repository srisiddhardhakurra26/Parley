import './env.ts'; // load .env before any module reads process.env
import express from 'express';
import type { Request, Response } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimView } from './claims.ts';
import { postJob, saveCandidateProfile, saveEmployerProfile } from './agents.ts';
import { runParley } from './orchestrator.ts';
import { getProvider } from './provider.ts';
import { store } from './store.ts';
import { seed, DEMO } from './seed.ts';
import {
  clearSession, createAccount, currentUser, googleConfigured, publicUser,
  setSession, verifyGoogleIdToken, verifyPassword,
} from './auth.ts';
import type { Agent, Claim, Conversation, Role, Turn, User } from './types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const app = express();
app.use(express.json({ limit: '1mb' }));

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
  const u = roled(req, res, 'candidate'); if (!u) return;
  const agent = u.agentId ? store.getAgent(u.agentId) : undefined;
  res.json({ agent: agent ?? null, claims: agent ? store.claimsBySubject(agent.id).map(viewClaim) : [] });
});

app.put('/api/me/agent', (req, res) => {
  const u = roled(req, res, 'candidate'); if (!u) return;
  try {
    const agent = saveCandidateProfile(u.id, req.body);
    res.json({ agent, claims: store.claimsBySubject(agent.id).map(viewClaim) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.get('/api/jobs', (req, res) => {
  const u = auth(req, res); if (!u) return;
  res.json(store.listJobs().map(viewJob));
});

// Apply → run the parley and STREAM it turn-by-turn over Server-Sent Events, so
// the candidate watches the two agents actually talk (rather than staring at a
// frozen button while a real model thinks for ~20s). Non-fatal: if a client
// can't stream, it still gets the `done` event with the conversation id.
app.post('/api/apply', async (req, res) => {
  const u = roled(req, res, 'candidate'); if (!u) return;
  if (!u.agentId) return res.status(400).json({ error: 'set up your agent first' });
  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const job = store.getJob(jobId);
  const employer = job ? store.getAgent(job.employerAgentId) : undefined;
  const candidate = store.getAgent(u.agentId);
  if (!job || !employer || !candidate) return res.status(404).json({ error: 'job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so turns flush live
  });
  const send = (type: string, data: unknown) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  const agentView = (a: Agent) => ({ displayName: a.displayName, avatar: a.avatar, voice: a.voice, principalName: a.principalName });

  send('meta', {
    provider: getProvider().name,
    job: viewJob(job),
    candidate: agentView(candidate),
    employer: agentView(employer),
  });

  try {
    const conv = await runParley(jobId, u.agentId, {
      onTurn: (t, speaker) => { send('turn', viewTurn(t, speaker)); },
    });
    send('done', { id: conv.id, status: conv.status, endedReason: conv.endedReason });
  } catch (e) {
    send('error', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    res.end();
  }
});

app.get('/api/me/applications', (req, res) => {
  const u = roled(req, res, 'candidate'); if (!u) return;
  res.json(store.conversationsForUser(u.id, 'candidate').map(summarizeConv));
});

// ── employer ──────────────────────────────────────────────────────────────────

app.get('/api/me/profile', (req, res) => {
  const u = roled(req, res, 'employer'); if (!u) return;
  res.json({ profile: u.profile ?? {}, displayName: u.displayName });
});

app.put('/api/me/profile', (req, res) => {
  const u = roled(req, res, 'employer'); if (!u) return;
  try {
    const updated = saveEmployerProfile(u.id, req.body ?? {});
    res.json({ profile: updated.profile ?? {} });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.post('/api/me/jobs', (req, res) => {
  const u = roled(req, res, 'employer'); if (!u) return;
  try {
    const { job } = postJob(u.id, req.body);
    res.json({ job: viewJob(job) });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); }
});

app.get('/api/me/jobs', (req, res) => {
  const u = roled(req, res, 'employer'); if (!u) return;
  res.json(store.jobsByEmployerUser(u.id).map((j) => {
    const applicants = store.listConversations().filter((c) => c.jobId === j.id).length;
    return { ...viewJob(j), applicants };
  }));
});

app.get('/api/me/applicants', (req, res) => {
  const u = roled(req, res, 'employer'); if (!u) return;
  res.json(store.conversationsForUser(u.id, 'employer').map(summarizeConv));
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
