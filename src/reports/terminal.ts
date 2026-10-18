import pc from 'picocolors';
import type {
  ContextualAdvisory,
  DependencyHealthResult,
  DependencyRecord,
  MaintenanceRisk,
  Report,
} from '../core/types.js';

function getRiskBadge(risk: MaintenanceRisk): string {
  switch (risk) {
    case 'critical':
      return pc.bgRed(pc.white(pc.bold(' CRITICAL ')));
    case 'high':
      return pc.bgYellow(pc.black(pc.bold(' HIGH ')));
    case 'medium':
      return pc.yellow(pc.bold('MEDIUM'));
    case 'low':
      return pc.green(pc.bold('LOW'));
    case 'unknown':
      return pc.dim('UNKNOWN');
  }
}

function getAdvisoryBadge(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'critical':
      return pc.bgRed(pc.white(pc.bold(' CRITICAL ')));
    case 'high':
      return pc.bgYellow(pc.black(pc.bold(' HIGH ')));
    case 'moderate':
    case 'medium':
      return pc.yellow(pc.bold('MODERATE'));
    case 'low':
      return pc.cyan(pc.bold('LOW'));
    default:
      return pc.dim('ADVISORY');
  }
}

function getScoreText(score: number | null): string {
  if (score === null) return pc.dim('N/A');
  if (score >= 80) return pc.green(String(score));
  if (score >= 50) return pc.yellow(String(score));
  if (score >= 25) return pc.yellow(String(score));
  return pc.red(String(score));
}

