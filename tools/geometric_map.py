"""Draw a floor plan as a geometric schematic: building and rooms snapped to a metre grid.

Usage:
    python tools/geometric_map.py INPUT.pdf OUTPUT.svg --floor gf --clip x0,y0,x1,y1 \
        [--exclude ...] [--grid 1.25] [--cache mask.npz]

Every shape is an orthogonal polygon whose edges lie on a regular grid
(--grid points per cell; 1.25 pt = 1 m at this drawing scale):

  * fp-geo-floor  building footprint, drawn with a heavy outline
  * fp-geo-room   rooms; adjacent rooms share edges exactly, so their outlines
                  read as the inner walls. Nearly rectangular rooms become
                  perfect rectangles.

No CAD linework is kept: walls are implied by the edges of the shapes.
"""
import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from extract_walls import parse_rect, wall_mask  # noqa: E402
from stylize_map import layers, square_up, thin, trace  # noqa: E402


def coverage(mask, cell):
    """Fraction of each grid cell covered by a uint8/bool mask."""
    h, w = mask.shape
    gh, gw = int(np.ceil(h / cell)), int(np.ceil(w / cell))
    padded = np.zeros((gh * cell, gw * cell), np.float32)
    padded[:h, :w] = mask > 0
    return padded.reshape(gh, cell, gw, cell).mean(axis=(1, 3))


def outline(cells):
    """Exact boundary loops of a boolean cell grid, as lists of (x, y) grid corners."""
    h, w = cells.shape
    grid = np.pad(cells, 1)
    edges = {}

    def add(a, b):
        edges.setdefault(a, []).append(b)

    ys, xs = np.nonzero(cells)
    for y, x in zip(ys.tolist(), xs.tolist()):
        gy, gx = y + 1, x + 1
        if not grid[gy - 1, gx]:
            add((x, y), (x + 1, y))
        if not grid[gy, gx + 1]:
            add((x + 1, y), (x + 1, y + 1))
        if not grid[gy + 1, gx]:
            add((x + 1, y + 1), (x, y + 1))
        if not grid[gy, gx - 1]:
            add((x, y + 1), (x, y))
    loops = []
    while edges:
        start = next(iter(edges))
        loop = [start]
        current = start
        while True:
            targets = edges.get(current)
            if not targets:
                break
            nxt = targets.pop()
            if not targets:
                del edges[current]
            if nxt == start:
                break
            loop.append(nxt)
            current = nxt
        # Keep only the corners (drop collinear points).
        corners = []
        for i, point in enumerate(loop):
            prev, nxt = loop[i - 1], loop[(i + 1) % len(loop)]
            if (prev[0] == point[0] == nxt[0]) or (prev[1] == point[1] == nxt[1]):
                continue
            corners.append(point)
        if len(corners) >= 4:
            loops.append(corners)
    return loops


def path(loops, unit):
    def fmt(value):
        text = f'{value * unit:.1f}'
        return text[:-2] if text.endswith('.0') else text

    parts = []
    for loop in loops:
        x0, y0 = loop[0]
        segments = [f'M{fmt(x0)} {fmt(y0)}']
        for (ax, ay), (bx, by) in zip(loop, loop[1:] + loop[:1]):
            segments.append(f'H{fmt(bx)}' if ay == by else f'V{fmt(by)}')
        segments[-1] = 'Z'
        parts.append(''.join(segments))
    return ''.join(parts)


