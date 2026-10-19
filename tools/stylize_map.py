"""Redraw a CAD floor plan as a clean indoor map: building silhouette, rooms, and walls.

Usage:
    python tools/stylize_map.py INPUT.pdf OUTPUT.svg --floor gf --clip x0,y0,x1,y1 [--exclude ...] \
        [--preview preview.png] [--cache mask.npz]

Nothing from the CAD drawing is copied as-is. The wall mask from extract_walls.py is
turned into new geometry:

  * fp-floor  the building silhouette (walls grown, holes filled, shrunk back)
  * fp-room   enclosed rooms (door gaps bridged so a room is a closed tile)
  * fp-line   wall centre-lines: thinned, traced, simplified and squared to
              horizontal/vertical, so every wall gets one uniform stroke

Columns, glass hairlines, hatches, furniture and text are left out on purpose.
"""
import argparse
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from extract_walls import parse_rect, wall_mask  # noqa: E402

NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def rect(width_px, height_px=None):
    width = max(1, int(round(width_px)))
    height = max(1, int(round(height_px if height_px is not None else width_px)))
    return cv2.getStructuringElement(cv2.MORPH_RECT, (width, height))


def disk(radius_px):
    size = max(1, int(round(radius_px)) * 2 + 1)
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def thin(mask):
    """Zhang-Suen thinning, vectorised with numpy. Input/output: bool arrays."""
    img = np.pad(mask.astype(np.uint8), 1)
    while True:
        changed = False
        for step in (0, 1):
            p = img
            p2, p3, p4 = p[:-2, 1:-1], p[:-2, 2:], p[1:-1, 2:]
            p5, p6, p7 = p[2:, 2:], p[2:, 1:-1], p[2:, :-2]
            p8, p9 = p[1:-1, :-2], p[:-2, :-2]
            neighbours = [p2, p3, p4, p5, p6, p7, p8, p9]
            count = sum(n.astype(np.int16) for n in neighbours)
            ring = neighbours + [p2]
            transitions = sum(((ring[i] == 0) & (ring[i + 1] == 1)).astype(np.int16) for i in range(8))
            if step == 0:
                cond = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                cond = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            remove = (p[1:-1, 1:-1] == 1) & (count >= 2) & (count <= 6) & (transitions == 1) & cond
            if remove.any():
                img[1:-1, 1:-1][remove] = 0
                changed = True
        if not changed:
            return img[1:-1, 1:-1].astype(bool)


def trace(skeleton):
    """Trace a one-pixel skeleton into polylines (lists of (x, y))."""
    ys, xs = np.nonzero(skeleton)
    pixels = set(zip(ys.tolist(), xs.tolist()))

    def neighbours(pixel):
        y, x = pixel
        return [(y + dy, x + dx) for dy, dx in NEIGHBOURS if (y + dy, x + dx) in pixels]

    degree = {pixel: len(neighbours(pixel)) for pixel in pixels}
    visited_edges = set()
    paths = []

    def walk(start, nxt):
        path = [start, nxt]
        visited_edges.add((start, nxt))
        visited_edges.add((nxt, start))
        previous, current = start, nxt
        while degree[current] == 2:
            options = [n for n in neighbours(current) if n != previous and (current, n) not in visited_edges]
            if not options:
                break
            previous, current = current, options[0]
            visited_edges.add((previous, current))
            visited_edges.add((current, previous))
            path.append(current)
        return path

    for pixel in pixels:
        if degree[pixel] != 2:
            for n in neighbours(pixel):
                if (pixel, n) not in visited_edges:
                    paths.append(walk(pixel, n))
    # Closed loops have no endpoints or junctions.
    for pixel in pixels:
        for n in neighbours(pixel):
            if (pixel, n) not in visited_edges:
                paths.append(walk(pixel, n))
    return [[(x, y) for y, x in path] for path in paths]


def square_up(points, tolerance_deg):
    """Snap nearly horizontal/vertical segments to exact axes, keeping the chain connected."""
    out = [list(points[0])]
    for x, y in points[1:]:
        px, py = out[-1]
        angle = abs(math.degrees(math.atan2(y - py, x - px))) % 180
        if angle < tolerance_deg or angle > 180 - tolerance_deg:
            y = py
        elif abs(angle - 90) < tolerance_deg:
            x = px
        out.append([x, y])
    return out


def path_data(points, factor, closed=False):
    coords = [(round(x * factor), round(y * factor)) for x, y in points]
    cleaned = [coords[0]]
    for point in coords[1:]:
        if point != cleaned[-1]:
            cleaned.append(point)
    if len(cleaned) < 2:
        return ''
    x0, y0 = cleaned[0]
    parts = [f'M{x0} {y0}']
    for (ax, ay), (bx, by) in zip(cleaned, cleaned[1:]):
        dx, dy = bx - ax, by - ay
        parts.append(f'h{dx}' if dy == 0 else f'v{dy}' if dx == 0 else f'l{dx} {dy}')
    if closed:
        parts.append('z')
    return ''.join(parts).replace(' -', '-')


