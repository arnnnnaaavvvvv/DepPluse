import type { DependencyRecord } from '../../core/types.js';

export interface PythonDiscovery {
  readonly dependencies: DependencyRecord[];
  readonly manifestPath: string;
  readonly lockfilePath?: string | undefined;
}

/**
 * Parses requirements.txt content into standardized DependencyRecord items.
 */
export function parseRequirementsTxt(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) {
      continue;
    }

    // Strip environment markers (e.g. ; python_version >= '3.8')
    const withoutMarker = line.split(';')[0]?.trim() ?? '';
    if (!withoutMarker) continue;

    // Match package name and version specifier with optional extras like uvicorn[standard]
    // Format: package-name[extras] (==|>=|<=|~=|!=|<|>|===) version
    const match = /^([a-zA-Z0-9_.-]+)(?:\[[^\]]*\])?(?:\s*([=><~!^]+)\s*([a-zA-Z0-9_.*+-]+))?/.exec(
      withoutMarker,
    );
    if (!match || !match[1]) continue;

    const name = match[1].toLowerCase();
    const op = match[2] ?? '';
    const ver = match[3] ?? '*';
    const declaredRange = op ? `${op}${ver}` : '*';
    const resolvedVersion = op === '==' && !ver.includes('*') ? ver : declaredRange;

    records.push({
      id: `${name}@${resolvedVersion}`,
      name,
      declaredRange,
      resolvedVersion,
      type: 'prod',
      source: 'pypi',
      ecosystem: 'pypi',
      registryUrl: 'https://pypi.org',
      isDirect: true,
      dependents: [],
    });
  }

  return records;
}

/**
 * Parses pyproject.toml dependencies (PEP 621 or Poetry).
 */
export function parsePyprojectToml(content: string, _filePath: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const lines = content.split(/\r?\n/);

  let inProjectDeps = false;
  let inPoetryDeps = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#') || !line) continue;

    if (line.startsWith('[project.dependencies]') || line.startsWith('dependencies = [')) {
      inProjectDeps = true;
      inPoetryDeps = false;
      continue;
    }

    if (line.startsWith('[tool.poetry.dependencies]')) {
      inPoetryDeps = true;
      inProjectDeps = false;
      continue;
    }

    if (line.startsWith('[') && !line.includes('dependencies')) {
      inProjectDeps = false;
      inPoetryDeps = false;
      continue;
    }

    if (inProjectDeps) {
      if (line === ']') {
        inProjectDeps = false;
        continue;
      }
      const depMatch =
        /^"([a-zA-Z0-9_.-]+)(?:\[[^\]]*\])?(?:\s*([=><~!^]+)\s*([^"]+))?"/.exec(line) ||
        /^'([a-zA-Z0-9_.-]+)(?:\[[^\]]*\])?(?:\s*([=><~!^]+)\s*([^']+))?'/.exec(line);
      if (depMatch && depMatch[1]) {
        const name = depMatch[1].toLowerCase();
        const op = depMatch[2] ?? '';
        const ver = depMatch[3] ?? '*';
        const declaredRange = op ? `${op}${ver}` : '*';
        records.push({
          id: `${name}@${declaredRange}`,
          name,
          declaredRange,
          resolvedVersion: op === '==' ? ver : declaredRange,
          type: 'prod',
          source: 'pypi',
          ecosystem: 'pypi',
          registryUrl: 'https://pypi.org',
          isDirect: true,
          dependents: [],
        });
      }
    } else if (inPoetryDeps) {
      if (line.startsWith('python =')) continue;
      const poetryMatch =
        /^([a-zA-Z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(line) ||
        /^([a-zA-Z0-9_.-]+)\s*=\s*\{[^}]*version\s*=\s*["']([^"']+)["']/.exec(line);
      if (poetryMatch && poetryMatch[1] && poetryMatch[2]) {
        const name = poetryMatch[1].toLowerCase();
        const declaredRange = poetryMatch[2];
        records.push({
          id: `${name}@${declaredRange}`,
          name,
          declaredRange,
          resolvedVersion: declaredRange,
          type: 'prod',
          source: 'pypi',
          ecosystem: 'pypi',
          registryUrl: 'https://pypi.org',
          isDirect: true,
          dependents: [],
        });
      }
    }
  }

  return records;
}

/**
 * Parses poetry.lock into locked DependencyRecord entries.
 */
export function parsePoetryLock(content: string): Map<string, string> {
  const locked = new Map<string, string>();
  const blocks = content.split('[[package]]');

  for (const block of blocks) {
    const nameMatch = /name\s*=\s*"([^"]+)"/.exec(block);
    const verMatch = /version\s*=\s*"([^"]+)"/.exec(block);
    if (nameMatch && nameMatch[1] && verMatch && verMatch[1]) {
      locked.set(nameMatch[1].toLowerCase(), verMatch[1]);
    }
  }

  return locked;
}