def grid_walls(walls, cell, min_cells, gap_cells):
    """Straight wall runs snapped to grid lines and merged: {('h'|'v', line): [(start, end), ...]}."""
    runs = {}
    for trail in trace(thin(walls > 0)):
        if len(trail) < 2:
            continue
        approx = cv2.approxPolyDP(np.array(trail, np.int32).reshape(-1, 1, 2), cell * 0.15, False).reshape(-1, 2).tolist()
        points = square_up(approx, 10)
        for (ax, ay), (bx, by) in zip(points, points[1:]):
            if ay == by and ax != bx:
                key, a, b = ('h', round(ay / cell)), round(min(ax, bx) / cell), round(max(ax, bx) / cell)
            elif ax == bx and ay != by:
                key, a, b = ('v', round(ax / cell)), round(min(ay, by) / cell), round(max(ay, by) / cell)
            else:
                continue  # diagonal: not part of a geometric plan
            if b > a:
                runs.setdefault(key, []).append((a, b))
    merged = {}
    for key, spans in runs.items():
        spans.sort()
        out = [list(spans[0])]
        for a, b in spans[1:]:
            if a <= out[-1][1] + gap_cells:
                out[-1][1] = max(out[-1][1], b)
            else:
                out.append([a, b])
        kept = [(a, b) for a, b in out if b - a >= min_cells]
        if kept:
            merged[key] = kept
    return merged


def wall_path(runs, unit, inside):
    """Path data for wall runs, keeping only the parts that lie inside the building."""
    def fmt(value):
        text = f'{value * unit:.1f}'
        return text[:-2] if text.endswith('.0') else text

    gh, gw = inside.shape
    parts = []
    for (orientation, line), spans in sorted(runs.items()):
        for a, b in spans:
            # A grid line is "inside" where a cell on either side of it is building.
            if orientation == 'h':
                rows = inside[max(line - 1, 0):min(line + 1, gh), a:min(b, gw)]
                covered = rows.any(axis=0) if rows.size else np.zeros(0, bool)
            else:
                cols = inside[a:min(b, gh), max(line - 1, 0):min(line + 1, gw)]
                covered = cols.any(axis=1) if cols.size else np.zeros(0, bool)
            start = None
            for offset, flag in enumerate(list(covered) + [False]):
                if flag and start is None:
                    start = offset
                elif not flag and start is not None:
                    if offset - start >= 2:
                        s0, s1 = a + start, a + offset
                        parts.append(f'M{fmt(s0)} {fmt(line)}H{fmt(s1)}' if orientation == 'h' else f'M{fmt(line)} {fmt(s0)}V{fmt(s1)}')
                    start = None
    return ''.join(parts)


def clean(cells, min_cells):
    cells = cells.astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(cells, 4)
    keep = stats[:, cv2.CC_STAT_AREA] >= min_cells
    keep[0] = False
    return keep[labels]


