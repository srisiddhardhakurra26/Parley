'use strict';

// ── tiny helpers ─────────────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const app = () => $('#app');
const view = () => $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), data);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

const state = { me: null, config: {}, tab: null, convId: null };

// ── speech (listenable logs) ─────────────────────────────────────────────────
let VOICES = [];
function loadVoices() { VOICES = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickSystemVoice(name) {
  if (!VOICES.length) return null;
  const english = VOICES.filter((v) => /en[-_]/i.test(v.lang));
  const pool = english.length ? english : VOICES;
  const idx = name === 'employer' || name === 'maya' ? 0 : Math.min(1, pool.length - 1);
  return pool[idx % pool.length];
}
function speak(text, voice, onend) {
  if (!window.speechSynthesis) { if (onend) onend(); return; }
  const u = new SpeechSynthesisUtterance(text);
  if (voice) { u.rate = voice.rate ?? 1; u.pitch = voice.pitch ?? 1; const sv = pickSystemVoice(voice.name); if (sv) u.voice = sv; }
  if (onend) u.onend = onend;
  speechSynthesis.speak(u);
}
function stopSpeech() { if (window.speechSynthesis) speechSynthesis.cancel(); }

// ── shared bits ──────────────────────────────────────────────────────────────
function claimCard(c) {
  const sources = (c.evidence || []).map((e) => {
    if (e.kind === 'transcript') return `<span class="src-link" data-turn="${esc(e.ref)}" title="jump to the moment it was said">↳ ${esc(e.label || 'said in parley')}${e.audioTs != null ? ` · ${e.audioTs}s` : ''}</span>`;
    if (e.kind === 'url') return `<a class="src-link" href="${esc(e.ref)}" target="_blank" rel="noopener">${esc(e.label || e.ref)}</a>`;
    return `<span class="pill">${esc(e.label || e.kind)}</span>`;
  }).join('');
  const v = c.verification || {};
  const vnote = v.status && v.status !== 'unverified' ? `<span class="vnote">✓ ${esc(v.status)}${v.note ? ` — ${esc(v.note)}` : ''}</span>` : '';
  const subj = c.subjectRole ? `<span class="pill">about ${esc(c.subjectRole)}</span>` : '';
  const prot = c.protectedClass ? `<span class="protected-flag">⚠ protected — withheld</span>` : '';
  return `<div class="claim ${c.inferred ? 'inferred' : ''}">
    <div class="statement">${esc(c.statement)}</div>
    <div class="prov"><span class="tier ${c.tier}">${esc(c.tierLabel)}</span>${subj}${sources}${vnote}${prot}</div>
  </div>`;
}

function providerBadge() {
  const c = state.config || {};
  if (c.hasKey) {
    const model = String(c.provider || 'live').split(':').pop();
    return `<span class="badge live" title="live agents via ${esc(c.provider)}"><i class="livedot"></i> ${esc(model)}</span>`;
  }
  return `<span class="badge mock" title="no API key set — deterministic mock provider">mock provider</span>`;
}

function header() {
  const me = state.me;
  const tag = !me ? 'agents parley · humans decide'
    : me.role === 'candidate' ? 'candidate workspace' : 'interviewer workspace';
  const right = me
    ? `${providerBadge()}<span class="badge role-${me.role}">${esc(me.displayName)} · ${me.role === 'candidate' ? 'Candidate' : 'Interviewer'}</span><button class="ghost" id="logoutBtn">Log out</button>`
    : providerBadge();
  return `<header class="top"><div class="brand">⚖ Parley <small>${tag}</small></div><div class="spacer"></div>${right}</header>`;
}

function frame(tabs, bodyHtml) {
  const nav = tabs.length
    ? `<nav class="tabs">${tabs.map((t) => `<button data-tab="${t.id}" class="${t.id === state.tab ? 'active' : ''}">${esc(t.label)}</button>`).join('')}</nav>` : '';
  app().innerHTML = header() + nav + `<main id="view">${bodyHtml}</main>`;
  const lo = $('#logoutBtn');
  if (lo) lo.addEventListener('click', async () => { await api('POST', '/api/auth/logout'); state.me = null; state.tab = null; state.convId = null; route(); });
  app().querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.convId = null; route(); }));
}

