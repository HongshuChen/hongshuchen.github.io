"""Make equirectangular "land dots" globe textures from Natural Earth land (world-atlas TopoJSON).

Dots sit on rows of equal latitude with a near-uniform spacing on the sphere, and each dot is drawn
wider by 1/cos(latitude) so it looks round once the texture is wrapped around the globe.

usage: python3 -I make_land_dots.py <land-50m.json> <out_dir>
"""

import json
import math
import sys

from PIL import Image, ImageDraw

W, H = 2048, 1024  # output size
SS = 2  # supersampling for smooth dots
STEP = 1.05  # degrees between dots along a meridian (about 6 output pixels)
RADIUS = 1.6  # dot radius in output pixels, at the equator

PALETTES = {
    # name: (ocean, land dot)
    "light": ((210, 237, 251), (62, 108, 156)),
    "dark": ((21, 38, 55), (128, 180, 220)),
}


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def ring_coords(ring, arcs):
    pts = []
    for i in ring:
        seg = arcs[i] if i >= 0 else list(reversed(arcs[~i]))
        if pts:
            seg = seg[1:]
        pts.extend(seg)
    return pts


def polygons(topo):
    arcs = decode_arcs(topo)
    obj = topo["objects"]["land"]
    geoms = obj["geometries"] if obj["type"] == "GeometryCollection" else [obj]
    for g in geoms:
        if g["type"] == "Polygon":
            yield [ring_coords(r, arcs) for r in g["arcs"]]
        elif g["type"] == "MultiPolygon":
            for poly in g["arcs"]:
                yield [ring_coords(r, arcs) for r in poly]


def to_px(lon, lat, w, h):
    return ((lon + 180) / 360 * w, (90 - lat) / 180 * h)


def unwrap(ring):
    """Make longitudes continuous where a ring crosses the antimeridian (no jumps of more than 180 degrees)."""
    out = [ring[0]]
    for lon, lat in ring[1:]:
        prev = out[-1][0]
        while lon - prev > 180:
            lon -= 360
        while lon - prev < -180:
            lon += 360
        out.append((lon, lat))
    return out


def land_mask(topo, w, h):
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    for rings in polygons(topo):
        for k, ring in enumerate(rings):
            if len(ring) < 3:
                continue
            ring = unwrap(ring)
            winding = ring[-1][0] - ring[0][0]
            if abs(winding) > 180:
                # The ring goes all the way round a pole (Antarctica): close it along that pole.
                pole = -90 if min(p[1] for p in ring) < 0 else 90
                ring = ring + [(ring[-1][0], pole), (ring[0][0], pole)]
            for shift in (-360, 0, 360):
                pts = [to_px(lon + shift, lat, w, h) for lon, lat in ring]
                draw.polygon(pts, fill=255 if k == 0 else 0)
    return mask


def main():
    topo = json.load(open(sys.argv[1]))
    out_dir = sys.argv[2]
    mask = land_mask(topo, W, H)
    dots = []
    rows = int(round(180 / STEP))
    for r in range(rows):
        lat = 90 - (r + 0.5) * 180 / rows
        n = max(1, int(round(360 * math.cos(math.radians(lat)) / STEP)))
        for i in range(n):
            lon = -180 + (i + 0.5) * 360 / n
            x, y = to_px(lon, lat, W, H)
            if mask.getpixel((min(W - 1, int(x)), min(H - 1, int(y)))):
                dots.append((x, y, lat))
    for name, (ocean, dot) in PALETTES.items():
        img = Image.new("RGB", (W * SS, H * SS), ocean)
        draw = ImageDraw.Draw(img)
        for x, y, lat in dots:
            ry = RADIUS * SS
            rx = min(ry / max(math.cos(math.radians(lat)), 0.05), 6 * ry)
            draw.ellipse((x * SS - rx, y * SS - ry, x * SS + rx, y * SS + ry), fill=dot)
        img = img.resize((W, H), Image.LANCZOS)
        img = img.quantize(colors=16, method=Image.Quantize.MEDIANCUT)
        img.save(f"{out_dir}/land-dots-{name}.png", optimize=True)
    print(f"{len(dots)} land dots")


main()
