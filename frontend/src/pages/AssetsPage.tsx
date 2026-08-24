/**
 * `/assets` - synthetic assets ranked by their FR2.1 criticality score.
 *
 * The `trainsAffectedCount` column is deliberately badged Real: it is the train
 * count observed in the published timetable (T3), not a generated value, and
 * that distinction is the point of the provenance work.
 */
import { Link } from 'react-router-dom'
import { useGetAssetsQuery } from '../api/apiSlice.ts'
import { useAutoTour } from '../lib/useAutoTour.ts'
import { ASSETS_TOUR_ID, ASSETS_TOUR_STEPS } from '../tours/referenceTours.ts'
import { DepartmentPill, PageHeader, TableShell, Td, Th } from '../components/Table.tsx'
import QueryState from '../components/QueryState.tsx'
import SyntheticBadge from '../components/SyntheticBadge.tsx'

export function AssetsPage() {
  const assets = useGetAssetsQuery({ limit: 100 })
  const rows = assets.data?.data ?? []
  useAutoTour(ASSETS_TOUR_ID, ASSETS_TOUR_STEPS, !assets.isLoading)

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle="Physical assets with an asset criticality score. The score is a weighted average
          of five factors; two of them are real measurements, three are simulated."
        meta={
          <span
            data-tour="assets-count-badge"
            className="rounded-lg bg-white px-3 py-1.5 text-xs text-slate-600 ring-1 ring-slate-200 ring-inset"
          >
            {assets.data?.pagination.total ?? 0} assets
          </span>
        }
      />

      <QueryState
        isLoading={assets.isLoading}
        error={assets.error}
        isEmpty={rows.length === 0}
        emptyMessage="No assets seeded yet."
      >
        <div data-tour="assets-table">
        <TableShell>
          <thead>
            <tr>
              <Th>Asset</Th>
              <Th>Corridor</Th>
              <Th>Type</Th>
              <Th>Dept</Th>
              <Th align="right">Criticality</Th>
              <Th>Dominant factor</Th>
              <Th align="right">Trains affected</Th>
              <Th>Data</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((asset) => (
              <tr key={asset._id} className="hover:bg-slate-50">
                <Td mono>{asset._id}</Td>
                <Td mono>
                  <Link
                    to={`/corridors/${encodeURIComponent(asset.corridorId)}`}
                    className="text-sky-700 hover:underline"
                  >
                    {asset.corridorId}
                  </Link>
                </Td>
                <Td>{asset.assetType}</Td>
                <Td>
                  <DepartmentPill department={asset.department} />
                </Td>
                <Td align="right">
                  <span className="font-semibold">{asset.criticalityScore.toFixed(2)}</span>
                </Td>
                <Td>
                  <span className="text-xs text-slate-500">
                    {asset.dominantCriticalityFactor?.replace(/_/g, ' ')}
                  </span>
                </Td>
                <Td align="right">
                  {asset.criticality.trainsAffectedCount}{' '}
                  <SyntheticBadge synthetic realNote="Real — observed in the published timetable (T3)" />
                </Td>
                <Td>
                  <SyntheticBadge synthetic={asset.synthetic} />
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
        </div>
      </QueryState>
    </>
  )
}

export default AssetsPage