function emptyState(html) { return `<div class="empty">${html}</div>`; }

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
let authTab = 'login';
let signupRole = 'candidate';

function renderAuth() {
  const isSignup = authTab === 'signup';
  const body = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-tabs">
          <button data-atab="login" class="${!isSignup ? 'active' : ''}">Log in</button>
          <button data-atab="signup" class="${isSignup ? 'active' : ''}">Sign up</button>
        </div>
        ${isSignup ? `
          <label>I am a…</label>
          <div class="role-toggle">
            <button data-role="candidate" class="${signupRole === 'candidate' ? 'sel' : ''}">🧑‍💻 Candidate<small>I'm looking for a role</small></button>
            <button data-role="employer" class="${signupRole === 'employer' ? 'sel' : ''}">🏢 Interviewer<small>I'm hiring</small></button>
          </div>
          <label>Name</label><input id="su_name" placeholder="${signupRole === 'candidate' ? 'Maya' : 'Priya (Acme)'}" />
        ` : ''}
        <label>Email</label><input id="au_email" type="email" placeholder="you@example.com" />
        <label>Password</label><input id="au_pw" type="password" placeholder="••••••••" />
        <button class="primary block" id="au_submit">${isSignup ? 'Create account' : 'Log in'}</button>
        <div class="divider"><span>or</span></div>
        <div id="googleSlot"></div>
        <div class="auth-foot">
          <button class="ghost small" id="seedBtn">Seed demo accounts</button>
          <span class="faint">Demo: <code>${esc(state.config?.demo?.candidate?.email || 'maya@demo.test')}</code> / <code>demo1234</code> (candidate) · <code>${esc(state.config?.demo?.employer?.email || 'priya@demo.test')}</code> (interviewer)</span>
        </div>
      </div>
      <p class="auth-blurb">A hiring platform where each side sets up an AI agent. The agents parley — gather verifiable info, report back — and <b>you</b> decide.</p>
    </div>`;
  frame([], body);

  view().querySelectorAll('[data-atab]').forEach((b) => b.addEventListener('click', () => { authTab = b.dataset.atab; renderAuth(); }));
  view().querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => { signupRole = b.dataset.role; renderAuth(); }));

  $('#au_submit').addEventListener('click', submitAuth);
  $('#au_pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  $('#seedBtn').addEventListener('click', async () => { await api('POST', '/api/seed'); toast('Demo accounts ready — log in with the credentials below'); });

  setupGoogle($('#googleSlot'));
}

async function submitAuth() {
  const email = $('#au_email').value.trim();
  const password = $('#au_pw').value;
  try {
    if (authTab === 'signup') {
      const displayName = $('#su_name').value.trim();
      const { user } = await api('POST', '/api/auth/signup', { email, password, role: signupRole, displayName });
      onAuthed(user);
    } else {
      const { user } = await api('POST', '/api/auth/login', { email, password });
      onAuthed(user);
    }
  } catch (e) { toast(e.message); }
}

function onAuthed(user) {
  state.me = user;
  state.tab = null;
  state.convId = null;
  route();
}

function setupGoogle(slot) {
  if (state.config.googleConfigured && state.config.googleClientId) {
    // Real Google Identity Services button.
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      window.google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: onGoogleCredential });
      window.google.accounts.id.renderButton(slot, { theme: 'filled_black', size: 'large', width: 320, text: 'continue_with' });
    };
    document.head.appendChild(s);
  } else {
    slot.innerHTML = `<button class="google-btn block" id="gdemo"><span>G</span> Continue with Google <em>(demo)</em></button>`;
    $('#gdemo').addEventListener('click', googleDemo);
  }
}

async function onGoogleCredential(resp) {
  try {
    const payload = { credential: resp.credential };
    if (authTab === 'signup') { payload.role = signupRole; payload.displayName = $('#su_name')?.value.trim(); }
    const { user } = await api('POST', '/api/auth/google', payload);
    onAuthed(user);
  } catch (e) {
    if (e.needRole) { toast('Pick Candidate or Interviewer on the Sign up tab first.'); authTab = 'signup'; renderAuth(); }
    else toast(e.message);
  }
}

async function googleDemo() {
  const email = prompt('Demo Google connect — enter a Gmail address:');
  if (!email) return;
  const role = signupRole;
  const displayName = authTab === 'signup' ? ($('#su_name')?.value.trim() || '') : '';
  try {
    const { user } = await api('POST', '/api/auth/google-demo', { email, role, displayName });
    onAuthed(user);
  } catch (e) { toast(e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDIDATE APP
// ─────────────────────────────────────────────────────────────────────────────
const CAND_TABS = [
  { id: 'agent', label: 'My Agent' },
  { id: 'jobs', label: 'Browse Jobs' },
  { id: 'applications', label: 'My Applications' },
];

async function renderCandidate() {
  if (!state.tab) state.tab = state.me.hasAgent ? 'jobs' : 'agent';
  frame(CAND_TABS, `<div class="muted">Loading…</div>`);
  if (state.tab === 'agent') return candAgentView();
  if (state.tab === 'jobs') return candJobsView();
  if (state.tab === 'applications') return state.convId ? detailView('candidate') : candApplicationsView();
}

async function candAgentView() {
  const { agent, claims } = await api('GET', '/api/me/agent');
  const intro = agent
    ? `<div class="muted">Your agent is set up with <b>${claims.length}</b> claims. Re-saving rebuilds it.</div>`
    : `<div class="callout">👋 Set up your agent first — this is what represents you when you apply. It can only assert what you give it here.</div>`;
  const store = claims.length
    ? `<h3 style="margin-top:22px">Your claim store</h3><div class="muted" style="font-size:12.5px;margin-bottom:8px">What your agent may assert on your behalf, with provenance:</div>${claims.slice().sort((a, b) => b.rank - a.rank).map(claimCard).join('')}`
    : '';
  view().innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>🧑‍💻 Your agent</h3>
        ${intro}
        <form id="candForm">
          <label>Years of experience</label><input name="years" type="number" value="${agent ? '' : 7}" placeholder="7" />
          <label>Skills (comma-separated)</label><input name="skills" placeholder="Go, Kubernetes, distributed systems" />
          <label>Education</label><input name="education" placeholder="MS Computer Science, Georgia Tech" />
          <label>Experience (one per line)</label><textarea name="experience" placeholder="Led a 6-person platform team at Skiff"></textarea>
          <label>Projects (one per line)</label><textarea name="projects" placeholder="raftish — a teaching Raft implementation"></textarea>
          <div class="row"><div style="flex:1"><label>GitHub handle</label><input name="github" placeholder="sam-builds" /></div>
          <div style="flex:1"><label>Connector-verified skills</label><input name="githubVerifiedSkills" placeholder="Go, Kubernetes" /></div></div>
          <label>Withhold these topics</label><input name="withhold" value="current salary" />
          <label>Agent voice</label><select name="voice"><option value="maya">bright (higher)</option><option value="employer">measured</option></select>
          <div style="margin-top:14px"><button class="primary" type="submit">${agent ? 'Rebuild my agent' : 'Create my agent'}</button></div>
        </form>
      </div>
      <div>${store || `<div class="card muted">Your claim store will appear here once you create your agent.</div>`}</div>
    </div>`;

  const voicePresets = { employer: { rate: 0.95, pitch: 0.85 }, maya: { rate: 1.05, pitch: 1.1 } };
  $('#candForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const vName = f.voice.value;
    try {
      await api('PUT', '/api/me/agent', {
        principalName: state.me.displayName, years: +f.years.value || 0, skills: list(f.skills.value),
        education: f.education.value, experience: lines(f.experience.value), projects: lines(f.projects.value),
        github: f.github.value, githubVerifiedSkills: list(f.githubVerifiedSkills.value),
        voice: { name: vName, ...voicePresets[vName] }, avatar: { emoji: '🧑‍💻', color: '#6c8cff' },
        disclosure: { freelyShare: ['skills', 'experience', 'education', 'projects', 'availability'], withhold: list(f.withhold.value), revealOnReciprocity: ['target compensation', 'competing offers'] },
      });
      state.me.hasAgent = true;
      toast('Your agent is ready'); candAgentView();
    } catch (err) { toast(err.message); }
  });
  wireClaimSources();
}

