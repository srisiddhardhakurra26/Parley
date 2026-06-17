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

// ── theme (light / dark) ─────────────────────────────────────────────────────
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }
function themeIcon(t) {
  return t === 'dark'
    // sun — shown while dark, click goes back to light
    ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`
    // moon — shown while light
    : `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>`;
}
function themeBtn() { return `<button class="icon-btn" id="themeBtn" title="Toggle light / dark" aria-label="Toggle theme">${themeIcon(currentTheme())}</button>`; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('parley_theme', t); } catch {}
  const b = document.getElementById('themeBtn');
  if (b) b.innerHTML = themeIcon(t);
}
function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
function initTheme() {
  let t = null;
  try { t = localStorage.getItem('parley_theme'); } catch {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
}

// ── notifications (unread direct messages) ───────────────────────────────────
const BELL_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;
let notif = { total: 0, items: [] };
let notifTimer = null;
let notifPrimed = false;

function bellBtn() {
  return `<button class="icon-btn notif-btn" id="notifBtn" title="Messages" aria-label="Notifications">${BELL_SVG}${notif.total ? `<span class="notif-badge">${notif.total > 9 ? '9+' : notif.total}</span>` : ''}</button>`;
}
function renderBell() {
  const btn = document.getElementById('notifBtn');
  if (btn) btn.innerHTML = BELL_SVG + (notif.total ? `<span class="notif-badge">${notif.total > 9 ? '9+' : notif.total}</span>` : '');
}
async function pollNotifications() {
  if (!state.me) return;
  let data;
  try { data = await api('GET', '/api/notifications'); } catch { return; }
  const prev = notif.total;
  notif = { total: data.total || 0, items: data.items || [] };
  renderBell();
  if (notifPrimed && notif.total > prev && notif.items[0]) {
    const it = notif.items[0];
    toast(`💬 ${it.otherName}: ${String(it.lastText).slice(0, 48)}`);
  }
  notifPrimed = true;
}
function startNotifPoll() { stopNotifPoll(); notifPrimed = false; pollNotifications(); notifTimer = setInterval(pollNotifications, 10000); }
function stopNotifPoll() { if (notifTimer) { clearInterval(notifTimer); notifTimer = null; } }

function toggleNotifMenu() {
  const existing = document.getElementById('notifMenu');
  if (existing) { existing.remove(); document.removeEventListener('click', closeNotifOutside); return; }
  const menu = document.createElement('div');
  menu.id = 'notifMenu';
  menu.className = 'notif-menu';
  menu.innerHTML = notif.items.length
    ? notif.items.map((it) => `<button class="notif-item" data-conv="${it.conversationId}">
        <div class="notif-row"><b>${esc(it.otherName)}</b><span class="notif-count">${it.unread}</span></div>
        ${it.jobTitle ? `<div class="notif-sub">${esc(it.jobTitle)}</div>` : ''}
        <div class="notif-last">${esc(String(it.lastText).slice(0, 72))}</div>
      </button>`).join('')
    : `<div class="notif-empty muted">No unread messages</div>`;
  document.body.appendChild(menu);
  const btn = document.getElementById('notifBtn');
  if (btn) { const r = btn.getBoundingClientRect(); menu.style.top = `${r.bottom + 8}px`; menu.style.right = `${window.innerWidth - r.right}px`; }
  menu.querySelectorAll('[data-conv]').forEach((b) => b.addEventListener('click', () => { const cid = b.getAttribute('data-conv'); menu.remove(); document.removeEventListener('click', closeNotifOutside); openConversationMessages(cid); }));
  setTimeout(() => document.addEventListener('click', closeNotifOutside), 0);
}
function closeNotifOutside(e) {
  const menu = document.getElementById('notifMenu');
  if (menu && !menu.contains(e.target) && !e.target.closest('#notifBtn')) { menu.remove(); document.removeEventListener('click', closeNotifOutside); }
}
function openConversationMessages(cid) {
  state.convId = cid;
  state.tab = state.me.role === 'candidate' ? 'applications' : 'applicants';
  state.openMessages = true;
  route();
}

const state = { me: null, config: {}, tab: null, convId: null, openMessages: false };

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
    if (e.kind === 'document' && String(e.ref).startsWith('source:')) return `<a class="src-link" href="/api/sources/${esc(String(e.ref).slice(7))}/raw" target="_blank" rel="noopener" title="open the uploaded document">📄 ${esc(e.label || 'document')}</a>`;
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
  return `<header class="top"><div class="brand">⚖ <span class="wordmark">Parley</span> <small>${tag}</small></div><div class="spacer"></div>${me ? bellBtn() : ''}${themeBtn()}${right}</header>`;
}

function frame(tabs, bodyHtml) {
  const nav = tabs.length
    ? `<nav class="tabs">${tabs.map((t) => `<button data-tab="${t.id}" class="${t.id === state.tab ? 'active' : ''}">${esc(t.label)}</button>`).join('')}</nav>` : '';
  app().innerHTML = header() + nav + `<main id="view">${bodyHtml}</main>`;
  const lo = $('#logoutBtn');
  if (lo) lo.addEventListener('click', async () => { stopNotifPoll(); notif = { total: 0, items: [] }; await api('POST', '/api/auth/logout'); state.me = null; state.tab = null; state.convId = null; route(); });
  document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
  document.getElementById('notifBtn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleNotifMenu(); });
  app().querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.convId = null; route(); }));
}

function emptyState(html) { return `<div class="empty">${html}</div>`; }

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
let authTab = 'login';
let signupRole = 'candidate';

// Crisp line-icons for the hero (emoji render inconsistently across platforms).
const HERO_ICON = {
  verified: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>`,
  control: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  fast: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
};

