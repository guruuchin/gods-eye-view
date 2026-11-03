import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NISAR_PRODUCTS,
  buildNisarGranuleUrl,
  findOpaqueExtremes,
  fitBrowseExtent,
  formatNisarSceneDate,
  nisarSite,
  normalizeNisarGranules,
  parseNisarGranuleName,
} from './model.js';
import { createCmrNisarSource, createNisarBrowseLoader } from './source.js';

const GCOV =
  'NISAR_L2_PR_GCOV_033_169_A_023_2005_DHDH_A_20261023T215501_20261023T215536_P05023_N_F_J_001';
const GUNW =
  'NISAR_L2_PR_GUNW_032_169_A_023_033_2000_SH_20261011T215501_20261011T215536_20261023T215501_20261023T215536_P05023_N_F_J_001';
// CMR footprint of the Oyu Tolgoi GCOV frame above (track 169, frame 023).
const OYU_FOOTPRINT = [
  [108.68896, 41.79376],
  [107.78359, 43.89143],
  [104.68085, 43.09737],
  [105.69727, 41.03005],
  [108.68896, 41.79376],
];

function granule(name, { footprint = OYU_FOOTPRINT, browse = true } = {}) {
  return {
    umm: {
      GranuleUR: name,
      SpatialExtent: {
        HorizontalSpatialDomain: {
          Geometry: {
            GPolygons: [
              {
                Boundary: {
                  Points: footprint.map(([Longitude, Latitude]) => ({
                    Longitude,
                    Latitude,
                  })),
                },
              },
            ],
          },
        },
      },
      RelatedUrls: browse
        ? [
            {
              Type: 'GET DATA',
              URL: `https://nisar.asf.earthdatacloud.nasa.gov/NISAR/x/${name}.h5`,
            },
            {
              Type: 'GET RELATED VISUALIZATION',
              URL: `s3://bucket/${name}_LATLON.png`,
            },
            {
              Type: 'GET RELATED VISUALIZATION',
              URL: `https://nisar.asf.earthdatacloud.nasa.gov/BROWSE/x/${name}_LATLON.png`,
            },
          ]
        : [],
    },
  };
}

test('granule names expose cycle, track, direction and frame', () => {
  assert.deepEqual(parseNisarGranuleName(GCOV), {
    productType: 'GCOV',
    cycle: 33,
    track: 169,
    direction: 'ascending',
    frame: 23,
  });
  assert.equal(parseNisarGranuleName(GUNW).frame, 23);
  assert.equal(parseNisarGranuleName('S1A_IW_GRDH_1SDV_20261023'), null);
});

test('the CMR query targets one product at the site point', () => {
  const url = new URL(
    buildNisarGranuleUrl({
      product: NISAR_PRODUCTS.gunw,
      site: nisarSite('oyu-tolgoi'),
    }),
  );
  assert.equal(
    url.searchParams.get('short_name'),
    'NISAR_L2_GUNW_PROVISIONAL_V1',
  );
  assert.equal(url.searchParams.get('point'), '106.8705,43.0172');
  assert.equal(nisarSite('nowhere').id, 'erdenet');
});

test('scenes keep the busiest frame, drop duplicates and sort oldest first', () => {
  const older = GCOV.replace(/20261023/g, '20261011').replace(
    '_033_169',
    '_032_169',
  );
  const reprocessed = GCOV.replace(/_001$/, '_002');
  const otherFrame = GCOV.replace('_A_023_', '_A_024_');
  const scenes = normalizeNisarGranules({
    items: [
      granule(GCOV),
      granule(otherFrame),
      granule(older),
      granule(reprocessed),
      granule('junk'),
    ],
  });
  assert.deepEqual(
    scenes.map((scene) => scene.id),
    [older, reprocessed],
  );
  assert.equal(scenes[1].start, '2026-10-23T21:55:01Z');
  assert.equal(scenes[1].footprint.length, 4, 'closing vertex is dropped');
  assert.match(scenes[1].browseUrl, /^https:\/\/.*_LATLON\.png$/);
  assert.equal(normalizeNisarGranules({}), null);
  assert.deepEqual(
    normalizeNisarGranules({ items: [granule(GCOV, { browse: false })] }),
    [],
  );
});

test('with a site, a central frame beats a slightly longer edge frame', () => {
  const shift = ([lon, lat]) => [lon + 1.2, lat];
  const edge = (cycle) =>
    granule(
      GCOV.replace('_033_169_A_023_', `_0${cycle}_105_D_067_`).replace(
        /20261023/g,
        `202610${cycle}`,
      ),
      { footprint: OYU_FOOTPRINT.map(shift) },
    );
  const central = (cycle) =>
    granule(
      GCOV.replace('_033_', `_0${cycle}_`).replace(
        /20261023/g,
        `202610${cycle}`,
      ),
    );
  const items = [
    edge(10),
    edge(11),
    edge(12),
    edge(13),
    central(20),
    central(21),
    central(22),
  ];
  const site = nisarSite('oyu-tolgoi');
  assert.equal(
    normalizeNisarGranules({ items })[0].track,
    105,
    'longest series without a site',
  );
  const scenes = normalizeNisarGranules({ items }, { site });
  assert.deepEqual(
    [scenes[0].track, scenes[0].frame, scenes.length],
    [169, 23, 3],
  );
  // A frame with under 75% of the longest series is not eligible.
  const sparse = normalizeNisarGranules(
    { items: [...items.slice(0, 4), central(20), central(21)] },
    { site },
  );
  assert.equal(sparse[0].track, 105);
});

