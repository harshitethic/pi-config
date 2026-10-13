import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getUsage, validateFormat } from './cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
const cliPath = join(__dirname, 'cli.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-gen-test-'));
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  // Make a file so we have something to commit
  writeFileSync(join(dir, 'README.md'), '# Test');
  spawnSync('git', ['add', 'README.md'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'feat: initial commit'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  // More commits with different types
  writeFileSync(join(dir, 'file1.txt'), 'content');
  spawnSync('git', ['add', 'file1.txt'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'fix: bug fix'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  writeFileSync(join(dir, 'file2.txt'), 'content');
  spawnSync('git', ['add', 'file2.txt'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'docs: update docs'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  // BREAKING CHANGE via ! marker
  writeFileSync(join(dir, 'file3.txt'), 'content');
  spawnSync('git', ['add', 'file3.txt'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'feat!: breaking feature change'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  return dir;
}

function runCli(args: string[], cwd?: string) {
  return spawnSync('npx', ['tsx', cliPath, ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env, PATH: process.env.PATH },
  });
}

// ---------------------------------------------------------------------------
// Pure unit tests
// ---------------------------------------------------------------------------

describe('getUsage', () => {
  it('returns usage text with expected content', () => {
    const usage = getUsage();
    expect(usage).toContain('Usage: changelog-gen');
    expect(usage).toContain('--since');
    expect(usage).toContain('--until');
    expect(usage).toContain('--format');
    expect(usage).toContain('-h, --help');
  });
});

describe('validateFormat', () => {
  it('accepts "md"', () => {
    expect(validateFormat('md')).toBe(true);
  });

  it('accepts "text"', () => {
    expect(validateFormat('text')).toBe(true);
  });

  it('rejects "xml"', () => {
    expect(validateFormat('xml')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateFormat('')).toBe(false);
  });

  it('rejects "MD" (case-sensitive)', () => {
    expect(validateFormat('MD')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('CLI integration', () => {
  let tempRepo: string;

  beforeAll(() => {
    tempRepo = createTempGitRepo();
  }, 30_000);

  afterAll(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  }, 30_000);

  it('happy path --format md', () => {
    const result = runCli([tempRepo, '--format', 'md']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('# Changelog');
    expect(result.stdout).toContain('⚠ Breaking changes');
    expect(result.stdout).toContain('## feat');
    expect(result.stdout).toContain('## fix');
    expect(result.stdout).toContain('## docs');
    // Each commit line is a bullet with hash:subject
    const lines = result.stdout.split('\n');
    const bulletLines = lines.filter(l => /^- [0-9a-f]+: /.test(l));
    expect(bulletLines.length).toBeGreaterThanOrEqual(4);
    // Breaking section in md uses backtick-wrapped hash: `hash`: subject
    const breakingBulletLines = lines.filter(l => /^- `[0-9a-f]+`/.test(l));
    expect(breakingBulletLines.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('happy path --format text', () => {
    const result = runCli([tempRepo, '--format', 'text']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('CHANGELOG');
    expect(result.stdout).toContain('BREAKING CHANGES');
    expect(result.stdout).toContain('FEAT');
    expect(result.stdout).toContain('FIX');
    expect(result.stdout).toContain('DOCS');
    // Each commit line is a bullet with hash:subject
    const lines = result.stdout.split('\n');
    const bulletLines = lines.filter(l => /^- [0-9a-f]+: /.test(l));
    expect(bulletLines.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('--help flag prints usage and exits 0', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: changelog-gen');
    expect(result.stdout).toContain('--since');
    expect(result.stdout).toContain('--format');
  }, 30_000);

  it('-h short flag prints usage and exits 0', () => {
    const result = runCli(['-h']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: changelog-gen');
  }, 30_000);

  it('invalid --format exits 1 with error message', () => {
    const result = runCli([tempRepo, '--format', 'xml']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changelog-gen:');
    expect(result.stderr).toContain('Invalid format');
  }, 30_000);

  it('non-git / bad repo path exits 1', () => {
    const result = runCli(['/tmp/nonexistent-repo-12345']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changelog-gen:');
  }, 30_000);

  it('--since filter to future date returns empty changelog', () => {
    const result = runCli([tempRepo, '--since', '2099-01-01']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Changelog');
  }, 30_000);

  it('--until filter includes all commits from temp repo', () => {
    const result = runCli([tempRepo, '--until', '2099-01-01']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Changelog');
    expect(result.stdout).toContain('## feat');
    expect(result.stdout).toContain('## fix');
    expect(result.stdout).toContain('## docs');
    expect(result.stdout).toContain('⚠ Breaking changes');
  }, 30_000);

  it('unknown flag exits 1 with error message', () => {
    const result = runCli(['--unknown-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changelog-gen:');
  }, 30_000);
});

describe('CLI default repo', () => {
  it('default repo . exits 0 with changelog header', () => {
    // Run from the apps/changelog-gen directory (which is a git repo)
    const result = spawnSync('npx', ['tsx', cliPath], {
      cwd: join(__dirname, '..'),
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Changelog');
  }, 30_000);
});
