# Fonts

`archivo-latin.woff2` and `archivo-latin-ext.woff2` are subsets of **Archivo**, the
variable build carrying both axes the design system uses:

| Axis   | Range     | Used for                                    |
|--------|-----------|---------------------------------------------|
| `wght` | 100 – 900 | weight                                      |
| `wdth` | 62 – 125  | width — headlines stretch, data labels compress |

Two files, split by `unicode-range`, so a visitor who never sees an extended-Latin
glyph never downloads the second one. Scripts outside Latin (the greetings screen
shows Japanese, Arabic, Devanagari, Cyrillic and more) fall through to the OS stack
by design — no webfont ships for them.

Self-hosted because the site's CSP is `default-src 'self'` with no `font-src`
exception; a font CDN would simply be blocked.

Source: <https://fonts.google.com/specimen/Archivo> (Omnibus-Type).
Licensed under the SIL Open Font License 1.1 — see `OFL.txt`.
