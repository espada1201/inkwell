import { describe, expect, it } from 'vitest';
import { nearLine, phoneNote } from '../../src/ui/warnnear';

describe('the warning line for a named place', () => {
  it('says plainly when the shaking came first, with the range of seconds', () => {
    expect(nearLine('Napa', 9.6, { n: 4, min: -3.68, max: -0.47, warned: 0 }, 15)).toBe(
      'Near Napa (10 km from the epicentre): shaking came 0.5–3.7 s before the alert (4 phones within 15 km), so no warning.',
    );
  });

  it('says so in the singular for one phone', () => {
    expect(nearLine('Napa', 9.6, { n: 1, min: -1.2, max: -1.2, warned: 0 }, 15)).toBe(
      'Near Napa (10 km from the epicentre): shaking came 1.2 s before the alert (1 phone within 15 km), so no warning.',
    );
  });

  it('gives the warning when the alert came first', () => {
    expect(nearLine('Ridgecrest', 17.9, { n: 2, min: 3.14, max: 5.06, warned: 2 }, 15)).toBe(
      'Near Ridgecrest (18 km from the epicentre): the alert came 3.1–5.1 s before the strong shaking (2 phones within 15 km).',
    );
  });

  it('says both when phones there differ', () => {
    expect(nearLine('Napa', 9.6, { n: 3, min: -2, max: 1.5, warned: 1 }, 15)).toBe(
      'Near Napa (10 km from the epicentre): from shaking 2.0 s before the alert to 1.5 s of warning (3 phones within 15 km); 1 of 3 phones was warned.',
    );
  });

  it('says there is no figure where no simulated phone felt it', () => {
    expect(nearLine('Napa', 9.6, null, 15)).toBe('Near Napa (10 km from the epicentre): no simulated phone within 15 km felt it, so there is no figure for it.');
  });
});

describe('the note on one phone', () => {
  const at = (s: number, felt = true) => ({ lat: 0, lon: 0, epicentreKm: 9.64, s, felt });
  it('gives its distance and its seconds', () => {
    expect(phoneNote(at(-3.68), true)).toBe('Simulated phone, 9.6 km from the epicentre. The strong shaking reached it 3.7 s before the alert: no warning.');
    expect(phoneNote(at(12.04), true)).toBe('Simulated phone, 9.6 km from the epicentre. The alert reached it 12.0 s before the strong shaking.');
  });
  it('says when it barely felt the quake, and when there is no alert yet', () => {
    expect(phoneNote(at(40, false), true)).toBe('Simulated phone, 9.6 km from the epicentre. It barely felt the quake.');
    expect(phoneNote(at(0), false)).toBe('Simulated phone, 9.6 km from the epicentre. No alert yet, so no warning time yet.');
  });
});