export function formatTerminalReport(
  report: Report,
  options: { verbose?: boolean | undefined } = {},
): string {
  const lines: string[] = [];

  // Title & Header
  lines.push('');
  lines.push(
    pc.bold(pc.cyan('DepPulse')) +
      ' ' +
      pc.dim('v0.2.0 – Universal Dependency Health & Maintenance Intelligence'),
  );
  lines.push(pc.dim('─'.repeat(70)));

  // Manifest info
  lines.push(
    `Manifest: ${pc.bold(report.manifestPath)} ${
      report.lockfilePath
        ? pc.dim(`(${report.lockfileFormat}, coverage: ${report.coverage})`)
        : pc.yellow('(no lockfile)')
    }`,
  );
  lines.push(
    `Scanned: ${pc.bold(String(report.scannedDependenciesCount))} dependencies (${report.directCount} direct, ${report.transitiveCount} transitive, ${report.skippedCount} skipped)`,
  );
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

  // Summary Metrics Bar
  const s = report.summary;
  const summaryBadges = [
    s.criticalRisk > 0 ? pc.red(`Critical: ${s.criticalRisk}`) : pc.dim(`Critical: 0`),
    s.highRisk > 0 ? pc.yellow(`High: ${s.highRisk}`) : pc.dim(`High: 0`),
    s.mediumRisk > 0 ? pc.yellow(`Medium: ${s.mediumRisk}`) : pc.dim(`Medium: 0`),
    pc.green(`Low (Healthy): ${s.lowRisk}`),
    s.unknownRisk > 0 ? pc.dim(`Unknown: ${s.unknownRisk}`) : null,
    allAdvisories.length > 0
      ? pc.bgRed(pc.white(pc.bold(` ${allAdvisories.length} Vulnerabilities `)))
      : pc.dim('Vulnerabilities: 0'),
  ]
    .filter(Boolean)
    .join(pc.dim(' | '));

  lines.push(`Health Overview: ${summaryBadges}`);
  if (s.averageScore !== null) {
    lines.push(`Average Health Score: ${getScoreText(s.averageScore)}/100`);
  }
  lines.push(pc.dim('─'.repeat(70)));

  // Filter items to show:
  // If verbose: all. Otherwise: critical, high, medium, unknown, OR any package carrying security advisories
  const itemsToShow = options.verbose
    ? report.results
    : report.results.filter(
        r =>
          r.maintenanceRisk !== 'low' ||
          (r.contextualAdvisories && r.contextualAdvisories.length > 0),
      );

  if (itemsToShow.length > 0) {
    lines.push('');
    lines.push(pc.bold('Actionable Maintenance Alerts & Flagged Dependencies:'));
    lines.push('');

    for (const item of itemsToShow) {
      const dep = item.dependency;
      const badge = getRiskBadge(item.maintenanceRisk);
      const scoreStr = getScoreText(item.score);
      const directTag = dep.isDirect ? pc.cyan('[direct]') : pc.dim('[transitive]');

      lines.push(`  ${badge}  ${pc.bold(dep.id)} ${directTag} Score: ${scoreStr}`);

      // Print primary explanation from evidence
      const significantEvidence = item.evidence.filter(e => e.contribution < 0 || e.isFatalCap);

      for (const ev of significantEvidence) {
        if (ev.isFatalCap) {
          lines.push(`     ${pc.red('✖')} ${ev.explanation}`);
        } else if (ev.contribution < 0) {
          lines.push(`     ${pc.yellow('⚠')} ${ev.explanation} (${ev.contribution})`);
        }
      }

      // Print itemized security advisories for this package
      if (item.contextualAdvisories && item.contextualAdvisories.length > 0) {
        lines.push(
          `     ${pc.magenta(pc.bold(`🛡 Security Vulnerabilities (${item.contextualAdvisories.length}):`))}`,
        );
        for (const adv of item.contextualAdvisories) {
          const advBadge = getAdvisoryBadge(adv.severity);
          const cveTag = adv.cveId ? pc.dim(` [${adv.cveId}]`) : '';
          lines.push(`       ${advBadge} ${pc.bold(adv.advisoryId)}${cveTag}: ${adv.title}`);
          lines.push(`          ${pc.dim('Advisory: ' + adv.url)}`);
        }
      }

      lines.push('');
    }
  } else {
    lines.push('');
    lines.push(
      pc.green(
        '✔ No critical, high, or medium maintenance risks found. All scanned packages are healthy.',
      ),
    );
    lines.push('');
  }

  // Dedicated Complete Security Vulnerabilities Section
  if (allAdvisories.length > 0) {
    lines.push(pc.dim('─'.repeat(70)));
    lines.push(
      pc.bold(
        pc.red(
          `🛡 Security Vulnerabilities & Advisories (${allAdvisories.length} detected across project):`,
        ),
      ),
    );
    lines.push(pc.dim('─'.repeat(70)));

    const severityOrder: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1 };
    const sortedAdvisories = [...allAdvisories].sort(
      (a, b) =>
        (severityOrder[b.advisory.severity] ?? 0) - (severityOrder[a.advisory.severity] ?? 0),
    );

    for (const { dep, advisory } of sortedAdvisories) {
      const advBadge = getAdvisoryBadge(advisory.severity);
      const directTag = dep.isDirect ? pc.cyan('[direct]') : pc.dim('[transitive]');
      const cveTag = advisory.cveId ? pc.dim(` (${advisory.cveId})`) : '';

      lines.push(`  ${advBadge}  ${pc.bold(dep.id)} ${directTag}`);
      lines.push(`     • ${pc.bold(advisory.advisoryId)}${cveTag}: ${advisory.title}`);
      lines.push(`       ${pc.dim('Advisory Link: ' + advisory.url)}`);
      lines.push('');
    }
  }

  // Policy Outcome
  lines.push(pc.dim('─'.repeat(70)));
  if (report.policyResult.isPassed) {
    lines.push(
      pc.bold(pc.green('✔ POLICY PASSED: All dependencies satisfy configured health thresholds.')),
    );
  } else {
    lines.push(
      pc.bold(
        pc.red(
          `✖ POLICY FAILED: Found ${report.policyResult.violations.length} policy violation(s):`,
        ),
      ),
    );
    for (const v of report.policyResult.violations) {
      lines.push(`   - ${pc.red(v.message)} ${pc.dim(`(Rule: ${v.rule})`)}`);
    }
  }

  if (report.policyResult.allowedExceptions.length > 0) {
    lines.push('');
    lines.push(pc.dim(`Permitted Exceptions (${report.policyResult.allowedExceptions.length}):`));
    for (const ex of report.policyResult.allowedExceptions) {
      lines.push(pc.dim(`   • ${ex}`));
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function formatSinglePackageTerminal(result: DependencyHealthResult): string {
  const lines: string[] = [];
  const dep = result.dependency;

  lines.push('');
  lines.push(pc.bold(pc.cyan('DepPulse Package Analysis: ') + pc.white(dep.id)));
  lines.push(pc.dim('─'.repeat(60)));
  lines.push(`Maintenance Risk : ${getRiskBadge(result.maintenanceRisk)}`);
  lines.push(`Health Score     : ${getScoreText(result.score)} / 100`);
  lines.push(`Confidence       : ${(result.confidence * 100).toFixed(0)}%`);
  lines.push(
    `Lifecycle Status : ${result.isMatureStable ? pc.green('Mature-Stable') : pc.cyan('Active/Emerging')}`,
  );

  // If contextual advisories exist, display them with badges and links
  if (result.contextualAdvisories && result.contextualAdvisories.length > 0) {
    lines.push('');
    lines.push(
      pc.bold(pc.red(`Security Vulnerabilities (${result.contextualAdvisories.length} detected):`)),
    );
    for (const adv of result.contextualAdvisories) {
      const advBadge = getAdvisoryBadge(adv.severity);
      const cveTag = adv.cveId ? pc.dim(` [${adv.cveId}]`) : '';
      lines.push(`  ${advBadge} ${pc.bold(adv.advisoryId)}${cveTag}: ${adv.title}`);
      lines.push(`     ${pc.dim('Advisory: ' + adv.url)}`);
    }
  }

  lines.push('');
  lines.push(pc.bold('Evidence Audit Trail:'));

  for (const ev of result.evidence) {
    const symbol = ev.isFatalCap
      ? pc.red('✖')
      : ev.contribution > 0
        ? pc.green('✔')
        : ev.contribution < 0
          ? pc.yellow('⚠')
          : pc.dim('•');

    const delta =
      ev.contribution !== 0 ? ` (${ev.contribution > 0 ? '+' : ''}${ev.contribution})` : '';
    lines.push(`  ${symbol} [${ev.signal}] ${ev.explanation}${delta}`);
  }

  lines.push('');
  return lines.join('\n');
}
