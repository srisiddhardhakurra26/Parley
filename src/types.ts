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
  /** Free-text steering from the human: how to address the other side, what to
   *  emphasise, how to keep the conversation. Strategy/style only — it never
   *  overrides the hard rules (can't invent facts, can't change tiers, disclosure binding). */
  instructions?: string;
  disclosure: DisclosurePolicy;
  agenda: string[];        // what its human wants to find out from the other side
  createdAt: string;
}

// ── Sources (uploaded documents — resume, certificates …) ────────────────────

export type SourceKind = 'resume' | 'certificate' | 'portfolio' | 'reference' | 'other';

/**
 * A document a human uploads for their agent. Its text is chunked and turned
 * into document-backed claims, so it can be retrieved (RAG) during the parley
 * and linked, with provenance, in the report.
 */
export interface Source {
  id: string;
  ownerUserId: string;     // the human who uploaded it (survives agent rebuilds)
  title: string;
  kind: SourceKind;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;     // the raw upload, for download/linking (kept small)
  text: string;            // extracted/pasted text used for RAG
  chunks: string[];        // retrievable text chunks
  claimIds: string[];      // the document-backed claims minted from this source (across agents)
  createdAt: string;
}

// ── Direct messages (human ↔ human, after the agents have parleyed) ───────────

export type DMKind = 'message' | 'system' | 'call';

export interface DM {
  id: string;
  conversationId: string;  // the parley this thread hangs off
  fromUserId: string;
  fromRole: Role;
  kind: DMKind;
  text: string;
  callUrl?: string;        // for kind 'call' — a live video room link
  callTime?: string;       // suggested time (ISO) for the call
  createdAt: string;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Employer-side defaults, applied to each new posting's recruiting agent. */
export interface UserProfile {
  company?: string;
  persona?: string;
  instructions?: string;   // steering for the recruiting agent, applied to each posting
  voice?: Voice;
  avatar?: Avatar;
  disclosure?: DisclosurePolicy;
}

/** The raw fields a candidate entered, kept so updates (web or MCP) can merge
 *  rather than wipe — the claim store is rebuilt from these each time. */
export interface CandidateInputs {
  years?: number;
  skills?: string[];
  education?: string;
  experience?: string[];
  projects?: string[];
  github?: string;
  githubVerifiedSkills?: string[];
  instructions?: string;
  disclosure?: DisclosurePolicy;
  voice?: Voice;
  avatar?: Avatar;
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
  candidateInputs?: CandidateInputs; // raw candidate setup, for merge-updates
  connectorToken?: string; // bearer token for this user's MCP connector
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

// ── Parley requests (mutual consent before the agents talk) ──────────────────

export type RequestStatus = 'pending' | 'accepted' | 'declined';

/**
 * One side asks the other to parley; the agents only talk once it's accepted.
 * A candidate requests against a posting; an employer requests a specific
 * candidate for a posting. Either way the recipient accepts (which runs the
 * parley) or declines.
 */
export interface ParleyRequest {
  id: string;
  jobId: string;
  candidateAgentId: string;
  employerAgentId: string;
  fromRole: Role;                 // who initiated
  status: RequestStatus;
  message?: string;
  conversationId?: string;        // set when accepted and the parley runs
  createdAt: string;
  updatedAt: string;
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
  practice?: boolean;   // a candidate's private practice run — the employer never sees it
  coaching?: string;    // post-practice feedback for the candidate
  endedReason?: string;
  createdAt: string;
  updatedAt: string;
}
