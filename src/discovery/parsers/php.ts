import type { DependencyRecord, DependencyType } from '../../core/types.js';

interface RawComposerJson {
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

interface RawComposerLock {
  packages?: Array<{ name: string; version: string }>;
  'packages-dev'?: Array<{ name: string; version: string }>;
}

export function parseComposerJson(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  try {
    const raw = JSON.parse(content) as RawComposerJson;

    const processMap = (map: Record<string, string> | undefined, type: DependencyType) => {
      if (!map) return;
      for (const [name, range] of Object.entries(map)) {
        if (name === 'php' || name.startsWith('ext-')) continue;
        records.push({
          id: `${name}@${range}`,
          name,
          declaredRange: range,
          resolvedVersion: range,
          type,
          source: 'packagist',
          ecosystem: 'packagist',
          registryUrl: 'https://packagist.org',
          isDirect: true,
          dependents: [],
        });
      }
    };

    processMap(raw.require, 'prod');
    processMap(raw['require-dev'], 'dev');
  } catch {
    // If invalid JSON, returns empty records without crash
  }

  return records;
}

export function parseComposerLock(content: string): Map<string, string> {
  const locked = new Map<string, string>();
  try {
    const raw = JSON.parse(content) as RawComposerLock;
    const all = [...(raw.packages ?? []), ...(raw['packages-dev'] ?? [])];
    for (const pkg of all) {
      if (pkg.name && pkg.version) {
        locked.set(pkg.name, pkg.version.replace(/^v/, ''));
      }
    }
  } catch {
    // Graceful parse
  }

  return locked;
}
