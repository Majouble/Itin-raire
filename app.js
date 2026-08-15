/* ==========================================================================
   Accessibilité crue Seine — widget Grist
   Calcule, pour chaque collègue (table Grist), si un itinéraire routier
   existe vers le lieu de travail en évitant une zone de crue (GeoJSON),
   via l'API OpenRouteService (avoid_polygons).

   Schéma de table Grist attendu (voir README.md) :
     Nom, Adresse, Latitude, Longitude, Accessible, Distance_km, Duree_min, Statut
   ========================================================================== */

const STORAGE_KEY = 'crue-seine-widget-config';

const state = {
  config: {
    orsKey: '',
    workAddress: '',
    workCoords: null, // [lon, lat]
    profile: 'driving-car',
    simplifyFlood: false,
  },
  floodGeometry: null, // GeoJSON geometry (Polygon/MultiPolygon) or null
  rows: [], // records from Grist: {id, Nom, Adresse, Latitude, Longitude, ...}
  map: null,
  floodLayer: null,
  routeLayers: [],
  markerLayer: null,
  running: false,
};

/* ---------------------------- Config persistence ------------------------ */

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state.config, JSON.parse(raw));
  } catch (e) {
    console.warn('Config invalide en localStorage, ignorée.', e);
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
}

function applyConfigToForm() {
  document.getElementById('ors-key').value = state.config.orsKey || '';
  document.getElementById('work-address').value = state.config.workAddress || '';
  document.getElementById('profile').value = state.config.profile || 'driving-car';
  if (state.config.workCoords) {
    document.getElementById('work-coords').textContent =
      `✓ ${state.config.workCoords[1].toFixed(5)}, ${state.config.workCoords[0].toFixed(5)}`;
  }
  updateRunButtonState();
}

/* --------------------------------- Map ----------------------------------- */

function initMap() {
  state.map = L.map('map').setView([48.8566, 2.3522], 11); // Paris par défaut
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);
}

function drawFloodZone(geometry) {
  if (state.floodLayer) {
    state.map.removeLayer(state.floodLayer);
    state.floodLayer = null;
  }
  if (!geometry) return;
  state.floodLayer = L.geoJSON(geometry, {
    style: { color: '#1d4ed8', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.35 },
  }).addTo(state.map);
  try {
    state.map.fitBounds(state.floodLayer.getBounds(), { padding: [20, 20] });
  } catch (e) {
    /* geometry vide ou invalide pour fitBounds */
  }
}

function clearRouteLayers() {
  state.routeLayers.forEach((l) => state.map.removeLayer(l));
  state.routeLayers = [];
  state.markerLayer.clearLayers();
}

function drawRoute(routeGeoJSONGeometry, accessible) {
  const layer = L.geoJSON(routeGeoJSONGeometry, {
    style: { color: accessible ? '#16a34a' : '#dc2626', weight: 3, opacity: 0.8 },
  }).addTo(state.map);
  state.routeLayers.push(layer);
}

function drawHomeMarker(lon, lat, name, accessible) {
  const marker = L.circleMarker([lat, lon], {
    radius: 6,
    color: accessible ? '#16a34a' : '#dc2626',
    fillColor: accessible ? '#16a34a' : '#dc2626',
    fillOpacity: 0.9,
  }).bindTooltip(name);
  marker.addTo(state.markerLayer);
}

/* ------------------------------ Geocodage -------------------------------- */

