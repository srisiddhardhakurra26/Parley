// The provenance engine. Tiers are computed from (source + verification), never
// set by hand by the model. Assertion and verification are kept as separate
// events: a claim is *born* as an assertion, and verification is *attached*
// later — which is what lets the UI show "claimed 5y, evidence supports ~4y".

import { id, now } from './store.ts';
import type { Claim, ClaimSource, Evidence, Tier, VerificationStatus } from './types.ts';

const LADDER: Tier[] = ['self-stated', 'document-backed', 'third-party', 'verified'];

export function tierRank(t: Tier): number {
  switch (t) {
    case 'contradicted': return -1;
    case 'inferred': return 0;
    case 'self-stated': return 1;
    case 'document-backed': return 2;
    case 'third-party': return 3;
    case 'verified': return 4;
  }
}

function bump(t: Tier): Tier {
  const i = LADDER.indexOf(t);
  if (i === -1 || i === LADDER.length - 1) return t;
  return LADDER[i + 1]!;
}

/** The whole point: tier is a pure function of source + verification. */
export function tierOf(claim: Claim): Tier {
  if (claim.source === 'inferred') return 'inferred';
  if (claim.verification.status === 'contradicted') return 'contradicted';
  if (claim.verification.status === 'verified') return 'verified';

  const base: Tier =
    claim.source === 'document' ? 'document-backed' :
    claim.source === 'third_party' ? 'third-party' :
    'self-stated'; // self_stated or conversation both start here

  return claim.verification.status === 'corroborated' ? bump(base) : base;
}

export const TIER_LABEL: Record<Tier, string> = {
  'self-stated': 'Self-stated',
  'document-backed': 'Document-backed',
  'third-party': 'Third-party',
  'verified': 'Verified',
  'inferred': "Agent's read",
  'contradicted': 'Contradicted',
};

interface MakeClaimInput {
  subjectId: string;
  statement: string;
  source: ClaimSource;
  evidence?: Evidence[];
  confidence?: number;
  protectedClass?: boolean;
}

export function makeClaim(input: MakeClaimInput): Claim {
  return {
    id: id('clm'),
    subjectId: input.subjectId,
    statement: input.statement,
    source: input.source,
    evidence: input.evidence ?? [],
    verification: { status: 'unverified', by: [] },
    confidence: input.confidence,
    protectedClass: input.protectedClass,
    createdAt: now(),
  };
}

/**
 * Attach a verification event. This is the ONLY way a claim's tier rises, and
 * it is called by connectors / the orchestrator — never by the conversational
 * model. Returns a new claim object.
 */
export function attachVerification(
  claim: Claim,
  status: VerificationStatus,
  by: Evidence[],
  note?: string,
): Claim {
  return { ...claim, verification: { status, by, note } };
}

/** A human-facing projection of a claim. The UI only ever sees this shape. */
export interface ClaimView {
  id: string;
  statement: string;
  tier: Tier;
  tierLabel: string;
  rank: number;
  source: ClaimSource;
  inferred: boolean;
  protectedClass: boolean;
  confidence?: number;
  evidence: Evidence[];
  verification: { status: VerificationStatus; note?: string; by: Evidence[] };
}

export function claimView(claim: Claim): ClaimView {
  const tier = tierOf(claim);
  return {
    id: claim.id,
    statement: claim.statement,
    tier,
    tierLabel: TIER_LABEL[tier],
    rank: tierRank(tier),
    source: claim.source,
    inferred: claim.source === 'inferred',
    protectedClass: Boolean(claim.protectedClass),
    confidence: claim.confidence,
    evidence: claim.evidence,
    verification: claim.verification,
  };
}

/** Sort load-bearing claims first: verified → third-party → … inferred last. */
export function byTrust(a: Claim, b: Claim): number {
  return tierRank(tierOf(b)) - tierRank(tierOf(a));
}
