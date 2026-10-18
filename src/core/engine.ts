import type {
  ContextualAdvisory,
  DependencyHealthResult,
  DependencyRecord,
  MaintenanceRisk,
  PackageMetadata,
  Report,
  ReportSummary,
  SupportedEcosystem,
  UpgradeAssessment,
} from './types.js';
import type { DepPulseConfig } from './config.js';
import { getDefaultConfig } from './config.js';
import { discoverDependencies } from '../discovery/index.js';
import { DiskCacheStore } from '../cache/disk-store.js';
import { ResilientHttpClient } from '../providers/http/client.js';
import { DefaultUniversalRegistryProvider } from '../providers/universal-registry.js';
import { DefaultGitHubProvider } from '../providers/github/client.js';
import { DefaultAdvisoryProvider } from '../providers/advisory/contextual.js';
import type {
  AdvisoryProvider,
  CacheStore,
  NpmRegistryProvider,
  RepoProvider,
  UniversalRegistryProvider,
} from '../providers/types.js';
import { scoreDependencyHealth } from '../scoring/engine.js';
import { evaluateUpgradeRisk } from '../analysis/upgrade.js';
import { evaluatePolicy } from '../policy/evaluator.js';

export interface EngineDependencies {
  npmProvider?: NpmRegistryProvider | undefined;
  universalProvider?: UniversalRegistryProvider | undefined;
  repoProvider?: RepoProvider | undefined;
  advisoryProvider?: AdvisoryProvider | undefined;
  cacheStore?: CacheStore | undefined;
}

export class DepPulseEngine {
  private readonly config: DepPulseConfig;
  private readonly npmProvider: NpmRegistryProvider;
  private readonly universalProvider: UniversalRegistryProvider;
  private readonly repoProvider: RepoProvider;
  private readonly advisoryProvider: AdvisoryProvider;
  private readonly cacheStore: CacheStore;

  constructor(config?: DepPulseConfig | undefined, deps: EngineDependencies = {}) {
    this.config = config ?? getDefaultConfig();

    this.cacheStore =
      deps.cacheStore ??
      new DiskCacheStore({
        dir: this.config.cache.dir,
        enabled: this.config.cache.enabled,
      });

    const httpClient = new ResilientHttpClient({
      concurrency: this.config.network.concurrency,
      timeoutMs: this.config.network.timeoutMs,
      maxRetries: this.config.network.maxRetries,
      allowedRegistries: this.config.network.allowedRegistries,
    });

    this.universalProvider =
      deps.universalProvider ?? new DefaultUniversalRegistryProvider(httpClient, this.cacheStore);
    this.npmProvider =
      deps.npmProvider ?? (this.universalProvider as unknown as NpmRegistryProvider);
    this.repoProvider = deps.repoProvider ?? new DefaultGitHubProvider(httpClient, this.cacheStore);
    this.advisoryProvider =
      deps.advisoryProvider ?? new DefaultAdvisoryProvider(httpClient, this.cacheStore);
  }

