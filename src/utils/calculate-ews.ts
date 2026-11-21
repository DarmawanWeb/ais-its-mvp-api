import fs from 'fs';
import path from 'path';
import { FeatureCollection, Polygon, MultiPolygon, LineString } from 'geojson';
import { point } from '@turf/helpers';
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';

const PIPELINE_FILE = 'data/pipeline.json';

/*
 * The geometry files are read and pre-processed once, on first use, instead of
 * on every AIS message. Paths stay relative to the working directory, as before.
 * The pre-processed shapes are exactly the objects the per-call code used to
 * build, so results are numerically identical.
 */

/** Outer ring of every (multi)polygon as a LineString, keyed by resolved file path. */
const coastlineCache = new Map<string, LineString[]>();
let pipelineLine: LineString | null = null;

const loadCoastlines = (geojsonFile: string): LineString[] => {
  const cacheKey = path.resolve(geojsonFile);
  const cached = coastlineCache.get(cacheKey);
  if (cached) return cached;

  const geojsonData = JSON.parse(
    fs.readFileSync(geojsonFile, 'utf8'),
  ) as FeatureCollection<Polygon | MultiPolygon>;

  const lines: LineString[] = [];
  for (const feature of geojsonData.features) {
    const geom = feature.geometry;

    if (geom.type === 'Polygon') {
      lines.push({ type: 'LineString', coordinates: geom.coordinates[0] });
    }

    if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        lines.push({ type: 'LineString', coordinates: poly[0] });
      }
    }
  }

  coastlineCache.set(cacheKey, lines);
  return lines;
};

/**
 * Find nearest coastal distance (in meters) to a given lat/lon
 */
export const findNearestCoastDistance = (
  geojsonFile: string,
  lat: number,
  lon: number,
): number => {
  const pt = point([lon, lat]);

  let minDistance: number | null = null;

  for (const line of loadCoastlines(geojsonFile)) {
    const nearest = nearestPointOnLine(line, pt);
    const d = distance(pt, nearest, { units: 'meters' });

    if (minDistance === null || d < minDistance) {
      minDistance = d;
    }
  }

  return minDistance !== null ? minDistance : Infinity;
};

type PipelinePoint = {
  Latitude: number;
  Longitude: number;
  Name?: string;
};

const loadPipelineLine = (): LineString => {
  if (!pipelineLine) {
    const pipelineData = JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8')) as {
      pipeline: PipelinePoint[];
    };

    pipelineLine = {
      type: 'LineString',
      coordinates: pipelineData.pipeline.map((p) => [p.Longitude, p.Latitude]),
    };
  }
  return pipelineLine;
};

/**
 * Check ship safety against pipeline
 * Return:
 *  0 = DANGER (< 500m)
 *  1 = WARNING (500–1750m)
 *  3 = SAFE (> 1750m)
 */
export const checkShipStatus = (
  lat: number,
  lon: number,
  navstatus: number,
): 0 | 1 | 3 => {
  const pt = point([lon, lat]);
  const nearest = nearestPointOnLine(loadPipelineLine(), pt);
  const d = distance(pt, nearest, { units: 'meters' });

  if (navstatus === 1) {
    if (d < 500) return 0;
    if (d < 1750) return 1;
  }
  return 3;
};
