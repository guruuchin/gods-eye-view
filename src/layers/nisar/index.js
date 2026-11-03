import * as Cesium from 'cesium';
import {
  NISAR_DEFAULT_PRODUCT_ID,
  NISAR_DEFAULT_SITE_ID,
  NISAR_PRODUCTS,
  NISAR_SITES,
  formatNisarSceneDate,
  nisarProduct,
  nisarSite,
} from './model.js';
export * from './model.js';
export { createCmrNisarSource, createNisarBrowseLoader } from './source.js';

const FOOTPRINT_COLOR = Cesium.Color.fromCssColorString('#4dd0e1');
const SITE_COLOR = Cesium.Color.fromCssColorString('#ffb300');
const IMAGE_ALPHA = 0.85;
// Browse PNGs are 2–4 MB; a handful of decoded scenes keeps stepping instant
// without holding a whole time series in memory.
const BROWSE_CACHE_LIMIT = 6;

/**
 * Own the NISAR radar change display: site pins, the selected frame's
 * footprint, and the selected scene's browse image draped on the ground.
 * Row chips pick the site, the product and step through time.
 */
export function createNisarLayer({
  source,
  browseLoader,
  requestRender = () => {},
} = {}) {
  if (typeof source?.getScenes !== 'function')
    throw new TypeError('NISAR requires a scene source');
  if (typeof browseLoader?.load !== 'function')
    throw new TypeError('NISAR requires a browse loader');

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    siteId: NISAR_DEFAULT_SITE_ID,
    productId: NISAR_DEFAULT_PRODUCT_ID,
    scenes: [],
    scenesKey: null,
    index: -1,
    shownSceneId: null,
    catalogRequest: null,
    browseRequest: null,
    browseCache: new Map(),
    status: 'idle',
    error: null,
    lastUpdate: null,
    flyOnNextLoad: false,
    listener: null,
  };

  const notify = () => {
    state.listener?.();
    requestRender('nisar');
  };

  const currentScene = () => state.scenes[state.index] || null;
  const catalogKey = () => `${state.siteId}|${state.productId}`;

  function addSitePins() {
    for (const site of NISAR_SITES) {
      state.dataSource.entities.add({
        id: `nisar:site:${site.id}`,
        position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat),
        point: {
          pixelSize: 9,
          color: SITE_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: site.name,
          font: '13px sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            3_000_000,
          ),
        },
        properties: { site: site.id, focus: site.focus },
      });
    }
  }

  function clearScene() {
    state.dataSource?.entities.removeById('nisar:footprint');
    state.dataSource?.entities.removeById('nisar:image');
    state.shownSceneId = null;
  }

  function showScene(scene, browse) {
    clearScene();
    const ring = scene.footprint.flatMap(([lon, lat]) => [lon, lat]);
    ring.push(scene.footprint[0][0], scene.footprint[0][1]);
    state.dataSource.entities.add({
      id: 'nisar:footprint',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(ring),
        width: 2,
        material: FOOTPRINT_COLOR,
        clampToGround: true,
      },
    });
    if (browse) {
      const { west, south, east, north } = browse.extent;
      state.dataSource.entities.add({
        id: 'nisar:image',
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
          material: new Cesium.ImageMaterialProperty({
            image: browse.objectUrl,
            transparent: true,
            color: Cesium.Color.WHITE.withAlpha(IMAGE_ALPHA),
          }),
          classificationType: Cesium.ClassificationType.BOTH,
        },
        properties: {
          scene: scene.id,
          date: formatNisarSceneDate(scene),
          track: scene.track,
          frame: scene.frame,
        },
      });
    }
    state.shownSceneId = scene.id;
  }

  function flyToSite() {
    const viewer = state.viewer;
    if (!viewer || viewer.trackedEntity) return;
    const site = nisarSite(state.siteId);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        site.lon,
        site.lat - 0.25,
        site.viewHeightM,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
      duration: 2.5,
    });
  }

  function cacheBrowse(sceneId, browse) {
    state.browseCache.set(sceneId, browse);
    for (const [id, entry] of state.browseCache) {
      if (state.browseCache.size <= BROWSE_CACHE_LIMIT) break;
      // Never revoke the URL the ground material is drawing from.
      if (id === state.shownSceneId || id === sceneId) continue;
      state.browseCache.delete(id);
      URL.revokeObjectURL(entry.objectUrl);
    }
  }

  async function presentCurrentScene() {
    const scene = currentScene();
    state.browseRequest?.abort();
    state.browseRequest = null;
    if (!scene) {
      clearScene();
      notify();
      return;
    }
    const cached = state.browseCache.get(scene.id);
    if (cached) {
      showScene(scene, cached);
      state.status = 'ready';
      notify();
      return;
    }
    // Footprint first so the step reads immediately; the image follows.
    showScene(scene, null);
    state.status = 'loading';
    notify();
    const request = new AbortController();
    state.browseRequest = request;
    try {
      const { blob, extent } = await browseLoader.load(scene, {
        signal: request.signal,
      });
      if (request.signal.aborted || state.browseRequest !== request) return;
      const browse = { objectUrl: URL.createObjectURL(blob), extent };
      cacheBrowse(scene.id, browse);
      if (currentScene()?.id === scene.id && state.enabled)
        showScene(scene, browse);
      state.status = 'ready';
      state.error = null;
    } catch (error) {
      if (request.signal.aborted || state.browseRequest !== request) return;
      console.warn('[Data:NISAR] Browse error:', error);
      state.status = 'error';
      state.error = error?.message || 'NISAR browse unavailable';
    } finally {
      if (state.browseRequest === request) state.browseRequest = null;
    }
    notify();
  }

  async function loadCatalog({ signal } = {}) {
    const key = catalogKey();
    state.catalogRequest?.abort();
    const request = new AbortController();
    state.catalogRequest = request;
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    const keepSceneId = state.scenesKey === key ? currentScene()?.id : null;
    state.status = 'loading';
    notify();
    try {
      const scenes = await source.getScenes({
        product: nisarProduct(state.productId),
        site: nisarSite(state.siteId),
        signal: request.signal,
      });
      if (
        request.signal.aborted ||
        state.catalogRequest !== request ||
        !state.enabled
      )
        return false;
      state.scenes = scenes;
      state.scenesKey = key;
      const kept = keepSceneId
        ? scenes.findIndex((s) => s.id === keepSceneId)
        : -1;
      state.index = kept >= 0 ? kept : scenes.length - 1;
      state.lastUpdate = Date.now();
      state.error = scenes.length
        ? null
        : 'No NISAR scenes cover this site yet';
      console.log(
        `[Data:NISAR] ${scenes.length} ${state.productId} scenes for ${state.siteId}`,
      );
      if (state.flyOnNextLoad) {
        state.flyOnNextLoad = false;
        flyToSite();
      }
      await presentCurrentScene();
      return true;
    } catch (error) {
      if (request.signal.aborted || state.catalogRequest !== request)
        return false;
      console.warn('[Data:NISAR] Catalog error:', error);
      state.status = 'error';
      state.error = error?.message || 'NISAR catalog unavailable';
      notify();
      return false;
    } finally {
      if (state.catalogRequest === request) state.catalogRequest = null;
    }
  }

  function selectSite(siteId) {
    if (!state.enabled || siteId === state.siteId) return flyToSite();
    state.siteId = siteId;
    state.scenes = [];
    state.index = -1;
    clearScene();
    state.flyOnNextLoad = true;
    loadCatalog();
  }

  function selectProduct(productId) {
    if (!state.enabled || productId === state.productId) return;
    state.productId = productId;
    state.scenes = [];
    state.index = -1;
    clearScene();
    loadCatalog();
  }

  function step(delta) {
    const next = state.index + delta;
    if (!state.enabled || next < 0 || next >= state.scenes.length) return;
    state.index = next;
    presentCurrentScene();
  }

  return {
    id: 'nisar',
    name: 'NISAR Radar Change',
    icon: '📡',
    source: 'NASA-ISRO NISAR · ASF DAAC',
    // New frames arrive every 12 days; an hourly catalog check is plenty.
    updateInterval: 3_600_000,

    init(viewer) {
      if (state.viewer) throw new Error('NISAR layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource('nisar');
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      addSitePins();
      console.log('[Data:NISAR] Initialized');
    },

    enable() {
      state.enabled = true;
      state.flyOnNextLoad = true;
      if (state.dataSource) state.dataSource.show = true;
    },

    disable() {
      state.catalogRequest?.abort();
      state.browseRequest?.abort();
      state.enabled = false;
      state.flyOnNextLoad = false;
      if (state.dataSource) state.dataSource.show = false;
      requestRender('nisar');
    },

    async update(viewer, { signal } = {}) {
      if (!state.enabled || !state.dataSource) return false;
      return loadCatalog({ signal });
    },

    destroy(viewer = state.viewer) {
      state.catalogRequest?.abort();
      state.browseRequest?.abort();
      state.enabled = false;
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      for (const browse of state.browseCache.values())
        URL.revokeObjectURL(browse.objectUrl);
      state.browseCache.clear();
      state.dataSource = null;
      state.viewer = null;
      state.scenes = [];
      state.scenesKey = null;
      state.index = -1;
      state.shownSceneId = null;
      state.status = 'idle';
      state.error = null;
      state.lastUpdate = null;
    },

    getRowControls() {
      const scene = currentScene();
      const busy = state.status === 'loading';
      const product = nisarProduct(state.productId);
      return {
        chips: [
          ...NISAR_SITES.map((site) => ({
            id: `site-${site.id}`,
            label: site.label,
            title: `${site.name} — ${site.focus}`,
            active: site.id === state.siteId,
            onClick: () => selectSite(site.id),
          })),
          ...Object.values(NISAR_PRODUCTS).map((entry) => ({
            id: `product-${entry.id}`,
            label: entry.label,
            title: entry.title,
            active: entry.id === state.productId,
            onClick: () => selectProduct(entry.id),
          })),
          {
            id: 'older',
            label: '◀ OLDER',
            title: 'Previous 12-day acquisition on this frame',
            disabled: state.index <= 0,
            onClick: () => step(-1),
          },
          {
            id: 'newer',
            label: 'NEWER ▶',
            title: 'Next 12-day acquisition on this frame',
            disabled: state.index < 0 || state.index >= state.scenes.length - 1,
            onClick: () => step(1),
          },
        ],
        legend: scene
          ? [
              {
                label: `${product.label} ${formatNisarSceneDate(scene)} · track ${scene.track} frame ${scene.frame} · scene`,
                color: FOOTPRINT_COLOR.toCssColorString(),
                count: state.index + 1,
                blurb: `${product.title}${busy ? ' Loading…' : ''}${state.error ? ` (${state.error})` : ''}`,
              },
            ]
          : [],
      };
    },

    setRowControlsListener(listener) {
      state.listener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const scene = currentScene();
      return {
        count: state.scenes.length,
        countLabel: scene
          ? `${state.index + 1}/${state.scenes.length} · ${formatNisarSceneDate(scene)}`
          : '',
        lastUpdate: state.lastUpdate,
        loading: state.status === 'loading',
        error: state.error,
      };
    },
  };
}