def fill_holes(cells, max_hole):
    inverse = (~cells).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(inverse, 4)
    h, w = cells.shape
    out = cells.copy()
    for index in range(1, count):
        x, y, cw, ch, area = stats[index]
        touches_edge = x == 0 or y == 0 or x + cw == w or y + ch == h
        if not touches_edge and area <= max_hole:
            out[labels == index] = True
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pdf')
    parser.add_argument('svg')
    parser.add_argument('--floor', required=True)
    parser.add_argument('--label', default='')
    parser.add_argument('--clip', type=parse_rect, required=True)
    parser.add_argument('--exclude', type=parse_rect, action='append', default=[])
    parser.add_argument('--resolution', type=float, default=12)
    parser.add_argument('--scale', type=float, default=10, help='SVG units per PDF point')
    parser.add_argument('--grid', type=float, default=1.25, help='grid cell in points (1.25 pt = 1 m)')
    parser.add_argument('--min-room', type=int, default=4, help='smallest room, in cells')
    parser.add_argument('--rectangular', type=float, default=0.85, help='rooms filling this much of their box become rectangles')
    parser.add_argument('--min-wall', type=float, default=2.0, help='shortest wall run kept, in grid cells')
    parser.add_argument('--cache')
    parser.add_argument('--preview')
    args = parser.parse_args()

    res = args.resolution
    if args.cache and os.path.exists(args.cache):
        mask = np.load(args.cache)['mask']
    else:
        mask, _ = wall_mask(args.pdf, args.clip, args.exclude, res)
        if args.cache:
            np.savez_compressed(args.cache, mask=mask)
    walls, floor, rooms = layers(mask, res)

    cell = max(2, int(round(args.grid * res)))
    unit = cell / res * args.scale  # SVG units per grid cell

    # Footprint on the grid, smoothed by one cell so single-cell notches disappear.
    building = coverage(floor, cell) >= 0.5
    kernel = np.ones((3, 3), np.uint8)
    building = cv2.morphologyEx(building.astype(np.uint8), cv2.MORPH_CLOSE, kernel).astype(bool)
    building = cv2.morphologyEx(building.astype(np.uint8), cv2.MORPH_OPEN, kernel).astype(bool)
    building = clean(building, 30)
    building = fill_holes(building, 12)

    # Rooms: each detected room claims the cells it covers best.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(rooms, 4)
    gh, gw = building.shape
    owner = np.zeros((gh, gw), np.int32)
    best = np.zeros((gh, gw), np.float32)
    for index in range(1, count):
        x, y, w, h, _ = stats[index]
        x0, y0 = x // cell, y // cell
        x1, y1 = (x + w + cell - 1) // cell, (y + h + cell - 1) // cell
        crop = labels[y0 * cell:y1 * cell, x0 * cell:x1 * cell] == index
        cov = coverage(crop, cell)[: y1 - y0, : x1 - x0]
        region = (slice(y0, y0 + cov.shape[0]), slice(x0, x0 + cov.shape[1]))
        better = (cov >= 0.5) & (cov > best[region])
        owner[region][better] = index
        best[region][better] = cov[better]

    room_loops = []
    room_cells = np.zeros_like(building)
    for index in np.unique(owner):
        if index == 0:
            continue
        cells = (owner == index) & building
        if cells.sum() < args.min_room:
            continue
        ys, xs = np.nonzero(cells)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        if min(y1 - y0, x1 - x0) < 2:
            continue  # thinner than 2 m: a corridor sliver, not a room
        box = np.zeros_like(cells)
        box[y0:y1, x0:x1] = True
        free_box = box & building & ~(room_cells & ~cells)
        if cells.sum() >= free_box.sum() * args.rectangular:
            cells = free_box  # nearly rectangular: square it off
        cells = fill_holes(cells, 6)
        room_cells |= cells
        room_loops.extend(outline(cells))

    width = round(args.clip.width * args.scale)
    height = round(args.clip.height * args.scale)
    label = args.label or f'Denah {args.floor}'
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" data-floor="{args.floor}" data-style="geometric" role="img" aria-label="{label}">',
        f'<path class="fp-geo-floor" fill="#eef2f4" stroke="#37474f" stroke-width="6" stroke-linejoin="miter" fill-rule="evenodd" d="{path(outline(building), unit)}"/>',
        f'<path class="fp-geo-wall" fill="none" stroke="#37474f" stroke-width="3" stroke-linecap="square" d="{wall_path(grid_walls(walls, cell, args.min_wall, 1), unit, building)}"/>',
        f'<path class="fp-geo-room" fill="#ffffff" stroke="#37474f" stroke-width="3" stroke-linejoin="miter" d="{path(room_loops, unit)}"/>',
        '</svg>',
    ]
    with open(args.svg, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(svg))
    print(f'{args.svg}: {width}x{height}, grid {args.grid} pt, {len(room_loops)} room outlines, '
          f'{sum(len(p) for p in svg) // 1024} KB', file=sys.stderr)

    if args.preview:
        image = np.full((gh, gw, 3), 245, np.uint8)
        image[building] = (225, 230, 232)
        image[room_cells] = (255, 255, 255)
        cv2.imwrite(args.preview, cv2.resize(image, (gw * 4, gh * 4), interpolation=cv2.INTER_NEAREST))


if __name__ == '__main__':
    main()
