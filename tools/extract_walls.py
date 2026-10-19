"""Extract only the walls (plus columns and glass lines) from a CAD floor-plan PDF.

Usage:
    python tools/extract_walls.py INPUT.pdf OUTPUT.svg --floor gf --clip x0,y0,x1,y1 \
        [--exclude x0,y0,x1,y1 ...] [--resolution 20] [--preview preview.png]

Why raster + morphology: CAD layers in these drawings are inconsistent (walls sit
in "0", "Hatch", "A0--WALL", "DENAH2", ...), so a layer whitelist misses walls.
Walls, however, are always drawn as two dark lines about one wall thickness apart
(0.15-0.3 m, i.e. 0.2-0.4 pt at 1:~800). So we:

  1. draw every dark, neutral stroke/fill except clutter layers (text, furniture,
     sanitary, stairs, equipment, paving) onto a high-resolution mask;
  2. close the mask so wall line pairs merge into solid bands;
  3. open it so single thin lines (furniture, grid, dimensions) disappear;
  4. drop tiny specks and trace the remaining bands back into vector polygons.

Glass, window frames and mullions are thin single lines, so they are taken from
their CAD layers as plain strokes and drawn on top as class "fp-glass".
"""
import argparse
import re
import sys

import cv2
import numpy as np
import pymupdf

CLUTTER = re.compile(
    r'text|teks|notasi|dim|dimensi|axis|grid|frames|kop|furn|fur$|furniture|sanit|^san|fitting|toilet|'
    r'stair|strs|tangga|railing|hand ?rel|equip|fixture|mech|plumbing|listrik|ac-|outdoor|vrv|acecories|accessor|'
    r'plant|taman|paving|bhs|trolley|bolt|counter|benda|support|lantai|floor|finish|finm|not-fin|area|void|'
    r'arsir|hatch|hat$|ahat|patt|solid|bayang|center|dilatasi|bantu|a-commerce|signage|lamp',
    re.I,
)
GLASS = re.compile(r'^(kaca|glass|a-glass|a0--glass|mulion set|kusen|kusen2|kusen potong|kusenwer|partition|a0--door window)$', re.I)


def parse_rect(value):
    return pymupdf.Rect(*(float(part) for part in value.split(',')))


def layer_name(drawing):
    return (drawing.get('layer') or '').split('$0$')[-1].strip()


def dark_neutral(rgb):
    return rgb and max(rgb[:3]) <= 0.35 and (max(rgb[:3]) - min(rgb[:3])) <= 0.1