  async scan(
    projectPath: string,
    scanOverrides: {
      noCache?: boolean | undefined;
      directOnly?: boolean | undefined;
      ecosystem?: SupportedEcosystem | 'all' | undefined;
    } = {},
  ): Promise<Report> {
    const discovery = await discoverDependencies(projectPath, {
      includeTransitive: !scanOverrides.directOnly,
      ecosystem: scanOverrides.ecosystem,
    });

    const results: DependencyHealthResult[] = [];
    const requestOptions = {
      forceRefresh: Boolean(scanOverrides.noCache),
    };

    // Analyze dependencies with bounded parallel execution
    const concurrency = Math.min(
      Math.max(1, this.config.network.concurrency || 8),
      Math.max(1, discovery.dependencies.length),
    );

    let nextIndex = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < discovery.dependencies.length) {
        const dep = discovery.dependencies[nextIndex++];
        if (!dep) break;

        try {
          const ecosystem = (dep.ecosystem ?? dep.source ?? 'npm') as SupportedEcosystem;
          const pkgMeta = await (this.universalProvider?.getPackageMeta
            ? this.universalProvider.getPackageMeta(
                dep.name,
                dep.resolvedVersion,
                requestOptions,
                ecosystem,
              )
            : this.npmProvider.getPackageMeta(dep.name, dep.resolvedVersion, requestOptions));
          const repoMeta = await this.repoProvider.getRepoMetadata(
            pkgMeta.rawRepository?.url,
            dep.name,
            requestOptions,
          );
          let advisories: readonly ContextualAdvisory[] = [];
          try {
            advisories = await this.advisoryProvider.getAdvisories(
              dep.name,
              pkgMeta.version || dep.resolvedVersion,
              requestOptions,
            );
          } catch {
            // Advisories are non-blocking
          }

          // If dep was a semver range (direct scanning without lockfile), update resolvedVersion from pkgMeta
          const effectiveDep: DependencyRecord =
            pkgMeta.version &&
            (dep.resolvedVersion.startsWith('^') ||
              dep.resolvedVersion.startsWith('~') ||
              dep.resolvedVersion.startsWith('>') ||
              dep.resolvedVersion.startsWith('<') ||
              dep.resolvedVersion === '*')
              ? {
                  ...dep,
                  resolvedVersion: pkgMeta.version,
                  id: `${dep.name}@${pkgMeta.version}`,
                }
              : dep;

          const health = scoreDependencyHealth(effectiveDep, pkgMeta, repoMeta, advisories, {
            minConfidenceThreshold: this.config.scoring.minConfidenceThreshold,
            maturityThresholdYears: this.config.scoring.maturityThresholdYears,
          });

          results.push(health);
        } catch (err) {
          // Individual package fetch failure does not fail the entire scan (unless private/unavailable)
          const fallbackMeta: PackageMetadata = {
            name: dep.name,
            version: dep.resolvedVersion,
            latestVersion: dep.resolvedVersion,
            publishedAt: '',
            releaseCount: 0,
            isDeprecated: false,
            hasProvenance: false,
            versionsTime: {},
          };
          const fallbackRepo = {
            owner: '',
            repo: '',
            associationStatus: 'missing' as const,
            isArchived: false,
            isFork: false,
            defaultBranch: 'main',
            stars: 0,
            openIssuesCount: 0,
            unverifiedReason: `Upstream fetch failed: ${(err as Error).message}`,
          };

          const fallbackResult = scoreDependencyHealth(dep, fallbackMeta, fallbackRepo, [], {
            minConfidenceThreshold: this.config.scoring.minConfidenceThreshold,
          });
          results.push(fallbackResult);
        }
      }
    });

    await Promise.all(workers);

    // Deterministic sorting: Critical -> High -> Medium -> Unknown -> Low, then by score asc, then name
    const riskRank: Record<MaintenanceRisk, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      unknown: 3,
      low: 4,
    };

    results.sort((a, b) => {
      const rankDiff = riskRank[a.maintenanceRisk] - riskRank[b.maintenanceRisk];
      if (rankDiff !== 0) return rankDiff;

      const scoreA = a.score ?? -1;
      const scoreB = b.score ?? -1;
      if (scoreA !== scoreB) return scoreA - scoreB;

      return a.dependency.id.localeCompare(b.dependency.id);
    });

    // Compute summary
    let lowCount = 0;
    let medCount = 0;
    let highCount = 0;
    let critCount = 0;
    let unkCount = 0;
    let scoreSum = 0;
    let scoredCount = 0;

    for (const r of results) {
      switch (r.maintenanceRisk) {
        case 'low':
          lowCount++;
          break;
        case 'medium':
          medCount++;
          break;
        case 'high':
          highCount++;
          break;
        case 'critical':
          critCount++;
          break;
        case 'unknown':
          unkCount++;
          break;
      }
      if (r.score !== null) {
        scoreSum += r.score;
        scoredCount++;
      }
    }

    const summary: ReportSummary = {
      lowRisk: lowCount,
      mediumRisk: medCount,
      highRisk: highCount,
      criticalRisk: critCount,
      unknownRisk: unkCount,
      averageScore: scoredCount > 0 ? Math.round(scoreSum / scoredCount) : null,
    };

    const policyResult = evaluatePolicy(results, {
      failOnRisk: this.config.policy.failOnRisk,
      maxHighRiskAllowed: this.config.policy.maxHighRiskAllowed,
      allowList: this.config.policy.allowList,
      minScore: this.config.policy.minScore,
      treatUnknownAsFailure: this.config.policy.treatUnknownAsFailure,
    });

    return {
      schemaVersion: '1.0.0',
      manifestPath: discovery.manifestPath,
      lockfilePath: discovery.lockfilePath,
      lockfileFormat: discovery.lockfileFormat,
      coverage: discovery.coverage,
      scannedDependenciesCount: results.length,
      directCount: discovery.dependencies.filter(d => d.isDirect).length,
      transitiveCount: discovery.dependencies.filter(d => !d.isDirect).length,
      skippedCount: discovery.skipped.length,
      summary,
      results,
      policyResult,
      generatedAt: new Date().toISOString(),
    };
  }

  async analyze(
    packageName: string,
    version?: string,
    ecosystem?: SupportedEcosystem,
  ): Promise<DependencyHealthResult> {
    let targetEcosystem: SupportedEcosystem = ecosystem ?? 'npm';
    let cleanPkgName = packageName;
    const prefixMatch = /^(pypi|crates|golang|rubygems|packagist|maven|nuget|npm):(.+)$/i.exec(
      packageName,
    );
    if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
      targetEcosystem = prefixMatch[1].toLowerCase() as SupportedEcosystem;
      cleanPkgName = prefixMatch[2];
    }

    const pkgMeta = await (this.universalProvider?.getPackageMeta
      ? this.universalProvider.getPackageMeta(cleanPkgName, version, {}, targetEcosystem)
      : this.npmProvider.getPackageMeta(cleanPkgName, version));
    const resolvedVersion = version ?? pkgMeta.version;
    const repoMeta = await this.repoProvider.getRepoMetadata(
      pkgMeta.rawRepository?.url,
      cleanPkgName,
    );
    let advisories: readonly ContextualAdvisory[] = [];
    try {
      advisories = await this.advisoryProvider.getAdvisories(cleanPkgName, resolvedVersion);
    } catch {
      // non-blocking
    }

    const dummyDep: DependencyRecord = {
      id: `${cleanPkgName}@${resolvedVersion}`,
      name: cleanPkgName,
      declaredRange: resolvedVersion,
      resolvedVersion,
      type: 'prod',
      source: targetEcosystem,
      ecosystem: targetEcosystem,
      registryUrl:
        targetEcosystem === 'pypi'
          ? 'https://pypi.org'
          : targetEcosystem === 'crates'
            ? 'https://crates.io'
            : targetEcosystem === 'rubygems'
              ? 'https://rubygems.org'
              : targetEcosystem === 'packagist'
                ? 'https://packagist.org'
                : 'https://registry.npmjs.org',
      isDirect: true,
      dependents: [],
    };

    return scoreDependencyHealth(dummyDep, pkgMeta, repoMeta, advisories, {
      minConfidenceThreshold: this.config.scoring.minConfidenceThreshold,
      maturityThresholdYears: this.config.scoring.maturityThresholdYears,
    });
  }

  async compare(
    packageName: string,
    fromVersion: string,
    toVersion: string,
    ecosystem?: SupportedEcosystem,
  ): Promise<UpgradeAssessment> {
    let targetEcosystem: SupportedEcosystem = ecosystem ?? 'npm';
    let cleanPkgName = packageName;
    const prefixMatch = /^(pypi|crates|golang|rubygems|packagist|maven|nuget|npm):(.+)$/i.exec(
      packageName,
    );
    if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
      targetEcosystem = prefixMatch[1].toLowerCase() as SupportedEcosystem;
      cleanPkgName = prefixMatch[2];
    }

    const currentHealth = await this.analyze(cleanPkgName, fromVersion, targetEcosystem);
    const targetMeta = await (this.universalProvider?.getPackageMeta
      ? this.universalProvider.getPackageMeta(cleanPkgName, toVersion, {}, targetEcosystem)
      : this.npmProvider.getPackageMeta(cleanPkgName, toVersion));
    const targetRepo = await this.repoProvider.getRepoMetadata(
      targetMeta.rawRepository?.url,
      cleanPkgName,
    );
    const targetHealth = scoreDependencyHealth(
      {
        id: `${cleanPkgName}@${toVersion}`,
        name: cleanPkgName,
        declaredRange: toVersion,
        resolvedVersion: toVersion,
        type: 'prod',
        source: targetEcosystem,
        ecosystem: targetEcosystem,
        registryUrl: 'https://registry.npmjs.org',
        isDirect: true,
        dependents: [],
      },
      targetMeta,
      targetRepo,
      [],
    );

    return evaluateUpgradeRisk(
      currentHealth.dependency,
      fromVersion,
      toVersion,
      targetMeta,
      currentHealth.maintenanceRisk,
      targetHealth.maintenanceRisk,
    );
  }
}
