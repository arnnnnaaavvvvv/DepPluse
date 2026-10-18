import type { DependencyRecord, DependencyType } from '../../core/types.js';

export function parseGoMod(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  let inRequireBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }

    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }

    if (inRequireBlock || line.startsWith('require ')) {
      const cleanLine = inRequireBlock ? line : line.replace(/^require\s+/, '');
      const parts = cleanLine.split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0]!;
        const version = parts[1]!;
        const isIndirect = cleanLine.includes('// indirect');
        const type: DependencyType = isIndirect ? 'transitive' : 'prod';

        records.push({
          id: `${name}@${version}`,
          name,
          declaredRange: version,
          resolvedVersion: version,
          type,
          source: 'golang',
          ecosystem: 'golang',
          registryUrl: 'https://proxy.golang.org',
          isDirect: !isIndirect,
          dependents: [],
        });
      }
    }
  }

  return records;
}

export function parseGoSum(content: string): Map<string, string> {
  const locked = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const name = parts[0]!;
      const version = parts[1]!.replace(/\/go\.mod$/, '');
      if (!locked.has(name)) {
        locked.set(name, version);
      }
    }
  }

  return locked;
}
