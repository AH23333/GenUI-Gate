import type { AdapterIssueCode } from '@genui/adapter-a2ui';
import type { Severity, VerdictAction } from '@genui/gate';

/** Factual accessibility metadata coverage of a rendered tree (no policy judgment in M0). */
export interface A11yBaseline {
  nodes: number;
  withAccessibility: number;
  withLabel: number;
  withDescription: number;
  withLive: number;
  withHidden: number;
}

export interface RuleHitSample {
  nodePath: string;
  message: string;
}

/** Gate trace entries grouped by ruleId, with capped samples for the report. */
export interface RuleHit {
  ruleId: string;
  severity: Severity;
  action: VerdictAction;
  count: number;
  samples: RuleHitSample[];
}

export interface SurfaceAudit {
  surfaceId: string;
  catalogId?: string;
  deleted: boolean;
  componentCount: number;
  /** Canonical IR hash; present iff a renderable tree was built. */
  irHash?: string;
  nodeCount: number;
  maxDepth: number;
  verdict: VerdictAction;
  /** Audit-layer block: live surface with no tree or a block verdict. Deleted surfaces never block. */
  blocked: boolean;
  ruleHits: RuleHit[];
  a11y: A11yBaseline;
}

export interface IssueGroup {
  code: AdapterIssueCode;
  count: number;
  samples: string[];
}

export interface AuditReport {
  inputSha256: string;
  inputBytes: number;
  surfaceCount: number;
  liveSurfaceCount: number;
  blockedSurfaceCount: number;
  totalComponents: number;
  totalNodes: number;
  parseError: boolean;
  adapterIssueCount: number;
  adapterIssues: IssueGroup[];
  surfaces: SurfaceAudit[];
}