function renderAuth() {
  const isSignup = authTab === 'signup';
  const showGoogle = !!(state.config.googleConfigured && state.config.googleClientId);

  app().innerHTML = `
    <div class="auth-shell" data-mode="${isSignup ? 'signup' : 'login'}">
      <aside class="auth-hero">
        <div class="hero-brand">⚖ <span>Parley</span></div>
        <div class="hero-mid">
          <h1 class="hero-title">Two agents parley.<br/>You decide.</h1>
          <p class="hero-sub">Each side sets up an AI agent. They trade verifiable information and report back — the human always makes the final call.</p>
          <div class="parley-preview">
            <span class="pp-chip">🧑‍💻 Candidate’s agent</span>
            <span class="pp-ex">⇄</span>
            <span class="pp-chip">🏢 Recruiter’s agent</span>
          </div>
        </div>
        <ul class="hero-features">
          <li class="hero-feature"><span class="hf-ico">${HERO_ICON.verified}</span><div><b>Verifiable claims, not vibes</b><span>Every fact an agent shares carries its own provenance.</span></div></li>
          <li class="hero-feature"><span class="hf-ico">${HERO_ICON.control}</span><div><b>You stay in control</b><span>Agents gather and report. They never score or decide for you.</span></div></li>
          <li class="hero-feature"><span class="hf-ico">${HERO_ICON.fast}</span><div><b>Live in minutes</b><span>Set up your agent, then watch the conversation unfold.</span></div></li>
        </ul>
      </aside>

      <main class="auth-panel">
        <div class="auth-controls">${providerBadge()}${themeBtn()}</div>
        <div class="auth-box">
          <h2>${isSignup ? 'Create your account' : 'Welcome back'}</h2>
          <p class="auth-sub">${isSignup ? 'Choose how you’ll use Parley — it only takes a moment.' : 'Log in to pick up where your agents left off.'}</p>

          ${isSignup ? `
          <div class="role-cards">
            <button type="button" class="role-card ${signupRole === 'candidate' ? 'sel' : ''}" data-role="candidate">
              <span class="rc-icon">🧑‍💻</span>
              <span class="rc-title">I’m job seeking</span>
              <span class="rc-sub">An agent that represents you to employers.</span>
              <span class="rc-check">✓</span>
            </button>
            <button type="button" class="role-card ${signupRole === 'employer' ? 'sel' : ''}" data-role="employer">
              <span class="rc-icon">🏢</span>
              <span class="rc-title">I’m hiring</span>
              <span class="rc-sub">Screen candidates with your recruiting agent.</span>
              <span class="rc-check">✓</span>
            </button>
          </div>
          <div class="field"><label>${signupRole === 'candidate' ? 'Your name' : 'Your name or company'}</label><input id="su_name" placeholder="${signupRole === 'candidate' ? 'e.g. Maya Chen' : 'e.g. Priya · Acme'}" /></div>
          ` : ''}

          <div class="field"><label>Email</label><input id="au_email" type="email" autocomplete="email" placeholder="you@example.com" /></div>
          <div class="field"><label>Password</label><input id="au_pw" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="••••••••" /></div>
          <button class="primary block btn-lg" id="au_submit">${isSignup ? 'Create account →' : 'Log in →'}</button>

          ${showGoogle ? `<div class="divider"><span>or</span></div><div id="googleSlot"></div>` : ''}

          <p class="auth-switch">${isSignup ? 'Already have an account? <a data-switch="login">Log in</a>' : 'New to Parley? <a data-switch="signup">Create an account</a>'}</p>
        </div>
      </main>
    </div>`;

  document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => { signupRole = b.dataset.role; renderAuth(); }));
  document.querySelectorAll('[data-switch]').forEach((a) => a.addEventListener('click', () => { authTab = a.dataset.switch; renderAuth(); }));
  $('#au_submit').addEventListener('click', submitAuth);
  document.querySelectorAll('#au_email, #au_pw, #su_name').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); }));
  if (showGoogle) setupGoogle($('#googleSlot'));
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
  startNotifPoll();
}

