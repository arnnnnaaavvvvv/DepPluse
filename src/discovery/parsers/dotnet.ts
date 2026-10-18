import type { DependencyRecord } from '../../core/types.js';

export function parseCsProj(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('<!--') || !line) continue;

    const match =
      /<PackageReference\s+[^>]*Include=["']([^"']+)["'][^>]*Version=["']([^"']+)["']/.exec(line) ||
      /<PackageReference\s+[^>]*Version=["']([^"']+)["'][^>]*Include=["']([^"']+)["']/.exec(line);

    if (match && match[1] && match[2]) {
      const name = match[1];
      const version = match[2];
      records.push({
        id: `${name}@${version}`,
        name,
        declaredRange: version,
        resolvedVersion: version,
        type: 'prod',
        source: 'nuget',
        ecosystem: 'nuget',
        registryUrl: 'https://api.nuget.org',
        isDirect: true,
        dependents: [],
      });
    }
  }

  return records;
}

export function parsePackagesConfig(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = /<package\s+[^>]*id=["']([^"']+)["'][^>]*version=["']([^"']+)["']/.exec(line);
    if (match && match[1] && match[2]) {
      const name = match[1];
      const version = match[2];
      records.push({
        id: `${name}@${version}`,
        name,
        declaredRange: version,
        resolvedVersion: version,
        type: 'prod',
        source: 'nuget',
        ecosystem: 'nuget',
        registryUrl: 'https://api.nuget.org',
        isDirect: true,
        dependents: [],
      });
    }
  }

  return records;
}
