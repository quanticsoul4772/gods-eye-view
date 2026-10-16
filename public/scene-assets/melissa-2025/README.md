# Hurricane Melissa 2025 scene assets

Files for the built-in scene "Hurricane Melissa — Jamaica, Oct 2025"
(`src/scenes/recipes.js`, id `hurricane-melissa-2025`). Melissa made landfall
near New Hope, Westmoreland, Jamaica, at 17:25 UTC on 28 October 2025 as a
Category 5 hurricane (160 kt, 897 mb), per the NHC Tropical Cyclone Report
AL132025.

## Provenance and licenses

- **`track.json`**
  - Source: NHC best track for AL132025 from HURDAT2 (`hurdat2-1851-2025-092326.txt`). The positions form one line, with consecutive duplicate positions removed, plus the Jamaica landfall point. All are set at a 1,500 m ellipsoid height so the line clears the island's hills.
  - License: public domain (U.S. Government work).
- **`black-river-destroyed.json`**
  - Source: Copernicus EMS Rapid Mapping activation EMSR847, AOI21 Black River, grading product v1 (`builtUpP` layer).
  - Contents: only the 1,526 buildings graded **Destroyed**, of 9,432 graded. Coordinates are rounded to 6 decimals and placed at −5 m ellipsoid height, about 6 m above local ground.
  - License: Copernicus EMS terms, which allow reproduction, distribution and adaptation with the source credited: "© European Union, Copernicus Emergency Management Service (EMSR847)".
- **`black-river-aerial.jpg`**
  - Source: NOAA NGS emergency response imagery, flight 20251031a, tile `20251031aC0775100w180215n.tif`.
  - Crop: pixels 0–3200 × 7282–9415, about 480 × 320 m, centre 18.026338 N, 77.847941 W. Resized to 1400 px.
  - License: CC0 1.0 (NOAA data.gov record).
- **`savanna-la-mar-aerial.jpg`**
  - Source: NOAA NGS emergency response imagery, flight 20251101a, tile `20251101aC0780815w181330n.tif`.
  - Crop: about 520 × 345 m, centre 18.218469 N, 78.129345 W. Resized to 1400 px.
  - License: CC0 1.0.
- **`montego-bay-aerial.jpg`**
  - Source: NOAA NGS emergency response imagery, flight 20251106b, tile `20251106bC0775530w182830n.tif`.
  - Crop: about 705 × 470 m along the Montego River, centre 18.464728 N, 77.918432 W. Resized to 1400 px.
  - License: CC0 1.0.
- **`st-elizabeth-before-after.jpg`**
  - Source: NASA Earth Observatory, "A Direct Hit on Jamaican Forests". Images by Lauren Dauphin, using Landsat 8/9 data from the U.S. Geological Survey, captured 8 Sep 2025 and 3 Nov 2025.
  - The two images are resized to 700 px each and set side by side, with date labels added.
  - License: public domain (U.S. Government work).
- **`night-lights-before-after.jpg`**
  - Source: "Devastation and Power Loss Across Jamaica Following Melissa at Night", 30 Oct 2025, frames `before0` and `after0`. JPSS imagery: CSU/CIRA & NOAA/NESDIS.
  - The two 1920 px PNG frames are resized to 700 px each and set side by side, with labels added.
  - License: public domain (U.S. Government work).

These third-party assets are **not covered by the application's MIT license**;
each keeps the license listed above. Keep the credits that the scene shows on
every card.

Sources:

- [NHC Tropical Cyclone Report AL132025 (Melissa)](https://www.nhc.noaa.gov/data/tcr/AL132025_Melissa.pdf)
- [HURDAT2](https://www.nhc.noaa.gov/data/hurdat/)
- [Copernicus EMS activation EMSR847](https://mapping.emergency.copernicus.eu/activations/EMSR847)
- [Copernicus EMS terms and conditions](https://mapping.emergency.copernicus.eu/terms-and-conditions/)
- [NOAA NGS storm imagery viewer, Melissa](https://storms.ngs.noaa.gov/storms/melissa/index.html)
- [NOAA emergency response imagery on AWS (`noaa-eri-pds`)](https://catalog.data.gov/dataset/2025-noaa-ngs-emergency-response-imagery-hurricane-melissa)
- [NASA Earth Observatory images on Wikimedia Commons (before)](https://commons.wikimedia.org/wiki/File:A_Direct_Hit_on_Jamaican_Forests_(154887_-_20250908_lrg).jpg)
- [NASA Earth Observatory images on Wikimedia Commons (after)](https://commons.wikimedia.org/wiki/File:A_Direct_Hit_on_Jamaican_Forests_(154887_-_2_20251103_lrg).jpg)
- [CIRA night-lights images on Wikimedia Commons (before)](https://commons.wikimedia.org/wiki/File:Devastation_and_Power_Loss_Across_Jamaica_Following_Melissa_at_Night_(CIRA_2025-10-30_-_before0).png)
- [CIRA night-lights images on Wikimedia Commons (after)](https://commons.wikimedia.org/wiki/File:Devastation_and_Power_Loss_Across_Jamaica_Following_Melissa_at_Night_(CIRA_2025-10-30_-_after0).png)

Google 3D tiles and other basemap imagery are fetched at runtime, not bundled;
their provider attribution remains visible in the application.
