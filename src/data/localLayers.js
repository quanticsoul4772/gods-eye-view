import { localGeoJsonServices } from './localGeojson.js';
import { createInfrastructureLayers } from './infrastructure.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import submarineCablesLayer from './telegeographySubmarineCables.js';

const [datacenters, dams] = createInfrastructureLayers(localGeoJsonServices);

// Live NASA FIRMS fires via the /api/firms proxy (keyed API with
// FIRMS_MAP_KEY, else NASA's public 24 h files from the source directory).
// The id keeps the historical `local-` prefix for persistence +
// voice-tool-enum compat, but the data is NOT bundled anymore.
const fires = createFirmsHeatmapLayer({
  id: 'local-firms',
  name: 'FIRMS Active Fires',
  icon: '▲',
  source: 'NASA FIRMS · LIVE',
});

export default [datacenters, dams, submarineCablesLayer, fires];