def points(item):
    op = item[0]
    if op == 'l':
        return [item[1], item[2]]
    if op == 'c':
        return [item[1], item[2], item[3], item[4]]
    if op == 're':
        r = item[1]
        return [r.tl, r.tr, r.br, r.bl, r.tl]
    if op == 'qu':
        q = item[1]
        return [q.ul, q.ur, q.lr, q.ll, q.ul]
    return []


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pdf')
    parser.add_argument('svg')
    parser.add_argument('--floor', required=True)
    parser.add_argument('--label', default='')
    parser.add_argument('--clip', type=parse_rect, required=True)
    parser.add_argument('--exclude', type=parse_rect, action='append', default=[])
    parser.add_argument('--resolution', type=float, default=20, help='mask pixels per PDF point')
    parser.add_argument('--close', type=float, default=0.35, help='gap bridged between wall lines, in points')
    parser.add_argument('--open', type=float, default=0.15, help='thinnest band kept, in points')
    parser.add_argument('--min-area', type=float, default=0.12, help='smallest kept blob, in square points')
    parser.add_argument('--max-thickness', type=float, default=1.2, help='solid areas thicker than this (points) are hatches, not walls')
    parser.add_argument('--min-glass', type=float, default=0.4, help='shortest kept glass segment, in points (drops door swings)')
    parser.add_argument('--scale', type=float, default=10, help='SVG units per PDF point')
    parser.add_argument('--preview', help='optional PNG of the extracted mask')
    args = parser.parse_args()

    page = pymupdf.open(args.pdf)[0]
    rotation = page.rotation_matrix
    clip, res = args.clip, args.resolution
    width_px, height_px = int(clip.width * res), int(clip.height * res)
    mask = np.zeros((height_px, width_px), np.uint8)

    def to_px(p):
        q = pymupdf.Point(p) * rotation
        return ((q.x - clip.x0) * res, (q.y - clip.y0) * res)

    def visible(rect):
        r = pymupdf.Rect(rect) * rotation
        if r.x1 < clip.x0 or r.x0 > clip.x1 or r.y1 < clip.y0 or r.y0 > clip.y1:
            return False
        return not any(r.x0 >= a.x0 and r.x1 <= a.x1 and r.y0 >= a.y0 and r.y1 <= a.y1 for a in args.exclude)

    strokes, fills, glass = [], [], []
    for drawing in page.get_drawings():
        if not visible(drawing['rect']):
            continue
        name = layer_name(drawing)
        filled = drawing['type'] in ('f', 'fs')
        rgb = drawing.get('fill') if filled else drawing.get('color')
        if GLASS.match(name) and not filled and dark_neutral(rgb):
            for item in drawing['items']:
                if item[0] != 'l':
                    continue  # curves on these layers are door swings
                a, b = item[1], item[2]
                if abs(b.x - a.x) + abs(b.y - a.y) >= args.min_glass:
                    glass.append([to_px(a), to_px(b)])
            continue
        if CLUTTER.search(name) or not dark_neutral(rgb):
            continue
        polygon = []
        for item in drawing['items']:
            pts = points(item)
            if not pts:
                continue
            if item[0] == 'c':
                pts = [pts[0], pts[3]]
            arr = np.array([to_px(p) for p in pts], np.int32)
            (polygon if filled else strokes).append(arr)
        if filled and polygon:
            shape = np.concatenate(polygon)
            if len({tuple(point) for point in shape}) == 3:
                continue  # filled triangles are passenger-flow arrow heads
            fills.append(shape)

    cv2.polylines(mask, strokes, False, 255, 1, cv2.LINE_8)
    if fills:
        cv2.fillPoly(mask, fills, 255)

    def kernel(points_size):
        size = max(1, int(round(points_size * res)))
        return cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))

    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel(args.close))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel(args.open))
    # Hatched floors and zones become solid after closing; walls are thin bands, so
    # anything that still survives a large opening is area fill, not a wall.
    thick = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel(args.max_thickness))
    thick = cv2.dilate(thick, kernel(args.close))
    mask = cv2.subtract(mask, thick)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel(args.open))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    keep = np.zeros(count, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= args.min_area * res * res
    mask = np.where(keep[labels], 255, 0).astype(np.uint8)
    if args.preview:
        cv2.imwrite(args.preview, 255 - mask)

    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    factor = args.scale / res
    parts = []
    for contour in contours:
        approx = cv2.approxPolyDP(contour, 0.6, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        coords = np.round(approx * factor).astype(int)
        x0, y0 = coords[0]
        rel = np.diff(coords, axis=0)
        parts.append(f'M{x0} {y0}' + ''.join(f'l{dx} {dy}' for dx, dy in rel if dx or dy) + 'z')
    wall_path = ''.join(parts).replace(' -', '-')

    glass_parts = []
    seen = set()
    for line in glass:
        coords = [(round(x * factor), round(y * factor)) for x, y in line]
        key = tuple(coords) if coords[0] <= coords[-1] else tuple(reversed(coords))
        if key in seen or len(set(coords)) < 2:
            continue
        seen.add(key)
        x0, y0 = coords[0]
        glass_parts.append(f'M{x0} {y0}' + ''.join(f'l{b[0] - a[0]} {b[1] - a[1]}' for a, b in zip(coords, coords[1:])))
    glass_path = ''.join(glass_parts).replace(' -', '-')

    width = round(clip.width * args.scale)
    height = round(clip.height * args.scale)
    label = args.label or f'Denah {args.floor}'
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" data-floor="{args.floor}" role="img" aria-label="{label}">',
        f'<path class="fp-glass" fill="none" stroke="#5b9bd5" d="{glass_path}"/>' if glass_path else '',
        f'<path class="fp-solid" fill="#1f2d2a" fill-rule="evenodd" d="{wall_path}"/>',
        '</svg>',
    ]
    with open(args.svg, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(part for part in svg if part))
    print(f'{args.svg}: {width}x{height}, {len(parts)} wall polygons, {len(glass_parts)} glass lines, '
          f'{sum(len(p) for p in svg) // 1024} KB', file=sys.stderr)


if __name__ == '__main__':
    main()
