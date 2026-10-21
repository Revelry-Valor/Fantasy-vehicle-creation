# Vehicle Construction Studio — Design Spec

Oct 20, 2026 · @Revelry

## Overview

A browser-based 3D studio for building vehicles of any kind — starships, battleships, airships, walkers, ground vehicles — from beams and plates on a grid, with curved hulls and working joints you can pose and animate. It is for worldbuilding and for recreating real and fictional vehicles, so the aim is crafts that look and move believably, not engineering accuracy.

It borrows Starbase's way of building (a beam frame, plates over it, functional parts on top) and drops its engineering layer: no bolts holding things together, no load or stress math. The Starbase research lives in a separate background doc.

## Principles

- **Looks and moves right.** Realism means believable form and working moving parts, not physics accuracy.
- **Grid-locked, but not boxy.** Everything snaps to the grid; beams can still bend and plates follow curves between grid points.
- **Build once, mirror the rest.** Symmetry is a mode, not an afterthought.
- **No code required.** Moving parts are driven by sliders, linked controls and saved poses.
- **Friendly by default.** Live feedback, clickable warnings, undo for everything.
- **Yours to extend.** A part and material editor so the catalog grows with your settings.

The full numbered requirements, each with a done-when test and a priority, are in Requirements.

## Decisions so far

| Topic | Decision | Why |
|---|---|---|
| Tech stack | Web app: Three.js + TypeScript, built with Vite | Claude can write, run and screenshot-test it directly; runs in any browser; can be wrapped as a desktop app later |
| Purpose | Worldbuilding, plus recreating real and fictional vehicles | Drives the emphasis on looks, joints and a custom part catalog |
| Realism | Visual and mechanical believability only | No load, stress or durability math |
| Grid | Locked to the grid | Clean alignment; curves happen between grid points |
| Connections | Automatic when parts touch at snap points | Replaces Starbase's welds and bolts |
| Bolts | Optional cosmetic detail only | Look good, carry no meaning |
| Scripting | None; joints driven by sliders, linked controls and poses | Covers posing and moving parts without code |
| Curves | Bendable beams and conforming plates; one-direction curves first | Covers ship hulls; compound curves later |
| Mirroring | Live mirror on any combination of three axes | Build one side only |
| Moving parts | Core feature: joints, poses, animation between poses | AT-AT legs, rotating turrets, landing gear |
| MVP | Build, connect, curve, mirror, articulate; no damage or flight | Smallest version that makes complete, posable vehicles |

## Building

Vehicles are built from three kinds of parts on a locked grid; parts connect automatically when they touch, and the connection graph is what tells the studio what is attached and what moves together.

### The grid

- A major grid with a finer sub-grid; every part's position and endpoints snap to it.
- Rotation snaps to 15° steps, with one-key 90° turns.
- The grid can be shown, hidden, or shown only on the plane you're working on.

### Part types

| Type | Examples | How it's made |
|---|---|---|
| Structural shapes | Beams (square, round, I-section), plates, wedges, cylinders, cones, hull panels | Generated in code from parameters (length, width, thickness, radius), so any size on the grid is possible without 3D modeling |
| Functional parts | Joints, turret rings, pistons, sliders, wheels, thrusters, lights, doors | Shapes plus behavior: a joint moves, a light glows, a thruster shows exhaust |
| Assemblies | A leg, a gun turret, a cockpit, an engine pod | Any selection saved as a reusable group, nestable, including its joints |
| Imported models | Detail pieces, greebles, figure-scale props | glTF or OBJ files, placed and snapped like any part |

Every part has a material: color, finish (matte, metal, glass, emissive) and optional texture. The part and material editor lets you add your own shapes, materials and stats.

### Connections

- When two parts touch at snap points or share a face, they are connected. No welding or bolting step.
- Connections can be broken or forced by hand when the automatic guess is wrong.
- Bolts, rivets and panel lines are a cosmetic stamp tool only.

### Checks

The studio runs three checks continuously and lists any problems in a warnings panel; clicking one zooms to the part.

1. Floating parts: anything not connected to the main body.
2. Overlaps: parts passing through each other.
3. Motion collisions: parts that hit something when a joint moves through its range.

Mass and center of mass are shown as information only, never as a pass/fail rule.

## Curved hulls

Hulls are built the way real ships are: ribs across the hull, stringers curving down its length, and plates filling the cells between them, each plate following the curve of its edges. Beam ends snap to the grid; the bend between them is free.

### Bendable beams

- A beam is a path with a cross-section swept along it.
- Bend tool: drag a beam's middle to curve it, or pick a preset (90° arc of a given radius, S-curve).
- Multi-point beams: click several grid points and the beam flows smoothly through all of them.
- Cross-sections are swappable: square, round, I-section, or custom.

### Ribs and stringers

1. Draw a few ribs (cross-section frames) at key stations: bow, midship, stern.
2. Choose how many stringers to run lengthwise; the studio lays each one smoothly through every rib.
3. Edit any rib and the stringers reshape to follow.

