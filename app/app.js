(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    map: null,
    globe: null,
    globeOn: false,
    config: null,
    bundle: {},
    layers: {},
    weatherLayers: {},
    selected: null,
    watchlists: [],
  };

  const layerDefaults = {
    flights: true,
    ais: false,
    satellites: true,
    earthquakes: true,
    naturalEvents: true,
    weatherRadar: true,
    weatherTemp: false,
    weatherWind: false,
    trainStations: true,
    trainLines: true,
    busStops: false,
    transitVehicles: false,
    trafficIncidents: false,
    cameras: false,
    custom: false,
  };

  function activeLayers() {
    const layers = { ...layerDefaults };
    document.querySelectorAll('[data-layer]').forEach((el) => {
      layers[el.dataset.layer] = el.checked;
    });
    return layers;
  }

  function initMap() {
    state.map = L.map('map', { zoomControl: true }).setView([38.9072, -77.0369], 10);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(state.map);

    state.layers.trainLines = L.layerGroup().addTo(state.map);
    state.layers.trainStations = L.layerGroup().addTo(state.map);
    state.layers.busStops = L.layerGroup().addTo(state.map);
    state.layers.transitVehicles = L.layerGroup().addTo(state.map);
    state.layers.flights = L.layerGroup().addTo(state.map);
    state.layers.ais = L.layerGroup().addTo(state.map);
    state.layers.earthquakes = L.layerGroup().addTo(state.map);
    state.layers.naturalEvents = L.layerGroup().addTo(state.map);
    state.layers.trafficIncidents = L.layerGroup().addTo(state.map);
    state.layers.cameras = L.layerGroup().addTo(state.map);
    state.layers.custom = L.layerGroup().addTo(state.map);

    state.weatherLayers.weatherRadar = L.tileLayer('https://tilecache.rainviewer.com/v2/radar/nowcast_0/256/{z}/{x}/{y}/2/1_1.png', { opacity: 0.55 });
    state.weatherLayers.weatherTemp = L.tileLayer('https://maps.openweathermap.org/maps/2.0/weather/TA2/{z}/{x}/{y}?appid=demo', { opacity: 0.45 });
    state.weatherLayers.weatherWind = L.tileLayer('https://maps.openweathermap.org/maps/2.0/weather/WND/{z}/{x}/{y}?appid=demo', { opacity: 0.45 });
    state.weatherLayers.weatherRadar.addTo(state.map);

    state.map.on('moveend zoomend', debounce(refreshLayers, 350));
    state.map.on('click', async (e) => {
      try {
        const weather = await api(`/api/weather/point?lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
        showSelected({
          title: 'Weather point',
          type: 'weather',
          lat: e.latlng.lat,
          lon: e.latlng.lng,
          meta: [
            `Temp ${weather.current?.temperature_2m}°`,
            `Wind ${weather.current?.wind_speed_10m}`,
            `Humidity ${weather.current?.relative_humidity_2m}%`,
            `Code ${weather.current?.weather_code}`,
          ].join(' | '),
        });
      } catch {}
    });
  }

  function initGlobe() {
    state.globe = new Cesium.Viewer('globe', {
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrain: Cesium.Terrain.fromWorldTerrain(),
    });
    state.globe.scene.globe.enableLighting = true;
    state.globe.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-77.0369, 38.9072, 3500000) });
  }

  function setGlobe(on) {
    state.globeOn = on;
    $('map').classList.toggle('hidden', on);
    $('globe').classList.toggle('hidden', !on);
    $('globeBtn').textContent = on ? 'Map' : 'Globe';
    if (on) renderSatellitesOnGlobe();
  }

  function bbox() {
    const b = state.map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function markerIcon(color, label = '') {
    return L.divIcon({
      className: 'custom-div-icon',
      html: `<div style="background:${color};color:#fff;border-radius:10px;padding:2px 6px;font:600 10px/1 Inter,Arial;border:1px solid rgba(255,255,255,.35);box-shadow:0 2px 8px rgba(0,0,0,.25)">${label}</div>`,
      iconSize: [28, 18],
      iconAnchor: [14, 9],
    });
  }

  function clearLeafletLayers() {
    Object.values(state.layers).forEach((g) => g.clearLayers());
  }

  function renderBundle() {
    clearLeafletLayers();
    toggleWeather();
    renderTrainLines(state.bundle.trainLines || []);
    renderNamedPoints('trainStations', state.bundle.trainStations || [], '#8b5cf6', 'RAI');
    renderNamedPoints('busStops', state.bundle.busStops || [], '#f59e0b', 'BUS');
    renderVehicles('transitVehicles', state.bundle.transitVehicles || [], '#ef4444');
    renderFlights(state.bundle.flights || []);
    renderShips(state.bundle.ais || []);
    renderEvents('earthquakes', state.bundle.earthquakes || [], '#22c55e');
    renderEvents('naturalEvents', state.bundle.naturalEvents || [], '#06b6d4');
    renderNamedPoints('trafficIncidents', state.bundle.trafficIncidents || [], '#dc2626', 'TRF');
    renderNamedPoints('cameras', state.bundle.cameras || [], '#64748b', 'CAM');
    renderCustom(state.bundle.custom);
    updateSummary();
    renderSatellitesOnGlobe();
  }

  function renderTrainLines(lines) {
    for (const line of lines) {
      if (!Array.isArray(line.geometry) || !line.geometry.length) continue;
      L.polyline(line.geometry, { color: '#c084fc', weight: 3, opacity: 0.7 })
        .bindPopup(`<strong>${escapeHtml(line.name || 'Rail Line')}</strong>`)
        .addTo(state.layers.trainLines);
    }
  }

  function renderNamedPoints(layerName, rows, color, label) {
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      const name = row.name || row.title || row.label || layerName;
      const marker = L.marker([row.lat, row.lon], { icon: markerIcon(color, label) });
      marker.bindPopup(`<strong>${escapeHtml(name)}</strong>${row.meta ? `<br>${escapeHtml(row.meta)}` : ''}`);
      marker.on('click', () => showSelected({ title: name, type: layerName, lat: row.lat, lon: row.lon, meta: row.meta || '' }));
      marker.addTo(state.layers[layerName]);
    }
  }

  function renderVehicles(layerName, rows, color) {
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      const marker = L.circleMarker([row.lat, row.lon], { radius: 6, color, weight: 2, fillOpacity: 0.7 });
      const title = row.label || row.route_id || row.name || 'Vehicle';
      marker.bindPopup(`<strong>${escapeHtml(title)}</strong><br>${escapeHtml(row.trip_id || '')}`);
      marker.on('click', () => showSelected({ title, type: layerName, lat: row.lat, lon: row.lon, meta: `Trip ${row.trip_id || 'n/a'} | Feed ${row.feedName || ''}` }));
      marker.addTo(state.layers[layerName]);
      if (row.heading != null) {
        const p2 = destination(row.lat, row.lon, row.heading, 0.5);
        L.polyline([[row.lat, row.lon], [p2.lat, p2.lon]], { color, weight: 2 }).addTo(state.layers[layerName]);
      }
    }
  }

  function renderFlights(rows) {
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      const marker = L.circleMarker([row.lat, row.lon], { radius: 5, color: '#60a5fa', weight: 2, fillOpacity: 0.8 });
      const title = row.callsign || row.id || 'Flight';
      marker.bindPopup(`<strong>${escapeHtml(title)}</strong><br>Alt ${fmt(row.altitude)} m<br>Speed ${fmt(row.speed)} m/s`);
      marker.on('click', () => showSelected({ title, type: 'flight', lat: row.lat, lon: row.lon, meta: `Country ${row.country || 'n/a'} | Alt ${fmt(row.altitude)} m | Speed ${fmt(row.speed)} m/s | Heading ${fmt(row.heading)}°` }));
      marker.addTo(state.layers.flights);
      if (row.heading != null) {
        const p2 = destination(row.lat, row.lon, row.heading, 6);
        L.polyline([[row.lat, row.lon], [p2.lat, p2.lon]], { color: '#60a5fa', weight: 2, opacity: 0.6 }).addTo(state.layers.flights);
      }
    }
  }

  function renderShips(rows) {
    for (const row of rows) {
      const lat = row.lat ?? row.latitude;
      const lon = row.lon ?? row.longitude;
      if (lat == null || lon == null) continue;
      const heading = row.heading ?? row.cog ?? row.course;
      const speed = row.speed ?? row.sog;
      const title = row.name || row.mmsi || 'Vessel';
      const marker = L.circleMarker([lat, lon], { radius: 5, color: '#14b8a6', weight: 2, fillOpacity: 0.8 });
      marker.bindPopup(`<strong>${escapeHtml(title)}</strong><br>Speed ${fmt(speed)} kn<br>Heading ${fmt(heading)}°`);
      marker.on('click', () => showSelected({ title, type: 'ship', lat, lon, meta: `Speed ${fmt(speed)} kn | Heading ${fmt(heading)}° | Destination ${row.destination || 'n/a'}` }));
      marker.addTo(state.layers.ais);
      if (heading != null) {
        const p2 = destination(lat, lon, heading, 8);
        L.polyline([[lat, lon], [p2.lat, p2.lon]], { color: '#14b8a6', weight: 2, opacity: 0.6 }).addTo(state.layers.ais);
      }
    }
  }

  function renderEvents(layerName, rows, color) {
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      const marker = L.circleMarker([row.lat, row.lon], { radius: 6, color, weight: 2, fillOpacity: 0.45 });
      const title = row.title || row.name || layerName;
      marker.bindPopup(`<strong>${escapeHtml(title)}</strong>`);
      marker.on('click', () => showSelected({ title, type: layerName, lat: row.lat, lon: row.lon, meta: Object.entries(row).filter(([k,v]) => !['lat','lon','title','name','type','id'].includes(k) && v != null).map(([k,v]) => `${k}: ${v}`).join(' | ') }));
      marker.addTo(state.layers[layerName]);
    }
  }

  function renderCustom(data) {
    if (!data) return;
    if (Array.isArray(data)) return renderNamedPoints('custom', data, '#a855f7', 'CUS');
    if (data.type === 'FeatureCollection') {
      L.geoJSON(data, {
        pointToLayer: (f, latlng) => L.marker(latlng, { icon: markerIcon('#a855f7', 'CUS') }),
        onEachFeature: (f, layer) => {
          const title = f.properties?.name || f.properties?.title || 'Custom feature';
          layer.bindPopup(`<strong>${escapeHtml(title)}</strong>`);
          layer.on('click', () => showSelected({ title, type: 'custom', lat: layer.getLatLng?.().lat, lon: layer.getLatLng?.().lng, meta: JSON.stringify(f.properties || {}) }));
        }
      }).addTo(state.layers.custom);
    }
  }

  function toggleWeather() {
    const layers = activeLayers();
    for (const [name, tile] of Object.entries(state.weatherLayers)) {
      const on = !!layers[name];
      const has = state.map.hasLayer(tile);
      if (on && !has) tile.addTo(state.map);
      if (!on && has) state.map.removeLayer(tile);
    }
  }

  function updateSummary() {
    const counts = {};
    for (const [k, v] of Object.entries(state.bundle)) counts[k] = Array.isArray(v) ? v.length : v?.features?.length || 0;
    $('summary').innerHTML = Object.keys(counts).length ? Object.entries(counts).map(([k,v]) => `<div><strong>${escapeHtml(k)}</strong>: ${v}</div>`).join('') : '<div class="muted">No loaded layer data.</div>';
  }

  function showSelected(item) {
    state.selected = item;
    const card = $('selectedCard');
    card.classList.remove('hidden');
    let street = '';
    if (state.config?.googleMapsApiKey && item.lat != null && item.lon != null) {
      const src = `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(state.config.googleMapsApiKey)}&location=${item.lat},${item.lon}`;
      street = `<iframe title="Street View" width="100%" height="220" style="border:0;border-radius:12px;margin-top:10px" loading="lazy" allowfullscreen src="${src}"></iframe>`;
    }
    card.innerHTML = `<h3>${escapeHtml(item.title || 'Selected')}</h3><div class="meta">${escapeHtml(item.type || '')}${item.lat != null ? `<br>Lat ${item.lat.toFixed(4)} | Lon ${item.lon.toFixed(4)}` : ''}${item.meta ? `<br>${escapeHtml(item.meta)}` : ''}</div>${street}`;
  }

  async function refreshLayers() {
    if (!state.map) return;
    const payload = { bbox: bbox(), layers: activeLayers() };
    try {
      const bundle = await api('/api/layers/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.bundle = bundle;
      renderBundle();
    } catch (e) {
      $('summary').innerHTML = `<div style="color:#fda4af">${escapeHtml(String(e.message || e))}</div>`;
    }
  }

  function renderSatellitesOnGlobe() {
    if (!state.globe) return;
    state.globe.entities.removeAll();
    if (!activeLayers().satellites) return;
    const demo = [
      { name: 'ISS', lon: -40, lat: 8, alt: 420000 },
      { name: 'NOAA-20', lon: 15, lat: 54, alt: 824000 },
      { name: 'STARLINK', lon: 97, lat: -12, alt: 550000 },
    ];
    for (const sat of demo) {
      state.globe.entities.add({
        name: sat.name,
        position: Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, sat.alt),
        point: { pixelSize: 8, color: Cesium.Color.CYAN },
        label: { text: sat.name, font: '12px sans-serif', pixelOffset: new Cesium.Cartesian2(0, -16), fillColor: Cesium.Color.WHITE },
      });
    }
  }

  async function loadConfig() {
    state.config = await api('/api/config');
    $('cfgOpenAiKey').value = state.config.openaiApiKey || '';
    $('cfgOpenAiModel').value = state.config.openaiModel || 'gpt-4.1-mini';
    $('cfgGoogleKey').value = state.config.googleMapsApiKey || '';
    $('cfgCesium').value = state.config.cesiumIonToken || '';
    $('cfgOpenSkyId').value = state.config.openSkyClientId || '';
    $('cfgOpenSkySecret').value = state.config.openSkyClientSecret || '';
    $('cfgAisUrl').value = state.config.aisFeedUrl || '';
    $('cfgTrafficUrl').value = state.config.trafficIncidentsUrl || '';
    $('cfgCamerasUrl').value = state.config.camerasUrl || '';
    $('cfgCustomUrl').value = state.config.customGeoJsonUrl || '';
    $('cfgTransitFeeds').value = JSON.stringify(state.config.transitFeeds || [], null, 2);
    if (state.config.cesiumIonToken) Cesium.Ion.defaultAccessToken = state.config.cesiumIonToken;
  }

  async function saveConfig() {
    const next = {
      ...state.config,
      openaiApiKey: $('cfgOpenAiKey').value.trim(),
      openaiModel: $('cfgOpenAiModel').value.trim() || 'gpt-4.1-mini',
      googleMapsApiKey: $('cfgGoogleKey').value.trim(),
      cesiumIonToken: $('cfgCesium').value.trim(),
      openSkyClientId: $('cfgOpenSkyId').value.trim(),
      openSkyClientSecret: $('cfgOpenSkySecret').value.trim(),
      aisFeedUrl: $('cfgAisUrl').value.trim(),
      trafficIncidentsUrl: $('cfgTrafficUrl').value.trim(),
      camerasUrl: $('cfgCamerasUrl').value.trim(),
      customGeoJsonUrl: $('cfgCustomUrl').value.trim(),
      transitFeeds: parseJsonSafe($('cfgTransitFeeds').value, []),
    };
    state.config = (await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })).config;
  }

  async function loadWatchlists() {
    state.watchlists = await api('/api/watchlists');
    renderWatchlists();
  }

  function renderWatchlists() {
    $('watchlists').innerHTML = state.watchlists.length ? state.watchlists.map((w, i) => `
      <div class="watch-item">
        <div><strong>${escapeHtml(w.name)}</strong></div>
        <div class="row"><span>${w.lat.toFixed(4)}, ${w.lon.toFixed(4)} · ${w.radiusKm} km</span><button data-watch-go="${i}">Go</button></div>
      </div>
    `).join('') : '<div class="muted">No watchlists yet.</div>';
    document.querySelectorAll('[data-watch-go]').forEach((btn) => btn.onclick = () => {
      const w = state.watchlists[Number(btn.dataset.watchGo)];
      state.map.setView([w.lat, w.lon], 10);
    });
  }

  async function addWatchlistFromCenter() {
    const center = state.map.getCenter();
    const name = $('watchName').value.trim() || 'Current view';
    const radiusKm = Number($('watchRadius').value) || 60;
    state.watchlists.push({ name, lat: center.lat, lon: center.lng, radiusKm });
    await api('/api/watchlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.watchlists) });
    renderWatchlists();
  }

  async function snapshotNow() {
    const body = {
      createdAt: new Date().toISOString(),
      center: state.map.getCenter(),
      zoom: state.map.getZoom(),
      bbox: bbox(),
      activeLayers: activeLayers(),
      bundle: state.bundle,
    };
    await api('/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function runAnalyst() {
    const prompt = $('analystPrompt').value.trim() || 'Summarize the current view.';
    const context = {
      center: state.map.getCenter(),
      zoom: state.map.getZoom(),
      counts: Object.fromEntries(Object.entries(state.bundle).map(([k,v]) => [k, Array.isArray(v) ? v.length : 0])),
      sample: Object.fromEntries(Object.entries(state.bundle).map(([k,v]) => [k, Array.isArray(v) ? v.slice(0, 6) : v])),
    };
    $('analystOutput').textContent = 'Running…';
    try {
      const result = await api('/api/analyst', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, context }) });
      $('analystOutput').textContent = result.text || 'No output.';
    } catch (e) {
      $('analystOutput').textContent = String(e.message || e);
    }
  }

  async function searchPlace() {
    const q = $('searchInput').value.trim();
    if (!q) return;
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const rows = await (await fetch(url)).json();
    if (!rows.length) return;
    state.map.setView([Number(rows[0].lat), Number(rows[0].lon)], 11);
  }

  function wireUi() {
    $('goBtn').onclick = searchPlace;
    $('settingsBtn').onclick = () => $('settingsDialog').showModal();
    $('saveSettingsBtn').onclick = async (e) => { e.preventDefault(); await saveConfig(); $('settingsDialog').close(); await refreshLayers(); };
    $('refreshBtn').onclick = refreshLayers;
    $('snapshotBtn').onclick = snapshotNow;
    $('globeBtn').onclick = () => setGlobe(!state.globeOn);
    $('addWatchBtn').onclick = addWatchlistFromCenter;
    $('analystBtn').onclick = runAnalyst;
    document.querySelectorAll('[data-layer]').forEach((el) => el.onchange = refreshLayers);
  }

  function fmt(v) { return v == null || v === '' ? 'n/a' : Number.isFinite(Number(v)) ? Number(v).toFixed(0) : String(v); }
  function parseJsonSafe(s, fallback) { try { return s.trim() ? JSON.parse(s) : fallback; } catch { return fallback; } }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
  function destination(lat, lon, bearingDeg, km) {
    const R = 6371; const br = bearingDeg * Math.PI / 180; const d = km / R;
    const lat1 = lat * Math.PI / 180; const lon1 = lon * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
    const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
  }

  async function boot() {
    initMap();
    initGlobe();
    wireUi();
    await loadConfig();
    await loadWatchlists();
    await refreshLayers();
  }

  boot();
})();
