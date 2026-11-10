# Legacy Microsoft Office fixtures

Documents in the file formats of old Microsoft Office versions, which current Office opens only in
Protected View or refuses under its File Block settings. They come from the
[Apache POI test data](https://github.com/apache/poi/tree/trunk/test-data) (Apache-2.0):

| File | Format | POI name |
| --- | --- | --- |
| `word6.doc` | Word 6.0 | `document/Word6.doc` |
| `word95.doc` | Word 95 | `document/Word95.doc` |
| `excel4.xls` | Excel 4.0 worksheet (BIFF4) | `spreadsheet/testEXCEL_4.xls` |
| `excel5.xls` | Excel 5.0/95 workbook (BIFF5) | `spreadsheet/testEXCEL_5.xls` |
| `excel95.xls` | Excel 5.0/95 workbook (BIFF5) | `spreadsheet/testEXCEL_95.xls` |

PowerPoint 95 is not here: LibreOffice imports it with the libmwaw-based "Microsoft PowerPoint
1-4 and 95's" filter, which this build leaves out (`build/patches/0006`).
