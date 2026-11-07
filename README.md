# GPS-foto

Enkel app for feltdokumentasjon: ta et bilde, så skrives UTM-koordinatene (X/Y, ETRS89) direkte inn i bildet.

- Innebygd kamera med live-bilde
- GPS-posisjon og nøyaktighet (±m) vises før du tar bildet. Utløseren er sperret til appen har fått en fersk posisjon.
- Automatisk UTM-sone (32/33/34/35, også Svalbard), ETRS89 / EPSG:258xx
- X, Y, sone, nøyaktighet og tidspunkt skrives inn i selve bildet, nederst til venstre
- Lagres automatisk i kamerarullen: på iPhone åpnes delingsarket etter hvert bilde (trykk «Arkiver bilde»), på Android lastes bildet ned automatisk.
- Hent bilder fra kamerarullen: bruker GPS-posisjonen i bildet, eller (etter spørsmål) posisjonen der du står.
- GPS-posisjon og tidspunkt skrives også i bildefilens EXIF, så bildet havner på riktig sted og dato i Bilder.
- Galleri: vis, del, lagre til Bilder, velg flere, slett.
- Virker uten nett etter første åpning.

## Publisere på GitHub Pages
1. Last opp alle filene i denne mappen til et GitHub-repo (f.eks. `gps-foto`).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, mappe `/ (root)` → **Save**.
3. Etter 1–2 minutter ligger appen på `https://<brukernavn>.github.io/gps-foto/`.

## Legge på hjemskjermen
- **iPhone (Safari):** åpne adressen → Del-knappen → «Legg til på Hjem-skjerm».
- **Android (Chrome):** åpne adressen → menyen ⋮ → «Legg til på startskjermen» / «Installer app».

Første gang du trykker TA BILDE spør telefonen om tilgang til kamera og posisjon. Svar «Tillat» og velg **nøyaktig posisjon**.

## Merk
- X = øst, Y = nord (som i eksemplet i bestillingen).
- Telefonens GPS gir WGS84, som her behandles som ETRS89. Forskjellen er under 1 meter i Norge i dag, altså godt innenfor telefonens egen nøyaktighet.
- Bildene ligger bare i appen på telefonen. Lagre eller del dem jevnlig. Hvis du sletter appen eller nettleserdata, forsvinner bildene.
