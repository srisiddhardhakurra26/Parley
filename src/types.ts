// ─────────────────────────────────────────────────────────────────────────────
// Parley domain model.
//
// One motif runs through everything: structured substance underneath, human
// texture on top — and the thing that generates the texture (the conversational
// LLM) is never trusted with the substance. Claims carry provenance; the
// orchestrator (not the agents) writes them; tiers can only be raised by
// verifiers, never by the model.
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'candidate' | 'employer';

// ── Provenance ───────────────────────────────────────────────────────────────

/** Where a claim's assertion came from. Inferred is quarantined — never a fact. */
export type ClaimSource =
  | 'self_stated'   // the principal told their own agent during setup
  | 'document'      // pulled from an uploaded artifact (résumé, etc.)
  | 'third_party'   // an external connector asserted it (GitHub, employment check)
  | 'conversation'  // surfaced live in the agent-to-agent parley
  | 'inferred';     // the agent synthesised it — "agent's read", never a fact

export type VerificationStatus =
  | 'unverified'
  | 'corroborated'  // some external evidence supports it
  | 'verified'      // a trusted connector confirmed it
  | 'contradicted'; // evidence conflicts with the assertion

/** The visible trust ladder. `inferred` and `contradicted` sit off the ladder. */
export type Tier =
  | 'self-stated'
  | 'document-backed'
  | 'third-party'
  | 'verified'
  | 'inferred'
  | 'contradicted';

export type EvidenceKind = 'document' | 'url' | 'commit' | 'transcript' | 'connector' | 'none';

export interface Evidence {
  kind: EvidenceKind;
  /** A pointer: doc#span, a URL, a commit sha, or a transcript turn id. */
  ref: string;
  label?: string;
  /** For transcript evidence: the audio offset (seconds) to jump to. */
  audioTs?: number;
}

export interface Verification {
  status: VerificationStatus;
  by: Evidence[];
  note?: string;
}

/**
 * The atom. The agent never hands a human prose — it hands Claims, and the UI
 * renders them. `statement` is natural language; everything around it is the
 * structured provenance envelope.
 */
export interface Claim {
  id: string;
  subjectId: string;        // the agent whose principal this claim is about
  statement: string;
  source: ClaimSource;
  evidence: Evidence[];
  verification: Verification;
  confidence?: number;      // mostly for inferred
  /** Protected-class info (age, nationality…) — must never reach the human's view. */
  protectedClass?: boolean;
  createdAt: string;
}

// ── Agents (the configured AI for one human) ─────────────────────────────────

/** Browser speechSynthesis params — this is how a log becomes "listenable". */
export interface Voice {
  name: string;
  rate: number;   // 0.5 – 2
  pitch: number;  // 0 – 2
}

export interface Avatar {
  emoji: string;
  color: string;
}

/**
 * Disclosure policy — the clever, human bit. Each person bounds what their
 * agent may reveal, withhold, or trade. The agent negotiates within these.
 */
export interface DisclosurePolicy {
  freelyShare: string[];          // topics it may volunteer
  withhold: string[];             // topics it must never reveal
  revealOnReciprocity: string[];  // topics it reveals only if the other side reveals theirs first
}

export interface Agent {
  id: string;
  userId?: string;         // the account that owns this agent
  role: Role;
  principalName: string;   // the human behind the agent
  displayName: string;     // e.g. "Maya's agent"
  avatar: Avatar;
  voice: Voice;
  persona: string;         // tone the agent speaks in — style only, never substance
  disclosure: DisclosurePolicy;
  agenda: string[];        // what its human wants to find out from the other side
  createdAt: string;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Employer-side defaults, applied to each new posting's recruiting agent. */
export interface UserProfile {
  company?: string;
  persona?: string;
  voice?: Voice;
  avatar?: Avatar;
  disclosure?: DisclosurePolicy;
}

export interface User {
  id: string;
  email: string;
  role: Role;
  displayName: string;
  passwordHash?: string;   // scrypt; absent for Google-only accounts
  salt?: string;
  googleSub?: string;      // Google account id, if linked
  agentId?: string;        // a candidate's single standing agent
  profile?: UserProfile;   // an employer's recruiting-agent defaults
  createdAt: string;
}

// ── Jobs (an employer agent's disclosed posting) ─────────────────────────────

export interface Job {
  id: string;
  employerAgentId: string;
  company: string;
  title: string;
  salaryMin: number;
  salaryMax: number;
  currency: string;
  visaSponsorship: boolean;
  remote: 'remote' | 'hybrid' | 'onsite';
  location: string;
  requirements: string[];
  createdAt: string;
}

// ── The parley ───────────────────────────────────────────────────────────────

export interface AnswerIntent {
  statement: string;
  /** Links the spoken answer back to an underlying stored claim, if any. */
  sourceClaimId?: string;
  topic?: string;
  protectedClass?: boolean;
}

/** The structured side-channel an agent emits alongside its natural-language turn. */
export interface TurnIntents {
  answers: AnswerIntent[];  // info disclosed about its own principal this turn
  asks: string[];           // questions put to the other side
  followups: string[];      // topics it cannot answer now and must go fetch
  satisfied: boolean;       // its own agenda is now met
  escalate?: string;        // reason to hand control back to the human
}

export interface Turn {
  id: string;        // transcript_msg_id — the provenance target for conversation claims
  agentId: string;
  role: Role;
  text: string;      // the wire text (what gets logged and spoken)
  audioTs: number;   // cumulative seconds offset — click-to-source jumps here
  intents: TurnIntents;
  note?: string;     // orchestrator annotation (followup dispatched, escalation…)
  createdAt: string;
}

export interface Followup {
  id: string;
  askedBy: Role;
  answeredBy: Role;
  topic: string;
  status: 'pending' | 'resolved';
  resolution?: string;
  resolvedTurnId?: string;
}

export interface Report {
  audience: Role;
  toPrincipal: string;
  learnedClaimIds: string[];  // claims about the OTHER side, with provenance
  read: string;               // the demoted, inferred "agent's read"
  recommendation?: string;    // soft, non-scoring — the human decides
  createdAt: string;
}

export type ConversationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'escalated'
  | 'failed';

export interface Conversation {
  id: string;
  jobId: string;
  candidateAgentId: string;
  employerAgentId: string;
  status: ConversationStatus;
  turns: Turn[];
  claimIds: string[];   // claims produced during the parley
  openAgenda: { candidate: string[]; employer: string[] };
  followups: Followup[];
  reports: { candidate?: Report; employer?: Report };
  endedReason?: string;
  createdAt: string;
  updatedAt: string;
}
