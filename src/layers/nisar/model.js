/**
 * NISAR radar change layer — pure catalogue and georeferencing model.
 *
 * Scenes come from NASA's Common Metadata Repository (CMR), which indexes the
 * NISAR L2 products ASF distributes. The full HDF5 granules need an Earthdata
 * login, but every granule also ships a public, CORS-enabled browse PNG
 * (`*_LATLON.png`) rendered on a north-up lat/lon grid. Those PNGs carry no
 * georeference of their own (matplotlib output) and the sidecar KML that does
 * is login-gated, so the image extent is recovered by fitting the opaque
 * frame's extreme pixels to the CMR footprint corners (`fitBrowseExtent`).
 * Checked against GCOV and GUNW browses of track 169 / frame 023 (Oyu
 * Tolgoi): both fits agree to ~0.002° and the unused corners land within
 * ~0.005° (~400 m) of the footprint.
 *
 * No Cesium import here, so the whole module runs under `node --test`.
 */

export const NISAR_CMR_GRANULES_URL =
  'https://cmr.earthdata.nasa.gov/search/granules.umm_json';

/** Products the layer can step through. */
export const NISAR_PRODUCTS = Object.freeze({
  gcov: Object.freeze({
    id: 'gcov',
    label: 'BACKSCATTER',
    shortName: 'NISAR_L2_GCOV_PROVISIONAL_V1',
    title:
      'GCOV polarimetric backscatter (HH/HV false colour). Bare ground, new spoil and pit walls brighten; open water and tailings ponds go dark.',
  }),
  gunw: Object.freeze({
    id: 'gunw',
    label: 'INTERFEROGRAM',
    shortName: 'NISAR_L2_GUNW_PROVISIONAL_V1',
    title:
      '12-day unwrapped interferogram (line-of-sight phase). Broad smooth bands are mostly atmosphere and ionosphere; local, sharp patterns over a dam or pit are the deformation signal.',
  }),
});

export const NISAR_DEFAULT_PRODUCT_ID = 'gcov';

/**
 * Mongolian monitoring sites. Coordinates are site centres taken from
 * OpenStreetMap where it maps the operation (Oyu Tolgoi, Tavan Tolgoi,
 * Zaamar); Erdenet is an approximate centre between the city, concentrator,
 * pit and tailings facility. `viewHeightM` frames the whole operation.
 */
export const NISAR_SITES = Object.freeze([
  Object.freeze({
    id: 'erdenet',
    label: 'ERDENET',
    name: 'Erdenet copper mine & tailings',
    lon: 104.1,
    lat: 49.05,
    viewHeightM: 45_000,
    focus: 'Tailings dam deformation and pond extent',
  }),
  Object.freeze({
    id: 'oyu-tolgoi',
    label: 'OYU TOLGOI',
    name: 'Oyu Tolgoi copper-gold mine',
    lon: 106.8705,
    lat: 43.0172,
    viewHeightM: 40_000,
    focus: 'Block-cave subsidence, tailings facility, pit growth',
  }),
  Object.freeze({
    id: 'tavan-tolgoi',
    label: 'TAVAN TOLGOI',
    name: 'Tavan Tolgoi coal field',
    lon: 105.4913,
    lat: 43.6212,
    viewHeightM: 45_000,
    focus: 'Pit and waste-dump expansion',
  }),
  Object.freeze({
    id: 'zaamar',
    label: 'ZAAMAR',
    name: 'Zaamar placer-gold district (Tuul River)',
    lon: 104.7747,
    lat: 48.2162,
    viewHeightM: 60_000,
    focus: 'River-valley disturbance from placer and informal mining',
  }),
  Object.freeze({
    id: 'ulaanbaatar',
    label: 'ULAANBAATAR',
    name: 'Ulaanbaatar',
    lon: 106.917,
    lat: 47.918,
    viewHeightM: 60_000,
    focus: 'Urban ground motion reference',
  }),
]);

export const NISAR_DEFAULT_SITE_ID = 'erdenet';

/** Look up a site by id, falling back to the default site. */
export function nisarSite(id) {
  return (
    NISAR_SITES.find((site) => site.id === id) ||
    NISAR_SITES.find((site) => site.id === NISAR_DEFAULT_SITE_ID)
  );
}

/** Look up a product by id, falling back to the default product. */
export function nisarProduct(id) {
  return NISAR_PRODUCTS[id] || NISAR_PRODUCTS[NISAR_DEFAULT_PRODUCT_ID];
}

/**
 * Build the CMR query for every granule of one product covering one site.
 * @param {{ product: object, site: object, pageSize?: number }} input
 * @returns {string}
 */
