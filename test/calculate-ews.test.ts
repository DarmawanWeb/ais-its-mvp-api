import fs from 'fs';
import { FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson';
import { point } from '@turf/helpers';
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

type EwsModule = typeof import('../src/utils/calculate-ews');

/** Pre-phase-0 implementation, verbatim: it parsed the files on every call. */
const legacy = {
  findNearestCoastDistance(geojsonFile: string, lat: number, lon: number) {
    const geojsonData = JSON.parse(
      fs.readFileSync(geojsonFile, 'utf8'),
    ) as FeatureCollection<Polygon | MultiPolygon>;
    const pt = point([lon, lat]);
    let minDistance: number | null = null;
    for (const feature of geojsonData.features) {
      const geom = feature.geometry;
      if (geom.type === 'Polygon') {
        const coords = geom.coordinates[0];
        const line = { type: 'LineString', coordinates: coords } as const;
        const nearest = nearestPointOnLine(line, pt);
        const d = distance(pt, nearest, { units: 'meters' });
        if (minDistance === null || d < minDistance) minDistance = d;
      }
      if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          const coords = poly[0];
          const line = { type: 'LineString', coordinates: coords } as const;
          const nearest = nearestPointOnLine(line, pt);
          const d = distance(pt, nearest, { units: 'meters' });
          if (minDistance === null || d < minDistance) minDistance = d;
        }
      }
    }
    return minDistance !== null ? minDistance : Infinity;
  },

  checkShipStatus(lat: number, lon: number, navstatus: number): 0 | 1 | 3 {
    const pipelineData = JSON.parse(
      fs.readFileSync('data/pipeline.json', 'utf8'),
    ) as {
      pipeline: { Latitude: number; Longitude: number }[];
    };
    const line: LineString = {
      type: 'LineString',
      coordinates: pipelineData.pipeline.map((p) => [p.Longitude, p.Latitude]),
    };
    const pt = point([lon, lat]);
    const nearest = nearestPointOnLine(line, pt);
    const d = distance(pt, nearest, { units: 'meters' });
    if (navstatus === 1) {
      if (d < 500) return 0;
      if (d < 1750) return 1;
    }
    return 3;
  },
};

/** Deterministic pseudo-random points (LCG) around Indonesia. */
const samplePoints = (count: number): [number, number][] => {
  let seed = 20261120;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, () => [
    -11 + random() * 17,
    95 + random() * 46,
  ]);
};

// Around the pipeline near Surabaya (danger, warning and safe distances),
// Batam, a point on land and far offshore.
const NAMED_POINTS: [number, number][] = [
  [-6.87197219605424, 112.719384869178],
  [-6.875, 112.7225],
  [-6.89, 112.735],
  [-6.95, 112.75],
  [-7.2575, 112.7521],
  [1.08, 104.03],
  [1.15, 103.85],
  [-6.2, 106.816666],
  [-2.5, 118.0],
  [5.5, 95.3],
  [-9.5, 135.0],
];

describe('calculate-ews', () => {
  let ews: EwsModule;
  let readFileSync: MockInstance<typeof fs.readFileSync>;

  beforeEach(async () => {
    vi.resetModules(); // fresh, empty geometry cache for every test
    readFileSync = vi.spyOn(fs, 'readFileSync');
    ews = await import('../src/utils/calculate-ews');
  });

  it('returns exactly the same values as the old implementation', () => {
    const points = [...NAMED_POINTS, ...samplePoints(150)];
    for (const [lat, lon] of points) {
      expect(
        ews.findNearestCoastDistance('data/indonesia.json', lat, lon),
      ).toBe(legacy.findNearestCoastDistance('data/indonesia.json', lat, lon));
      for (const navstatus of [0, 1, 5]) {
        expect(ews.checkShipStatus(lat, lon, navstatus)).toBe(
          legacy.checkShipStatus(lat, lon, navstatus),
        );
      }
    }
  });

  it('covers danger, warning and safe pipeline distances', () => {
    expect(ews.checkShipStatus(-6.87197219605424, 112.719384869178, 1)).toBe(0);
    expect(ews.checkShipStatus(-6.875, 112.7275, 1)).toBe(1);
    expect(ews.checkShipStatus(-6.95, 112.75, 1)).toBe(3);
    expect(ews.checkShipStatus(-6.87197219605424, 112.719384869178, 0)).toBe(3);
  });

  it('reads each data file only once', () => {
    for (const [lat, lon] of samplePoints(25)) {
      ews.findNearestCoastDistance('data/indonesia.json', lat, lon);
      ews.checkShipStatus(lat, lon, 1);
    }

    const reads = readFileSync.mock.calls.map(([file]) => String(file));
    expect(reads.filter((file) => file.endsWith('indonesia.json'))).toEqual([
      'data/indonesia.json',
    ]);
    expect(reads.filter((file) => file.endsWith('pipeline.json'))).toEqual([
      'data/pipeline.json',
    ]);
  });

  it('caches per file path', () => {
    ews.findNearestCoastDistance('data/indonesia.json', 1.1, 104);
    ews.findNearestCoastDistance('data/batam.json', 1.1, 104);
    ews.findNearestCoastDistance('./data/batam.json', 1.1, 104);

    const reads = readFileSync.mock.calls.map(([file]) => String(file));
    expect(reads).toEqual(['data/indonesia.json', 'data/batam.json']);
    expect(ews.findNearestCoastDistance('data/batam.json', 1.1, 104)).toBe(
      legacy.findNearestCoastDistance('data/batam.json', 1.1, 104),
    );
  });
});