async function candJobsView() {
  const jobs = await api('GET', '/api/jobs');
  if (!jobs.length) return (view().innerHTML = emptyState('No open roles yet.'));
  const canApply = state.me.hasAgent;
  view().innerHTML = `${canApply ? '' : '<div class="callout">Set up your agent under <b>My Agent</b> before applying.</div>'}<div class="grid cols-2">` + jobs.map((j) => `
    <div class="tile">
      <div class="head">
        <div class="avatar" style="background:${esc(j.employer?.avatar?.color || '#27c498')}22;border-color:${esc(j.employer?.avatar?.color || '#27c498')}">${esc(j.employer?.avatar?.emoji || '🏢')}</div>
        <div><h3>${esc(j.title)}</h3><div class="muted">${esc(j.company)}</div></div>
      </div>
      <div class="kv"><b>Salary</b> ${esc(j.currency)} ${j.salaryMin.toLocaleString()}–${j.salaryMax.toLocaleString()}</div>
      <div class="kv"><b>Visa</b> ${j.visaSponsorship ? 'sponsorship available' : 'no sponsorship'}</div>
      <div class="kv"><b>Location</b> ${esc(j.remote)} · ${esc(j.location)}</div>
      <div class="wrap" style="margin-top:8px">${j.requirements.map((r) => `<span class="pill">${esc(r)}</span>`).join('')}</div>
      <div class="applybar"><button class="primary" data-apply="${j.id}" ${canApply ? '' : 'disabled'}>Apply ▶</button><span class="faint">one click → your agent parleys with theirs</span></div>
    </div>`).join('') + `</div>`;

  view().querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => {
    const job = jobs.find((j) => j.id === b.getAttribute('data-apply'));
    if (job) startLiveParley(job);
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE PARLEY — stream the agent-to-agent conversation as it happens
// ─────────────────────────────────────────────────────────────────────────────

// Consume the SSE stream from POST /api/apply. Each `data:` line is one event.
async function streamApply(jobId, onEvent, signal) {
  const res = await fetch('/api/apply', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ jobId }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
      buf = buf.slice(i + 2);
      if (!line) continue;
      try { const m = JSON.parse(line.slice(5).trim()); onEvent(m.type, m.data); } catch {}
    }
  }
}