export function buildNisarGranuleUrl({ product, site, pageSize = 200 }) {
  const params = new URLSearchParams({
    short_name: product.shortName,
    point: `${site.lon},${site.lat}`,
    page_size: String(pageSize),
    sort_key: '-start_date',
  });
  return `${NISAR_CMR_GRANULES_URL}?${params}`;
}

// NISAR_L2_PR_GCOV_033_169_A_023_2005_...      cycle, track, direction, frame
// NISAR_L2_PR_GUNW_032_169_A_023_033_2000_...  ref cycle, track, dir, frame, sec cycle
const GRANULE_NAME =
  /^NISAR_L2_[A-Z]+_(GCOV|GUNW)_(\d{3})_(\d{3})_([AD])_(\d{3})_/;
const NAME_TIMESTAMP = /_(\d{8}T\d{6})/g;

/** Parse the orbit geometry encoded in a NISAR L2 granule name. */
export function parseNisarGranuleName(name) {
  const match = GRANULE_NAME.exec(String(name || ''));
  if (!match) return null;
  return {
    productType: match[1],
    cycle: Number(match[2]),
    track: Number(match[3]),
    direction: match[4] === 'A' ? 'ascending' : 'descending',
    frame: Number(match[5]),
  };
}

function compactToIso(stamp) {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

function footprintOf(umm) {
  const points =
    umm?.SpatialExtent?.HorizontalSpatialDomain?.Geometry?.GPolygons?.[0]
      ?.Boundary?.Points;
  if (!Array.isArray(points) || points.length < 4) return null;
  const ring = [];
  for (const point of points) {
    const lon = Number(point?.Longitude);
    const lat = Number(point?.Latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    ring.push([lon, lat]);
  }
  const [first] = ring;
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) ring.pop();
  return ring.length >= 3 ? ring : null;
}

function browseUrlOf(umm) {
  for (const entry of umm?.RelatedUrls || []) {
    const url = String(entry?.URL || '');
    if (url.startsWith('https://') && url.endsWith('_LATLON.png')) return url;
  }
  return null;
}

/**
 * Turn a CMR UMM-JSON granule search into displayable scenes.
 *
 * Scenes are restricted to a single track/frame (see `pickFrame`) so
 * stepping through time compares like with like (ascending and descending
 * passes, or neighbouring frames, look completely different in radar).
 * Re-processed duplicates of one acquisition keep the lexically latest name.
 * @param {object} payload CMR `granules.umm_json` response body.
 * @param {{ site?: {lon:number, lat:number} }} [options]
 * @returns {Array<object>|null} Oldest-first scenes, or null when malformed.
 */
export function normalizeNisarGranules(payload, { site } = {}) {
  if (!payload || !Array.isArray(payload.items)) return null;
  const byAcquisition = new Map();
  for (const item of payload.items) {
    const umm = item?.umm;
    const name = umm?.GranuleUR;
    const geometry = parseNisarGranuleName(name);
    const footprint = footprintOf(umm);
    const browseUrl = browseUrlOf(umm);
    if (!geometry || !footprint || !browseUrl) continue;
    const stamps = [...String(name).matchAll(NAME_TIMESTAMP)].map((m) =>
      compactToIso(m[1]),
    );
    if (!stamps.length) continue;
    const isPair = geometry.productType === 'GUNW' && stamps.length >= 4;
    const scene = {
      id: name,
      productType: geometry.productType,
      track: geometry.track,
      frame: geometry.frame,
      direction: geometry.direction,
      groupKey: `${geometry.track}-${geometry.direction}-${geometry.frame}`,
      // For an interferogram the scene's date is the secondary acquisition:
      // the change it shows happened between referenceStart and start.
      start: isPair ? stamps[2] : stamps[0],
      referenceStart: isPair ? stamps[0] : null,
      footprint,
      browseUrl,
      sizeBytes:
        Number(
          umm?.DataGranule?.ArchiveAndDistributionInformation?.[0]?.SizeInBytes,
        ) || null,
    };
    const key = `${scene.groupKey}|${scene.referenceStart || ''}|${scene.start}`;
    const previous = byAcquisition.get(key);
    if (!previous || previous.id < scene.id) byAcquisition.set(key, scene);
  }

  const groups = new Map();
  for (const scene of byAcquisition.values()) {
    if (!groups.has(scene.groupKey)) groups.set(scene.groupKey, []);
    groups.get(scene.groupKey).push(scene);
  }
  const best = pickFrame(
    [...groups.keys()].sort().map((key) => groups.get(key)),
    site,
  );
  return best.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  );
}

