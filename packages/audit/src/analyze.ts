import { adaptA2UI } from '@genui/adapter-a2ui';
import type { AdapterIssue, AdapterIssueCode } from '@genui/adapter-a2ui';
import { gate } from '@genui/gate';
import type { TraceEntry, VerdictAction } from '@genui/gate';
import { sha256Hex, specHash } from '@genui/ir';
import type { IRNode, JsonObject, JsonValue } from '@genui/ir';
import type {
  A11yBaseline,
  AuditReport,
  IssueGroup,
  RuleHit,
  SurfaceAudit,
} from './types';

const SAMPLES_MAX = 3;

function emptyA11y(): A11yBaseline {
  return {
    nodes: 0,
    withAccessibility: 0,
    withLabel: 0,
    withDescription: 0,
    withLive: 0,
    withHidden: 0,
  };
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

interface WalkStats {
  nodeCount: number;
  maxDepth: number;
  a11y: A11yBaseline;
}

function walkTree(root: IRNode): WalkStats {
  const a11y = emptyA11y();
  let nodeCount = 0;
  let maxDepth = 0;
  const stack: Array<{ node: IRNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node, depth } = frame;
    nodeCount += 1;
    if (depth > maxDepth) maxDepth = depth;
    a11y.nodes += 1;
    const meta = node.props['accessibility'];
    if (isPlainObject(meta)) {
      a11y.withAccessibility += 1;
      if (isNonEmptyString(meta['label'])) a11y.withLabel += 1;
      if (isNonEmptyString(meta['description'])) a11y.withDescription += 1;
      if (isNonEmptyString(meta['live'])) a11y.withLive += 1;
      if (meta['hidden'] === true) a11y.withHidden += 1;
    }
    const slotNames = Object.keys(node.slots);
    for (let i = slotNames.length - 1; i >= 0; i--) {
      const children = node.slots[slotNames[i]!]!;
      for (let j = children.length - 1; j >= 0; j--) {
        stack.push({ node: children[j]!, depth: depth + 1 });
      }
    }
  }
  return { nodeCount, maxDepth, a11y };
}

function groupTrace(trace: TraceEntry[]): RuleHit[] {
  const hits: RuleHit[] = [];
  const byRuleId = new Map<string, RuleHit>();
  for (const entry of trace) {
    let hit = byRuleId.get(entry.ruleId);
    if (hit === undefined) {
      hit = {
        ruleId: entry.ruleId,
        severity: entry.severity,
        action: entry.action,
        count: 0,
        samples: [],
      };
      byRuleId.set(entry.ruleId, hit);
      hits.push(hit);
    }
    hit.count += 1;
    if (hit.samples.length < SAMPLES_MAX) {
      hit.samples.push({ nodePath: entry.nodePath, message: entry.message });
    }
  }
  return hits;
}

function groupIssues(issues: AdapterIssue[]): {
  groups: IssueGroup[];
  parseError: boolean;
} {
  const groups: IssueGroup[] = [];
  const byCode = new Map<AdapterIssueCode, IssueGroup>();
  let parseError = false;
  for (const issue of issues) {
    if (issue.code === 'parse-error') parseError = true;
    let group = byCode.get(issue.code);
    if (group === undefined) {
      group = { code: issue.code, count: 0, samples: [] };
      byCode.set(issue.code, group);
      groups.push(group);
    }
    group.count += 1;
    if (group.samples.length < SAMPLES_MAX) group.samples.push(issue.message);
  }
  return { groups, parseError };
}

/**
 * One-shot audit: A2UI spec text → deterministic quality report
 * (parse + adapt + gate + factual a11y coverage). Pure, no I/O.
 */
export function audit(rawInput: string): AuditReport {
  const text = rawInput.startsWith('\uFEFF') ? rawInput.slice(1) : rawInput;
  const inputSha256 = sha256Hex(text);
  const inputBytes = new TextEncoder().encode(text).length;
  const adapted = adaptA2UI(text);
  const { groups: adapterIssues, parseError } = groupIssues(adapted.issues);

  const surfaces: SurfaceAudit[] = [];
  let liveSurfaceCount = 0;
  let blockedSurfaceCount = 0;
  let totalComponents = 0;
  let totalNodes = 0;

  for (const surface of adapted.surfaces) {
    totalComponents += surface.componentCount;
    let irHash: string | undefined;
    let nodeCount = 0;
    let maxDepth = 0;
    let a11y = emptyA11y();
    let verdict: VerdictAction = 'pass';
    let ruleHits: RuleHit[] = [];
    if (surface.ir !== null) {
      const stats = walkTree(surface.ir);
      nodeCount = stats.nodeCount;
      maxDepth = stats.maxDepth;
      a11y = stats.a11y;
      irHash = specHash(surface.ir);
      const gateResult = gate(surface.ir);
      verdict = gateResult.verdict;
      ruleHits = groupTrace(gateResult.trace);
    }
    const live = !surface.deleted;
    const blocked = live && (surface.ir === null || verdict === 'block');
    if (live) liveSurfaceCount += 1;
    if (blocked) blockedSurfaceCount += 1;
    surfaces.push({
      surfaceId: surface.surfaceId,
      ...(surface.catalogId !== undefined ? { catalogId: surface.catalogId } : {}),
      deleted: surface.deleted,
      componentCount: surface.componentCount,
      ...(irHash !== undefined ? { irHash } : {}),
      nodeCount,
      maxDepth,
      verdict,
      blocked,
      ruleHits,
      a11y,
    });
    totalNodes += nodeCount;
  }

  return {
    inputSha256,
    inputBytes,
    surfaceCount: surfaces.length,
    liveSurfaceCount,
    blockedSurfaceCount,
    totalComponents,
    totalNodes,
    parseError,
    adapterIssueCount: adapted.issues.length,
    adapterIssues,
    surfaces,
  };
}

/**
 * Audit-layer exit code (fail-closed):
 * - 2 on any parse error, zero surfaces at all, or any blocked live surface;
 * - 0 otherwise (a stream whose surfaces all ended deleted is a valid
 *   protocol outcome, not a failure).
 * Audit-layer policy only; the gate itself stays limits-only (KAN-010).
 */
export function auditExitCode(report: AuditReport): 0 | 2 {
  if (report.parseError) return 2;
  if (report.surfaceCount === 0) return 2;
  if (report.blockedSurfaceCount > 0) return 2;
  return 0;
}
