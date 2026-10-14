/** Referral: keyless data sources that cover a place, from the source directory. */

import { defineTool } from '../catalog.js';
import { AREA_SCHEMA, areaCenter, resolveArea } from '../area.js';
import { LIMIT_SCHEMA, capRows } from '../results.js';
import {
  SOURCE_TOPICS,
  domainOfTopic,
  nounOfDomain,
} from '../../data/sourceDomains.js';

/** One-line answer naming what can be shown now and what only exists. */
export function referralSummary(label, rows) {
  if (!rows.length)
    return `No keyless live source in the source directory covers ${label}.`;
  const usable = rows.filter((r) => r.usable);
  const listed = rows.filter((r) => !r.usable);
  const names = (list) =>
    list
      .slice(0, 4)
      .map((r) => `${r.name} (${nounOfDomain(r.domain)})`)
      .join(', ');
  const parts = [];
  if (usable.length)
    parts.push(
      `${usable.length} can be shown in God's Eye View: ${names(usable)}`,
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
    'stations, traffic camera lists) that cover a place, from the self-maintaining source ' +
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
    const { sources, generatedAt } = await services.sources.find({
      lat: center.lat,
      lon: center.lon,
      domain: domainOfTopic(args.topic),
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