const other = (r) => (r === 'candidate' ? 'employer' : 'candidate');

function stageAgentHtml(a, side) {
  if (!a) return `<div class="stage-agent ${side}"></div>`;
  const col = a.avatar?.color || '#888';
  return `<div class="stage-agent ${side}">
    <div class="avatar lg" style="background:${esc(col)}22;border-color:${esc(col)}">${esc(a.avatar?.emoji || '🤖')}</div>
    <div class="sa-meta"><div class="sa-name">${esc(a.displayName)}</div><div class="faint">${esc(a.principalName || '')}</div></div>
  </div>`;
}

function liveBubbleHtml(t) {
  const col = t.speaker?.avatar?.color || '#444';
  return `<div class="bubble ${t.role} enter" id="${esc(t.id)}">
    <div class="avatar" style="background:${esc(col)}22;border-color:${esc(col)}">${esc(t.speaker?.avatar?.emoji || '🤖')}</div>
    <div class="body">
      <div class="meta"><b>${esc(t.speaker?.displayName || t.role)}</b><button class="play" data-speak="${esc(t.id)}" title="listen">▶</button><span class="faint">${t.audioTs}s</span></div>
      <div class="text">${esc(t.text)}</div>
      ${t.note ? `<div class="note">⚙ ${esc(t.note)}</div>` : ''}
    </div>
  </div>`;
}

