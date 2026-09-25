# bos brand-kit provenance and mapping

- supplied by: Firaz F. Hansurie for the BOS product
- source directory: `/Users/firazfhansurie/aios-firaz/outputs/2026-09-20-bos-brand-kit`
- generated: 2026-09-20
- status: first-party BOS project artwork; not derived from OpenMausBot source or assets

The source prompt used an existing BOS mascot as the identity reference and a supplied Grok Bot icon only as a material/restraint reference. BOS outputs must remain visually distinct and must not reuse Grok Bot or OpenMausBot trademarks, source, or artwork.

## deterministic mapping

| source | repository target | sha-256 |
| --- | --- | --- |
| `build/bos.icns` | `build/icon.icns` | `ac3c6043a3f3943c99bc990e07570defa74b12e91635acabeb57b4ebc1bf3907` |
| `app-icons/bos-512.png` | `build/icon.png`, `electron/resources/app-icon.png` | `e883835b62eb9d943da6317ab3e57d76b6f0443d54e3680766807143adf10206` |
| `bos-mascot-master.png` | `public/bos-mascot.png` | `74a9c4ffb5183ec2d5246db8f17882817ad5c647b88c9471ba72af8b1417b162` |
| `tokens/bos-tokens.css` | `src/styles/bos-tokens.css` | `2dc0da4504dfe6e067d2793f4b15e6bcc1fcdbcaeac79ee9b438118a492fe62c` |

Builds use only repository copies. The absolute source path is provenance metadata and must never be a runtime or packaging dependency.
