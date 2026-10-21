# Vehicle file format

A saved vehicle (`*.vehicle.json`) is the studio's document as JSON. Units are metres and degrees. Axes: +X starboard (right), +Y up, +Z forward (bow).

```jsonc
{
  "format": "vehicle-studio",      // always this
  "version": 1,
  "id": "v…", "name": "Walker AT-6", "notes": "…",
  "grid": { "major": 1, "minor": 0.25 },
  "mirror": { "x": true, "y": false, "z": false, "origin": [0, 0, 0] },
  "parts": [ Part, … ],
  "connections": [ { "a": "partId", "b": "partId", "mode": "forced" | "broken" } ],
  "jointValues": { "jointPartId": [degreesOrMetres, …] },
  "controls": [ Control, … ],
  "poses": [ { "id", "name", "values": { "jointPartId": [ … ] } } ],
  "animations": [ { "id", "name", "duration", "loop", "smooth", "keys": [ { "time", "pose" } ] } ],
  "assemblies": [ { "id", "name", "parts": [ Part, … ] } ],
  "materials": [ { "id", "name", "color": "#rrggbb", "finish": "matte|metal|glass|emissive", "density", "texture?" } ],
  "partDefs": [ PartDef, … ],       // custom catalog entries
  "statDefs": [ { "key", "label", "unit?" } ],
  "stats": { "key": number },       // vehicle-level additions to the totals
  "baseVehicle": "…",               // reserved: variants
  "meta": { "created", "modified", "app" }
}
```

## Part

```jsonc
{
  "id": "p…",
  "def": "beam.square",             // catalog id (see src/model/catalog.ts) or a custom partDef id
  "name": "Front hip",              // optional
  "params": { "w": 0.2, "h": 0.2 }, // size parameters of the def
  "position": [x, y, z],            // centre (shapes); beams keep their first point here
  "rotation": [rx, ry, rz],         // Euler XYZ, degrees
  "flip": [1, 1, -1],               // optional local axis flips; mirrored twins carry their reflection here
  "material": "steel",
  "layer": "frame|plating|functional|details",
  "path": {                         // beams only
    "points": [[x, y, z], …],       // grid points
    "handles": [[[x,y,z],[x,y,z]] | null, …], // optional Bézier handles per segment
    "smooth": true, "closed": false
  },
  "section": "square|round|ibeam|channel",
  "surface": {                      // skin plates only
    "edges": [ { "part": "beamId", "t0": 0, "t1": 1, "frac": false } ], // 3 or 4, in loop order
    "thickness": 0.04, "side": 1
  },
  "derived": { "kind": "stringer", "ribs": ["ribId", …], "s": 0.25 }, // stringers: path is recomputed from the ribs
  "mirror": { "source": "partId", "axes": "x" }, // live twins only
  "joint": { "type": "hinge|turret|ball|piston|wheel", "min", "max", "rest", "continuous?" },
  "notes": "…", "stats": { "crew": 1 },
  "livery": { "layers": [] }, "vehicleRef": "…", "assembly": "…"  // reserved / bookkeeping
}
```

### Beam paths

A beam has one segment between each pair of consecutive points (plus one back to the start if `closed`). Each segment is a cubic Bézier:

- with `handles[i]`, the control points are `points[i], handles[i][0], handles[i][1], points[i+1]`;
- otherwise, if `smooth`, it uses Catmull-Rom tangents through the neighbouring points;
- otherwise it is straight.

Edge parameters (`t0`, `t1`) count segments: 0 is the first point, `n` the n-th. With `frac: true` they are fractions of the beam's length instead.

### Joints

A joint part's +Y half is its *head*. The half that moves is the one on the far side from the main body. Values are degrees, or metres for pistons:

| Joint | Values |
|---|---|
| hinge | `[angle about local X]` |
| turret | `[angle about local Y]` |
| ball | `[x, y, z]` |
| piston | `[extension along local Y]` (sliding doors: local X) |
| wheel | `[spin, steer]` |

A part whose `flip` has an odd number of −1s turns the opposite way. That is how mirrored joints move as mirror images.

## Control

```jsonc
{ "id", "name", "value", "min", "max", "aim": false,
  "links": [ { "joint": "partId", "dof": 0, "ratio": 1, "offset": 0 } ] }
```

Each linked joint is set to `offset + ratio × value`, then clamped to its limits. An aim control instead turns its linked turret rings and hinges toward a target point.
