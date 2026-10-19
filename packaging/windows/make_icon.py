#!/usr/bin/env python3
"""Draws the app icon (the Micro seen from above, ring lit) into a multi-size .ico. Standard library only."""
import math, struct, sys, zlib

BODY, PLATE, KEY = (0x2a, 0x31, 0x38), (0x36, 0x3e, 0x46), (0xe6, 0xea, 0xee)
CODEX, CLAUDE = (0x2f, 0x6b, 0xff), (0xff, 0x9a, 0x1f)

def rounded(px, py, x, y, w, h, r):
    """Signed distance to a rounded rectangle (negative inside)."""
    qx = abs(px - (x + w / 2)) - (w / 2 - r); qy = abs(py - (y + h / 2)) - (h / 2 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def over(dst, src, a):
    return tuple(d + (s - d) * a for d, s in zip(dst, src))

def pixel(u, v):
    """Colour and alpha at unit coordinates (0..1)."""
    color, alpha = (0, 0, 0), 0.0
    ring = rounded(u, v, .06, .16, .88, .68, .17)
    if ring < .035:
        # Ring light: Codex blue fading into Claude amber around the body.
        t = (math.atan2(v - .5, u - .5) / math.pi + 1) / 2
        glow = max(0.0, 1 - abs(ring) / .035)
        color, alpha = over(CODEX, CLAUDE, .5 - .5 * math.cos(2 * math.pi * t)), glow
    body = rounded(u, v, .09, .19, .82, .62, .14)
    if body < 0:
        color, alpha = BODY, 1.0
        if rounded(u, v, .13, .23, .74, .54, .11) < 0: color = PLATE
        for i in range(6):
            kx, ky = .19 + (i % 3) * .19, .29 + (i // 3) * .21
            if rounded(u, v, kx, ky, .15, .15, .04) < 0:
                color = CODEX if i == 0 else CLAUDE if i == 1 else KEY
    return color, alpha

def rgba(size, samples):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc, a = [0.0, 0.0, 0.0], 0.0
            for sy in range(samples):
                for sx in range(samples):
                    c, al = pixel((x + (sx + .5) / samples) / size, (y + (sy + .5) / samples) / size)
                    for k in range(3): acc[k] += c[k] * al
                    a += al
            n = samples * samples
            row += bytes([int(acc[k] / a) if a else 0 for k in range(3)] + [round(255 * a / n)])
        rows.append(bytes(row))
    return rows

def png(size, rows):
    def chunk(kind, data): return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\0' + r for r in rows)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

def dib(size, rows):
    # Classic icon frame: BITMAPINFOHEADER, bottom-up BGRA rows, then an empty AND mask.
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    pixels = b''.join(bytes(b for i in range(0, len(r), 4) for b in (r[i + 2], r[i + 1], r[i], r[i + 3])) for r in reversed(rows))
    mask = b'\0' * (((size + 31) // 32) * 4 * size)
    return header + pixels + mask

def main(path):
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    # PNG compression is only reliable for the 256 px frame; smaller frames stay uncompressed.
    images = [png(s, rgba(s, 2)) if s == 256 else dib(s, rgba(s, 4)) for s in sizes]
    header = struct.pack('<HHH', 0, 1, len(sizes)); offset = 6 + 16 * len(sizes); entries = b''
    for s, data in zip(sizes, images):
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset); offset += len(data)
    with open(path, 'wb') as f: f.write(header + entries + b''.join(images))

if __name__ == '__main__': main(sys.argv[1])