test('interferograms are dated by their secondary acquisition', () => {
  const [scene] = normalizeNisarGranules({ items: [granule(GUNW)] });
  assert.equal(scene.referenceStart, '2026-10-11T21:55:01Z');
  assert.equal(scene.start, '2026-10-23T21:55:01Z');
  assert.equal(formatNisarSceneDate(scene), '11 Oct → 23 Oct 2026');
  assert.equal(
    formatNisarSceneDate({ start: '2026-07-05T00:00:00Z' }),
    '5 Jul 2026',
  );
});

test('opaque extremes find the rotated frame corners', () => {
  const width = 5;
  const height = 4;
  const rgba = new Uint8Array(width * height * 4);
  for (const [x, y] of [
    [2, 0],
    [0, 1],
    [1, 1],
    [4, 2],
    [3, 3],
  ])
    rgba[(y * width + x) * 4 + 3] = 255;
  assert.deepEqual(findOpaqueExtremes(rgba, width, height), {
    top: [2, 0],
    bottom: [3, 3],
    left: [0, 1],
    right: [4, 2],
  });
  assert.equal(findOpaqueExtremes(new Uint8Array(16), 2, 2), null);
});

test('browse extent fit matches the measured Oyu Tolgoi GCOV image', () => {
  // Pixel extremes measured from the real 2004×1973 LATLON browse PNG.
  const extent = fitBrowseExtent(
    {
      width: 2004,
      height: 1973,
      extremes: {
        top: [1482, 146],
        bottom: [558, 1870],
        left: [104, 624],
        right: [1886, 1408],
      },
    },
    OYU_FOOTPRINT.slice(0, 4),
  );
  assert.ok(Math.abs(extent.west - 104.447) < 0.01, `west ${extent.west}`);
  assert.ok(Math.abs(extent.east - 108.954) < 0.01, `east ${extent.east}`);
  assert.ok(Math.abs(extent.north - 44.134) < 0.01, `north ${extent.north}`);
  assert.ok(Math.abs(extent.south - 40.859) < 0.01, `south ${extent.south}`);
  // The corners not used by the fit land close to their footprint vertices.
  const lonAt = (x) =>
    extent.west + ((x + 0.5) / 2004) * (extent.east - extent.west);
  const latAt = (y) =>
    extent.north - ((y + 0.5) / 1973) * (extent.north - extent.south);
  assert.ok(Math.abs(lonAt(1482) - 107.78359) < 0.02);
  assert.ok(Math.abs(latAt(624) - 43.09737) < 0.02);
  assert.equal(
    fitBrowseExtent({ width: 10, height: 10, extremes: null }, OYU_FOOTPRINT),
    null,
  );
});

test('a failed or malformed catalogue reply is never shown as an empty site', async () => {
  const site = nisarSite('erdenet');
  const product = NISAR_PRODUCTS.gcov;
  const failing = createCmrNisarSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(failing.getScenes({ product, site }), /CMR HTTP 503/);
  const malformed = createCmrNisarSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ hits: 3 }) }),
  });
  await assert.rejects(
    malformed.getScenes({ product, site }),
    /Malformed CMR response/,
  );
  const ok = createCmrNisarSource({
    fetchImpl: async (url) => {
      assert.match(url, /short_name=NISAR_L2_GCOV_PROVISIONAL_V1/);
      return { ok: true, json: async () => ({ items: [granule(GCOV)] }) };
    },
  });
  assert.equal((await ok.getScenes({ product, site })).length, 1);
});

test('the browse loader georeferences the decoded image', async () => {
  const [scene] = normalizeNisarGranules({ items: [granule(GCOV)] });
  const loader = createNisarBrowseLoader({
    fetchImpl: async (url) => {
      assert.equal(url, scene.browseUrl);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    decodeImpl: async () => {
      const width = 4;
      const height = 4;
      const rgba = new Uint8Array(width * height * 4);
      for (const [x, y] of [
        [2, 0],
        [0, 1],
        [3, 2],
        [1, 3],
      ])
        rgba[(y * width + x) * 4 + 3] = 255;
      return { width, height, rgba };
    },
  });
  const { blob, extent } = await loader.load(scene);
  assert.equal(blob.type, 'image/png');
  assert.ok(extent.west < 104.69 && extent.east > 108.68);
  const failing = createNisarBrowseLoader({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  await assert.rejects(failing.load(scene), /browse HTTP 404/);
});
