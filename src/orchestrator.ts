// The referee. Two agents never talk to each other directly — every turn goes
// through here. The orchestrator is what writes claims (so the model can't), what
// fences the other side's text as untrusted input, what enforces the turn budget
// and termination, and what runs the followup pause-and-resolve. Agents propose;
// the orchestrator disposes.

import { attachVerification, makeClaim, tierOf, TIER_LABEL } from './claims.ts';
import { factsFor } from './agents.ts';
import { buckets, getProvider, type SpeakContext } from './provider.ts';
import { id, now, store } from './store.ts';
import type {
  Agent, Claim, Conversation, Evidence, Followup, Report, Role, Turn,
} from './types.ts';

const MAX_TURNS = 14; // ~7 each — the budget that keeps two LLMs from rambling forever

/** Optional observer so a caller (e.g. the SSE endpoint) can watch the parley
 *  unfold turn-by-turn instead of only seeing the finished conversation. */
export interface ParleyHooks {
  onStart?: (conversationId: string) => void;
  onTurn?: (turn: Turn, speaker: Agent) => void | Promise<void>;
}

const STOP = new Set(['the','a','an','is','are','do','you','your','what','whats','how','and','or','of','to','for','in','on','with','this','that','any','we','our','will','about','tell','who','which','role','job','does','their','they','can']);
function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
/** Are two questions about the same thing? (used to retire asked agenda items) */
function similar(a: string, b: string): boolean {
  const aw = words(a);
  const bw = words(b);
  const overlap = [...aw].filter((w) => bw.has(w)).length;
  const sharedBucket = buckets(a).some((x) => buckets(b).includes(x));
  return overlap >= 2 || sharedBucket;
}

export async function runParley(jobId: string, candidateAgentId: string, hooks?: ParleyHooks): Promise<Conversation> {
  const job = store.getJob(jobId);
  if (!job) throw new Error('job not found');
  const candidate = store.getAgent(candidateAgentId);
  const employer = store.getAgent(job.employerAgentId);
  if (!candidate || !employer) throw new Error('agent not found');

  const provider = getProvider();
  const byRole: Record<Role, Agent> = { candidate, employer };

  const conv: Conversation = {
    id: id('conv'),
    jobId,
    candidateAgentId: candidate.id,
    employerAgentId: employer.id,
    status: 'running',
    turns: [],
    claimIds: [],
    openAgenda: { candidate: [...candidate.agenda], employer: [...employer.agenda] },
    followups: [],
    reports: {},
    createdAt: now(),
    updatedAt: now(),
  };
  store.putConversation(conv);
  hooks?.onStart?.(conv.id);

  const disclosed: Record<Role, Set<string>> = { candidate: new Set(), employer: new Set() };
  const satisfied: Record<Role, boolean> = { candidate: false, employer: false };
  let audioCursor = 0;
  let consecutiveIdle = 0;

  for (let i = 0; i < MAX_TURNS; i++) {
    const role: Role = i % 2 === 0 ? 'candidate' : 'employer';
    const other: Role = role === 'candidate' ? 'employer' : 'candidate';
    const speaker = byRole[role];

    // Followups this side fetched since its last turn, ready to deliver.
    const ready = conv.followups.filter((f) => f.answeredBy === role && f.status === 'resolved' && !f.resolvedTurnId);

    const ctx: SpeakContext = {
      self: {
        role,
        displayName: speaker.displayName,
        persona: speaker.persona,
        instructions: speaker.instructions,
        agendaOpen: conv.openAgenda[role],
        disclosure: speaker.disclosure,
        facts: factsFor(speaker.id),
        counterpartShared: [...disclosed[other]],
      },
      counterpartName: byRole[other].displayName,
      transcript: conv.turns.map((t) => ({ speaker: byRole[t.role].displayName, text: t.text })),
      resolvedFollowups: ready.map((f) => ({ topic: f.topic, resolution: f.resolution ?? '' })),
      turnsLeft: MAX_TURNS - i,
    };

    const result = await provider.speak(ctx);

    const dur = Math.max(2.5, Math.round((result.message.split(/\s+/).length / 2.6) * 10) / 10);
    const turn: Turn = {
      id: id('turn'),
      agentId: speaker.id,
      role,
      text: result.message,
      audioTs: audioCursor,
      intents: { answers: result.answers, asks: result.asks, followups: result.followups, satisfied: result.satisfied, escalate: result.escalate },
      createdAt: now(),
    };
    audioCursor = Math.round((audioCursor + dur) * 10) / 10;

    // Escalation — bounded gofer hands control to the human.
    if (result.escalate) {
      turn.note = `escalated to human: ${result.escalate}`;
      conv.turns.push(turn);
      await hooks?.onTurn?.(turn, speaker);
      conv.status = 'escalated';
      conv.endedReason = `Agent escalated: ${result.escalate}`;
      conv.updatedAt = now();
      store.putConversation(conv);
      break;
    }

    // The orchestrator — not the agent — writes claims from the disclosed answers.
    const newClaims: Claim[] = [];
    for (const ans of result.answers) {
      newClaims.push(conversationClaim(speaker.id, ans, turn));
      for (const b of buckets(ans.statement)) disclosed[role].add(b);
      if (ans.topic) for (const b of buckets(ans.topic)) disclosed[role].add(b);
    }
    if (newClaims.length) {
      store.putClaims(newClaims);
      conv.claimIds.push(...newClaims.map((c) => c.id));
    }

    // The asker burns its own agenda by putting the questions to the other side —
    // it has asked, so it stops re-asking; the answer arrives via the transcript
    // or a followup. This is what keeps two agents from looping forever.
    if (result.asks.length) {
      conv.openAgenda[role] = conv.openAgenda[role].filter((item) => !result.asks.some((a) => similar(item, a)));
    }

    // Followups: agent couldn't answer from its store → pause, fetch, deliver later.
    for (const topic of result.followups) {
      const f: Followup = { id: id('fup'), askedBy: other, answeredBy: role, topic, status: 'pending' };
      // Simulated async fetch completing (connector / ping-the-human).
      f.resolution = await provider.resolveFollowup({ topic, side: role, facts: factsFor(speaker.id) });
      f.status = 'resolved';
      conv.followups.push(f);
      turn.note = (turn.note ? turn.note + '; ' : '') + `fetching: ${topic}`;
    }
    // Mark just-delivered followups as delivered on this turn.
    for (const f of ready) f.resolvedTurnId = turn.id;

    satisfied[role] = result.satisfied || conv.openAgenda[role].length === 0;

    const idle = result.answers.length === 0 && result.asks.length === 0 && result.followups.length === 0;
    consecutiveIdle = idle ? consecutiveIdle + 1 : 0;

    conv.turns.push(turn);
    conv.updatedAt = now();
    store.putConversation(conv);
    await hooks?.onTurn?.(turn, speaker);

    // Termination: both agendas drained and every followup delivered, or a stall.
    const pendingFollowups = conv.followups.some((f) => !f.resolvedTurnId);
    const agendasDone = conv.openAgenda.candidate.length === 0 && conv.openAgenda.employer.length === 0;
    if ((agendasDone && !pendingFollowups) || consecutiveIdle >= 2) {
      conv.status = 'completed';
      conv.endedReason = consecutiveIdle >= 2 ? 'conversation stalled' : 'both agendas satisfied, all followups delivered';
      break;
    }
    if (i === MAX_TURNS - 1) {
      conv.status = 'completed';
      conv.endedReason = 'turn budget reached';
    }
  }

  if (conv.status === 'running') conv.status = 'completed';

  // Reports — each agent reports to its human: claims (with provenance) about the
  // OTHER side, plus a clearly-demoted inferred "read". Protected-class info is
  // filtered out before it can reach the human's decision.
  conv.reports.candidate = await buildReport(provider, conv, 'candidate', employer);
  conv.reports.employer = await buildReport(provider, conv, 'employer', candidate);

  conv.updatedAt = now();
  store.putConversation(conv);
  return conv;
}

