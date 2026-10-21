# Vehicle Studio

A browser-based 3D studio for building vehicles of any kind (starships, battleships, airships, walkers, ground vehicles) from beams and plates on a grid, with curved hulls and working joints you can pose and animate. It's for worldbuilding and for recreating real and fictional vehicles: believable form and motion, not engineering accuracy.

The design spec is in [docs/SPEC.md](docs/SPEC.md). The save format is in [docs/FILE_FORMAT.md](docs/FILE_FORMAT.md).

## Running it

```
npm install
npm run dev        # http://localhost:5173
npm test           # model tests (curves, connections, mirroring, joints, hulls, samples)
npm run build      # type-check and build into dist/
```

Open **☰ File → Samples** for a walker with a walk cycle, a battleship whose turrets track one aim control, and a steerable buggy.

## Building

- **Camera:** right-drag orbits, middle-drag (or Shift+right) pans, the wheel zooms toward the cursor. F frames the selection; 1–4 are front, side, top and three-quarter views.
- **The grid:** a major grid and a sub-grid, set per vehicle (Vehicle → Settings has presets from buggy to capital ship). Everything snaps to it. You draw on a working plane: **Q** switches between level, front and side planes, **PgUp/PgDn** move it, and it follows points you pick off other parts. **G** shows the grid everywhere, only on the working plane, or not at all.
- **Beams:** pick a beam and click grid points. *Straight* mode adds one beam per click; *Curved* mode runs one smooth beam through every click (double-click or Enter to finish). Hold **Shift** to lock to X, Y or Z from the last point, which makes uprights easy. Points snap to existing beam ends, grid points along beams, and part corners and faces (Alt ignores them). Square, round, I-section and channel sections can be swapped at any time.
- **Bending:** select a beam and drag the blue diamond on a segment to bend it (the bend between grid points is free), or use the Arc 90°, 45° and S-curve presets. Yellow points move the beam's grid points.
- **Parts:** click a part in the browser, then click to place it. The ghost snaps to the grid, sits flush on whatever surface is under the cursor, and turns red when it would overlap. **R / T / Shift+T** turn it 90°.
- **Moving:** the gizmo moves in grid steps and rotates in 15° steps; arrow keys nudge. Box-select by dragging on empty space.
- **Editing:** change any size in Properties, swap a part's type in place, duplicate, repeat in a pattern, align and distribute, select everything connected or everything past a joint.
- **Frame generators:** box, wedge and cylinder frames from dimensions.

## Hulls

- **Skin between beams:** select 3 or 4 beams that meet end to end and press *Skin between these beams*. The plate follows its beams exactly, even when they're curved, and reshapes when you bend them later.
- **Ribs and stringers:** draw a few ribs (cross-section frames) at key stations, select them and *Lay stringers*. The stringers run smoothly through every rib and follow when a rib is edited. *Skin hull* then plates every cell. The cylinder frame generator makes a ready-to-skin example.
- Hull panels (slices of a cylinder wall), cylinders, cones and wedges cover other one-direction curves. Compound curves such as domes and teardrop cockpits aren't in yet.

## Connections and checks

Parts connect automatically when they touch, or when a snap point of one sits inside another (a beam end on another beam, a plate corner on a frame). There is no welding or bolting step. You can break or force any connection in Properties. Bolt heads are cosmetic only.

The **Checks** tab lists problems as you build; click one to select and zoom to it:

- floating parts (not connected to the main body; scale figures are exempt)
- overlaps (parts passing through each other)
- joints that sweep into something across their range, and parts that collide in the current pose (these light up red while you pose)
- locked joints (both sides joined to the same structure)
- plates whose beams no longer form a loop

After an edit, only the pairs involving changed parts are tested again. Mass and centre of mass are shown in the report as information only.

## Mirroring

**Live mirror** (M) is on by default across X (left/right). Y (top/bottom) and Z (front/back) can be added in any combination; three axes make seven twins. Build one side and the others follow, and edits on either side carry over. Parts on the mirror plane don't get a twin. The mirror planes can be moved to any grid line for off-centre pairs. Reflections are exact: lopsided shapes, curves and plates keep their shape, and a mirrored hinge turns the opposite way, so the same pose value gives a mirror-image movement. *Break symmetry* lets one side differ; *Mirror copy* makes one-off unlinked copies.

## Moving parts

Joints split the vehicle into rigid groups. Everything on the far side of a joint (away from the main body) moves with it, and joints chain, so a gun elevates on a hinge riding on a turret ring.

| Joint | Motion |
|---|---|
| Hinge | turns about its X axis, within limits |
| Turret ring | rotates about Y, optionally all the way round |
| Ball | turns on all three axes within limits |
| Piston / sliding door | slides along its axis |
| Wheel | spins freely and steers within limits |

- **Sliders** for every joint in the Controls tab, clamped to their limits.
- **Pose tool (P):** drag any part past a joint in the viewport.
- **Linked controls:** one dial drives many joints, each with its own ratio and offset. Use a ratio of −1 for a mirrored twin that should turn the same way, as the buggy's steering does.
- **Aim at point:** an aim control turns its turrets and guns toward a clicked target, parents first, within their limits.
- **Poses** save every joint's value under a name and switch back instantly.
- **Timeline:** place poses on it and the studio blends between them, with loop, smooth easing, play and scrub. Space plays and pauses.

## Library, output and views

- **Assemblies:** save a selection (a leg, a turret) and place copies from the Parts panel.
- **Materials:** custom colour, finish (matte, metal, glass, emissive), density and optional texture.
- **Custom parts:** any shape with your own default sizes, material and stats.
- **Custom stats** such as crew, cargo or mana: parts carry them and the vehicle report totals them. Every part and the vehicle can carry lore notes.
- **Layers:** frame, plating, functional and details can each be hidden, locked or isolated.
- **Viewing:** a cross-section clipping slider on X, Y or Z, camera bookmarks, and walk-through mode at figure scale (K; WASD and drag to look).
- **History:** the undo history is a visible list you can roll back to any step. The vehicle autosaves in the browser and is recovered on reload. Named versions can be saved and compared side by side.
- **Output:**
  - JSON save files.
  - glTF export.
  - Screenshots, optionally with a transparent background.
  - One render per pose.
  - A turntable video.
  - A vehicle report: dimensions, counts by type and material, mass, centre of mass, joint list and stat totals.
- **Help:** a guided first build (Vehicle → Settings → Help). Every keyboard shortcut can be rebound (Vehicle → Keys).

## Code layout

```
src/model/      the vehicle document and everything that reads it (no DOM):
                types, catalog, curves, geometry, connections + checks,
                mirror, rig (joints, controls, poses, animation), hull,
                studio (history + edits), report, io, samples
src/render/     three.js: part meshes, the posed vehicle view, the viewport
                and its tools, walk-through mode
src/ui/         panels: part browser, properties, controls, checks,
                history, vehicle, keys, tutorial
test/           vitest suites for the model and the samples
```

The vehicle is one JSON document. Every edit goes through `Studio.commit`, which keeps mirror twins and stringers in line and records a history step. The 3D view, the checks and playback all read from that document.

## Not built yet

These spec items are designed for in the data model but not built:

- compound curves
- wrap plates and edge rounding
- importing glTF/OBJ models
- vehicles inside vehicles
- variants
- decals and livery
- the vehicle sheet and STL exports
- reference images
- inverse kinematics
