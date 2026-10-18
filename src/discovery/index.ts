import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseManifest } from './manifest.js';
import { findAndParseLockfile } from './lockfiles/resolver.js';
import type { DiscoveryResult, ProjectManifest, SkippedDependency } from './types.js';
import type { DependencyRecord, SupportedEcosystem } from '../core/types.js';
import { DiscoveryError } from '../core/errors.js';
import semver from 'semver';

import { detectEcosystemManifests } from './detector.js';
import { parsePyprojectToml, parseRequirementsTxt, parsePoetryLock } from './parsers/python.js';
import { parseCargoLock, parseCargoToml } from './parsers/rust.js';
import { parseGoMod, parseGoSum } from './parsers/golang.js';
import { parseGemfile, parseGemfileLock } from './parsers/ruby.js';
import { parseComposerJson, parseComposerLock } from './parsers/php.js';
import { parseBuildGradle, parsePomXml } from './parsers/jvm.js';
import { parseCsProj, parsePackagesConfig } from './parsers/dotnet.js';

export interface DiscoveryOptions {
  includeDev?: boolean;
  includeTransitive?: boolean;
  ecosystem?: SupportedEcosystem | 'all' | undefined;
}

export async function discoverDependencies(
  projectDirOrManifest: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const includeDev = options.includeDev ?? true;
  const includeTransitive = options.includeTransitive ?? true;

  let projectDir = projectDirOrManifest;
  let targetFile: string | null = null;

  try {
    const stat = await fs.stat(projectDirOrManifest);
    if (!stat.isDirectory()) {
      targetFile = path.basename(projectDirOrManifest);
      projectDir = path.dirname(projectDirOrManifest);
    }
  } catch {
    // Let parsing proceed to trigger DiscoveryError
  }

  const dependencies: DependencyRecord[] = [];
  const skipped: SkippedDependency[] = [];
  const warnings: string[] = [];

  let manifestPath = targetFile
    ? path.join(projectDir, targetFile)
    : path.join(projectDir, 'package.json');
  let lockfilePath: string | undefined;
  let lockfileFormat: any | undefined;
  let coverage: 'full' | 'partial' | 'direct-only' = 'direct-only';
  let projectManifest: ProjectManifest | undefined;

  // 1. Specific file targeted directly
  if (targetFile) {
    const content = await fs.readFile(manifestPath, 'utf-8').catch(err => {
      throw new DiscoveryError(
        `Failed to read manifest at ${manifestPath}`,
        'Verify file exists and is readable.',
        { path: manifestPath },
        { cause: err },
      );
    });

    if (targetFile === 'package.json') {
      return discoverNpmDependencies(projectDir, manifestPath, includeDev, includeTransitive);
    } else if (targetFile === 'requirements.txt') {
      dependencies.push(...parseRequirementsTxt(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'pyproject.toml') {
      dependencies.push(...parsePyprojectToml(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'Cargo.toml') {
      dependencies.push(...parseCargoToml(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'go.mod') {
      dependencies.push(...parseGoMod(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'Gemfile') {
      dependencies.push(...parseGemfile(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'composer.json') {
      dependencies.push(...parseComposerJson(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'pom.xml') {
      dependencies.push(...parsePomXml(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'build.gradle' || targetFile === 'build.gradle.kts') {
      dependencies.push(...parseBuildGradle(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile.endsWith('.csproj')) {
      dependencies.push(...parseCsProj(content, manifestPath));
      coverage = 'direct-only';
    } else if (targetFile === 'packages.config') {
      dependencies.push(...parsePackagesConfig(content, manifestPath));
      coverage = 'direct-only';
    }

    return {
      manifestPath,
      manifest: {
        path: manifestPath,
        raw: {},
        isPrivate: false,
        workspaces: [],
        declaredDependencies: dependencies.map(d => ({
          name: d.name,
          range: d.declaredRange,
          type: d.type,
          source: d.source,
        })),
      },
      coverage,
      dependencies,
      skipped,
      warnings,
    };
  }

  // 2. Directory scan: Check if package.json exists
  const hasPackageJson = await fs
    .stat(path.join(projectDir, 'package.json'))
    .then(s => s.isFile())
    .catch(() => false);

  if (hasPackageJson) {
    const npmDiscovery = await discoverNpmDependencies(
      projectDir,
      path.join(projectDir, 'package.json'),
      includeDev,
      includeTransitive,
    );
    dependencies.push(...npmDiscovery.dependencies);
    skipped.push(...npmDiscovery.skipped);
    warnings.push(...npmDiscovery.warnings);
    manifestPath = npmDiscovery.manifestPath;
    lockfilePath = npmDiscovery.lockfilePath;
    lockfileFormat = npmDiscovery.lockfileFormat;
    coverage = npmDiscovery.coverage;
    projectManifest = npmDiscovery.manifest;
  }

  // 3. Check for any other language ecosystem manifests in the same directory (polyglot support)
  const detected = await detectEcosystemManifests(projectDir);

  for (const item of detected) {
    if (item.ecosystem === 'npm') continue; // Handled above

    try {
      const content = await fs.readFile(item.manifestPath, 'utf-8');
      const base = path.basename(item.manifestPath);

      if (base === 'requirements.txt') {
        dependencies.push(...parseRequirementsTxt(content, item.manifestPath));
      } else if (base === 'pyproject.toml') {
        dependencies.push(...parsePyprojectToml(content, item.manifestPath));
        if (item.lockfilePath) {
          const lockContent = await fs.readFile(item.lockfilePath, 'utf-8').catch(() => '');
          if (lockContent) {
            const locked = parsePoetryLock(lockContent);
            for (let i = 0; i < dependencies.length; i++) {
              const d = dependencies[i]!;
              if (d.ecosystem === 'pypi' && locked.has(d.name)) {
                dependencies[i] = { ...d, resolvedVersion: locked.get(d.name)! };
              }
            }
          }
        }
      } else if (base === 'Cargo.toml') {
        const cargoDeps = parseCargoToml(content, item.manifestPath);
        if (item.lockfilePath) {
          const lockContent = await fs.readFile(item.lockfilePath, 'utf-8').catch(() => '');
          if (lockContent) {
            const locked = parseCargoLock(lockContent);
            for (let i = 0; i < cargoDeps.length; i++) {
              const d = cargoDeps[i]!;
              if (locked.has(d.name)) {
                cargoDeps[i] = { ...d, resolvedVersion: locked.get(d.name)! };
              }
            }
          }
        }
        dependencies.push(...cargoDeps);
      } else if (base === 'go.mod') {
        const goDeps = parseGoMod(content, item.manifestPath);
        if (item.lockfilePath) {
          const lockContent = await fs.readFile(item.lockfilePath, 'utf-8').catch(() => '');
          if (lockContent) {
            const locked = parseGoSum(lockContent);
            for (let i = 0; i < goDeps.length; i++) {
              const d = goDeps[i]!;
              if (locked.has(d.name)) {
                goDeps[i] = { ...d, resolvedVersion: locked.get(d.name)! };
              }
            }
          }
        }
        dependencies.push(...goDeps);
      } else if (base === 'Gemfile') {
        const rubyDeps = parseGemfile(content, item.manifestPath);
        if (item.lockfilePath) {
          const lockContent = await fs.readFile(item.lockfilePath, 'utf-8').catch(() => '');
          if (lockContent) {
            const locked = parseGemfileLock(lockContent);
            for (let i = 0; i < rubyDeps.length; i++) {
              const d = rubyDeps[i]!;
              if (locked.has(d.name)) {
                rubyDeps[i] = { ...d, resolvedVersion: locked.get(d.name)! };
              }
            }
          }
        }
        dependencies.push(...rubyDeps);
      } else if (base === 'composer.json') {
        const phpDeps = parseComposerJson(content, item.manifestPath);
        if (item.lockfilePath) {
          const lockContent = await fs.readFile(item.lockfilePath, 'utf-8').catch(() => '');
          if (lockContent) {
            const locked = parseComposerLock(lockContent);
            for (let i = 0; i < phpDeps.length; i++) {
              const d = phpDeps[i]!;
              if (locked.has(d.name)) {
                phpDeps[i] = { ...d, resolvedVersion: locked.get(d.name)! };
              }
            }
          }
        }
        dependencies.push(...phpDeps);
      } else if (base === 'pom.xml') {
        dependencies.push(...parsePomXml(content, item.manifestPath));
      } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
        dependencies.push(...parseBuildGradle(content, item.manifestPath));
      } else if (base === 'packages.config') {
        dependencies.push(...parsePackagesConfig(content, item.manifestPath));
      }

      if (!hasPackageJson && !manifestPath.endsWith(base)) {
        manifestPath = item.manifestPath;
        if (item.lockfilePath) lockfilePath = item.lockfilePath;
      }
    } catch {
      // Ignore reading issues on secondary manifests
    }
  }

  // 4. If nothing was found at all and package.json was not present, trigger standard DiscoveryError
  if (!hasPackageJson && detected.length === 0) {
    // Calling parseManifest will throw standard DiscoveryError for missing manifest
    await parseManifest(projectDirOrManifest);
  }

  if (!projectManifest) {
    projectManifest = {
      path: manifestPath,
      raw: {},
      isPrivate: false,
      workspaces: [],
      declaredDependencies: dependencies.map(d => ({
        name: d.name,
        range: d.declaredRange,
        type: d.type,
        source: d.source,
      })),
    };
  }

  return {
    manifestPath,
    manifest: projectManifest,
    lockfilePath,
    lockfileFormat,
    coverage,
    dependencies,
    skipped,
    warnings,
  };
}

async function discoverNpmDependencies(
  projectDir: string,
  manifestPath: string,
  includeDev: boolean,
  includeTransitive: boolean,
): Promise<DiscoveryResult> {
  const manifest = await parseManifest(manifestPath);
  const lockfile = await findAndParseLockfile(projectDir);

  const dependencies: DependencyRecord[] = [];
  const skipped: SkippedDependency[] = [];
  const warnings: string[] = [...(lockfile?.warnings ?? [])];
  const directNames = new Set<string>();

  for (const declared of manifest.declaredDependencies) {
    if (declared.type === 'dev' && !includeDev) {
      continue;
    }

    if (declared.source === 'workspace') {
      skipped.push({
        name: declared.name,
        declaredRange: declared.range,
        reason: 'private_workspace',
        explanation:
          'Local workspace package; internal source code is not published to public npm.',
      });
      continue;
    }

    if (declared.source === 'file' || declared.source === 'git') {
      skipped.push({
        name: declared.name,
        declaredRange: declared.range,
        reason: 'unsupported_source',
        explanation: `Non-npm source (${declared.source}); public registry telemetry is unavailable.`,
      });
      continue;
    }

    if (declared.source === 'alias') {
      skipped.push({
        name: declared.name,
        declaredRange: declared.range,
        reason: 'unsupported_source',
        explanation: `npm alias dependency (${declared.range}); direct registry telemetry lookup is skipped.`,
      });
      continue;
    }

    if (declared.source === 'unknown') {
      skipped.push({
        name: declared.name,
        declaredRange: declared.range,
        reason: 'unsupported_source',
        explanation: `Unrecognized dependency source format (${declared.range}); public registry telemetry is unavailable.`,
      });
      continue;
    }

    directNames.add(declared.name);

    let resolvedVersion = '';
    const lockfileEntry = lockfile?.packages.get(declared.name);
    if (lockfileEntry?.resolvedVersion) {
      resolvedVersion = lockfileEntry.resolvedVersion;
    } else {
      const cleanVer = semver.clean(declared.range);
      if (cleanVer) {
        resolvedVersion = cleanVer;
      } else {
        resolvedVersion = declared.range;
      }
    }

    dependencies.push({
      id: `${declared.name}@${resolvedVersion || declared.range}`,
      name: declared.name,
      declaredRange: declared.range,
      resolvedVersion: resolvedVersion || declared.range,
      type: declared.type,
      source: 'npm',
      ecosystem: 'npm',
      registryUrl: 'https://registry.npmjs.org',
      isDirect: true,
      dependents: [],
    });
  }

  if (includeTransitive && lockfile) {
    for (const [name, entry] of lockfile.packages.entries()) {
      if (directNames.has(name) || entry.isDirect) {
        continue;
      }

      dependencies.push({
        id: `${name}@${entry.resolvedVersion}`,
        name,
        declaredRange: entry.resolvedVersion,
        resolvedVersion: entry.resolvedVersion,
        type: 'transitive',
        source: 'npm',
        ecosystem: 'npm',
        registryUrl: 'https://registry.npmjs.org',
        isDirect: false,
        dependents: entry.dependents,
      });
    }
  }

  const coverage = lockfile && includeTransitive ? lockfile.coverage : 'direct-only';
  if (!lockfile) {
    warnings.push(
      'No lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock) found. Running in direct-only coverage mode.',
    );
  } else if (!includeTransitive) {
    warnings.push('Transitive scanning disabled. Running in direct-only coverage mode.');
  }

  return {
    manifestPath: manifest.path,
    manifest,
    lockfilePath: lockfile?.path,
    lockfileFormat: lockfile?.format,
    coverage,
    dependencies,
    skipped,
    warnings,
  };
}

export * from './types.js';
export * from './manifest.js';
export * from './source-classifier.js';
export * from './detector.js';
export * from './lockfiles/npm.js';
export * from './lockfiles/pnpm-yarn.js';
export * from './lockfiles/resolver.js';
export * from './parsers/python.js';
export * from './parsers/rust.js';
export * from './parsers/golang.js';
export * from './parsers/ruby.js';
export * from './parsers/php.js';
export * from './parsers/jvm.js';
export * from './parsers/dotnet.js';
