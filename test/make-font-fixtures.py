#!/usr/bin/env python3
"""Write the tiny fonts used by test/fonts-e2e.cjs (test/fixtures/fonts/).

They are made from scratch, so they carry no license: every glyph is a solid block,
which makes it obvious in a rendered page that the font, and not a substitute, was used.

  Demo On Demand Sans  Latin letters and digits (stands in for a font like Open Sans)
  Demo Thai Script     Thai letters (stands in for a script font like Noto Sans Thai)

Needs fontTools:  pip install fonttools
"""

import os
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'fonts')


def block(height):
    pen = TTGlyphPen(None)
    pen.moveTo((60, 0))
    pen.lineTo((60, height))
    pen.lineTo((540, height))
    pen.lineTo((540, 0))
    pen.closePath()
    return pen.glyph()


def write_font(file_name, family, code_points):
    names = ['.notdef', 'space'] + ['uni%04X' % cp for cp in code_points]
    cmap = {0x20: 'space'}
    cmap.update({cp: 'uni%04X' % cp for cp in code_points})
    glyphs = {'.notdef': block(700), 'space': TTGlyphPen(None).glyph()}
    glyphs.update({'uni%04X' % cp: block(700) for cp in code_points})

    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (600, 60) for name in names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    # The PostScript name is what a PDF calls the font, so the test can tell it was used.
    builder.setupNameTable({
        'familyName': family, 'styleName': 'Regular',
        'fullName': family, 'psName': family.replace(' ', ''),
    })
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, fsType=0)
    builder.setupPost()
    builder.save(os.path.join(OUT, file_name))


os.makedirs(OUT, exist_ok=True)
latin = list(range(ord('A'), ord('Z') + 1)) + list(range(ord('a'), ord('z') + 1)) + list(range(ord('0'), ord('9') + 1))
write_font('DemoOnDemandSans.ttf', 'Demo On Demand Sans', latin)
write_font('DemoThaiScript.ttf', 'Demo Thai Script', list(range(0x0E01, 0x0E2F)))
