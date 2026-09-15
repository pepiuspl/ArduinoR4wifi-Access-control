#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Szablon wiercenia na ścianę (1:1, A4) dla obudowy centralki CTRLABLE Node.
Generuje PDF bez żadnych bibliotek — do naklejenia na ścianę: krzyżyki otworów,
średnica wiertła/kołka, pasek kontrolny 100 mm do sprawdzenia skali wydruku.

Użycie:
  python tools/wall_template.py --out szablon.pdf --w 150 --h 110 --inset-x 8 --inset-y 8 \
      --drill 6 --plug "kołek 6 mm, wkręt 4×30" --name "CTRLABLE Node — obudowa 150×110"
  Opcjonalnie otwory jawnie:  --holes "8,8;142,8;8,102;142,102"  (mm od lewego GÓRNEGO rogu obudowy)
  Opcjonalnie wejścia kabli:  --cables "75,110:zasilanie 12 V + rygiel;20,110:panel drzwi"
Drukować w 100 % („rozmiar rzeczywisty"), bez dopasowania do strony.
"""
import argparse, datetime

MM = 72 / 25.4          # punkty PDF na mm
A4_W, A4_H = 210, 297   # mm

def esc(t):
    return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

def pl_ascii(t):
    # Fonty Type1 w PDF nie mają polskich znaków — zamieniamy na ASCII, żeby wydruk był czytelny.
    tbl = str.maketrans("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", "acelnoszzACELNOSZZ")
    return t.translate(tbl)

class PDF:
    def __init__(self):
        self.ops = []
    def line(self, x1, y1, x2, y2, w=0.35, dash=None):
        self.ops.append("%s %.2f w %s %.2f %.2f m %.2f %.2f l S" % (
            ("[%s] 0 d" % dash) if dash else "[] 0 d", w, "", x1 * MM, (A4_H - y1) * MM, x2 * MM, (A4_H - y2) * MM))
    def rect(self, x, y, w, h, lw=0.5, dash=None):
        self.ops.append("%s %.2f w %.2f %.2f %.2f %.2f re S" % (("[%s] 0 d" % dash) if dash else "[] 0 d", lw, x * MM, (A4_H - y - h) * MM, w * MM, h * MM))
    def circle(self, cx, cy, r, lw=0.5):
        k = 0.5523 * r; x, y = cx, A4_H - cy
        p = lambda a, b: "%.2f %.2f" % (a * MM, b * MM)
        self.ops.append("[] 0 d %.2f w %s m %s %s %s c %s %s %s c %s %s %s c %s %s %s c S" % (
            lw, p(x + r, y),
            p(x + r, y + k), p(x + k, y + r), p(x, y + r),
            p(x - k, y + r), p(x - r, y + k), p(x - r, y),
            p(x - r, y - k), p(x - k, y - r), p(x, y - r),
            p(x + k, y - r), p(x + r, y - k), p(x + r, y)))
    def text(self, x, y, s, size=9, bold=False):
        self.ops.append("BT /%s %.1f Tf %.2f %.2f Td (%s) Tj ET" % ("F2" if bold else "F1", size, x * MM, (A4_H - y) * MM, esc(pl_ascii(s))))
    def build(self):
        content = "\n".join(self.ops).encode("latin-1", "replace")
        objs = []
        objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
        objs.append(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>" % (A4_W * MM, A4_H * MM)).encode())
        objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
        out = bytearray(b"%PDF-1.4\n"); offs = []
        for i, o in enumerate(objs, 1):
            offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
        for o in offs: out += b"%010d 00000 n \n" % o
        out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
        return bytes(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True); ap.add_argument("--name", default="CTRLABLE Node")
    ap.add_argument("--w", type=float, required=True, help="szerokość obudowy [mm]")
    ap.add_argument("--h", type=float, required=True, help="wysokość obudowy [mm]")
    ap.add_argument("--inset-x", type=float, default=8); ap.add_argument("--inset-y", type=float, default=8)
    ap.add_argument("--holes", default=None, help='"x,y;x,y;..." mm od lewego górnego rogu obudowy')
    ap.add_argument("--drill", type=float, default=6, help="średnica wiertła [mm]")
    ap.add_argument("--plug", default="kołek 6 mm, wkręt 4x30")
    ap.add_argument("--cables", default="", help='"x,y:opis;x,y:opis" wejścia kabli (mm od lewego górnego rogu)')
    ap.add_argument("--note", default="")
    a = ap.parse_args()
    if a.holes:
        holes = [tuple(float(v) for v in h.split(",")) for h in a.holes.split(";") if h.strip()]
    else:
        holes = [(a.inset_x, a.inset_y), (a.w - a.inset_x, a.inset_y), (a.inset_x, a.h - a.inset_y), (a.w - a.inset_x, a.h - a.inset_y)]
    pdf = PDF()
    ox, oy = (A4_W - a.w) / 2, 40 + (A4_H - 40 - 30 - a.h) / 2     # obudowa wyśrodkowana, nagłówek u góry, stopka u dołu
    # nagłówek
    pdf.text(15, 15, "SZABLON WIERCENIA 1:1 - %s" % a.name, 14, True)
    pdf.text(15, 21, "Drukuj w 100%% (rozmiar rzeczywisty). Sprawdz pasek 100 mm linijka. Otwory: %d x srednica %.0f mm (%s)." % (len(holes), a.drill, a.plug), 9)
    pdf.text(15, 26, "Przyloz do sciany, wypoziomuj po gornej krawedzi, zaznacz srodki krzyzykow, wierc. Wygenerowano %s." % datetime.date.today().isoformat(), 8)
    if a.note: pdf.text(15, 31, a.note, 8)
    # obrys obudowy (przerywany) + linia pozioma do poziomicy
    pdf.rect(ox, oy, a.w, a.h, 0.4, "3 2")
    pdf.line(ox - 15, oy, ox + a.w + 15, oy, 0.3, "1 1"); pdf.text(ox + a.w - 52, oy - 6, "gorna krawedz obudowy - linia do poziomicy", 7)
    pdf.text(ox, oy - 2, "obrys obudowy %.0f x %.0f mm" % (a.w, a.h), 7)
    # otwory
    for i, (hx, hy) in enumerate(holes, 1):
        cx, cy = ox + hx, oy + hy
        pdf.line(cx - 10, cy, cx + 10, cy, 0.5); pdf.line(cx, cy - 10, cx, cy + 10, 0.5)
        pdf.circle(cx, cy, a.drill / 2, 0.5); pdf.circle(cx, cy, 1.0, 0.8)
        pdf.text(cx + 3, cy - 3, "H%d  o%.0f mm" % (i, a.drill), 8, True)
        pdf.text(cx + 3, cy + 6, "x=%.0f y=%.0f" % (hx, hy), 6.5)
    # rozstawy
    xs = sorted(set(h[0] for h in holes)); ys = sorted(set(h[1] for h in holes))
    if len(xs) >= 2:
        y = oy + a.h + 8; pdf.line(ox + xs[0], y, ox + xs[-1], y, 0.3); pdf.text(ox + (xs[0] + xs[-1]) / 2 - 8, y - 1.5, "rozstaw %.0f mm" % (xs[-1] - xs[0]), 7)
    if len(ys) >= 2:
        x = ox - 8; pdf.line(x, oy + ys[0], x, oy + ys[-1], 0.3); pdf.text(x - 14, oy + (ys[0] + ys[-1]) / 2, "%.0f mm" % (ys[-1] - ys[0]), 7)
    # wejścia kabli
    if a.cables:
        for item in a.cables.split(";"):
            if not item.strip(): continue
            pos, label = item.split(":", 1); cx, cy = (float(v) for v in pos.split(","))
            X, Y = ox + cx, oy + cy
            pdf.line(X - 4, Y - 4, X + 4, Y + 4, 0.6); pdf.line(X - 4, Y + 4, X + 4, Y - 4, 0.6)
            pdf.text(X + 5, Y + 1, "kabel: " + label, 7)
    # pasek kontrolny 100 mm
    bx, by = 15, A4_H - 18
    pdf.line(bx, by, bx + 100, by, 0.8)
    for i in range(0, 101, 10): pdf.line(bx + i, by - (3 if i % 50 == 0 else 2), bx + i, by, 0.5)
    pdf.text(bx, by + 5, "pasek kontrolny: dokladnie 100 mm po wydruku", 8, True)
    pdf.text(bx, by + 10, "CTRLABLE Tomasz Plewka - node@ctrlable.pl - 696 088 602", 7)
    open(a.out, "wb").write(pdf.build())
    print("zapisano", a.out, "| otwory:", holes)

if __name__ == "__main__":
    main()