Hand-placed beams can still go anywhere for decks, bulkheads and details.

### Conforming plates

- Skin between beams: select 3 or 4 beams forming a loop, curved or straight, and a plate is generated whose edges follow them exactly, with thickness added.
- Skin hull: plate every cell of a rib-and-stringer frame in one click.
- Wrap plates: around a curved beam or cylinder, for tubes, nacelles and rounded corners.
- Edge rounding: fillet the joint between two plates so the hull reads as one smooth shape.
- Plates stay linked to their beams: bend a beam later and its plates reshape.

### Staging

One-direction curves come first: cylinders, cones, and hull sides curving along the length. Compound curves (domes, teardrop cockpits, the very tip of a bow) come later; until then those areas render slightly faceted.

## Mirroring

Mirror works across left/right, top/bottom and front/back, in any combination, so most vehicles are built one side at a time.

- Live mirror mode: build on one side and the mirrored side updates as you go. Edits made on either side carry over.
- Mirror selection: a one-time copy of finished pieces across a chosen axis.
- Mirror plane defaults to the vehicle's center but can be moved to any grid line, for paired pods or wings off-center.
- Joints mirror correctly: a mirrored hinge turns the opposite way, so a pose on the left leg comes out right on the right leg.
- Curves and plates mirror with their shape intact, keeping rounded hulls symmetrical.
- Break symmetry on any part when one side needs to differ, such as a hatch on one side only.

## Moving parts

Joints split a vehicle into rigid groups that move as units: everything on the far side of a joint moves with it, the way a lower leg follows the knee. Joints chain, so a turret can rotate while the gun on it elevates.

### Joint types

| Joint | Motion | Typical use |
|---|---|---|
| Hinge | Rotates on one axis, within limits | Knees, hatches, landing gear, gun elevation |
| Turret ring | Rotates on one axis, optionally all the way round | Turrets, radar dishes, rotors |
| Ball | Rotates on all axes, within a cone | Hips, shoulders, sensor heads |
| Piston / slider | Moves in a straight line, within limits | Hydraulic rams, landing struts, sliding doors |
| Wheel | Spins freely; can steer | Ground vehicles |

Each joint has a pivot point snapped to the grid, an axis, limits, and a rest position.

### Driving joints

- Sliders: every joint gets a slider in the controls panel, clamped to its limits.
- Drag in the viewport: grab a part past a joint and drag; the joint turns within its limits.
- Linked controls: tie several joints to one control, each with its own ratio or direction. One dial turns all six turrets.
- Aim at point: click a target and every linked turret and gun turns to face it within its limits.

### Poses and animation

- Poses: save the current joint positions under a name (rest, kneeling, mid-stride, guns deployed) and switch between them instantly.
- Timeline: place poses on a timeline; the studio blends between them, so an AT-AT can step through a walk cycle without actually walking.
- Loop and preview: play, loop and scrub animations in the viewport.
- Collision while posing: parts that would hit each other are highlighted as you move a joint.

### Examples

- Walker (AT-AT): each leg is a chain of hip, knee and ankle hinges; poses for standing, mid-stride and kneeling; a timeline cycles the stride.
- Battleship: each turret is a turret ring carrying a gun hinge; all turrets link to one aim control that tracks a clicked target.

Turning the ring swings the turret and guns together; the hinge tilts only the guns. Six turrets linked to the same aim control all track one target.

## Editor and usability

The editor is a 3D viewport with a part browser, a properties panel, a controls panel for joints, and a warnings panel; everything is undoable and every problem is clickable.

### Placing and editing

- Part browser with categories, search, favorites, thumbnails and a "fits here" filter for the selected spot.
- Ghost preview while dragging: parts snap automatically, and the ghost turns red on overlap.
- Move and rotate gizmos, 15° steps, one-key 90° turns.
- Pattern / array tool: repeat a part or assembly every N grid cells; align and distribute a selection.
- Frame generators: box, wedge or cylinder frames from dimensions, then edited by hand.
- Swap part: change a beam's size or a plate's type in place, keeping connections.
- Select by connection: everything attached to a part, or everything past a joint.
- Bulk select by category: all plates, all beams, all joints.

### Seeing the work

- Layers: frame, plating, functional parts, details — hide, isolate or lock each.
- Clipping plane / cross-section slider to cut the hull open and work inside.
- Ruler and clearance readouts between any two parts.
- Walk-through mode at figure scale to judge interiors, doors and cockpits.
- Camera bookmarks and quick views (front, side, top, three-quarter).

### Safety nets

- Undo history as a visible list you can roll back to any step.
- Autosave and crash recovery.
- Versioned saves with side-by-side compare.

### Learning curve

- Guided first build: a short tutorial that walks through a frame, plating, mirroring and one joint.
- Hover tooltips on every tool, part and stat.
- Rebindable keys.

### Output