def polygons(mask, epsilon_px, factor, min_area_px):
    contours, _ = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for contour in contours:
        if abs(cv2.contourArea(contour)) < min_area_px:
            continue
        approx = cv2.approxPolyDP(contour, epsilon_px, True).reshape(-1, 2)
        if len(approx) >= 3:
            out.append(path_data(square_up(approx.tolist() + [approx[0].tolist()], 8)[:-1], factor, closed=True))
    return ''.join(out)


def layers(mask, res, bridge=1.0, column=1.4, bay=9.4, door=0.8):
    """Return (walls, floor, rooms) uint8 masks from a raw wall mask at `res` px per point."""
    px = lambda points: points * res  # noqa: E731
    # 0. Join walls that CAD interrupts at every column. Each direction only closes its
    #    own runs (horizontal runs along rows, vertical runs along columns), so collinear
    #    pieces meet while parallel walls a few decimetres apart stay separate.
    horizontal = cv2.morphologyEx(mask, cv2.MORPH_OPEN, rect(px(0.8), 1))
    vertical = cv2.morphologyEx(mask, cv2.MORPH_OPEN, rect(1, px(0.8)))
    mask = mask | cv2.morphologyEx(horizontal, cv2.MORPH_CLOSE, rect(px(bridge), 1))
    mask = mask | cv2.morphologyEx(vertical, cv2.MORPH_CLOSE, rect(1, px(bridge)))
    walls = mask > 0

    with_columns = walls.astype(np.uint8) * 255  # the column grid outlines the building
    # 1. Drop isolated columns and specks: small compact components.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(walls.astype(np.uint8), 8)
    small = (np.maximum(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT]) < px(column))
    small[0] = False
    walls &= ~small[labels]
    walls_u8 = walls.astype(np.uint8) * 255
    # Fill tiny holes inside walls (columns fused into a wall line) so the
    # centre-line does not loop around them.
    holes, hierarchy = cv2.findContours(walls_u8, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is not None:
        def narrow(contour):
            # Largest inscribed circle: rooms are at least ~1 m (1.2 pt) wide.
            x, y, cw, ch = cv2.boundingRect(contour)
            roi = np.zeros((ch + 2, cw + 2), np.uint8)
            cv2.drawContours(roi, [contour - [x - 1, y - 1]], -1, 255, cv2.FILLED)
            return cv2.distanceTransform(roi, cv2.DIST_L2, 3).max() * 2 < px(1.2)
        tiny = [c for c, info in zip(holes, hierarchy[0]) if info[3] >= 0 and narrow(c)]
        cv2.drawContours(walls_u8, tiny, -1, 255, cv2.FILLED)
    walls = walls_u8 > 0

    # 2. Building silhouette: grow walls, close courtyards, fill holes, shrink back.
    #    Square kernels keep the outline orthogonal instead of blobby.
    #    The canvas is padded first so the outside stays connected around walls
    #    (e.g. boarding bridges) that touch the clip edge.
    #    Columns stay in for this step: on glazed façades the column grid is the
    #    only thing that says "inside", and growing it by half a bay joins it up.
    pad = int(px(bay))
    grow = cv2.copyMakeBorder(with_columns | walls_u8, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    grow = cv2.dilate(grow, rect(px(bay * 0.55)))
    grow = cv2.morphologyEx(grow, cv2.MORPH_CLOSE, rect(px(6.0)))
    flood = grow.copy()
    cv2.floodFill(flood, np.zeros((flood.shape[0] + 2, flood.shape[1] + 2), np.uint8), (0, 0), 255)
    floor = grow | cv2.bitwise_not(flood)
    floor = cv2.erode(floor, rect(px(bay * 0.55 - 0.3)))
    floor = cv2.morphologyEx(floor, cv2.MORPH_OPEN, rect(px(2.0)))
    floor = np.ascontiguousarray(floor[pad:-pad, pad:-pad])
    h, w = floor.shape

    # 3. Rooms: free space inside the silhouette once door gaps are bridged.
    barrier = cv2.dilate(walls_u8, disk(px(door)))
    free = cv2.bitwise_and(floor, cv2.bitwise_not(barrier))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(free, 4)
    floor_area = max(1, int(np.count_nonzero(floor)))
    areas = stats[:, cv2.CC_STAT_AREA]
    is_room = (areas >= px(1.5) ** 2) & (areas <= floor_area * 0.08)
    is_room[0] = False
    # A real room is bounded by walls. Tiles whose edge mostly touches the outside
    # of the building are leftovers of removed fixtures, not rooms.
    border = (cv2.dilate(free, rect(3)) > 0) & (free == 0)
    near_label = cv2.dilate(labels.astype(np.float32), rect(3)).astype(np.int64)  # float32 is exact for label ids
    total_edge = np.bincount(near_label[border], minlength=count)
    wall_edge = np.bincount(near_label[border & (barrier > 0)], minlength=count)
    is_room &= wall_edge >= total_edge * 0.7
    rooms = is_room[labels].astype(np.uint8) * 255
    rooms = cv2.dilate(rooms, disk(px(door) * 0.9))
    rooms = cv2.bitwise_and(rooms, cv2.bitwise_not(walls_u8))
    rooms = cv2.morphologyEx(rooms, cv2.MORPH_OPEN, disk(px(0.3)))
    return walls_u8, floor, rooms


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pdf')
    parser.add_argument('svg')
    parser.add_argument('--floor', required=True)
    parser.add_argument('--label', default='')
    parser.add_argument('--clip', type=parse_rect, required=True)
    parser.add_argument('--exclude', type=parse_rect, action='append', default=[])
    parser.add_argument('--resolution', type=float, default=12, help='working pixels per PDF point')
    parser.add_argument('--scale', type=float, default=10, help='SVG units per PDF point')
    parser.add_argument('--door', type=float, default=0.8, help='door gaps up to twice this (points) are closed when finding rooms')
    parser.add_argument('--min-wall', type=float, default=1.5, help='shortest wall piece kept, in points')
    parser.add_argument('--min-group', type=float, default=6.0, help='isolated wall groups shorter than this (points) are dropped')
    parser.add_argument('--bay', type=float, default=9.4, help='column spacing in points (7.5 m axis grid)')
    parser.add_argument('--spur', type=float, default=0.9, help='dead-end stubs shorter than this (points) are removed')
    parser.add_argument('--bridge', type=float, default=1.0, help='collinear gaps up to this (points) are joined, e.g. at columns')
    parser.add_argument('--column', type=float, default=1.4, help='isolated blobs smaller than this (points) are columns and dropped')
    parser.add_argument('--cache', help='npz file to reuse the wall mask between runs')
    parser.add_argument('--preview', help='optional PNG preview')
    args = parser.parse_args()

    res = args.resolution
    if args.cache and os.path.exists(args.cache):
        mask = np.load(args.cache)['mask']
    else:
        mask, _ = wall_mask(args.pdf, args.clip, args.exclude, res)
        if args.cache:
            np.savez_compressed(args.cache, mask=mask)
    px = lambda points: points * res  # noqa: E731
    walls_u8, floor, rooms = layers(mask, res, args.bridge, args.column, args.bay, args.door)
    h, w = floor.shape

    # 4. Wall centre-lines.
    skeleton = thin(cv2.morphologyEx(walls_u8, cv2.MORPH_CLOSE, disk(px(0.25))) > 0)
    # Drop small isolated wall groups (leftover fixtures, planters, door details).
    count, labels, stats, _ = cv2.connectedComponentsWithStats(skeleton.astype(np.uint8), 8)
    group_length = np.bincount(labels.ravel(), minlength=count).astype(float)
    group_size = np.maximum(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT])
    keep_group = (group_length >= px(args.min_group)) & (group_size >= px(args.min_group) * 0.75)
    # Lines mostly outside the building (kerbs, road markings) are not walls.
    inside = np.bincount(labels.ravel(), weights=(floor > 0).ravel(), minlength=count)
    keep_group &= inside >= group_length * 0.5
    keep_group[0] = False
    skeleton &= keep_group[labels]
    factor = args.scale / res
    lines = []
    for path in trace(skeleton):
        if len(path) < 2:
            continue
        length = sum(math.dist(a, b) for a, b in zip(path, path[1:]))
        def degree(point):
            x, y = point
            return sum(1 for dy, dx in NEIGHBOURS if 0 <= y + dy < skeleton.shape[0] and 0 <= x + dx < skeleton.shape[1] and skeleton[y + dy, x + dx])
        free_ends = sum(1 for end in (path[0], path[-1]) if degree(end) <= 1)
        if free_ends and length < px(args.spur):
            continue  # spur: a stub left by a column or door jamb
        if free_ends == 2 and length < px(args.min_wall):
            continue  # short isolated piece
        approx = cv2.approxPolyDP(np.array(path, np.int32).reshape(-1, 1, 2), px(0.12), False).reshape(-1, 2).tolist()
        data = path_data(square_up(approx, 7), factor)
        if data:
            lines.append(data)

    width = round(args.clip.width * args.scale)
    height = round(args.clip.height * args.scale)
    label = args.label or f'Denah {args.floor}'
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" data-floor="{args.floor}" data-style="indoor" role="img" aria-label="{label}">',
        f'<path class="fp-floor" fill="#e9eef0" fill-rule="evenodd" d="{polygons(floor, px(0.5), factor, px(6) ** 2)}"/>',
        f'<path class="fp-room" fill="#f7f9fa" fill-rule="evenodd" d="{polygons(rooms, px(0.25), factor, px(1.2) ** 2)}"/>',
        f'<path class="fp-line" fill="none" stroke="#37474f" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="{"".join(lines)}"/>',
        '</svg>',
    ]
    with open(args.svg, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(svg))
    print(f'{args.svg}: {width}x{height}, {len(lines)} walls, {sum(len(p) for p in svg) // 1024} KB', file=sys.stderr)

    if args.preview:
        preview = np.full((h, w, 3), 255, np.uint8)
        preview[floor > 0] = (240, 238, 233)
        preview[rooms > 0] = (250, 249, 247)
        preview[skeleton] = (79, 71, 55)
        cv2.imwrite(args.preview, preview)


if __name__ == '__main__':
    main()
