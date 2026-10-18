import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCommitSubject, parseGitLog, fetchCommits, isValidDateParam } from './commits.js';
import type { Commit } from './types.js';

// ---------------------------------------------------------------------------
// parseCommitSubject
// ---------------------------------------------------------------------------
describe('parseCommitSubject', () => {
  it('parses feat: add button', () => {
    const result = parseCommitSubject('feat: add button');
    expect(result.type).toBe('feat');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('add button');
    expect(result.breaking).toBe(false);
    expect(result.raw).toBe('feat: add button');
  });

  it('parses feat(api): add endpoint', () => {
    const result = parseCommitSubject('feat(api): add endpoint');
    expect(result.type).toBe('feat');
    expect(result.scope).toBe('api');
    expect(result.subject).toBe('add endpoint');
    expect(result.breaking).toBe(false);
  });

  it('parses fix!: breaking bugfix', () => {
    const result = parseCommitSubject('fix!: breaking bugfix');
    expect(result.type).toBe('fix');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('breaking bugfix');
    expect(result.breaking).toBe(true);
  });

  it('parses feat(api)!: break the api', () => {
    const result = parseCommitSubject('feat(api)!: break the api');
    expect(result.type).toBe('feat');
    expect(result.scope).toBe('api');
    expect(result.subject).toBe('break the api');
    expect(result.breaking).toBe(true);
  });

  it('handles non-conventional subject', () => {
    const result = parseCommitSubject('random commit message');
    expect(result.type).toBe('');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('random commit message');
    expect(result.breaking).toBe(false);
  });

  it('parses docs: fix typo in README', () => {
    const result = parseCommitSubject('docs: fix typo in README');
    expect(result.type).toBe('docs');
    expect(result.scope).toBeUndefined();
    expect(result.subject).toBe('fix typo in README');
  });

  it('parses chore(deps): bump lodash', () => {
    const result = parseCommitSubject('chore(deps): bump lodash');
    expect(result.type).toBe('chore');
    expect(result.scope).toBe('deps');
    expect(result.subject).toBe('bump lodash');
  });

  it('lowercases type', () => {
    const result = parseCommitSubject('FEAT: uppercase type');
    expect(result.type).toBe('feat');
    expect(result.subject).toBe('uppercase type');
  });

  it('subject with colon does not confuse parser', () => {
    const result = parseCommitSubject('feat: add something: important');
    expect(result.type).toBe('feat');
    expect(result.subject).toBe('add something: important');
  });

  it('Merge branch subject is non-conventional', () => {
    const result = parseCommitSubject("Merge branch 'main'");
    expect(result.type).toBe('');
    expect(result.subject).toBe("Merge branch 'main'");
    expect(result.breaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseGitLog
// ---------------------------------------------------------------------------
describe('parseGitLog', () => {
  it('handles empty string', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('parses a single conventional commit with no body', () => {
    const stdout =
      'abc1234\x002025-01-01T00:00:00Z\x00Jane Doe <jane@example.com>\x00feat: add button\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      hash: 'abc1234',
      date: '2025-01-01T00:00:00Z',
      author: 'Jane Doe <jane@example.com>',
      type: 'feat',
      scope: undefined,
      subject: 'add button',
      breaking: false,
      raw: 'feat: add button',
    });
  });

  it('parses multiple commits with mix of conventional and non-conventional', () => {
    const stdout =
      'a1\x002025-01-01T00:00:00Z\x00A\x00feat(api): add endpoint\x00\x00\n' +
      'b2\x002025-01-02T00:00:00Z\x00B\x00random message\x00\x00\n' +
      'c3\x002025-01-03T00:00:00Z\x00C\x00fix!: fix it\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(3);

    expect(commits[0].hash).toBe('a1');
    expect(commits[0].type).toBe('feat');
    expect(commits[0].scope).toBe('api');

    expect(commits[1].hash).toBe('b2');
    expect(commits[1].type).toBe('');
    expect(commits[1].subject).toBe('random message');
    expect(commits[1].breaking).toBe(false);

    expect(commits[2].hash).toBe('c3');
    expect(commits[2].type).toBe('fix');
    expect(commits[2].breaking).toBe(true);
  });

  it('detects BREAKING CHANGE: footer in body', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00feat: add feature\x00some detail\n\nBREAKING CHANGE: drops old api\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
    expect(commits[0].type).toBe('feat');
  });

  it('detects BREAKING-CHANGE: footer in body', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00feat: add feature\x00BREAKING-CHANGE: removed\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
  });

  it('combines ! marker and BREAKING CHANGE: body footer', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00feat!: break now\x00also\nBREAKING CHANGE: break more\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
    expect(commits[0].subject).toBe('break now');
  });

  it('body with no breaking marker preserves subject-only breaking', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00fix!: major fix\x00multiline\nbody\ncontent\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(true);
    expect(commits[0].type).toBe('fix');
    expect(commits[0].subject).toBe('major fix');
  });

  it('body with lowercase "breaking change:" does NOT trigger breaking', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00fix: minor fix\x00note: breaking change: not detected\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(false);
  });

  it('subject with colon in non-type position is treated as non-conventional', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00Merge branch \'main\'\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].type).toBe('');
    expect(commits[0].subject).toBe("Merge branch 'main'");
    expect(commits[0].raw).toBe("Merge branch 'main'");
  });

  it('strips trailing newline from body', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00fix: a fix\x00some body\n\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].breaking).toBe(false);
  });

  it('preserves scope when present and undefined when absent', () => {
    const stdout =
      'abc\x002025-01-01T00:00:00Z\x00A\x00chore(deps): update\x00\x00\n' +
      'def\x002025-01-02T00:00:00Z\x00B\x00chore: no scope\x00\x00\n';
    const commits = parseGitLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0].scope).toBe('deps');
    expect(commits[1].scope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isValidDateParam
// ---------------------------------------------------------------------------
describe('isValidDateParam', () => {
  it('accepts ISO date 2025-01-01', () => {
    expect(isValidDateParam('2025-01-01')).toBe(true);
  });

  it('accepts ISO datetime 2025-01-01T00:00:00Z', () => {
    expect(isValidDateParam('2025-01-01T00:00:00Z')).toBe(true);
  });

  it('accepts relative date "3 months ago"', () => {
    expect(isValidDateParam('3 months ago')).toBe(true);
  });

  it('rejects value containing ~', () => {
    expect(isValidDateParam('HEAD~2')).toBe(false);
  });

  it('rejects value containing ^', () => {
    expect(isValidDateParam('main^')).toBe(false);
  });

  it('rejects HEAD', () => {
    expect(isValidDateParam('HEAD')).toBe(false);
  });

  it('rejects FETCH_HEAD', () => {
    expect(isValidDateParam('FETCH_HEAD')).toBe(false);
  });

  it('rejects ORIG_HEAD', () => {
    expect(isValidDateParam('ORIG_HEAD')).toBe(false);
  });

  it('rejects MERGE_HEAD', () => {
    expect(isValidDateParam('MERGE_HEAD')).toBe(false);
  });

  it('rejects CHERRY_PICK_HEAD', () => {
    expect(isValidDateParam('CHERRY_PICK_HEAD')).toBe(false);
  });

  it('rejects all-hex string 7+ chars (looks like hash)', () => {
    expect(isValidDateParam('abc1234')).toBe(false);
  });

  it('rejects long hex string', () => {
    expect(isValidDateParam('deadbeef1234567')).toBe(false);
  });

  it('accepts short hex string (under 7 chars)', () => {
    expect(isValidDateParam('abc123')).toBe(true);
  });

  it('rejects hex with uppercase letters', () => {
    expect(isValidDateParam('ABC1234')).toBe(false);
  });

  it('accepts non-hex string like "yesterday"', () => {
    expect(isValidDateParam('yesterday')).toBe(true);
  });

  it('accepts empty string (git ignores empty --since)', () => {
    // While we don't pass empty strings in practice, the function is lenient
    expect(isValidDateParam('')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchCommits (integration)
// ---------------------------------------------------------------------------
describe('fetchCommits', () => {
  it('returns commits from the repo at apps/changelog-gen', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    const commits = await fetchCommits(root);
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      expect(c).toHaveProperty('hash');
      expect(c).toHaveProperty('date');
      expect(c).toHaveProperty('author');
      expect(typeof c.type).toBe('string');
      expect(typeof c.subject).toBe('string');
      expect(typeof c.breaking).toBe('boolean');
      expect(typeof c.raw).toBe('string');
      // hash should be a non-empty string
      expect(c.hash.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('respects since filter', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    // Future date should return zero commits
    const empty = await fetchCommits(root, '2027-01-01');
    expect(empty.length).toBe(0);
  }, 30_000);

  it('respects until filter', async () => {
    const root = new URL('../..', import.meta.url).pathname;
    const all = await fetchCommits(root);
    const old = await fetchCommits(root, undefined, '2026-07-10');
    expect(old.length).toBeGreaterThan(0);
    expect(old.length).toBeLessThan(all.length);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Hermetic git repo test (real git log output)
// ---------------------------------------------------------------------------
describe('parseGitLog with real git output', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'changelog-gen-hermetic-'));
    execFileSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: repoDir, encoding: 'utf-8',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: repoDir, encoding: 'utf-8',
    });

    // Commit 1: empty body
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    execFileSync('git', ['add', 'a.txt'], { cwd: repoDir, encoding: 'utf-8' });
    execFileSync('git', ['commit', '-m', 'feat: empty body commit'], {
      cwd: repoDir, encoding: 'utf-8',
    });

    // Commit 2: single-line body
    writeFileSync(join(repoDir, 'b.txt'), 'b');
    execFileSync('git', ['add', 'b.txt'], { cwd: repoDir, encoding: 'utf-8' });
    execFileSync('git', ['commit', '-m', 'fix: single line body\n\nsingle body line'], {
      cwd: repoDir, encoding: 'utf-8',
    });

    // Commit 3: multi-line body
    writeFileSync(join(repoDir, 'c.txt'), 'c');
    execFileSync('git', ['add', 'c.txt'], { cwd: repoDir, encoding: 'utf-8' });
    execFileSync('git', ['commit', '-m', 'docs: multi line body\n\nline 1\nline 2\nline 3'], {
      cwd: repoDir, encoding: 'utf-8',
    });

    // Commit 4: BREAKING CHANGE footer
    writeFileSync(join(repoDir, 'd.txt'), 'd');
    execFileSync('git', ['add', 'd.txt'], { cwd: repoDir, encoding: 'utf-8' });
    execFileSync('git', [
      'commit', '-m',
      'feat: breaking change footer\n\nSome body text\n\nBREAKING CHANGE: drops old api',
    ], { cwd: repoDir, encoding: 'utf-8' });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('parses real git log output with various body formats', () => {
    const stdout = execFileSync(
      'git',
      ['-C', repoDir, 'log', '--format=%h%x00%aI%x00%an <%ae>%x00%s%x00%b%x00%n'],
      { encoding: 'utf-8' },
    );

    const commits = parseGitLog(stdout);

    // We should have 4 commits (newest first)
    expect(commits).toHaveLength(4);

    // All hashes must be clean hex strings
    for (const c of commits) {
      expect(c.hash).toMatch(/^[0-9a-f]+$/);
    }

    // Commit 0 (newest): feat with BREAKING CHANGE footer
    expect(commits[0].type).toBe('feat');
    expect(commits[0].subject).toBe('breaking change footer');
    expect(commits[0].breaking).toBe(true);

    // Commit 1: docs with multi-line body — not breaking
    expect(commits[1].type).toBe('docs');
    expect(commits[1].subject).toBe('multi line body');
    expect(commits[1].breaking).toBe(false);

    // Commit 2: fix with single-line body — not breaking
    expect(commits[2].type).toBe('fix');
    expect(commits[2].subject).toBe('single line body');
    expect(commits[2].breaking).toBe(false);

    // Commit 3 (oldest): feat with empty body — not breaking
    expect(commits[3].type).toBe('feat');
    expect(commits[3].subject).toBe('empty body commit');
    expect(commits[3].breaking).toBe(false);
  }, 30_000);
});