- Vehicle report: dimensions, part counts by type and material, mass and center of mass, joint list.
- Screenshots and thumbnails, with a transparent-background option for worldbuilding notes.
- Turntable and pose renders for sharing.
- Save files as documented JSON so other tools can read the vehicles.

## Worldbuilding and tabletop features

These connect the studio to your settings and campaigns. Custom stats, vehicle sheet export and variants are the priorities: build them right after the MVP, and design the data model for them from day one.

### Worldbuilding

- Scale figures and line-ups: drop in a human silhouette, or place several vehicles side by side to compare a fighter with its carrier.
- Paint, decals and livery: faction insignia, hull numbers, camouflage, weathering and wear.
- Faction livery presets: save a paint scheme and apply it to any vehicle or a whole fleet in one click.
- Lore notes: attach text to any part, assembly or vehicle so it carries its own documentation.
- Custom stats: catalog parts carry user-defined numbers (crew, cargo, weapon slots, mana capacity, anything your setting needs) that total up for the vehicle. Bookkeeping you define, not physics.

### Tabletop

- Vehicle sheet export: a one-page card with renders from several angles, dimensions, crew, armament list and custom stats.
- STL export for 3D printing, with a check for walls too thin to print, so vehicles can become miniatures.

### Building variety

- Variants and loadouts: one base hull with linked versions (cargo, gunship, command); a fix to the base carries to every variant.
- Module mounts: designated sockets where weapon or equipment modules plug in and swap out.
- Vehicles inside vehicles: place a saved vehicle inside another as a live reference — fighters in a hangar bay, a tank in a dropship — without duplicating its parts.
- Detail generator: fill a selected surface with randomized pipes, panels and vents.

### Presentation

- Scene staging: backdrops (open water with a waterline, sky, space, ground) and adjustable lighting.
- glTF export to take vehicles into Blender or a game engine.

## Architecture and build order

The vehicle is one data document — parts, connections, joints, poses — and everything else (the 3D view, checks, mirroring, animation) reads from or edits that document. This keeps saving, undo and mirroring simple.

### Data model

| Object | Holds |
|---|---|
| PartDef (catalog entry) | Category, parameters and their ranges, snap points, default material, behavior type (none, joint, wheel, light, thruster) |
| Part | Catalog id, parameter values, position (grid), rotation, material, layer, mirror link |
| CurvePath | Ordered grid points and bend handles for a curved beam; cross-section id |
| Surface | The 3–4 boundary beams a plate follows, thickness, material |
| Connection | Two part ids; automatic or forced |
| Joint | Type, pivot, axis, limits, rest value, the two rigid groups it splits |
| Control | Name, the joints it drives, ratio and direction per joint |
| Pose | Name, value per joint |
| Animation | Poses placed on a timeline, with blend timing and loop setting |
| Assembly | A saved group of all the above, reusable and nestable |
| Vehicle | Everything above, plus mirror settings and metadata |

Reserved from day one for the worldbuilding features: custom stat fields on PartDef and Vehicle, livery and decal layers on Part, notes on any object, a base vehicle link for variants, and a vehicle reference part type for vehicles placed inside vehicles.

### Build order

1. Viewport and grid: 3D view, camera, grid, selection, move and rotate gizmos.
2. Straight parts: parametric beams and plates, ghost preview, snapping, overlap detection.
3. Connections and checks: automatic connections, floating-part and overlap warnings.
4. Mirroring: live mirror mode and mirror selection.
5. Save, load and undo: JSON files, undo history, autosave.
6. Curved beams: bend tool, multi-point beams, ribs and stringers.
7. Conforming plates: skin between beams, skin hull, wrap plates.
8. Joints: rigid-group splitting, joint types, sliders, viewport dragging.
9. Poses, controls and animation: saved poses, linked controls, aim at point, timeline.
10. Assemblies, materials and the part editor.
11. Polish: layers, clipping plane, report, renders, tutorial.

After step 5 you can build and save complete boxy vehicles; after step 7, hulls; after step 9, everything in the MVP.

### Technical notes

- Three.js for rendering, with instanced drawing so thousands of repeated parts stay fast.
- Curves as Catmull-Rom or Bézier splines through grid points; plates as surface patches built from their boundary curves.
- Joints as a hierarchy: each rigid group is a child of its joint, so moving a joint moves everything past it.
- Checks recompute only what an edit touched.

## Open questions

- [ ] Scale and grid size: one fixed grid in real units, or a grid size set per vehicle? A 270 m battleship and a 3 m buggy need very different steps.
- [ ] Reference images: load blueprints or photos as backdrops on the front, side and top planes for tracing real and fictional vehicles?
- [ ] Leg posing: is joint-by-joint posing enough, or should dragging a foot move the whole leg (inverse kinematics)?
- [ ] Effects: should wheels and rotors spin, and thrusters, lights and screens glow or animate during playback?
- [ ] Interiors: how detailed? Rooms and decks, or exterior only at first?
- [ ] Starter part set: which 15–20 parts come first?
- [ ] Where files live: browser storage, local files, or a desktop wrapper?
- [ ] Name for the studio.