function conversationClaim(speakerId: string, ans: { statement: string; sourceClaimId?: string; protectedClass?: boolean }, turn: Turn): Claim {
  const ev: Evidence = { kind: 'transcript', ref: turn.id, label: 'said in parley', audioTs: turn.audioTs };
  let claim = makeClaim({ subjectId: speakerId, statement: ans.statement, source: 'conversation', evidence: [ev], protectedClass: ans.protectedClass });

  // Inherit provenance from the underlying stored claim, if the answer cited one.
  // This is the orchestrator consulting its own store — NOT the model upgrading a
  // tier. It's what makes "said in parley, backed by GitHub" possible.
  const underlying = ans.sourceClaimId ? store.getClaim(ans.sourceClaimId) : undefined;
  if (underlying && underlying.subjectId === speakerId) {
    claim.evidence.push(...underlying.evidence);
    if (underlying.verification.status !== 'unverified') {
      claim = attachVerification(claim, underlying.verification.status, [...underlying.verification.by], `traces to a ${underlying.source.replace('_', '-')} claim`);
    } else if (underlying.source === 'third_party' || underlying.source === 'document') {
      claim = attachVerification(claim, 'corroborated', [{ kind: 'connector', ref: underlying.id, label: `${underlying.source.replace('_', '-')} record` }], `traces to a ${underlying.source.replace('_', '-')} claim`);
    }
  }
  return claim;
}

async function buildReport(provider: ReturnType<typeof getProvider>, conv: Conversation, audience: Role, counterpart: Agent): Promise<Report> {
  const learned = store
    .getClaims(conv.claimIds)
    .filter((c) => c.subjectId === counterpart.id && !c.protectedClass); // protected info never reaches the human
  const counterpartName = audience === 'candidate' ? counterpart.displayName : counterpart.principalName;
  const read = await provider.inferRead({
    audience,
    counterpartName,
    learned: learned.map((c) => ({ statement: c.statement, tier: TIER_LABEL[tierOf(c)] })),
  });
  const myAgentId = audience === 'candidate' ? conv.candidateAgentId : conv.employerAgentId;
  return {
    audience,
    toPrincipal: store.getAgent(myAgentId)?.principalName ?? '',
    learnedClaimIds: learned.map((c) => c.id),
    read,
    createdAt: now(),
  };
}
