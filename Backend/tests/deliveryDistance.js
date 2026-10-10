const assert = require('node:assert/strict');
const { deliveryDistance } = require('../services/deliveryDistance');
const originalFetch = global.fetch;
let calls = 0;
const conn = address => ({ query: async () => [[{ address }]] });
const location = (name, coordinates, type = 'street') => ({ features: [{ properties: { name, type, city: 'San Juan' }, geometry: { coordinates } }] });

async function run() {
  global.fetch = async url => {
    calls++;
    const parsed = new URL(url);
    const data = parsed.pathname.includes('/route/')
      ? { code: 'Ok', routes: [{ distance: 7250 }] }
      : location(parsed.searchParams.get('q'), [121.03, 14.61]);
    return { ok: true, json: async () => data };
  };
  const result = await deliveryDistance(conn('Company Street'), 'company-a', 'Customer Street');
  assert.equal(result.distanceKm, 7.3);
  assert.equal(result.companyAddress, 'Company Street');
  await deliveryDistance(conn('Company Street'), 'company-a', 'Customer Street');
  assert.equal(calls, 3, 'Repeat lookup should reuse the geocoding and route cache');
  await assert.rejects(deliveryDistance(conn(''), 'company-b', 'Customer Street'), /save the company address/);
  await assert.rejects(deliveryDistance(conn('Company Street'), 'company-a', ''), /complete delivery address/);
  global.fetch = async () => ({ ok: true, json: async () => ({ features: [] }) });
  await assert.rejects(deliveryDistance(conn('Unmapped company'), 'company-c', 'Customer Street'), /could not be found/);
  global.fetch = async () => ({ ok: true, json: async () => location('City centre', [121.03, 14.61], 'city') });
  await assert.rejects(deliveryDistance(conn('Imprecise company'), 'company-d', 'Customer Street'), /more precise street/);
  global.fetch = async url => ({ ok: true, json: async () => new URL(url).pathname.includes('/route/') ? { code: 'NoRoute' } : location('Street', [121.03, 14.61]) });
  await assert.rejects(deliveryDistance(conn('Isolated company'), 'company-e', 'Isolated destination'), /No road route/);
  global.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(deliveryDistance(conn('Offline company'), 'company-f', 'Customer Street'), /try again shortly/);
  console.log('PASS: road distance, cache, missing company address, invalid addresses, imprecise locations, no route and service failures.');
}
run().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