function startLiveParley(job) {
  stopSpeech();
  const ctrl = new AbortController();
  let autoVoice = false;
  let names = { candidate: 'Candidate', employer: 'Recruiter' };
  let voices = {};
  let count = 0;
  let finished = false;

  view().innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <button class="ghost" id="liveBack">← back to jobs</button>
      <div class="spacer"></div>
      <span class="badge live"><i class="livedot"></i> live parley</span>
    </div>
    <div class="stage card">
      <div class="stage-head">
        <div id="stageL" class="stage-agent left muted">connecting…</div>
        <div class="stage-mid"><div class="ex">⇄</div></div>
        <div id="stageR" class="stage-agent right"></div>
      </div>
      <div class="stage-status" id="stageStatus"><span class="faint">Opening a channel between the two agents…</span></div>
    </div>
    <div class="live-controls">
      <button class="ghost small" id="voiceToggle">🔈 Auto-play voices: off</button>
      <button class="ghost small" id="voiceStop">■ Stop audio</button>
      <div class="spacer"></div>
      <span class="faint" id="liveCount"></span>
    </div>
    <div class="transcript live-transcript" id="liveTranscript"></div>
    <div id="liveFoot"></div>`;

  const $status = $('#stageStatus');
  const $tx = $('#liveTranscript');
  const $count = $('#liveCount');

  const setThinking = (role) => {
    if (finished) return;
    const nm = names[role];
    const col = role === 'candidate' ? 'var(--accent)' : 'var(--accent-2)';
    $status.innerHTML = `<span class="thinking-name" style="color:${col}">${esc(nm)}</span> is thinking<span class="dots"><i></i><i></i><i></i></span>`;
  };

  $('#liveBack').addEventListener('click', () => { ctrl.abort(); stopSpeech(); state.tab = 'jobs'; route(); });
  $('#voiceToggle').addEventListener('click', (e) => {
    autoVoice = !autoVoice;
    e.target.textContent = `${autoVoice ? '🔊' : '🔈'} Auto-play voices: ${autoVoice ? 'on' : 'off'}`;
    if (!autoVoice) stopSpeech();
  });
  $('#voiceStop').addEventListener('click', stopSpeech);

  const onEvent = (type, data) => {
    if (type === 'meta') {
      names = { candidate: data.candidate?.displayName || 'Candidate', employer: data.employer?.displayName || 'Recruiter' };
      voices = { candidate: data.candidate?.voice, employer: data.employer?.voice };
      $('#stageL').outerHTML = stageAgentHtml(data.candidate, 'left');
      $('#stageR').outerHTML = stageAgentHtml(data.employer, 'right');
      setThinking('candidate');
    } else if (type === 'turn') {
      count++;
      $tx.insertAdjacentHTML('beforeend', liveBubbleHtml(data));
      const node = document.getElementById(data.id);
      if (node) {
        node.querySelector('[data-speak]')?.addEventListener('click', () => { stopSpeech(); speak(data.text, data.speaker?.voice); });
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      $count.textContent = `${count} turn${count === 1 ? '' : 's'}`;
      if (autoVoice) speak(data.text, data.speaker?.voice);
      setThinking(other(data.role));
    } else if (type === 'done') {
      finished = true;
      $status.innerHTML = `<span class="ok">✓ Parley complete</span> <span class="faint">· ${esc(data.endedReason || '')}</span>`;
      $('#liveFoot').innerHTML = `<div class="done-bar"><div><b>The agents are done.</b> <span class="muted">Each side's report — claims, provenance, and your agent's read — is ready.</span></div><button class="primary" id="openReport">Open your report →</button></div>`;
      $('#openReport').addEventListener('click', () => { stopSpeech(); state.tab = 'applications'; state.convId = data.id; route(); });
      toast('Parley complete — your report is ready');
    } else if (type === 'error') {
      finished = true;
      $status.innerHTML = `<span class="err">✕ ${esc(data.error || 'the parley failed')}</span>`;
    }
  };

  streamApply(job.id, onEvent, ctrl.signal).catch((e) => {
    if (ctrl.signal.aborted) return;
    finished = true;
    $status.innerHTML = `<span class="err">✕ ${esc(e.message || 'connection lost')}</span>`;
  });
}

async function candApplicationsView() {
  const apps = await api('GET', '/api/me/applications');
  if (!apps.length) return (view().innerHTML = emptyState('No applications yet. Browse <b>Jobs</b> and hit Apply.'));
  view().innerHTML = `<h2 style="margin-bottom:14px">My applications</h2>` + apps.map((c) => `
    <div class="conv-item" data-conv="${c.id}">
      <span class="status ${c.status}">${esc(c.status)}</span>
      <div style="flex:1">${esc(c.jobTitle || 'Role')} <span class="muted">@ ${esc(c.company || '')}</span></div>
      <span class="muted">${c.turns} turns</span>
    </div>`).join('');
  wireConvRows();
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERVIEWER APP
// ─────────────────────────────────────────────────────────────────────────────
const EMP_TABS = [
  { id: 'profile', label: 'My Recruiting Agent' },
  { id: 'postings', label: 'Postings' },
  { id: 'applicants', label: 'Applicants' },
];

async function renderEmployer() {
  if (!state.tab) state.tab = 'profile';
  frame(EMP_TABS, `<div class="muted">Loading…</div>`);
  if (state.tab === 'profile') return empProfileView();
  if (state.tab === 'postings') return empPostingsView();
  if (state.tab === 'applicants') return state.convId ? detailView('employer') : empApplicantsView();
}

async function empProfileView() {
  const { profile } = await api('GET', '/api/me/profile');
  view().innerHTML = `
    <div class="card" style="max-width:560px">
      <h3>🏢 Your recruiting agent</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">These defaults apply to every job you post. Persona is style only — it never changes the facts.</div>
      <form id="empForm">
        <label>Company</label><input name="company" value="${esc(profile.company || '')}" placeholder="Acme Robotics" />
        <label>Agent persona / tone</label><input name="persona" value="${esc(profile.persona || 'warm, professional')}" />
        <label>Agent voice</label><select name="voice"><option value="employer" ${profile.voice?.name !== 'dev' ? 'selected' : ''}>measured (lower)</option><option value="dev" ${profile.voice?.name === 'dev' ? 'selected' : ''}>bright</option></select>
        <div style="margin-top:14px"><button class="primary" type="submit">Save recruiting agent</button></div>
      </form>
    </div>`;
  const voicePresets = { employer: { rate: 0.95, pitch: 0.85 }, dev: { rate: 1.1, pitch: 0.95 } };
  $('#empForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const vName = f.voice.value;
    try {
      await api('PUT', '/api/me/profile', { company: f.company.value, persona: f.persona.value, voice: { name: vName, ...voicePresets[vName] }, avatar: { emoji: '🤖', color: '#27c498' } });
      state.me.hasProfile = true;
      toast('Recruiting agent saved');
    } catch (err) { toast(err.message); }
  });
}

async function empPostingsView() {
  const jobs = await api('GET', '/api/me/jobs');
  view().innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>Post a job</h3>
        <form id="jobForm">
          <label>Title</label><input name="title" value="Staff Engineer" />
          <div class="row"><div style="flex:1"><label>Salary min</label><input name="salaryMin" type="number" value="180000" /></div>
          <div style="flex:1"><label>Salary max</label><input name="salaryMax" type="number" value="230000" /></div></div>
          <label><input type="checkbox" name="visa" checked style="width:auto;margin-right:8px" />Visa sponsorship available</label>
          <div class="row"><div style="flex:1"><label>Work mode</label><select name="remote"><option>hybrid</option><option>remote</option><option>onsite</option></select></div>
          <div style="flex:1"><label>Location</label><input name="location" value="New York" /></div></div>
          <label>Requirements (comma-separated)</label><input name="requirements" value="Go, distributed systems, leadership, 7+ years" />
          <label>Things your agent can answer (one per line)</label><textarea name="notes" placeholder="The stack is Go + Kubernetes on GCP
The team is 8 engineers">The stack is Go, Kubernetes, and gRPC on GCP
The team is 8 engineers; this opens a new reliability pod</textarea>
          <div style="margin-top:14px"><button class="primary" type="submit">Post job</button></div>
        </form>
      </div>
      <div>
        <h3>Your postings</h3>
        ${jobs.length ? jobs.map((j) => `
          <div class="tile" style="margin-bottom:12px">
            <div class="row"><h3 style="flex:1">${esc(j.title)}</h3><span class="pill">${j.applicants} applicant${j.applicants === 1 ? '' : 's'}</span></div>
            <div class="kv"><b>Salary</b> ${esc(j.currency)} ${j.salaryMin.toLocaleString()}–${j.salaryMax.toLocaleString()}</div>
            <div class="kv"><b>Mode</b> ${esc(j.remote)} · ${esc(j.location)}</div>
            <button class="ghost small" data-applicants>View applicants →</button>
          </div>`).join('') : '<div class="card muted">No postings yet.</div>'}
      </div>
    </div>`;

  $('#jobForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/me/jobs', {
        title: f.title.value, salaryMin: +f.salaryMin.value, salaryMax: +f.salaryMax.value,
        visaSponsorship: f.visa.checked, remote: f.remote.value, location: f.location.value,
        requirements: list(f.requirements.value), notes: lines(f.notes.value),
      });
      toast('Job posted'); empPostingsView();
    } catch (err) { toast(err.message); }
  });
  view().querySelectorAll('[data-applicants]').forEach((b) => b.addEventListener('click', () => { state.tab = 'applicants'; state.convId = null; route(); }));
}