async function geocodeAddress(address) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Géocodage HTTP ${res.status}`);
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) throw new Error("Adresse introuvable");
  const [lon, lat] = feature.geometry.coordinates;
  return { lon, lat, score: feature.properties.score };
}

/* ------------------------------ Zone de crue ------------------------------ */

function extractPolygonGeometry(geojson) {
  // Accepte FeatureCollection, Feature, ou Geometry brute.
  // Combine tous les polygones/multipolygones trouvés en un seul MultiPolygon.
  let features = [];
  if (geojson.type === 'FeatureCollection') features = geojson.features;
  else if (geojson.type === 'Feature') features = [geojson];
  else if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
    features = [{ type: 'Feature', geometry: geojson, properties: {} }];
  } else {
    throw new Error('Type GeoJSON non pris en charge : ' + geojson.type);
  }

  const polygons = [];
  for (const f of features) {
    if (!f.geometry) continue;
    if (f.geometry.type === 'Polygon') {
      polygons.push(f.geometry.coordinates);
    } else if (f.geometry.type === 'MultiPolygon') {
      polygons.push(...f.geometry.coordinates);
    }
  }
  if (polygons.length === 0) {
    throw new Error('Aucun polygone trouvé dans le fichier (attendu: Polygon/MultiPolygon).');
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}

function describeGeometry(geometry) {
  const areaKm2 = turf.area(geometry) / 1e6;
  let vertices = 0;
  geometry.coordinates.forEach((poly) => poly.forEach((ring) => (vertices += ring.length)));
  return { areaKm2, vertices };
}

async function handleFloodFile(file) {
  const statusEl = document.getElementById('flood-status');
  statusEl.textContent = 'Lecture du fichier...';
  statusEl.className = 'coords-display';
  try {
    const text = await file.text();
    const geojson = JSON.parse(text);
    let geometry = extractPolygonGeometry(geojson);

    if (state.config.simplifyFlood) {
      geometry = turf.simplify(geometry, { tolerance: 0.0008, highQuality: false });
    }

    const { areaKm2, vertices } = describeGeometry(geometry);
    state.floodGeometry = geometry;
    drawFloodZone(geometry);

    let msg = `✓ ${vertices} sommets, ~${areaKm2.toFixed(1)} km²`;
    statusEl.className = 'coords-display';
    if (areaKm2 > 190) {
      msg += ' ⚠ zone volumineuse : OpenRouteService peut refuser (limite ~200 km² sur l\'API publique).';
      statusEl.className = 'coords-display status-error';
    }
    statusEl.textContent = msg;
  } catch (e) {
    statusEl.textContent = 'Erreur : ' + e.message;
    statusEl.className = 'coords-display status-blocked';
    state.floodGeometry = null;
  }
  updateRunButtonState();
}

/* ------------------------------- Itinéraires ------------------------------ */

async function computeRoute(fromLonLat, toLonLat) {
  const url = `https://api.openrouteservice.org/v2/directions/${state.config.profile}/geojson`;
  const body = {
    coordinates: [fromLonLat, toLonLat],
  };
  if (state.floodGeometry) {
    body.options = { avoid_polygons: state.floodGeometry };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: state.config.orsKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message = (data && data.error && (data.error.message || JSON.stringify(data.error))) || `HTTP ${res.status}`;
    throw new Error(message);
  }

  const feature = data.features && data.features[0];
  if (!feature) throw new Error('Réponse ORS sans itinéraire.');
  const summary = feature.properties.summary;
  return {
    distanceKm: summary.distance / 1000,
    durationMin: summary.duration / 60,
    geometry: feature.geometry,
  };
}

/* --------------------------------- Grist ---------------------------------- */

function initGrist() {
  grist.ready({ requiredAccess: 'full' });
  grist.onRecords((records) => {
    state.rows = records;
    renderResultsTable();
    updateRunButtonState();
  });
}

async function writeRowResult(rowId, fields) {
  try {
    await grist.selectedTable.update({ id: rowId, fields });
  } catch (e) {
    console.error('Échec écriture Grist pour la ligne', rowId, e);
  }
}

/* ------------------------------ Résultats UI ------------------------------- */

function statusCellClass(row) {
  if (row.Accessible === true) return 'status-ok';
  if (row.Accessible === false) return 'status-blocked';
  if (row.Statut) return 'status-error';
  return 'status-pending';
}

