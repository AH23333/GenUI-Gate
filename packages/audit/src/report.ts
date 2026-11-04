import type {
  A11yBaseline,
  AuditReport,
  RuleHit,
  SurfaceAudit,
} from './types';

/** Machine-readable report (JSON-safe, deterministic field order). */
export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Human-readable terminal report. ASCII-only, no ANSI codes, no timestamps. */
export function renderText(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('GenUI Gate audit report');
  lines.push('=======================');
  lines.push('');
  lines.push(`Input: ${report.inputBytes} bytes (sha256 ${report.inputSha256})`);
  lines.push('');
  lines.push(
    `Surfaces: ${report.surfaceCount} (${report.liveSurfaceCount} live), ` +
      `components: ${report.totalComponents}, nodes: ${report.totalNodes}`,
  );
  lines.push(`Adapter issues: ${report.adapterIssueCount}${report.parseError ? ' (parse errors present)' : ''}`);
  lines.push('');
  for (const surface of report.surfaces) {
    pushSurface(lines, surface);
  }
  pushIssues(lines, report);
  pushOverall(lines, report);
  return `${lines.join('\n')}\n`;
}

function pushSurface(lines: string[], surface: SurfaceAudit): void {
  const tags: string[] = [];
  if (surface.deleted) tags.push('deleted');
  if (surface.blocked) tags.push('blocked');
  const tagSuffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const catalogSuffix = surface.catalogId !== undefined ? ` (${surface.catalogId})` : '';
  lines.push(`Surface "${surface.surfaceId}"${catalogSuffix}${tagSuffix}`);
  lines.push(
    `  Components: ${surface.componentCount}, nodes: ${surface.nodeCount}, max depth: ${surface.maxDepth}`,
  );
  if (surface.irHash !== undefined) {
    lines.push(`  IR hash: ${surface.irHash}`);
  }
  lines.push(`  Verdict: ${surface.verdict}`);
  lines.push(`  A11y baseline: ${formatA11y(surface.a11y)}`);
  if (surface.ruleHits.length === 0) {
    lines.push('  Rule violations: none');
  } else {
    for (const hit of surface.ruleHits) {
      pushRuleHit(lines, hit);
    }
  }
  lines.push('');
}

function pushRuleHit(lines: string[], hit: RuleHit): void {
  lines.push(`  Rule: ${hit.ruleId} (${hit.severity}/${hit.action}) x${hit.count}`);
  for (const sample of hit.samples) {
    lines.push(`    ${sample.nodePath}: ${sample.message}`);
  }
}

function formatA11y(a11y: A11yBaseline): string {
  return (
    `${a11y.nodes} nodes, ` +
    `${a11y.withAccessibility} with accessibility metadata, ` +
    `${a11y.withLabel} with label, ` +
    `${a11y.withDescription} with description, ` +
    `${a11y.withLive} live region, ` +
    `${a11y.withHidden} hidden`
  );
}

function pushIssues(lines: string[], report: AuditReport): void {
  if (report.adapterIssues.length === 0) return;
  lines.push('Adapter issues:');
  for (const group of report.adapterIssues) {
    lines.push(`  ${group.code} x${group.count}`);
    for (const sample of group.samples) {
      lines.push(`    ${sample}`);
    }
  }
  lines.push('');
}

function pushOverall(lines: string[], report: AuditReport): void {
  const reasons: string[] = [];
  if (report.parseError) reasons.push('parse errors present');
  if (report.surfaceCount === 0) reasons.push('no surfaces');
  if (report.blockedSurfaceCount > 0) {
    reasons.push(`${report.blockedSurfaceCount} surface(s) blocked`);
  }
  if (reasons.length === 0) {
    lines.push('Overall: PASS');
  } else {
    lines.push(`Overall: BLOCK (${reasons.join('; ')})`);
  }
}
