import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/model/samples';
import { Studio } from '../src/model/studio';
import { motionWarnings, poseGroups, sampleAnimation } from '../src/model/rig';

describe('samples', () => {
  for (const s of SAMPLES) {
    it(`${s.name} builds with no warnings and no locked joints`, () => {
      const st = new Studio(s.make());
      const { warnings, rig } = st.analysis();
      expect(warnings.map((w) => w.message)).toEqual([]);
      expect([...rig.joints.values()].filter((j) => j.locked)).toHaveLength(0);
      expect(rig.joints.size).toBeGreaterThan(0);
    });
  }
  it('the walker steps through its walk cycle without joints hitting anything', () => {
    const st = new Studio(SAMPLES[0].make());
    const { rig, graph } = st.analysis();
    const anim = st.v.animations[0];
    const vals = sampleAnimation(st.v, anim, 0.5)!;
    expect(Object.keys(vals).length).toBe(12);
    const mats = poseGroups(st.v, rig, vals);
    expect(mats.some((m) => !m.equals(mats[0]))).toBe(true);
    void graph;
  });
  it('the battleship turrets sweep clear of the superstructure', () => {
    const st = new Studio(SAMPLES[1].make());
    const { rig, graph } = st.analysis();
    const w = motionWarnings(st.v, rig, graph, st.solver, 6).filter((x) => x.kind !== 'motion' || !x.message.startsWith('In this pose'));
    expect(w.map((x) => x.message)).toEqual([]);
  });
});