function renderResultsTable() {
  const tbody = document.getElementById('results-body');
  tbody.innerHTML = '';
  for (const row of state.rows) {
    const tr = document.createElement('tr');
    const statusText =
      row.Accessible === true ? 'Accessible' :
      row.Accessible === false ? 'Bloqué' :
      (row.Statut || 'En attente');
    tr.innerHTML = `
      <td>${escapeHtml(row.Nom || '')}</td>
      <td>${escapeHtml(row.Adresse || '')}</td>
      <td class="${statusCellClass(row)}">${escapeHtml(statusText)}</td>
      <td>${row.Distance_km ? row.Distance_km.toFixed(1) + ' km' : ''}</td>
      <td>${row.Duree_min ? Math.round(row.Duree_min) + ' min' : ''}</td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------- Orchestration ------------------------------ */

function updateRunButtonState() {
  const ready = !!state.config.orsKey && !!state.config.workCoords && state.rows.length > 0 && !state.running;
  document.getElementById('run-calc').disabled = !ready;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCalculation() {
  if (state.running) return;
  state.running = true;
  updateRunButtonState();
  clearRouteLayers();

  const progressWrap = document.getElementById('progress-bar-wrap');
  const progressBar = document.getElementById('progress-bar');
  const runStatus = document.getElementById('run-status');
  progressWrap.hidden = false;

  const total = state.rows.length;
  let done = 0;

  for (const row of state.rows) {
    runStatus.textContent = `Traitement : ${row.Nom || row.Adresse || row.id}...`;

    // Portée large : reste disponible dans le catch même si l'échec survient
    // après le géocodage (cas le plus courant : itinéraire bloqué par la crue).
    let lon = row.Longitude;
    let lat = row.Latitude;

    try {
      // 1. Géocodage (avec cache sur les colonnes Latitude/Longitude)
      if (!lon || !lat) {
        const geo = await geocodeAddress(row.Adresse);
        lon = geo.lon;
        lat = geo.lat;
        await writeRowResult(row.id, { Latitude: lat, Longitude: lon });
        Object.assign(row, { Latitude: lat, Longitude: lon });
      }

      // 2. Calcul d'itinéraire en évitant la zone de crue
      const route = await computeRoute([lon, lat], state.config.workCoords);

      await writeRowResult(row.id, {
        Accessible: true,
        Distance_km: route.distanceKm,
        Duree_min: route.durationMin,
        Statut: '',
      });
      Object.assign(row, {
        Accessible: true, Distance_km: route.distanceKm, Duree_min: route.durationMin, Statut: '',
      });

      drawRoute(route.geometry, true);
      drawHomeMarker(lon, lat, row.Nom || row.Adresse, true);
    } catch (e) {
      await writeRowResult(row.id, {
        Accessible: false,
        Distance_km: null,
        Duree_min: null,
        Statut: e.message,
      });
      Object.assign(row, { Accessible: false, Distance_km: null, Duree_min: null, Statut: e.message });

      if (lon && lat) {
        drawHomeMarker(lon, lat, row.Nom || row.Adresse, false);
      }
    }

    done += 1;
    progressBar.style.width = `${Math.round((done / total) * 100)}%`;
    renderResultsTable();

    // Respecte les limites de débit de l'API publique ORS.
    await sleep(1200);
  }

  runStatus.textContent = `Terminé : ${done}/${total} collègues traités.`;
  progressWrap.hidden = true;
  state.running = false;
  updateRunButtonState();
}

/* ---------------------------------- Init ------------------------------------ */

function wireUpUI() {
  document.getElementById('toggle-config').addEventListener('click', () => {
    const body = document.getElementById('config-body');
    body.hidden = !body.hidden;
  });

  document.getElementById('geocode-work').addEventListener('click', async () => {
    const address = document.getElementById('work-address').value.trim();
    const coordsEl = document.getElementById('work-coords');
    if (!address) return;
    coordsEl.textContent = 'Géocodage...';
    coordsEl.className = 'coords-display';
    try {
      const geo = await geocodeAddress(address);
      state.config.workCoords = [geo.lon, geo.lat];
      state.config.workAddress = address;
      coordsEl.textContent = `✓ ${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} (confiance ${(geo.score * 100).toFixed(0)}%)`;
      state.map.setView([geo.lat, geo.lon], 12);
      L.marker([geo.lat, geo.lon]).addTo(state.map).bindPopup('Lieu de travail').openPopup();
      updateRunButtonState();
    } catch (e) {
      coordsEl.textContent = 'Erreur : ' + e.message;
      coordsEl.className = 'coords-display status-blocked';
    }
  });

  document.getElementById('flood-file').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (file) handleFloodFile(file);
  });

  document.getElementById('save-config').addEventListener('click', () => {
    state.config.orsKey = document.getElementById('ors-key').value.trim();
    state.config.profile = document.getElementById('profile').value;
    saveConfig();
    updateRunButtonState();
    document.getElementById('config-body').hidden = true;
  });

  document.getElementById('run-calc').addEventListener('click', runCalculation);
}

function main() {
  loadConfig();
  initMap();
  wireUpUI();
  applyConfigToForm();
  initGrist();
}

document.addEventListener('DOMContentLoaded', main);