/** Ground distance proxy (degrees, longitude scaled) from a site to a frame centre. */
function centreDistance(scene, site) {
  const ring = scene.footprint;
  const lon = ring.reduce((sum, [x]) => sum + x, 0) / ring.length;
  const lat = ring.reduce((sum, [, y]) => sum + y, 0) / ring.length;
  return Math.hypot(
    (lon - site.lon) * Math.cos((site.lat * Math.PI) / 180),
    lat - site.lat,
  );
}

/**
 * Choose one frame's scenes. Without a site the longest series wins. With a
 * site, any frame holding at least 75% of the longest series is eligible and
 * the one whose centre is nearest the site wins: a site on a frame's edge
 * often falls in the geocoded no-data strip, which is useless however many
 * dates it has. Ties keep the earliest (lowest-key) group.
 */
function pickFrame(groups, site) {
  const longest = Math.max(0, ...groups.map((scenes) => scenes.length));
  if (!site) return groups.find((scenes) => scenes.length === longest) || [];
  let best = [];
  let bestDistance = Infinity;
  for (const scenes of groups) {
    if (scenes.length < longest * 0.75) continue;
    const distance = centreDistance(scenes[0], site);
    if (distance < bestDistance) {
      best = scenes;
      bestDistance = distance;
    }
  }
  return best;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function shortDate(iso, withYear) {
  const [year, month, day] = iso.slice(0, 10).split('-');
  const text = `${Number(day)} ${MONTHS[Number(month) - 1]}`;
  return withYear ? `${text} ${year}` : text;
}

/** Human date label for one scene ("23 Oct 2026" or "11 Oct → 23 Oct 2026"). */
export function formatNisarSceneDate(scene) {
  if (!scene?.start) return '';
  if (scene.referenceStart)
    return `${shortDate(scene.referenceStart, false)} → ${shortDate(scene.start, true)}`;
  return shortDate(scene.start, true);
}

/**
 * Find the outermost opaque pixel on each side of an RGBA raster.
 * @param {Uint8ClampedArray|Uint8Array} rgba Row-major RGBA bytes.
 * @param {number} width
 * @param {number} height
 * @param {number} [alphaThreshold=128]
 * @returns {{top:number[],bottom:number[],left:number[],right:number[]}|null}
 *   Each side is an `[x, y]` pixel, or null when nothing is opaque.
 */
export function findOpaqueExtremes(rgba, width, height, alphaThreshold = 128) {
  let top = null;
  let bottom = null;
  let left = null;
  let right = null;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] < alphaThreshold) continue;
      if (!top) top = [x, y];
      bottom = [x, y];
      if (!left || x < left[0]) left = [x, y];
      if (!right || x > right[0]) right = [x, y];
    }
  }
  return top ? { top, bottom, left, right } : null;
}

/**
 * Recover a north-up browse image's geographic extent from its opaque frame.
 *
 * The rotated radar swath touches the image's left, right, top and bottom
 * with its west-, east-, north- and south-most footprint corners. A linear
 * pixel→degree map per axis through those pairs gives the full image extent.
 * @param {{ width:number, height:number, extremes:object }} image
 * @param {Array<[number, number]>} footprint `[lon, lat]` ring from CMR.
 * @returns {{west:number,south:number,east:number,north:number}|null}
 */
export function fitBrowseExtent({ width, height, extremes }, footprint) {
  if (!extremes || !Array.isArray(footprint) || footprint.length < 3)
    return null;
  const pick = (better) => footprint.reduce((a, b) => (better(b, a) ? b : a));
  const west = pick((a, b) => a[0] < b[0]);
  const east = pick((a, b) => a[0] > b[0]);
  const north = pick((a, b) => a[1] > b[1]);
  const south = pick((a, b) => a[1] < b[1]);
  const spanX = extremes.right[0] - extremes.left[0];
  const spanY = extremes.bottom[1] - extremes.top[1];
  if (spanX < 2 || spanY < 2) return null;
  const lonPerPx = (east[0] - west[0]) / spanX;
  const latPerPx = (north[1] - south[1]) / spanY;
  if (!(lonPerPx > 0) || !(latPerPx > 0)) return null;
  // Pixel edges, not centres: the extent covers the full image area.
  const westEdge = west[0] - lonPerPx * (extremes.left[0] + 0.5);
  const northEdge = north[1] + latPerPx * (extremes.top[1] + 0.5);
  return {
    west: westEdge,
    east: westEdge + lonPerPx * width,
    north: northEdge,
    south: northEdge - latPerPx * height,
  };
}
