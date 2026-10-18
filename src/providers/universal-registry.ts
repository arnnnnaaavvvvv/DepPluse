import type { PackageMetadata, SupportedEcosystem } from '../core/types.js';
import type {
  CacheStore,
  NpmRegistryProvider,
  RequestOptions,
  UniversalRegistryProvider,
} from './types.js';
import type { ResilientHttpClient } from './http/client.js';
import { DefaultNpmRegistryProvider } from './npm/registry.js';

export class DefaultUniversalRegistryProvider
  implements UniversalRegistryProvider, NpmRegistryProvider
{
  private readonly npmProvider: DefaultNpmRegistryProvider;

  constructor(
    private readonly httpClient: ResilientHttpClient,
    private readonly cache: CacheStore,
    private readonly cacheTtlMs = 24 * 60 * 60 * 1000,
  ) {
    this.npmProvider = new DefaultNpmRegistryProvider(
      httpClient,
      cache,
      'https://registry.npmjs.org',
      cacheTtlMs,
    );
  }

  async getPackageMeta(
    packageName: string,
    targetVersion?: string,
    options: RequestOptions = {},
    ecosystem: SupportedEcosystem = 'npm',
  ): Promise<PackageMetadata> {
    switch (ecosystem) {
      case 'pypi':
        return this.fetchPyPiMeta(packageName, targetVersion, options);
      case 'crates':
        return this.fetchCratesMeta(packageName, targetVersion, options);
      case 'rubygems':
        return this.fetchRubyGemsMeta(packageName, targetVersion, options);
      case 'packagist':
        return this.fetchPackagistMeta(packageName, targetVersion, options);
      case 'golang':
        return this.fetchGolangMeta(packageName, targetVersion, options);
      case 'maven':
        return this.fetchMavenMeta(packageName, targetVersion, options);
      case 'nuget':
        return this.fetchNuGetMeta(packageName, targetVersion, options);
      case 'npm':
      default:
        return this.npmProvider.getPackageMeta(packageName, targetVersion, options);
    }
  }

  private async fetchPyPiMeta(
    packageName: string,
    targetVersion?: string,
    options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const cacheKey = `pypi:packument:${packageName.toLowerCase()}`;
    if (!options.forceRefresh) {
      const cached = await this.cache.get<PackageMetadata>(cacheKey);
      if (cached) return cached;
    }

    try {
      const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
      const data = await this.httpClient.getJson<any>(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      const releases = data.releases ?? {};
      const allVersions = Object.keys(releases);
      const latestVersion = data.info?.version ?? allVersions[allVersions.length - 1] ?? '0.0.0';
      const chosenVersion =
        targetVersion && releases[targetVersion] ? targetVersion : latestVersion;

      const versionsTime: Record<string, string> = {};
      for (const [ver, files] of Object.entries<any[]>(releases)) {
        if (files && files[0]?.upload_time_iso_8601) {
          versionsTime[ver] = files[0].upload_time_iso_8601;
        }
      }

      const publishedAt =
        versionsTime[chosenVersion] ??
        data.releases?.[chosenVersion]?.[0]?.upload_time_iso_8601 ??
        new Date().toISOString();

      // Extract repository url from project_urls
      const projectUrls = data.info?.project_urls ?? {};
      let repoUrl: string | undefined;
      for (const [, v] of Object.entries<string>(projectUrls)) {
        if (typeof v === 'string' && (v.includes('github.com') || v.includes('gitlab.com'))) {
          repoUrl = v;
          break;
        }
      }

      const isDeprecated =
        Boolean(data.info?.yanked) ||
        (data.info?.summary ?? '').toLowerCase().includes('deprecated') ||
        (data.info?.description ?? '').toLowerCase().includes('this package is deprecated');

      const meta: PackageMetadata = {
        name: data.info?.name ?? packageName,
        version: chosenVersion,
        latestVersion,
        ecosystem: 'pypi',
        description: data.info?.summary,
        license: data.info?.license,
        publishedAt,
        releaseCount: allVersions.length,
        isDeprecated,
        deprecationReason:
          data.info?.yanked_reason ?? (isDeprecated ? 'Marked deprecated on PyPI' : undefined),
        engines: { python: data.info?.requires_python },
        rawRepository: repoUrl ? { url: repoUrl } : undefined,
        hasProvenance: false,
        versionsTime,
      };

      await this.cache.set(cacheKey, meta, this.cacheTtlMs);
      return meta;
    } catch {
      return this.createFallbackMeta(packageName, targetVersion ?? '0.0.0', 'pypi');
    }
  }

  private async fetchCratesMeta(
    packageName: string,
    targetVersion?: string,
    options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const cacheKey = `crates:packument:${packageName.toLowerCase()}`;
    if (!options.forceRefresh) {
      const cached = await this.cache.get<PackageMetadata>(cacheKey);
      if (cached) return cached;
    }

    try {
      const url = `https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}`;
      const data = await this.httpClient.getJson<any>(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      const crate = data.crate ?? {};
      const versions = data.versions ?? [];
      const latestVersion = crate.max_version ?? versions[0]?.num ?? '0.0.0';
      const chosenVersion = targetVersion ?? latestVersion;

      const chosenVerObj = versions.find((v: any) => v.num === chosenVersion) ?? versions[0];
      const versionsTime: Record<string, string> = {};
      for (const v of versions) {
        if (v.num && v.created_at) {
          versionsTime[v.num] = v.created_at;
        }
      }

      const meta: PackageMetadata = {
        name: crate.name ?? packageName,
        version: chosenVersion,
        latestVersion,
        ecosystem: 'crates',
        description: crate.description,
        license: chosenVerObj?.license,
        publishedAt: chosenVerObj?.created_at ?? crate.updated_at ?? new Date().toISOString(),
        releaseCount: versions.length,
        isDeprecated: Boolean(chosenVerObj?.yanked),
        deprecationReason: chosenVerObj?.yanked ? 'Crate version is yanked' : undefined,
        engines: { rust: chosenVerObj?.rust_version },
        rawRepository: crate.repository ? { url: crate.repository } : undefined,
        hasProvenance: false,
        versionsTime,
      };

      await this.cache.set(cacheKey, meta, this.cacheTtlMs);
      return meta;
    } catch {
      return this.createFallbackMeta(packageName, targetVersion ?? '0.0.0', 'crates');
    }
  }

  private async fetchRubyGemsMeta(
    packageName: string,
    targetVersion?: string,
    options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const cacheKey = `rubygems:packument:${packageName.toLowerCase()}`;
    if (!options.forceRefresh) {
      const cached = await this.cache.get<PackageMetadata>(cacheKey);
      if (cached) return cached;
    }

    try {
      const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(packageName)}.json`;
      const data = await this.httpClient.getJson<any>(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      const version = data.version ?? targetVersion ?? '0.0.0';
      const repoUrl = data.source_code_uri || data.homepage_uri || data.project_uri;

      const meta: PackageMetadata = {
        name: data.name ?? packageName,
        version,
        latestVersion: data.version ?? version,
        ecosystem: 'rubygems',
        description: data.info,
        license: Array.isArray(data.licenses) ? data.licenses[0] : undefined,
        publishedAt: data.version_created_at ?? new Date().toISOString(),
        releaseCount: 1,
        isDeprecated: false,
        rawRepository: repoUrl ? { url: repoUrl } : undefined,
        hasProvenance: false,
        versionsTime: { [version]: data.version_created_at ?? new Date().toISOString() },
      };

      await this.cache.set(cacheKey, meta, this.cacheTtlMs);
      return meta;
    } catch {
      return this.createFallbackMeta(packageName, targetVersion ?? '0.0.0', 'rubygems');
    }
  }

  private async fetchPackagistMeta(
    packageName: string,
    targetVersion?: string,
    options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const cacheKey = `packagist:packument:${packageName.toLowerCase()}`;
    if (!options.forceRefresh) {
      const cached = await this.cache.get<PackageMetadata>(cacheKey);
      if (cached) return cached;
    }

    try {
      const url = `https://repo.packagist.org/p2/${encodeURIComponent(packageName)}.json`;
      const data = await this.httpClient.getJson<any>(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      const pkgList = data.packages?.[packageName] ?? [];
      const latest = pkgList[0] ?? {};
      const version = targetVersion ?? latest.version ?? '0.0.0';

      const versionsTime: Record<string, string> = {};
      for (const p of pkgList) {
        if (p.version && p.time) {
          versionsTime[p.version] = p.time;
        }
      }

      const isAbandoned = Boolean(latest.abandoned);

      const meta: PackageMetadata = {
        name: packageName,
        version,
        latestVersion: latest.version ?? version,
        ecosystem: 'packagist',
        description: latest.description,
        publishedAt: latest.time ?? new Date().toISOString(),
        releaseCount: pkgList.length,
        isDeprecated: isAbandoned,
        deprecationReason: isAbandoned ? `Package abandoned: ${latest.abandoned}` : undefined,
        rawRepository: latest.source?.url ? { url: latest.source.url } : undefined,
        hasProvenance: false,
        versionsTime,
      };

      await this.cache.set(cacheKey, meta, this.cacheTtlMs);
      return meta;
    } catch {
      return this.createFallbackMeta(packageName, targetVersion ?? '0.0.0', 'packagist');
    }
  }

  private async fetchGolangMeta(
    packageName: string,
    targetVersion?: string,
    _options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const version = targetVersion ?? 'latest';
    const isGithub = packageName.startsWith('github.com/');
    const repoUrl = isGithub ? `https://${packageName}` : undefined;

    return {
      name: packageName,
      version,
      latestVersion: version,
      ecosystem: 'golang',
      publishedAt: new Date().toISOString(),
      releaseCount: 1,
      isDeprecated: false,
      rawRepository: repoUrl ? { url: repoUrl } : undefined,
      hasProvenance: false,
      versionsTime: { [version]: new Date().toISOString() },
    };
  }

  private async fetchMavenMeta(
    packageName: string,
    targetVersion?: string,
    _options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const version = targetVersion ?? '1.0.0';

    return {
      name: packageName,
      version,
      latestVersion: version,
      ecosystem: 'maven',
      publishedAt: new Date().toISOString(),
      releaseCount: 1,
      isDeprecated: false,
      hasProvenance: false,
      versionsTime: { [version]: new Date().toISOString() },
    };
  }

  private async fetchNuGetMeta(
    packageName: string,
    targetVersion?: string,
    _options: RequestOptions = {},
  ): Promise<PackageMetadata> {
    const version = targetVersion ?? '1.0.0';

    return {
      name: packageName,
      version,
      latestVersion: version,
      ecosystem: 'nuget',
      publishedAt: new Date().toISOString(),
      releaseCount: 1,
      isDeprecated: false,
      hasProvenance: false,
      versionsTime: { [version]: new Date().toISOString() },
    };
  }

  private createFallbackMeta(
    name: string,
    version: string,
    ecosystem: SupportedEcosystem,
  ): PackageMetadata {
    return {
      name,
      version,
      latestVersion: version,
      ecosystem,
      publishedAt: new Date().toISOString(),
      releaseCount: 1,
      isDeprecated: false,
      hasProvenance: false,
      versionsTime: { [version]: new Date().toISOString() },
    };
  }
}
