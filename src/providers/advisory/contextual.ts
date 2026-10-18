import type { ContextualAdvisory, SupportedEcosystem } from '../../core/types.js';
import type { AdvisoryProvider, CacheStore, RequestOptions } from '../types.js';
import type { ResilientHttpClient } from '../http/client.js';

interface OsvVulnSeverity {
  type?: string;
  score?: string;
}

interface OsvApiResponse {
  vulns?: Array<{
    id: string;
    summary?: string;
    details?: string;
    aliases?: string[];
    severity?: OsvVulnSeverity[];
    database_specific?: {
      severity?: string;
    };
    ecosystem_specific?: {
      severity?: string;
    };
  }>;
}

function toOsvEcosystem(eco?: SupportedEcosystem): string {
  switch (eco) {
    case 'pypi':
      return 'PyPI';
    case 'crates':
      return 'crates.io';
    case 'golang':
      return 'Go';
    case 'rubygems':
      return 'RubyGems';
    case 'packagist':
      return 'Packagist';
    case 'maven':
      return 'Maven';
    case 'nuget':
      return 'NuGet';
    case 'npm':
    default:
      return 'npm';
  }
}

function normalizeSeverity(raw?: string): 'low' | 'moderate' | 'high' | 'critical' {
  if (!raw) return 'moderate';
  const s = raw.toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'moderate' || s === 'medium') return 'moderate';
  if (s === 'low') return 'low';
  return 'moderate';
}

export class DefaultAdvisoryProvider implements AdvisoryProvider {
  constructor(
    private readonly httpClient: ResilientHttpClient,
    private readonly cache: CacheStore,
    private readonly cacheTtlMs = 2 * 60 * 60 * 1000, // 2 hours
  ) {}

  async getAdvisories(
    packageName: string,
    version: string,
    options: RequestOptions = {},
    ecosystem?: SupportedEcosystem,
  ): Promise<readonly ContextualAdvisory[]> {
    const osvEco = toOsvEcosystem(ecosystem);
    const cacheKey = `adv:osv:${osvEco}:${packageName}@${version}`;

    if (!options.forceRefresh) {
      const cached = await this.cache.get<ContextualAdvisory[]>(cacheKey);
      if (cached) return cached;
    }

    // OSV provides open package vulnerability data via POST /v1/query
    const url = 'https://api.osv.dev/v1/query';
    const cleanVersion = version ? version.replace(/^v/, '') : '';
    const queryPayload: Record<string, unknown> = {
      package: {
        name: packageName,
        ecosystem: osvEco,
      },
    };
    if (
      cleanVersion &&
      cleanVersion !== '*' &&
      !cleanVersion.startsWith('^') &&
      !cleanVersion.startsWith('~')
    ) {
      queryPayload['version'] = cleanVersion;
    }

    try {
      const data = await this.httpClient.postJson<OsvApiResponse>(url, queryPayload, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      const list: ContextualAdvisory[] = (data.vulns ?? []).map(v => {
        const rawSev = v.database_specific?.severity ?? v.ecosystem_specific?.severity ?? '';

        const severity = normalizeSeverity(rawSev);
        const cveId = v.aliases?.find(a => a.startsWith('CVE-'));

        // Clean summary / title
        let title = v.summary?.trim() || '';
        if (!title && v.details) {
          title =
            v.details
              .split(/\r?\n/)[0]
              ?.replace(/^#+\s*/, '')
              .trim() || '';
        }
        if (!title) {
          title = cveId ? `${cveId} vulnerability in ${packageName}` : v.id;
        }

        return {
          advisoryId: v.id,
          title,
          severity,
          url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`,
          packageName,
          packageVersion: cleanVersion || version,
          cveId,
        };
      });

      await this.cache.set(cacheKey, list, this.cacheTtlMs);
      return list;
    } catch {
      // If advisory query fails, return empty list (advisories are contextual only)
      return [];
    }
  }
}
