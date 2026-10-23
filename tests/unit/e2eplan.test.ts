import { describe, expect, it } from 'vitest';
import config from '../../playwright.config';

describe('how the browser tests are laid out', () => {
  const projects = config.projects ?? [];
  const named = (n: string) => projects.find((p) => p.name === n);

  it('runs the scale spec alone, in its own project, after every other project', () => {
    const scale = named('scale');
    expect(scale).toBeDefined();
    expect(String(scale!.testMatch)).toContain('scale');
    expect(scale!.fullyParallel).toBe(false);
    const others = projects.filter((p) => p.name !== 'scale').map((p) => p.name);
    expect(others.length).toBeGreaterThan(0);
    expect([...(scale!.dependencies ?? [])].sort()).toEqual([...others].sort());
  });

  it('keeps the scale spec out of every other project, so nothing runs it twice or beside its neighbours', () => {
    for (const p of projects.filter((p) => p.name !== 'scale')) {
      const matches = (file: string) => (p.testMatch ? [p.testMatch].flat().some((m) => new RegExp(String(m instanceof RegExp ? m.source : m)).test(file)) : true) && ![p.testIgnore ?? []].flat().some((m) => m instanceof RegExp && m.test(file));
      expect(matches('scale.spec.ts'), p.name).toBe(false);
    }
  });
});
