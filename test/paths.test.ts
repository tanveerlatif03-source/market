import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesAnyPath, ownersOfPaths, pathsOutsideLane } from '../src/paths.ts';

describe('task lanes', () => {
  it('matches exact files', () => {
    assert.equal(matchesAnyPath('src/auth/page.tsx', ['src/auth/page.tsx']), true);
    assert.equal(matchesAnyPath('src/auth/api.ts', ['src/auth/page.tsx']), false);
  });

  it('treats a trailing slash as everything underneath', () => {
    assert.equal(matchesAnyPath('src/auth/deep/file.ts', ['src/auth/']), true);
    assert.equal(matchesAnyPath('src/other.ts', ['src/auth/']), false);
  });

  it('keeps a single star inside one segment', () => {
    assert.equal(matchesAnyPath('src/auth.ts', ['src/*.ts']), true);
    assert.equal(matchesAnyPath('src/auth/page.ts', ['src/*.ts']), false);
    assert.equal(matchesAnyPath('src/auth/page.ts', ['src/**']), true);
  });

  it('normalizes leading ./ and duplicate slashes', () => {
    assert.equal(matchesAnyPath('./src//auth/page.tsx', ['src/auth/page.tsx']), true);
  });

  it('does not let a dot in the pattern match any character', () => {
    assert.equal(matchesAnyPath('srcXauth', ['src.auth']), false);
  });

  it('reports which files fall outside the lane', () => {
    assert.deepEqual(
      pathsOutsideLane(['src/ui/page.tsx', 'src/api/route.ts'], ['src/ui/**']),
      ['src/api/route.ts']
    );
  });

  it('names the task that owns a file, so the agent knows who to ask', () => {
    const tasks = [
      { id: 'ui', paths: ['src/ui/**'], owner: 'claude' },
      { id: 'api', paths: ['src/api/**'], owner: 'cursor' }
    ];
    assert.deepEqual(ownersOfPaths(['src/api/route.ts'], tasks, 'ui'), [
      { path: 'src/api/route.ts', taskId: 'api', owner: 'cursor' }
    ]);
  });
});