async function empApplicantsView() {
  const apps = await api('GET', '/api/me/applicants');
  if (!apps.length) return (view().innerHTML = emptyState('No applicants yet. When a candidate applies, their parley shows up here.'));
  view().innerHTML = `<h2 style="margin-bottom:14px">Applicants</h2>` + apps.map((c) => `
    <div class="conv-item" data-conv="${c.id}">
      <span class="status ${c.status}">${esc(c.status)}</span>
      <div style="flex:1"><b>${esc(c.candidateName || 'Candidate')}</b> <span class="muted">→ ${esc(c.jobTitle || '')}</span></div>
      <span class="muted">${c.turns} turns</span>
    </div>`).join('');
  wireConvRows();
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: a single parley (one report — the viewer's own)
// ─────────────────────────────────────────────────────────────────────────────
function wireConvRows() {
  view().querySelectorAll('[data-conv]').forEach((row) => row.addEventListener('click', () => { state.convId = row.getAttribute('data-conv'); route(); }));
}

async function detailView(viewerRole) {
  const c = await api('GET', '/api/conversations/' + state.convId);
  const turnsById = Object.fromEntries(c.turns.map((t) => [t.id, t]));
  const backLabel = viewerRole === 'candidate' ? '← my applications' : '← applicants';

  const transcript = c.turns.map((t) => `
    <div class="bubble ${t.role}" id="${esc(t.id)}">
      <div class="avatar" style="background:${esc(t.speaker?.avatar?.color || '#444')}22;border-color:${esc(t.speaker?.avatar?.color || '#444')}">${esc(t.speaker?.avatar?.emoji || '🤖')}</div>
      <div class="body">
        <div class="meta"><b>${esc(t.speaker?.displayName || t.role)}</b><button class="play" data-speak="${esc(t.id)}" title="listen">▶</button><span class="faint">${t.audioTs}s</span></div>
        <div class="text">${esc(t.text)}</div>
        ${t.note ? `<div class="note">⚙ ${esc(t.note)}</div>` : ''}
      </div>
    </div>`).join('');

  const report = c.reports[viewerRole];
  const reportHtml = report ? `
    <div class="report">
      <h3>${viewerRole === 'candidate' ? '🧑‍💻 Your agent’s report on the company' : '🏢 Your agent’s report on the candidate'}</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:8px">Claims with provenance, then your agent’s read. You decide — the agent never scores.</div>
      ${report.learned.length ? report.learned.slice().sort((a, b) => b.rank - a.rank).map(claimCard).join('') : '<div class="muted">Nothing concrete learned.</div>'}
      <div class="read"><div class="lbl">⚑ Agent’s read · inference, not a verdict</div>${esc(report.read)}</div>
    </div>` : '<div class="muted">No report.</div>';

  const claimsHtml = c.claims.length ? c.claims.slice().sort((a, b) => b.rank - a.rank).map(claimCard).join('') : '<div class="muted">No claims surfaced.</div>';
  const agendaList = (items, kind) => items.length ? items.map((a) => `<div class="agenda-item">${esc(a)}</div>`).join('') : `<div class="agenda-item done">✓ all ${kind} questions answered</div>`;
  const followups = c.followups.length ? c.followups.map((f) => `<div class="agenda-item ${f.status === 'resolved' ? 'done' : ''}">🔎 ${esc(f.answeredBy)} fetched “${esc(f.topic)}” → ${esc(f.resolution || 'pending')}</div>`).join('') : '<div class="muted">No followups were needed.</div>';

  view().innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <button class="ghost" id="backBtn">${backLabel}</button>
      <div class="spacer"></div>
      <span class="status ${c.status}">${esc(c.status)}</span><span class="muted">${esc(c.endedReason || '')}</span>
    </div>
    <div class="parley">
      <div>
        <div class="row" style="margin-bottom:10px"><button id="playAll" class="primary">▶ Play the recording</button><button class="ghost" id="stopAll">■ Stop</button></div>
        <div class="transcript">${transcript}</div>
      </div>
      <div>
        <div class="side-tabs"><button class="active" data-side="report">Your report</button><button data-side="claims">All claims (${c.claims.length})</button><button data-side="agendas">Agendas</button></div>
        <div id="sideReport" class="side-pane">${reportHtml}</div>
        <div id="sideClaims" class="side-pane" style="display:none"><div class="muted" style="font-size:12.5px;margin-bottom:8px">Every claim surfaced. Click a <span class="src-link">↳ source</span> to jump to the moment it was said.</div>${claimsHtml}</div>
        <div id="sideAgendas" class="side-pane" style="display:none"><div class="card">
          <div class="agenda-col"><h4>Candidate still wanted to know</h4>${agendaList(c.openAgenda.candidate, 'candidate')}</div>
          <div class="agenda-col" style="margin-top:14px"><h4>Interviewer still wanted to know</h4>${agendaList(c.openAgenda.employer, 'employer')}</div>
          <div class="agenda-col" style="margin-top:14px"><h4>Followups</h4>${followups}</div>
        </div></div>
      </div>
    </div>`;

  $('#backBtn').addEventListener('click', () => { stopSpeech(); state.convId = null; route(); });
  view().querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => {
    view().querySelectorAll('[data-side]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const w = b.getAttribute('data-side');
    $('#sideReport').style.display = w === 'report' ? '' : 'none';
    $('#sideClaims').style.display = w === 'claims' ? '' : 'none';
    $('#sideAgendas').style.display = w === 'agendas' ? '' : 'none';
  }));
  wireClaimSources(turnsById);
  view().querySelectorAll('[data-speak]').forEach((b) => b.addEventListener('click', () => { const t = turnsById[b.getAttribute('data-speak')]; stopSpeech(); if (t) speak(t.text, t.speaker?.voice); }));
  $('#playAll').addEventListener('click', () => {
    stopSpeech(); let i = 0;
    const next = () => {
      view().querySelectorAll('.bubble.flash').forEach((n) => n.classList.remove('flash'));
      if (i >= c.turns.length) return;
      const t = c.turns[i++]; const node = document.getElementById(t.id);
      if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.classList.add('flash'); }
      speak(t.text, t.speaker?.voice, next);
    };
    next();
  });
  $('#stopAll').addEventListener('click', () => { stopSpeech(); view().querySelectorAll('.bubble.flash').forEach((n) => n.classList.remove('flash')); });
}

function wireClaimSources(turnsById) {
  view().querySelectorAll('[data-turn]').forEach((lnk) => lnk.addEventListener('click', () => {
    const ref = lnk.getAttribute('data-turn');
    const node = document.getElementById(ref);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1400);
    const t = turnsById && turnsById[ref];
    if (t) { stopSpeech(); speak(t.text, t.speaker?.voice); }
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
function route() {
  stopSpeech();
  if (!state.me) return renderAuth();
  if (state.me.role === 'candidate') return renderCandidate();
  return renderEmployer();
}

async function boot() {
  try { state.config = await api('GET', '/api/config'); } catch { state.config = {}; }
  try { const { user } = await api('GET', '/api/auth/me'); state.me = user; } catch { state.me = null; }
  route();
}

boot();
