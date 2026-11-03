import {
  buildNisarGranuleUrl,
  findOpaqueExtremes,
  fitBrowseExtent,
  normalizeNisarGranules,
} from './model.js';

/** Query CMR for one site's NISAR scenes and validate the reply before use. */
export function createCmrNisarSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getScenes({ product, site, signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        buildNisarGranuleUrl({ product, site }),
        {
          signal,
        },
      );
      if (!response.ok) throw new Error(`CMR HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const scenes = normalizeNisarGranules(payload, { site });
      if (!scenes) throw new Error('Malformed CMR response');
      return scenes;
    },
  };
}

/** Decode an image blob to RGBA pixels in the browser. */
async function decodeBrowserImage(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgba: data };
  } finally {
    bitmap.close();
  }
}

/**
 * Fetch one scene's public browse PNG and georeference it.
 * Resolves `{ blob, extent }` where extent is degrees west/south/east/north.
 */
export function createNisarBrowseLoader({
  fetchImpl = (...args) => globalThis.fetch(...args),
  decodeImpl = decodeBrowserImage,
} = {}) {
  return {
    async load(scene, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(scene.browseUrl, { signal });
      if (!response.ok) throw new Error(`NISAR browse HTTP ${response.status}`);
      // ASF serves the PNG as binary/octet-stream; retype it so the image
      // decoders and the material's object URL treat it as a PNG.
      const blob = new Blob([await response.arrayBuffer()], {
        type: 'image/png',
      });
      signal?.throwIfAborted();
      const { width, height, rgba } = await decodeImpl(blob);
      const extremes = findOpaqueExtremes(rgba, width, height);
      const extent = fitBrowseExtent(
        { width, height, extremes },
        scene.footprint,
      );
      if (!extent) throw new Error('NISAR browse could not be georeferenced');
      return { blob, extent };
    },
  };
}
