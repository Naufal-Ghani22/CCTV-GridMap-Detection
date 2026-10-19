"""Convert a CAD floor-plan PDF into a layered SVG for CCTV Map.

Usage:
    python tools/pdf_to_svg.py INPUT.pdf OUTPUT.svg --floor gf \
        --clip 30,160,1170,500 [--exclude 1065,420,1180,456] [--scale 10]

Every vector drawing inside --clip is kept in its original paint order and
grouped into CSS classes the web app themes:

    fp-wall    black linework (walls, furniture, CAD text strokes)
    fp-col     black fills (columns, solid elements)
    fp-mask    white fills/strokes (CAD wipeouts) - painted with the map background
    fp-detail  grey linework (secondary detail, grid)
    fp-zone    grey fills (hatched/paved zones)
    fp-flow    coloured passenger-flow arrows (keep their own colour)
    fp-mark    yellow/orange markers
    fp-text    real PDF text (room numbers, labels)

Coordinates are page points x --scale, rounded to integers. Duplicate
segments are dropped and touching segments are chained into polylines,
which shrinks the file by an order of magnitude without visible change.
"""
import argparse
import html
import math
import re
import sys

import pymupdf


def parse_rect(value):
    x0, y0, x1, y1 = (float(part) for part in value.split(','))
    return pymupdf.Rect(x0, y0, x1, y1)


# CAD layer names (last part after "$0$") -> class, for --layers walls. Hatches are excluded on purpose.
WALL_LAYERS = re.compile(r'^(a0--wall|wall|a-wall|a-00-wall|i-wall|04200wall|dinding|dinding h|dinding potong|dinding tampak|rtt dinding|'
                         r'tahap 1 dinding|\^dinding bata|partition|bata|00 - bata|hebel|beton potong|00-beton)$', re.I)
COLUMN_LAYERS = re.compile(r'^(kolom|colm|colom|col|col solid|a0--coloumn|a-00-colm|conc-column|kolom praktis|a-str)$', re.I)
GLASS_LAYERS = re.compile(r'^(kaca|glass|a-glass|a0--glass|mulion set|kusen|kusen2|kusen potong|kusenwer)$', re.I)


def classify_layer(drawing):
    base = (drawing.get('layer') or '').split('$0$')[-1].strip()
    rgb = drawing.get('fill') if drawing.get('type') in ('f', 'fs') else drawing.get('color')
    if rgb and min(rgb[:3]) > 0.9:
        return None, None  # white wipeouts are not needed once furniture is gone
    if WALL_LAYERS.match(base):
        return 'fp-wall', None
    if COLUMN_LAYERS.match(base):
        return 'fp-col', None
    if GLASS_LAYERS.match(base):
        return 'fp-glass', None
    return None, None


def classify(drawing):
    stroke = drawing.get('color')
    fill = drawing.get('fill')
    kind = drawing.get('type')
    rgb = fill if kind in ('f', 'fs') and fill else stroke
    if not rgb:
        return None, None
    r, g, b = rgb[:3]
    filled = kind in ('f', 'fs')
    spread = max(r, g, b) - min(r, g, b)
    color = '#%02x%02x%02x' % tuple(round(channel * 255) for channel in (r, g, b))
    if spread < 0.06:  # neutral
        if r > 0.92:
            return ('fp-mask', None)
        if r < 0.12:
            return ('fp-col' if filled else 'fp-wall', None)
        return ('fp-zone' if filled else 'fp-detail', None)
    if r > 0.8 and g > 0.5 and b < 0.3:  # yellow / orange
        return ('fp-mark' if filled else 'fp-flow', color)
    return ('fp-flow', color)


