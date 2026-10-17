/** Referral: keyless data sources that cover a place, from the source directory. */

import { defineTool } from '../catalog.js';
import { AREA_SCHEMA, areaCenter, resolveArea } from '../area.js';
import { LIMIT_SCHEMA, capRows } from '../results.js';
import {
  SOURCE_TOPICS,
  domainsOfTopic,
  nounOfDomain,
  noteOfDomain,
} from '../../data/sourceDomains.js';

/** One-line answer naming what can be shown now and what only exists. */
export function referralSummary(label, rows) {
  if (!rows.length)
    return `No keyless live source in the source directory covers ${label}.`;
  const usable = rows.filter((r) => r.usable);
  // Domains the app lists by design say why; the rest are waiting on checks.
  const reference = rows.filter((r) => !r.usable && noteOfDomain(r.domain));
  const listed = rows.filter((r) => !r.usable && !noteOfDomain(r.domain));
  const names = (list, withNote = false) =>
    list
      .slice(0, 4)
      .map((r) =>
        withNote
          ? `${r.name} (${nounOfDomain(r.domain)}; ${noteOfDomain(r.domain)})`
          : `${r.name} (${nounOfDomain(r.domain)})`,
      )
      .join(', ');
  const parts = [];
  if (usable.length)
    parts.push(
      `${usable.length} can be shown in God's Eye View: ${names(usable)}`,
    );
  if (reference.length)
    parts.push(
      `${reference.length} listed for reference: ${names(reference, true)}`,
    );
  if (listed.length)
    parts.push(
      `${listed.length} listed but not shown (not yet verified, or its terms don't allow display): ${names(listed)}`,
    );
  return `Keyless sources covering ${label}: ${parts.join('; ')}.`;
}

export const findDataSources = defineTool({
  name: 'find_data_sources',
  title: 'Find keyless data sources',
  description:
    'Keyless live data sources (public transit vehicle positions, bike-share ' +
    'stations, free-floating shared bikes and scooters, traffic camera lists; ' +
    'worldwide earthquake, disaster-alert and active-fire feeds and provincial fire perimeter feeds with topic hazards; the worldwide air-quality sensor feed with topic environment) that cover a place, from the self-maintaining source ' +
    "directory: which ones God's Eye View can show now and which exist but " +
    'are not shown. Use when another tool or layer has no data for a place.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      topic: {
        type: 'string',
        enum: [...SOURCE_TOPICS],
        description: 'Which kind of source to look for (default any).',
      },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['sources'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const center = areaCenter(area);
    const domains = domainsOfTopic(args.topic);
    const { sources, generatedAt } = await services.sources.find({
      lat: center.lat,
      lon: center.lon,
      ...(domains.length === 1 ? { domain: domains[0] } : { domains }),
      limit: Math.min(args.limit ?? 10, 50),
      signal,
    });
    return {
      summary: referralSummary(area.label, sources),
      data: {
        ...capRows(sources, args.limit),
        directory_generated_at: generatedAt,
      },
    };
  },
});
