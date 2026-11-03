import {
  createNisarLayer as createLayer,
  createCmrNisarSource,
  createNisarBrowseLoader,
} from '../layers/nisar/index.js';
import { governorRequestRender } from '../renderGovernor.js';
export * from '../layers/nisar/index.js';
/** Wire the CMR catalogue, browse loader and render governor. */
export function createNisarLayer({
  source = createCmrNisarSource(),
  browseLoader = createNisarBrowseLoader(),
  requestRender = governorRequestRender,
} = {}) {
  return createLayer({ source, browseLoader, requestRender });
}
export default createNisarLayer();
