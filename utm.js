/*
 * UTM-konvertering for GPS-foto.
 * Breddegrad/lengdegrad (ETRS89/WGS84) -> UTM (Krüger-serier, 6. orden, ~mm-nøyaktighet).
 * Ellipsoide: GRS80 (ETRS89). Sonevalg følger UTM-standarden inkl. unntakene for
 * Sør-Norge (32V) og Svalbard (31X/33X/35X/37X).
 */
(function (root) {
  'use strict';

  var a = 6378137.0;               // GRS80 store halvakse
  var f = 1 / 298.257222101;       // GRS80 flattrykning
  var k0 = 0.9996;
  var FALSE_EASTING = 500000;
  var FALSE_NORTHING_SOUTH = 10000000;

  var e = Math.sqrt(f * (2 - f));
  var n = f / (2 - f);
  var n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  var A = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  var alpha = [
    0,
    n / 2 - 2 / 3 * n2 + 5 / 16 * n3 + 41 / 180 * n4 - 127 / 288 * n5 + 7891 / 37800 * n6,
    13 / 48 * n2 - 3 / 5 * n3 + 557 / 1440 * n4 + 281 / 630 * n5 - 1983433 / 1935360 * n6,
    61 / 240 * n3 - 103 / 140 * n4 + 15061 / 26880 * n5 + 167603 / 181440 * n6,
    49561 / 161280 * n4 - 179 / 168 * n5 + 6601661 / 7257600 * n6,
    34729 / 80640 * n5 - 3418889 / 1995840 * n6,
    212378941 / 319334400 * n6
  ];

  function utmZone(lat, lon) {
    // Normaliser lengdegrad til [-180, 180)
    var L = ((lon + 180) % 360 + 360) % 360 - 180;
    var zone = Math.floor((L + 180) / 6) + 1;
    if (zone > 60) zone = 60;
    // Unntak Sør-Vestlandet: sone 32 utvidet vestover (56°N–64°N, 3°E–12°E)
    if (lat >= 56 && lat < 64 && L >= 3 && L < 12) zone = 32;
    // Unntak Svalbard (72°N–84°N)
    if (lat >= 72 && lat < 84) {
      if (L >= 0 && L < 9) zone = 31;
      else if (L >= 9 && L < 21) zone = 33;
      else if (L >= 21 && L < 33) zone = 35;
      else if (L >= 33 && L < 42) zone = 37;
    }
    return zone;
  }

  function toUTM(lat, lon, forcedZone) {
    if (!isFinite(lat) || !isFinite(lon) || lat < -80 || lat > 84) {
      throw new Error('Posisjonen er utenfor UTM-området');
    }
    var zone = forcedZone || utmZone(lat, lon);
    var lon0 = (zone - 1) * 6 - 180 + 3;
    var dLon = ((lon - lon0 + 540) % 360) - 180;

    var phi = lat * Math.PI / 180;
    var lam = dLon * Math.PI / 180;
    var cosL = Math.cos(lam), sinL = Math.sin(lam);

    var tau = Math.tan(phi);
    var sigma = Math.sinh(e * atanh(e * tau / Math.sqrt(1 + tau * tau)));
    var tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    var xiP = Math.atan2(tauP, cosL);
    var etaP = asinh(sinL / Math.sqrt(tauP * tauP + cosL * cosL));

    var xi = xiP, eta = etaP;
    for (var j = 1; j <= 6; j++) {
      xi += alpha[j] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
      eta += alpha[j] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }

    var easting = k0 * A * eta + FALSE_EASTING;
    var northing = k0 * A * xi;
    var hemisphere = lat >= 0 ? 'N' : 'S';
    if (northing < 0) northing += FALSE_NORTHING_SOUTH;

    var etrs = hemisphere === 'N' && zone >= 28 && zone <= 38;
    var epsg = etrs ? 25800 + zone : (hemisphere === 'N' ? 32600 : 32700) + zone;
    var datum = etrs ? 'ETRS89' : 'WGS 84';

    return {
      x: easting,          // Øst (X i appen)
      y: northing,         // Nord (Y i appen)
      zone: zone,
      hemisphere: hemisphere,
      epsg: epsg,
      label: datum + ' / UTM ' + zone + hemisphere
    };
  }

  function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }
  function asinh(x) { return Math.log(x + Math.sqrt(x * x + 1)); }

  var api = { toUTM: toUTM, utmZone: utmZone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UTM = api;
})(this);
