import type { ContextualAdvisory, DependencyRecord, Report } from '../core/types.js';

export function formatMarkdownReport(report: Report): string {
  const lines: string[] = [];

  const statusEmoji = report.policyResult.isPassed ? '✅' : '❌';
  lines.push(`## ${statusEmoji} DepPulse Dependency Health Report`);
  lines.push('');
  lines.push(
    `- **Scanned**: ${report.scannedDependenciesCount} packages (${report.directCount} direct, ${report.transitiveCount} transitive)`,
  );
  lines.push(`- **Coverage**: ${report.coverage} (${report.lockfileFormat ?? 'no lockfile'})`);
  lines.push(`- **Scan Timestamp**: ${report.generatedAt}`);
  lines.push('');

  // Collect all vulnerabilities across all packages
  const allAdvisories: Array<{ dep: DependencyRecord; advisory: ContextualAdvisory }> = [];
  for (const item of report.results) {
    if (item.contextualAdvisories && item.contextualAdvisories.length > 0) {
      for (const adv of item.contextualAdvisories) {
        allAdvisories.push({ dep: item.dependency, advisory: adv });
      }
    }
  }

  const s = report.summary;
  lines.push('| Metric | Count |');
  lines.push('| :--- | :--- |');
  lines.push(`| 🔴 Critical Risk | ${s.criticalRisk} |`);
  lines.push(`| 🟡 High Risk | ${s.highRisk} |`);
  lines.push(`| 🟠 Medium Risk | ${s.mediumRisk} |`);
  lines.push(`| 🟢 Low Risk (Healthy) | ${s.lowRisk} |`);
  lines.push(`| ⚪ Unknown | ${s.unknownRisk} |`);
  if (allAdvisories.length > 0) {
    lines.push(`| 🛡️ Security Vulnerabilities | **${allAdvisories.length}** |`);
  }
  if (s.averageScore !== null) {
    lines.push(`| **Average Score** | **${s.averageScore} / 100** |`);
  }
  lines.push('');

  const flagged = report.results.filter(
    r =>
      r.maintenanceRisk !== 'low' || (r.contextualAdvisories && r.contextualAdvisories.length > 0),
  );

  if (flagged.length > 0) {
    lines.push('### ⚠️ Actionable Maintenance Alerts & Flagged Dependencies');
    lines.push('');
    lines.push('| Dependency | Risk | Score | Primary Finding |');
    lines.push('| :--- | :--- | :--- | :--- |');

    for (const item of flagged) {
      const primaryIssue =
        item.evidence.find(e => e.isFatalCap || e.contribution < 0)?.explanation ??
        (item.contextualAdvisories && item.contextualAdvisories.length > 0
          ? `${item.contextualAdvisories.length} security advisory/advisories detected`
          : 'Maintenance warning');
      lines.push(
        `| \`${item.dependency.id}\` | **${item.maintenanceRisk.toUpperCase()}** | ${item.score ?? 'N/A'} | ${primaryIssue} |`,
      );
    }
    lines.push('');
  }

  // Dedicated Detailed Vulnerabilities Table
  if (allAdvisories.length > 0) {
    lines.push('### 🛡️ Security Vulnerabilities & Advisories');
    lines.push('');
    lines.push('| Package | Severity | Advisory ID | Summary | Link |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');

    const severityOrder: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1 };
    const sortedAdvisories = [...allAdvisories].sort(
      (a, b) =>
        (severityOrder[b.advisory.severity] ?? 0) - (severityOrder[a.advisory.severity] ?? 0),
    );

    for (const { dep, advisory } of sortedAdvisories) {
      const sevEmoji =
        advisory.severity === 'critical'
          ? '🔴 **CRITICAL**'
          : advisory.severity === 'high'
            ? '🟠 **HIGH**'
            : advisory.severity === 'moderate'
              ? '🟡 **MODERATE**'
              : '🔵 **LOW**';

      const idText = advisory.cveId
        ? `\`${advisory.advisoryId}\`<br/>*(${advisory.cveId})*`
        : `\`${advisory.advisoryId}\``;

      lines.push(
        `| \`${dep.id}\` | ${sevEmoji} | ${idText} | ${advisory.title} | [View Advisory](${advisory.url}) |`,
      );
    }
    lines.push('');
  }

  if (!report.policyResult.isPassed) {
    lines.push('### ❌ Policy Violations');
    for (const v of report.policyResult.violations) {
      lines.push(`- ${v.message} *(Rule: \`${v.rule}\`)*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