class PathWriter:
    """Builds a compact path string with relative commands and pen tracking."""

    def __init__(self, transform):
        self.t = transform
        self.parts = []
        self.pen = None
        self.start = None

    def point(self, p):
        x, y = self.t(p)
        return round(x), round(y)

    def move(self, p):
        q = self.point(p)
        if q != self.pen:
            self.parts.append(f'M{q[0]} {q[1]}')
            self.pen = q
            self.start = q
        return q

    def line(self, a, b):
        self.move(a)
        q = self.point(b)
        dx, dy = q[0] - self.pen[0], q[1] - self.pen[1]
        if dx or dy:
            if dy == 0:
                self.parts.append(f'h{dx}')
            elif dx == 0:
                self.parts.append(f'v{dy}')
            else:
                self.parts.append(f'l{dx} {dy}')
        self.pen = q

    def curve(self, a, c1, c2, b):
        self.move(a)
        p0 = self.pen
        k1, k2, q = self.point(c1), self.point(c2), self.point(b)
        self.parts.append(f'c{k1[0]-p0[0]} {k1[1]-p0[1]} {k2[0]-p0[0]} {k2[1]-p0[1]} {q[0]-p0[0]} {q[1]-p0[1]}')
        self.pen = q

    def close(self):
        self.parts.append('z')
        self.pen = self.start

    def text(self):
        # "M10 -5" and "M10-5" are equivalent; drop the redundant space.
        return ''.join(self.parts).replace(' -', '-')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pdf')
    parser.add_argument('svg')
    parser.add_argument('--floor', required=True)
    parser.add_argument('--label', default='')
    parser.add_argument('--clip', type=parse_rect, required=True, help='x0,y0,x1,y1 in PDF points (as rendered)')
    parser.add_argument('--exclude', type=parse_rect, action='append', default=[], help='areas to drop, e.g. legends')
    parser.add_argument('--scale', type=float, default=10)
    parser.add_argument('--no-text', action='store_true')
    parser.add_argument('--layers', choices=['all', 'walls'], default='all', help='walls: keep only CAD wall, column and glass layers')
    parser.add_argument('--walls-only', action='store_true', help='geometric fallback for PDFs without layers')
    parser.add_argument('--min-seg', type=float, default=1.2, help='walls-only: shortest kept segment, in points')
    parser.add_argument('--min-extent', type=float, default=3.0, help='walls-only: smallest path bounding box side, in points')
    parser.add_argument('--no-columns', action='store_true', help='walls-only: drop filled columns')
    args = parser.parse_args()

    page = pymupdf.open(args.pdf)[0]
    # get_drawings() reports unrotated coordinates; map them to what a viewer shows.
    rotation = page.rotation_matrix
    clip, scale = args.clip, args.scale

    def transform(p):
        q = pymupdf.Point(p) * rotation
        return ((q.x - clip.x0) * scale, (q.y - clip.y0) * scale)

    def inside(r, area):
        return r.x0 >= area.x0 and r.x1 <= area.x1 and r.y0 >= area.y0 and r.y1 <= area.y1

    def visible(rect):
        # Compare coordinates directly: a horizontal line has an empty Rect, which intersects() rejects.
        r = pymupdf.Rect(rect) * rotation
        if r.x1 < clip.x0 or r.x0 > clip.x1 or r.y1 < clip.y0 or r.y0 > clip.y1:
            return False
        return not any(inside(r, area) for area in args.exclude)

    drawings = page.get_drawings()
    runs = []  # [class, color, writer]
    seen = {}
    stats = {'drawings': 0, 'segments': 0, 'duplicates': 0}
    for drawing in drawings:
        if not visible(drawing['rect']):
            continue
        cls, color = classify_layer(drawing) if args.layers == 'walls' else classify(drawing)
        if not cls:
            continue
        if args.walls_only:
            extent = max(drawing['rect'].width, drawing['rect'].height)
            if cls == 'fp-col':
                # Columns: small solid squares/circles; drop large fills (hatches, signs).
                if args.no_columns or extent > 4 or extent < 0.6:
                    continue
            elif cls != 'fp-wall' or extent < args.min_extent:
                continue
        stats['drawings'] += 1
        filled = drawing['type'] in ('f', 'fs')
        if not runs or runs[-1][0] != cls or runs[-1][1] != color:
            runs.append([cls, color, PathWriter(transform)])
        writer = runs[-1][2]
        dedupe = seen.setdefault((cls, color), set())
        for item in drawing['items']:
            op = item[0]
            if op == 'l':
                a, b = item[1], item[2]
                if args.walls_only and cls == 'fp-wall' and math.hypot(b.x - a.x, b.y - a.y) < args.min_seg:
                    continue
                pa, pb = writer.point(a), writer.point(b)
                key = (pa, pb) if pa <= pb else (pb, pa)
                if not filled:
                    if key in dedupe or pa == pb:
                        stats['duplicates'] += 1
                        continue
                    dedupe.add(key)
                writer.line(a, b)
                stats['segments'] += 1
            elif op == 'c':
                if args.walls_only and cls == 'fp-wall':
                    continue  # door swings and furniture curves
                writer.curve(item[1], item[2], item[3], item[4])
            elif op == 're':
                rect = item[1]
                corners = [rect.tl, rect.tr, rect.br, rect.bl]
                writer.move(corners[0])
                for index in range(1, 4):
                    writer.line(corners[index - 1], corners[index])
                writer.close()
            elif op == 'qu':
                quad = item[1]
                corners = [quad.ul, quad.ur, quad.lr, quad.ll]
                writer.move(corners[0])
                for index in range(1, 4):
                    writer.line(corners[index - 1], corners[index])
                writer.close()
        if filled or drawing.get('closePath'):
            writer.close()

    width = round(clip.width * scale)
    height = round(clip.height * scale)
    label = args.label or f'Denah {args.floor}'
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" data-floor="{args.floor}" role="img" aria-label="{html.escape(label)}">']
    defaults = {
        'fp-wall': 'fill="none" stroke="#1f2d2a"',
        'fp-detail': 'fill="none" stroke="#8a9893"',
        'fp-glass': 'fill="none" stroke="#5b9bd5"',
        'fp-col': 'fill="#1f2d2a"',
        'fp-zone': 'fill="#c9d1ce"',
        'fp-mask': 'fill="#ffffff"',
    }
    elements = 0
    for cls, color, writer in runs:
        data = writer.text()
        if not data:
            continue
        filled_class = cls in ('fp-zone', 'fp-mask', 'fp-mark')
        if cls in defaults:
            paint = defaults[cls]
        elif filled_class:
            paint = f'fill="{color}"'
        else:
            paint = f'fill="none" stroke="{color}"'
        out.append(f'<path class="{cls}" {paint} d="{data}"/>')
        elements += 1

    if not args.no_text and not args.walls_only and args.layers == 'all':
        texts = 0
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                direction = line.get('dir', (1, 0))
                for span in line['spans']:
                    content = span['text'].strip()
                    if not content:
                        continue
                    origin = pymupdf.Point(span['origin'])
                    bbox = pymupdf.Rect(span['bbox'])
                    if not visible(bbox):
                        continue
                    x, y = transform(origin)
                    angle = math.degrees(math.atan2(direction[1], direction[0])) + page.rotation
                    angle = ((angle + 180) % 360) - 180
                    size = span['size'] * scale
                    rotate = f' transform="rotate({round(angle)} {round(x)} {round(y)})"' if abs(angle) > 1 else ''
                    out.append(f'<text class="fp-text" x="{round(x)}" y="{round(y)}" font-size="{size:.0f}"{rotate}>{html.escape(content)}</text>')
                    texts += 1
        stats['texts'] = texts
    out.append('</svg>')
    with open(args.svg, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(out))
    stats['elements'] = elements
    stats['bytes'] = sum(len(part) + 1 for part in out)
    print(f'{args.svg}: {width}x{height}', stats, file=sys.stderr)


if __name__ == '__main__':
    main()
