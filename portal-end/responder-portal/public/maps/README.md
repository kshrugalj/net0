# Local Atlanta map

atlanta.geojson contains real OpenStreetMap ways (roads, buildings and parks), fetched September 26, 2026 via https://overpass.kumi.systems/api/interpreter.

Query: [out:json][timeout:45];(way["highway"](33.75,-84.405,33.79,-84.365);way["building"](33.75,-84.405,33.79,-84.365);way["leisure"="park"](33.75,-84.405,33.79,-84.365););out geom;

Each way's supplied geometry was converted to GeoJSON; closed building/park ways become polygons. Only name, highway, building, leisure and OSM way ID are retained. Multipolygon relations are not included. This is a bounded geographic extract, not a global basemap or authoritative emergency routing dataset.

© OpenStreetMap contributors. Data licensed under ODbL 1.0: https://www.openstreetmap.org/copyright and https://opendatacommons.org/licenses/odbl/1-0/ . Preserve attribution and applicable license obligations when redistributing this extract.

Vite copies these files into the production build. `atlanta-static.svg` is the presentation snapshot used by the responder portal: buildings are intentionally limited to the left side, while a restrained set of roads and street labels is baked into both halves; the remaining right-side background stays black. `atlanta.geojson` remains a data-only source for local street routing and is not rendered at runtime. No public tile server, fonts or geocoding service is used at runtime; the local application server must remain reachable, and no service worker/installable offline cache is implemented.

Incident coordinates remain development mock data from mockIncidents.ts. Device positions are separately and explicitly mocked in mockDeviceCoordinates.ts; they are not OSM features or surveyed hardware locations. The selected report path is recorded mock routing information, not proof of current successful delivery. Offline devices de-emphasize links; no alternate route is invented.
