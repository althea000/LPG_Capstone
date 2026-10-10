const ApiError = require('../utils/apiError');
const cache = new Map();
const TTL = 30 * 60 * 1000;

async function cached(key, work) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  const value = work();
  cache.set(key, { value, expires: Date.now() + TTL });
  try { return await value; } catch (err) { cache.delete(key); throw err; }
}

async function requestJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Map service unavailable');
    return await response.json();
  } catch {
    throw new ApiError(503, 'Unable to calculate delivery distance. Please try again shortly.');
  }
}

async function locate(address, label, bias) {
  return cached(`location:${address}:${bias?.coordinates.join(',') || ''}`, async () => {
    const url = new URL(process.env.DELIVERY_GEOCODER_URL || 'https://photon.komoot.io/api/');
    url.searchParams.set('q', address);
    url.searchParams.set('limit', '1');
    url.searchParams.set('lang', 'en');
    url.searchParams.set('countrycode', 'PH');
    if (bias) {
      url.searchParams.set('lon', bias.coordinates[0]);
      url.searchParams.set('lat', bias.coordinates[1]);
    }
    const result = await requestJson(url);
    const feature = result.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) {
      throw new ApiError(422, `${label} could not be found. Include the street, barangay and city.`);
    }
    const p = feature.properties || {};
    // A city centre alone is too imprecise for delivery fees.
    if (['city', 'county', 'state', 'country', 'district', 'locality'].includes(p.type) && !p.street) {
      throw new ApiError(422, `${label} needs a more precise street address or named landmark.`);
    }
    return { coordinates, label: [...new Set([p.name, [p.housenumber, p.street].filter(Boolean).join(' '), p.district, p.city, p.state, p.country].filter(Boolean))].join(', ') };
  });
}

async function deliveryDistance(conn, companyId, address) {
  if (typeof address !== 'string' || address.trim().length < 5 || address.length > 500) throw new ApiError(400, 'Enter a complete delivery address (up to 500 characters).');
  const [[company]] = await conn.query(`SELECT COALESCE(NULLIF(TRIM(s.Address),''),c.Address) AS address FROM Company c LEFT JOIN CompanySettings s ON s.CompanyID=c.CompanyID WHERE c.CompanyID=:company`, { company: companyId });
  const origin = company?.address?.trim();
  if (!origin) throw new ApiError(422, 'Ask an administrator to save the company address in Settings first.');
  return cached(`route:${origin}:${address.trim()}`, async () => {
    const from = await locate(origin, 'Company address');
    const to = await locate(address.trim(), 'Delivery address', from);
    const base = (process.env.DELIVERY_ROUTER_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
    const result = await requestJson(`${base}/route/v1/driving/${from.coordinates.join(',')};${to.coordinates.join(',')}?overview=false&alternatives=false&steps=false`);
    const metres = result.routes?.[0]?.distance;
    if (result.code !== 'Ok' || !Number.isFinite(metres) || metres < 0) throw new ApiError(422, 'No road route was found for this delivery address.');
    const distanceKm = Math.round(metres / 100) / 10;
    if (distanceKm > 1000) throw new ApiError(422, 'The delivery address is outside the supported delivery range.');
    return { distanceKm, companyAddress: origin, origin: from.label, destination: to.label };
  });
}

module.exports = { deliveryDistance };