// Real Google Identity Services button — only shown when GOOGLE_CLIENT_ID is set.
function setupGoogle(slot) {
  if (!slot || !(state.config.googleConfigured && state.config.googleClientId)) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    window.google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: onGoogleCredential });
    window.google.accounts.id.renderButton(slot, { theme: currentTheme() === 'dark' ? 'filled_black' : 'outline', size: 'large', width: 320, text: 'continue_with' });
  };
  document.head.appendChild(s);
}

async function onGoogleCredential(resp) {
  try {
    const payload = { credential: resp.credential };
    if (authTab === 'signup') { payload.role = signupRole; payload.displayName = $('#su_name')?.value.trim(); }
    const { user } = await api('POST', '/api/auth/google', payload);
    onAuthed(user);
  } catch (e) {
    if (e.needRole) { toast('Choose a role on the sign-up screen first.'); authTab = 'signup'; renderAuth(); }
    else toast(e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDIDATE APP
// ─────────────────────────────────────────────────────────────────────────────
const CAND_TABS = [
  { id: 'agent', label: 'My Agent' },
  { id: 'sources', label: 'Sources' },
  { id: 'jobs', label: 'Browse Jobs' },
  { id: 'applications', label: 'My Applications' },
  { id: 'connector', label: 'Connector' },
];

async function renderCandidate() {
  if (!state.tab) state.tab = state.me.hasAgent ? 'jobs' : 'agent';
  frame(CAND_TABS, `<div class="muted">Loading…</div>`);
  if (state.tab === 'agent') return candAgentView();
  if (state.tab === 'sources') return sourcesView();
  if (state.tab === 'jobs') return candJobsView();
  if (state.tab === 'applications') return state.convId ? detailView('candidate') : candApplicationsView();
  if (state.tab === 'connector') return connectorView();
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
          <label>How should your agent talk & answer? <span class="faint">(optional — style & strategy only)</span></label>
          <textarea name="instructions" placeholder="e.g. Be concise and confident. Lead with my Kubernetes depth. Always ask about on-call load before discussing comp.">${esc(agent?.instructions || '')}</textarea>
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
        github: f.github.value, githubVerifiedSkills: list(f.githubVerifiedSkills.value), instructions: f.instructions.value,
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
      <div class="applybar"><button class="primary" data-apply="${j.id}" ${canApply ? '' : 'disabled'}>Apply ▶</button><span class="faint">lines up the parley — you start it when ready</span></div>
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

function stageAgentHtml(a, side, id) {
  const idAttr = id ? ` id="${id}"` : '';
  if (!a) return `<div${idAttr} class="stage-agent ${side}"></div>`;
  const col = a.avatar?.color || '#888';
  return `<div${idAttr} class="stage-agent ${side}">
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

// Pre-flight first: line up both agents and wait. The model is NOT touched —
// no tokens are spent — until the human explicitly presses "Start the parley".
async function startLiveParley(job) {
  stopSpeech();

  let cand = null;
  try { const r = await api('GET', '/api/me/agent'); cand = r.agent; } catch {}
  const candMeta = cand
    ? { displayName: cand.displayName, avatar: cand.avatar, voice: cand.voice, principalName: state.me.displayName }
    : { displayName: `${state.me.displayName}'s agent`, avatar: { emoji: '🧑‍💻', color: '#6c8cff' }, principalName: state.me.displayName };
  const empMeta = job.employer || { displayName: `${job.company} recruiting agent`, avatar: { emoji: '🏢', color: '#27c498' }, principalName: job.company };
  const model = String(state.config?.provider || '').split(':').pop();
  const costLabel = state.config?.hasKey ? `⚡ live AI · ${esc(model)}` : '⚙ deterministic mock';

  view().innerHTML = `
    <div class="row" style="margin-bottom:18px">
      <button class="ghost" id="liveBack">← back to jobs</button>
      <div class="spacer"></div>
      <span class="badge live"><i class="livedot"></i> live parley</span>
    </div>
    <div class="stage card">
      <div class="stage-head">
        ${stageAgentHtml(candMeta, 'left', 'stageL')}
        <div class="stage-mid"><div class="ex">⇄</div></div>
        ${stageAgentHtml(empMeta, 'right', 'stageR')}
      </div>
      <div class="stage-status" id="stageStatus"><span class="faint">Both agents are briefed and standing by.</span></div>
    </div>
    <div class="preflight" id="preflight">
      <div class="preflight-head">
        <div>
          <h3 style="margin:0">Ready to start the conversation</h3>
          <div class="muted" style="margin-top:6px">Your agent will parley with <b>${esc(empMeta.displayName)}</b> about the <b>${esc(job.title)}</b> role.</div>
        </div>
        <span class="cost-chip">${costLabel}</span>
      </div>
      <p class="preflight-note">Nothing runs until you press start. The two agents only begin exchanging information — and spending AI inference — on your go, so you stay in control of when tokens are used. You can stop any time.</p>
      <div class="preflight-actions">
        <button class="primary btn-lg" id="startParley">▶&nbsp; Start the parley</button>
        <button class="ghost" id="cancelParley">Not now</button>
      </div>
    </div>
    <div class="live-controls" id="liveControls" style="display:none">
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

  const goBack = () => { stopSpeech(); state.tab = 'jobs'; route(); };
  $('#liveBack').addEventListener('click', goBack);
  $('#cancelParley').addEventListener('click', goBack);
  $('#startParley').addEventListener('click', begin);

  // The model only fires here, on an explicit click.
  function begin() {
    const ctrl = new AbortController();
    let autoVoice = false;
    let names = { candidate: candMeta.displayName, employer: empMeta.displayName };
    let count = 0;
    let finished = false;

    $('#preflight')?.remove();
    const lc = $('#liveControls'); if (lc) lc.style.display = '';
    $('#liveBack').onclick = () => { ctrl.abort(); goBack(); };
    $('#voiceToggle').addEventListener('click', (e) => {
      autoVoice = !autoVoice;
      e.currentTarget.textContent = `${autoVoice ? '🔊' : '🔈'} Auto-play voices: ${autoVoice ? 'on' : 'off'}`;
      if (!autoVoice) stopSpeech();
    });
    $('#voiceStop').addEventListener('click', stopSpeech);

    const setThinking = (role) => {
      if (finished) return;
      const nm = names[role];
      const col = role === 'candidate' ? 'var(--accent)' : 'var(--accent-2)';
      $status.innerHTML = `<span class="thinking-name" style="color:${col}">${esc(nm)}</span> is thinking<span class="dots"><i></i><i></i><i></i></span>`;
    };
    setThinking('candidate');

    const onEvent = (type, data) => {
      if (type === 'meta') {
        names = { candidate: data.candidate?.displayName || names.candidate, employer: data.employer?.displayName || names.employer };
        $('#stageL').outerHTML = stageAgentHtml(data.candidate, 'left', 'stageL');
        $('#stageR').outerHTML = stageAgentHtml(data.employer, 'right', 'stageR');
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
  { id: 'sources', label: 'Sources' },
  { id: 'postings', label: 'Postings' },
  { id: 'applicants', label: 'Applicants' },
  { id: 'connector', label: 'Connector' },
];

async function renderEmployer() {
  if (!state.tab) state.tab = 'profile';
  frame(EMP_TABS, `<div class="muted">Loading…</div>`);
  if (state.tab === 'profile') return empProfileView();
  if (state.tab === 'sources') return sourcesView();
  if (state.tab === 'postings') return empPostingsView();
  if (state.tab === 'applicants') return state.convId ? detailView('employer') : empApplicantsView();
  if (state.tab === 'connector') return connectorView();
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
        <label>How should your agent steer the conversation? <span class="faint">(optional — applies to every posting)</span></label>
        <textarea name="instructions" placeholder="e.g. Probe depth on distributed systems early. Be warm but get to notice period before comp. Never over-promise on salary.">${esc(profile.instructions || '')}</textarea>
        <label>Agent voice</label><select name="voice"><option value="employer" ${profile.voice?.name !== 'dev' ? 'selected' : ''}>measured (lower)</option><option value="dev" ${profile.voice?.name === 'dev' ? 'selected' : ''}>bright</option></select>
        <div style="margin-top:14px"><button class="primary" type="submit">Save recruiting agent</button></div>
      </form>
    </div>`;
  const voicePresets = { employer: { rate: 0.95, pitch: 0.85 }, dev: { rate: 1.1, pitch: 0.95 } };
  $('#empForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const vName = f.voice.value;
    try {
      await api('PUT', '/api/me/profile', { company: f.company.value, persona: f.persona.value, instructions: f.instructions.value, voice: { name: vName, ...voicePresets[vName] }, avatar: { emoji: '🤖', color: '#27c498' } });
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

// ─────────────────────────────────────────────────────────────────────────────
// SOURCES (uploaded documents → RAG in the parley + provenance in reports)
// ─────────────────────────────────────────────────────────────────────────────
const SRC_ICON = { resume: '📄', certificate: '🎓', portfolio: '🗂️', reference: '🔖', other: '📎' };

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function srcCard(s) {
  const meta = [`${s.chunks} chunk${s.chunks === 1 ? '' : 's'}`, s.chars ? `${s.chars} chars` : null, s.hasFile ? 'file attached' : null].filter(Boolean).join(' · ');
  return `<div class="src-item">
    <div class="src-ico">${SRC_ICON[s.kind] || '📎'}</div>
    <div style="flex:1;min-width:0">
      <div class="src-title">${esc(s.title)}</div>
      <div class="faint" style="font-size:12px">${esc(s.kind)} · ${meta}</div>
    </div>
    <a class="ghost small" href="/api/sources/${s.id}/raw" target="_blank" rel="noopener">Open</a>
    <button class="ghost small" data-del-src="${s.id}">Delete</button>
  </div>`;
}

async function sourcesView() {
  const sources = await api('GET', '/api/me/sources');
  const isCand = state.me.role === 'candidate';
  view().innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>📎 Add a document</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:6px">${isCand ? 'Résumé, degree certificates, references…' : 'Job descriptions, benefits, company handbook…'} The text is chunked so your agent can pull from it during a parley, and it’s linked — with provenance — in the report.</div>
        <form id="srcForm">
          <label>Title</label><input name="title" placeholder="${isCand ? 'Maya’s résumé' : 'Benefits overview'}" />
          <label>Type</label>
          <select name="kind">
            <option value="resume">Résumé / CV</option>
            <option value="certificate">Certificate / degree</option>
            <option value="portfolio">Portfolio</option>
            <option value="reference">Reference</option>
            <option value="other">Other</option>
          </select>
          <label>Attach a file <span class="faint">(optional)</span></label>
          <input type="file" name="file" id="srcFile" accept=".txt,.md,.csv,.json,.pdf,.doc,.docx,.png,.jpg,.jpeg" />
          <label>Text content <span class="faint">(what your agent reads — paste it for PDFs/images)</span></label>
          <textarea name="text" rows="6" placeholder="Paste the document’s text here so your agent can quote it…"></textarea>
          <div style="margin-top:14px"><button class="primary" type="submit">Add document</button></div>
        </form>
      </div>
      <div>
        <h3>Your documents</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">${sources.length} on file — they re-attach automatically whenever your agent is (re)built.</div>
        ${sources.length ? sources.map(srcCard).join('') : '<div class="card muted">No documents yet — add your first on the left.</div>'}
      </div>
    </div>`;

  let picked = null;
  $('#srcFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) { picked = null; return; }
    if (file.size > 10 * 1024 * 1024) { toast('File too large (max 10 MB)'); e.target.value = ''; return; }
    const buf = await file.arrayBuffer();
    picked = { fileName: file.name, mimeType: file.type || 'application/octet-stream', dataBase64: bufToB64(buf) };
    const f = $('#srcForm');
    if (!f.title.value.trim()) f.title.value = file.name.replace(/\.[^.]+$/, '');
    if (/^text\/|json|csv|markdown/i.test(file.type) || /\.(txt|md|csv|json)$/i.test(file.name)) {
      if (!f.text.value.trim()) f.text.value = new TextDecoder().decode(buf).slice(0, 20000);
    }
  });

  $('#srcForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { title: f.title.value, kind: f.kind.value, text: f.text.value };
    if (picked) Object.assign(body, picked);
    if (!body.text.trim() && !picked) return toast('Add some text or attach a file');
    try { await api('POST', '/api/me/sources', body); toast('Document added'); sourcesView(); }
    catch (err) { toast(err.message); }
  });

  view().querySelectorAll('[data-del-src]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this document? Its claims will be removed too.')) return;
    try { await api('DELETE', '/api/me/sources/' + b.getAttribute('data-del-src')); sourcesView(); }
    catch (err) { toast(err.message); }
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTOR (MCP endpoint — drive Parley from any assistant)
// ─────────────────────────────────────────────────────────────────────────────
async function connectorView() {
  const c = await api('GET', '/api/me/connector');
  const isCand = state.me.role === 'candidate';
  view().innerHTML = `
    <div class="card" style="max-width:720px">
      <h3>🔌 Parley connector <span class="pill" style="vertical-align:middle">MCP</span></h3>
      <div class="muted" style="font-size:13.5px;line-height:1.6;margin-bottom:18px">
        Add Parley to any MCP-compatible assistant (Claude, etc.) as a remote connector, then just talk to it:
        ${isCand
          ? '“what jobs are open?”, “apply to the staff backend role”, “update my résumé with this PDF”, “any messages from interviewers?”.'
          : '“post a senior Go role, hybrid in NYC, 180–230k”, “who applied?”, “message the candidate and set up a call”.'}
        It calls these tools for you and asks for anything it’s missing.
      </div>
      <label>Connector URL <span class="faint">(Streamable HTTP)</span></label>
      <div class="copy-row"><input id="connUrl" readonly value="${esc(c.url)}" /><button class="ghost small" id="copyUrl">Copy</button></div>
      <div class="muted" style="font-size:12px;margin-top:8px">The token in the URL authenticates as <b>${esc(state.me.displayName)}</b> · ${esc(c.role)}. Treat it like a password.</div>
      <h4 style="margin-top:24px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Tools exposed to your assistant</h4>
      <div class="wrap" id="connTools" style="margin-top:10px"><span class="muted">Loading…</span></div>
      <div class="row" style="margin-top:24px;gap:10px">
        <button class="ghost small" id="regenTok">Regenerate token</button>
        <span class="faint" style="font-size:12px">Invalidates the current URL.</span>
      </div>
    </div>`;

  const loadTools = async (url) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((x) => x.json());
      const tools = r?.result?.tools || [];
      $('#connTools').innerHTML = tools.map((t) => `<span class="pill" title="${esc(t.description)}">${esc(t.name)}</span>`).join('') || '<span class="muted">none</span>';
    } catch { $('#connTools').innerHTML = '<span class="muted">could not load tools</span>'; }
  };
  loadTools(c.url);

  $('#copyUrl').addEventListener('click', () => { navigator.clipboard?.writeText($('#connUrl').value); toast('Connector URL copied'); });
  $('#regenTok').addEventListener('click', async () => {
    if (!confirm('Regenerate the token? The old connector URL will stop working.')) return;
    const n = await api('POST', '/api/me/connector/regenerate');
    $('#connUrl').value = n.url; toast('New token generated'); loadTools(n.url);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT MESSAGES + live video call (the humans connect after their agents parley)
// ─────────────────────────────────────────────────────────────────────────────
let dmTimer = null;
function stopDMPoll() { if (dmTimer) { clearInterval(dmTimer); dmTimer = null; } }

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

const VIDEO_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2.5" ry="2.5"/></svg>`;

function dmBubble(m) {
  if (m.kind === 'system') return `<div class="dm-sys">${esc(m.text)}</div>`;
  if (m.kind === 'call') {
    const when = m.callTime ? `Suggested ${esc(fmtTime(m.callTime))}` : 'Join anytime';
    return `<div class="dm-msg call ${m.mine ? 'mine' : ''}">
      <div class="dm-call">
        <div class="dm-call-icon">${VIDEO_SVG}</div>
        <div class="dm-call-body">
          <div class="dm-call-title">Live video call</div>
          <div class="dm-call-sub">${when} · ${esc(m.fromName)}</div>
        </div>
        <a class="dm-call-join" href="${esc(m.callUrl)}" target="_blank" rel="noopener">Join</a>
      </div>
      <div class="dm-time">${esc(fmtTime(m.createdAt))}</div>
    </div>`;
  }
  return `<div class="dm-msg ${m.mine ? 'mine' : ''}">
    <div class="dm-text">${esc(m.text)}</div>
    <div class="dm-time">${m.mine ? '' : esc(m.fromName) + ' · '}${esc(fmtTime(m.createdAt))}</div>
  </div>`;
}

async function loadDMs(convId) {
  let msgs = [];
  try { msgs = await api('GET', `/api/conversations/${convId}/dms`); } catch { return; }
  const thread = $('#dmThread');
  if (!thread) { stopDMPoll(); return; }
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 50;
  thread.innerHTML = msgs.length ? msgs.map(dmBubble).join('') : `<div class="dm-empty muted">No messages yet. If your agents found a fit, reach out — say hello, or drop a call link.</div>`;
  if (atBottom) thread.scrollTop = thread.scrollHeight;
}

function openMessages(convId, otherName) {
  api('POST', `/api/conversations/${convId}/read`).then(pollNotifications).catch(() => {});
  loadDMs(convId);
  stopDMPoll();
  dmTimer = setInterval(() => {
    if (!$('#dmThread')) { stopDMPoll(); return; }
    loadDMs(convId);
    api('POST', `/api/conversations/${convId}/read`).catch(() => {});
  }, 4000);
  const form = $('#dmForm');
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = $('#dmInput'); const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      try { await api('POST', `/api/conversations/${convId}/dms`, { text }); await loadDMs(convId); }
      catch (err) { toast(err.message); }
    });
  }
  const call = $('#scheduleCall');
  if (call && !call.dataset.wired) {
    call.dataset.wired = '1';
    call.addEventListener('click', async () => {
      try { await api('POST', `/api/conversations/${convId}/call`, {}); toast('Call link sent'); await loadDMs(convId); }
      catch (err) { toast(err.message); }
    });
  }
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

  const otherName = viewerRole === 'candidate' ? (c.employer?.principalName || 'the interviewer') : (c.candidate?.principalName || 'the candidate');
  const report = c.reports[viewerRole];
  const connectCta = `
    <div class="connect-cta">
      <span class="muted">Like what your agent found? Take it from here:</span>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="ghost small" id="goMessages">💬 Message ${esc(otherName)}</button>
        <button class="primary small" id="reportCall">📹 Schedule a video call</button>
      </div>
    </div>`;
  const reportHtml = report ? `
    <div class="report">
      <h3>${viewerRole === 'candidate' ? '🧑‍💻 Your agent’s report on the company' : '🏢 Your agent’s report on the candidate'}</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:8px">Claims with provenance, then your agent’s read. You decide — the agent never scores.</div>
      ${report.learned.length ? report.learned.slice().sort((a, b) => b.rank - a.rank).map(claimCard).join('') : '<div class="muted">Nothing concrete learned.</div>'}
      <div class="read"><div class="lbl">⚑ Agent’s read · inference, not a verdict</div>${esc(report.read)}</div>
      ${connectCta}
    </div>` : `<div class="muted">No report.</div>${connectCta}`;

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
        <div class="side-tabs"><button class="active" data-side="report">Report</button><button data-side="claims">Claims (${c.claims.length})</button><button data-side="agendas">Agendas</button><button data-side="messages">Messages</button></div>
        <div id="sideReport" class="side-pane">${reportHtml}</div>
        <div id="sideClaims" class="side-pane" style="display:none"><div class="muted" style="font-size:12.5px;margin-bottom:8px">Every claim surfaced. Click a <span class="src-link">↳ source</span> to jump to the moment it was said, or a <span class="src-link">📄 document</span> to open the file.</div>${claimsHtml}</div>
        <div id="sideAgendas" class="side-pane" style="display:none"><div class="card">
          <div class="agenda-col"><h4>Candidate still wanted to know</h4>${agendaList(c.openAgenda.candidate, 'candidate')}</div>
          <div class="agenda-col" style="margin-top:14px"><h4>Interviewer still wanted to know</h4>${agendaList(c.openAgenda.employer, 'employer')}</div>
          <div class="agenda-col" style="margin-top:14px"><h4>Followups</h4>${followups}</div>
        </div></div>
        <div id="sideMessages" class="side-pane" style="display:none">
          <div class="dm-panel">
            <div class="dm-head"><div>Direct messages with <b>${esc(otherName)}</b></div><button class="ghost small" id="scheduleCall">📹 Schedule call</button></div>
            <div class="dm-thread" id="dmThread"><div class="muted">Loading…</div></div>
            <form class="dm-compose" id="dmForm"><input id="dmInput" placeholder="Message ${esc(otherName)}…" autocomplete="off" /><button class="primary" type="submit">Send</button></form>
          </div>
        </div>
      </div>
    </div>`;

  const showSide = (w) => {
    view().querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('active', x.getAttribute('data-side') === w));
    $('#sideReport').style.display = w === 'report' ? '' : 'none';
    $('#sideClaims').style.display = w === 'claims' ? '' : 'none';
    $('#sideAgendas').style.display = w === 'agendas' ? '' : 'none';
    $('#sideMessages').style.display = w === 'messages' ? '' : 'none';
    if (w === 'messages') openMessages(state.convId, otherName); else stopDMPoll();
  };

  $('#backBtn').addEventListener('click', () => { stopSpeech(); stopDMPoll(); state.convId = null; route(); });
  view().querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => showSide(b.getAttribute('data-side'))));
  $('#goMessages')?.addEventListener('click', () => showSide('messages'));
  $('#reportCall')?.addEventListener('click', async () => {
    try { await api('POST', `/api/conversations/${state.convId}/call`, {}); toast('Call link sent'); showSide('messages'); }
    catch (err) { toast(err.message); }
  });
  if (state.openMessages) { state.openMessages = false; showSide('messages'); }
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
  stopDMPoll();
  if (!state.me) return renderAuth();
  if (state.me.role === 'candidate') return renderCandidate();
  return renderEmployer();
}

async function boot() {
  initTheme();
  try { state.config = await api('GET', '/api/config'); } catch { state.config = {}; }
  try { const { user } = await api('GET', '/api/auth/me'); state.me = user; } catch { state.me = null; }
  route();
  if (state.me) startNotifPoll();
}

boot();
