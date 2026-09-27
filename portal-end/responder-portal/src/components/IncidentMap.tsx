import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import type { FeatureCollection } from 'geojson'
import 'leaflet/dist/leaflet.css'
import 'leaflet.heat'
import type { AiResponder, Incident } from '../types/incident'
import { emergencyIconHtml } from './EmergencyIcon'
import { AI_RESPONDERS, RESPONDER_COLOR, RESPONDER_LABEL, RESPONDER_SHORT } from '../utils/responders'
import { buildStreetGraph, routeDispatch, type StreetGraph } from '../utils/streetRoute'

export interface DispatchStop {
  id: string
  lat: number
  lon: number
}

interface Props {
  incidents: Incident[]
  selectedId: string | null
  onSelectIncident: (id: string) => void
  /** Close the open report-detail panel without selecting another incident. */
  onClearSelection?: () => void
  devicePosition?: L.LatLngTuple | null
  dispatchStops?: DispatchStop[]
  /** Dispatch list order. Numbers on the map follow this sequence. */
  dispatchOrder?: string[]
  highlightedDispatchId?: string | null
  /** Bump `token` to fly the map to this dispatch stop again. */
  dispatchFocus?: { id: string; token: number } | null
  /** Cumulative street-route arrival minutes for the current dispatch stops. */
  onDispatchEtas?: (etas: Record<string, number>) => void
}

interface IncidentCluster {
  id: string
  incidents: Incident[]
  center: L.LatLngTuple
  radius: number
}

type HeatPoint = [number, number, number]
type PriorityLevel = 1 | 2 | 3 | 4 | 5

/**
 * Urgency spectrum: blue (wide outer fade) → yellow → orange → red (tight core).
 * Blue owns most of the intensity range so blobs read blue-heavy; warmer colors
 * only appear near the center and step in smoothly.
 */
const PRIORITY_HEAT_GRADIENTS: Record<PriorityLevel, Record<number, string>> = {
  1: {
    0: 'rgba(20, 50, 130, 0)',
    0.25: '#143a8c',
    0.55: '#1a4db8',
    0.8: '#2a62e0',
    1: '#3d7bff',
  },
  2: {
    0: 'rgba(20, 50, 130, 0)',
    0.2: '#143a8c',
    0.45: '#1a55cc',
    0.7: '#4aa0f0',
    0.88: '#6ec4ff',
    1: '#9adbff',
  },
  3: {
    0: 'rgba(20, 50, 130, 0)',
    0.18: '#143a8c',
    0.4: '#1f5ad4',
    0.58: '#4aa8ff',
    0.72: '#7ec8ff',
    0.84: '#c8e06a',
    0.92: '#ffe933',
    1: '#fff066',
  },
  4: {
    0: 'rgba(20, 50, 130, 0)',
    0.15: '#143a8c',
    0.35: '#1f5ad4',
    0.52: '#4aa8ff',
    0.65: '#8fd0ff',
    0.76: '#d4d84a',
    0.84: '#ffe933',
    0.92: '#ff9a1a',
    1: '#ff8f00',
  },
  5: {
    0: 'rgba(20, 50, 130, 0)',
    0.12: '#143a8c',
    0.3: '#1f5ad4',
    0.48: '#4aa8ff',
    0.6: '#8fd0ff',
    0.7: '#c8dc55',
    0.78: '#ffe933',
    0.86: '#ff9a1a',
    0.92: '#ff5a10',
    0.97: '#ff1a1a',
    1: '#c40000',
  },
}

function asPriorityLevel(priority: number | null): PriorityLevel {
  if (priority == null || priority < 1) return 2
  if (priority >= 5) return 5
  return Math.floor(priority) as PriorityLevel
}

function coordinates(incident: Incident): L.LatLngTuple | null {
  if (
    incident.lat != null &&
    incident.lon != null &&
    Number.isFinite(incident.lat) &&
    Number.isFinite(incident.lon) &&
    Math.abs(incident.lat) <= 90 &&
    Math.abs(incident.lon) <= 180
  ) {
    return [incident.lat, incident.lon]
  }
  const values = incident.location.split(',').map(Number)
  return values.length === 2 && values.every(Number.isFinite) && Math.abs(values[0]) <= 90 && Math.abs(values[1]) <= 180
    ? [values[0], values[1]]
    : null
}

function distanceMeters(left: L.LatLngTuple, right: L.LatLngTuple): number {
  const latScale = 111_000
  const lonScale = 111_000 * Math.cos((left[0] * Math.PI) / 180)
  return Math.hypot((right[0] - left[0]) * latScale, (right[1] - left[1]) * lonScale)
}

function metersPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom)
}

/** Keep heat localized when zoomed out; bloom more as you zoom into a cluster. */
function heatStyleForZoom(zoom: number, gradient: Record<number, string>): L.HeatMapOptions {
  const t = Math.max(0, Math.min(1, (zoom - 12) / 5))
  // Smaller kernel when zoomed out so geographic lobes (not a round brush) define the silhouette.
  return {
    radius: Math.round(5 + t * 34),
    blur: Math.round(9 + t * 16),
    maxZoom: 16,
    max: 1,
    minOpacity: 0.55,
    gradient,
  }
}

/** Real pin pixel size — mildly smaller when zoomed out, full size when close. */
function markerPixelSizeForZoom(zoom: number): number {
  // ~22px at z11 → 36px at z17+
  const t = Math.max(0, Math.min(1, (zoom - 11) / 6))
  return Math.round(22 + t * 14)
}

/**
 * Click target tracks the visible heat footprint (radius+blur in px → meters),
 * padded so any colored area is easy to hit, especially when zoomed out.
 */
function clusterHitRadiusMeters(cluster: IncidentCluster, zoom: number): number {
  const style = heatStyleForZoom(zoom, PRIORITY_HEAT_GRADIENTS[3])
  const footprintPx = (style.radius ?? 25) + (style.blur ?? 15)
  const heatMeters = footprintPx * metersPerPixel(cluster.center[0], zoom)
  const pad = zoom < 14 ? 1.55 : zoom < 16 ? 1.4 : 1.25
  return Math.max(cluster.radius * 1.2, heatMeters * pad, 90)
}

/** Tighter north-edge radius for the popup tip — hugs the colored heat, not the click pad. */
function clusterPopupRadiusMeters(cluster: IncidentCluster, zoom: number): number {
  const style = heatStyleForZoom(zoom, PRIORITY_HEAT_GRADIENTS[3])
  const footprintPx = (style.radius ?? 25) * 0.85 + (style.blur ?? 15) * 0.35
  const heatMeters = footprintPx * metersPerPixel(cluster.center[0], zoom)
  return Math.max(cluster.radius * 0.75, heatMeters * 0.85, 50)
}

/** Anchor just above the heat fringe so the popup tip sits on the color edge. */
function clusterPopupAnchor(center: L.LatLngTuple, radiusMeters: number): L.LatLngTuple {
  return [center[0] + radiusMeters / 111_000, center[1]]
}

type HeatLayerInternal = {
  _map: L.Map
  _canvas: HTMLCanvasElement
  _heat?: unknown
  _frame?: number | null
  _drawZoom?: number
  _drawBounds?: L.LatLngBounds
  _initCanvas?: () => void
  _reset?: () => void
  _redraw?: () => void
  onAdd?: (map: L.Map) => void
  onRemove?: (map: L.Map) => void
  _updateTransform?: (center: L.LatLng, zoom: number) => void
  _onZoom?: () => void
  _animateZoom?: (e: L.ZoomAnimEvent) => void
  redraw?: () => HeatLayerInternal
}

/**
 * leaflet.heat is built for Leaflet 0.x: wrong zoomanim math, transform-origin
 * 50% 50%, and redraw guards `_animating` (Leaflet 1.x uses `_animatingZoom`).
 * Patch once on the prototype so every priority heat canvas tracks GridLayer-style.
 */
function patchLeafletHeatZoomAnimation() {
  const proto = (L as unknown as { HeatLayer?: { prototype: HeatLayerInternal & { __zoomPatched?: boolean } } })
    .HeatLayer?.prototype
  if (!proto || proto.__zoomPatched) return
  proto.__zoomPatched = true

  const applyOrigin = (canvas: HTMLCanvasElement | undefined) => {
    if (canvas) canvas.style.transformOrigin = '0 0'
  }

  const originalInitCanvas = proto._initCanvas
  proto._initCanvas = function (this: HeatLayerInternal) {
    originalInitCanvas?.call(this)
    applyOrigin(this._canvas)
  }

  proto._updateTransform = function (this: HeatLayerInternal, center: L.LatLng, zoom: number) {
    const map = this._map as L.Map & {
      _latLngBoundsToNewLayerBounds: (bounds: L.LatLngBounds, zoom: number, center: L.LatLng) => L.Bounds
      _animatingZoom?: boolean
    }
    if (!map || !this._canvas) return
    const bounds = this._drawBounds ?? map.getBounds()
    const fromZoom = this._drawZoom ?? map.getZoom()
    const scale = map.getZoomScale(zoom, fromZoom)
    const offset = map._latLngBoundsToNewLayerBounds(bounds, zoom, center).min
    if (offset) L.DomUtil.setTransform(this._canvas, offset, scale)
  }

  proto._animateZoom = function (this: HeatLayerInternal, e: L.ZoomAnimEvent) {
    this._updateTransform?.(e.center, e.zoom)
  }

  // Pinch / flyTo / trackpad fire `zoom` every frame without zoomanim — mirror GridLayer.
  proto._onZoom = function (this: HeatLayerInternal) {
    const map = this._map as L.Map & { _animatingZoom?: boolean }
    if (!map || map._animatingZoom) return
    this._updateTransform?.(map.getCenter(), map.getZoom())
  }

  const originalReset = proto._reset
  proto._reset = function (this: HeatLayerInternal) {
    applyOrigin(this._canvas)
    originalReset?.call(this)
    if (this._map) {
      this._drawZoom = this._map.getZoom()
      this._drawBounds = this._map.getBounds()
    }
  }

  // Stock checks `_animating` (never set on Leaflet 1.x) so mid-zoom redraws fight CSS transforms.
  proto.redraw = function (this: HeatLayerInternal) {
    const map = this._map as L.Map & { _animatingZoom?: boolean }
    if (this._heat && !this._frame && map && !map._animatingZoom) {
      this._frame = L.Util.requestAnimFrame(this._redraw!, this)
    }
    return this
  }

  const originalOnAdd = proto.onAdd
  proto.onAdd = function (this: HeatLayerInternal, map: L.Map) {
    originalOnAdd?.call(this, map)
    map.on('zoom', this._onZoom!, this)
    this._drawZoom = map.getZoom()
    this._drawBounds = map.getBounds()
    applyOrigin(this._canvas)
  }

  const originalOnRemove = proto.onRemove
  proto.onRemove = function (this: HeatLayerInternal, map: L.Map) {
    map.off('zoom', this._onZoom!, this)
    originalOnRemove?.call(this, map)
  }
}

/** Stable 0–1 noise from an id + salt (no flicker across re-renders). */
function seededUnit(seed: number, salt: number): number {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

function hashSeed(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Point weight within a priority layer.
 * Cores still hit the peak color; lobes/edges stay lower so blue dominates the spread.
 */
function heatPointWeight(kind: 'core' | 'lobe' | 'edge', unit = 0.5): number {
  if (kind === 'core') return 0.84 + unit * 0.12
  if (kind === 'lobe') return 0.32 + unit * 0.28
  return 0.14 + unit * 0.2
}

function clusterMaxPriority(cluster: IncidentCluster): number | null {
  let max: number | null = null
  for (const incident of cluster.incidents) {
    if (incident.priority == null) continue
    if (max == null || incident.priority > max) max = incident.priority
  }
  return max
}

/** Mild size factor from affected people; current organic sizes are the max (1). */
function peopleHeatScale(cluster: IncidentCluster): number {
  const reported = cluster.incidents.reduce((sum, incident) => sum + Math.max(0, incident.people), 0)
  // Unknown people (0): use report count as a soft stand-in so tiny clusters still shrink a bit.
  const count = reported > 0 ? reported : Math.max(1, cluster.incidents.length)
  if (count <= 1) return 0.62
  if (count === 2) return 0.72
  if (count === 3) return 0.82
  if (count === 4) return 0.9
  return 1
}

function pushOffsetPoint(
  points: HeatPoint[],
  origin: L.LatLngTuple,
  lonScale: number,
  angle: number,
  distMeters: number,
  stretchX: number,
  stretchY: number,
  weight: number,
) {
  const dx = Math.cos(angle) * distMeters * stretchX
  const dy = Math.sin(angle) * distMeters * stretchY
  points.push([
    origin[0] + dy / 111_000,
    origin[1] + dx / lonScale,
    weight,
  ])
}

/**
 * Build an irregular heat footprint from cluster member pins + seeded lobes.
 * When zoomed out, lobe distances scale up in screen-space so organic shape
 * still reads (meter-scale offsets alone collapse into a round pixel blob).
 */
function organicHeatPoints(cluster: IncidentCluster, zoom: number): HeatPoint[] {
  const seed = hashSeed(cluster.id)
  const memberPoints = cluster.incidents.flatMap(incident => {
    const point = coordinates(incident)
    return point ? [point] : []
  })
  if (!memberPoints.length) return []

  const center = cluster.center
  const lonScale = Math.max(1e-6, 111_000 * Math.cos((center[0] * Math.PI) / 180))
  const spreadMeters = Math.max(
    35,
    Math.max(...memberPoints.map(point => distanceMeters(center, point))),
  )
  const peopleScale = peopleHeatScale(cluster)
  const sizeScale = (0.7 + seededUnit(seed, 2) * 0.85) * peopleScale
  // 0 when close in, 1 when far out — drives screen-aware organic reach.
  const zoomOut = Math.max(0, Math.min(1, (15.25 - zoom) / 3.75))
  const mpp = metersPerPixel(center[0], zoom)
  const memberReach = Math.min(220, Math.max(45, spreadMeters * (0.85 + seededUnit(seed, 3) * 0.7) * sizeScale))
  // Aim for ~22–48px of geographic irregularity on screen when zoomed out.
  const screenReachPx = 22 + seededUnit(seed, 6) * 26
  const screenReachMeters = Math.min(720, Math.max(60, screenReachPx * mpp))
  const lobeReach = (memberReach * (1 - zoomOut * 0.55) + screenReachMeters * zoomOut) * peopleScale
  const points: HeatPoint[] = []

  // Soft cores on real report pins — anchors the blob to where people actually are.
  for (let index = 0; index < memberPoints.length; index += 1) {
    const point = memberPoints[index]
    points.push([point[0], point[1], heatPointWeight('core', seededUnit(seed, 10 + index))])
    const pinLonScale = Math.max(1e-6, 111_000 * Math.cos((point[0] * Math.PI) / 180))
    const pinLobes = 1 + Math.floor(seededUnit(seed, 20 + index) * (2 + zoomOut * 2))
    for (let lobe = 0; lobe < pinLobes; lobe += 1) {
      const pinReach = (10 + seededUnit(seed, 31 + index * 7 + lobe) * 32 * sizeScale) * (1 + zoomOut * 2.8)
      pushOffsetPoint(
        points,
        point,
        pinLonScale,
        seededUnit(seed, 30 + index * 7 + lobe) * Math.PI * 2,
        pinReach,
        0.35 + seededUnit(seed, 32 + index * 7 + lobe) * (1.1 + zoomOut * 0.6),
        0.35 + seededUnit(seed, 33 + index * 7 + lobe) * (1.1 + zoomOut * 0.6),
        heatPointWeight('lobe', seededUnit(seed, 34 + index * 7 + lobe)),
      )
    }
  }

  // Extra lobes / fringe — more of them when zoomed out so the silhouette stays ragged.
  const majorLobes = 3 + Math.floor(seededUnit(seed, 4) * (2 + 2 * peopleScale + zoomOut * 4))
  for (let index = 0; index < majorLobes; index += 1) {
    const baseAngle = (index / majorLobes) * Math.PI * 2 + seededUnit(seed, 40 + index) * (0.7 + zoomOut * 0.5)
    pushOffsetPoint(
      points,
      center,
      lonScale,
      baseAngle,
      lobeReach * (0.3 + seededUnit(seed, 41 + index) * 0.85),
      0.3 + seededUnit(seed, 42 + index) * (1.4 + zoomOut * 0.5),
      0.3 + seededUnit(seed, 43 + index) * (1.4 + zoomOut * 0.5),
      heatPointWeight('lobe', seededUnit(seed, 44 + index)),
    )
  }

  const fringe = 2 + Math.floor(seededUnit(seed, 5) * (2 + 2 * peopleScale + zoomOut * 5))
  for (let index = 0; index < fringe; index += 1) {
    pushOffsetPoint(
      points,
      center,
      lonScale,
      seededUnit(seed, 50 + index) * Math.PI * 2,
      lobeReach * (0.65 + seededUnit(seed, 51 + index) * 0.8),
      0.25 + seededUnit(seed, 52 + index) * (1.6 + zoomOut * 0.7),
      0.25 + seededUnit(seed, 53 + index) * (1.6 + zoomOut * 0.7),
      heatPointWeight('edge', seededUnit(seed, 54 + index)),
    )
  }

  return points
}

/**
 * Bucket clusters by max priority. Each layer uses a truncated blue→… spectrum
 * so lower priorities never paint orange/red, while P5 still fades through blue/yellow/orange.
 */
function clusterHeatByPriority(clusters: IncidentCluster[], zoom: number): Map<PriorityLevel, HeatPoint[]> {
  const byPriority = new Map<PriorityLevel, HeatPoint[]>([
    [1, []],
    [2, []],
    [3, []],
    [4, []],
    [5, []],
  ])
  for (const cluster of clusters) {
    const level = asPriorityLevel(clusterMaxPriority(cluster))
    const bucket = byPriority.get(level)!
    bucket.push(...organicHeatPoints(cluster, zoom))
  }
  return byPriority
}

function heatBucketsSignature(buckets: Map<PriorityLevel, HeatPoint[]>, zoom: number): string {
  const zoomKey = (Math.round(zoom * 2) / 2).toFixed(1)
  return `${zoomKey}|` + [1, 2, 3, 4, 5]
    .map(level => {
      const points = buckets.get(level as PriorityLevel) ?? []
      return `${level}:${points.map(([lat, lon, w]) => `${lat.toFixed(5)},${lon.toFixed(5)},${w.toFixed(2)}`).join(';')}`
    })
    .join('|')
}

function applyHeatBuckets(
  heatLayers: Map<PriorityLevel, L.HeatLayer>,
  clusters: IncidentCluster[],
  zoom: number,
  signatureRef: { current: string },
) {
  const buckets = clusterHeatByPriority(clusters, zoom)
  const signature = heatBucketsSignature(buckets, zoom)
  if (signature === signatureRef.current) return
  for (const [level, layer] of heatLayers) {
    layer.setLatLngs(buckets.get(level) ?? [])
  }
  signatureRef.current = signature
}

/** Same cap as the backend: one event area, not a chain across the city. */
const MAX_CLUSTER_DIAMETER_M = 500

function splitTightIncidents(incidents: Incident[]): Incident[][] {
  const placed = incidents.flatMap(incident => {
    const point = coordinates(incident)
    return point ? [{ incident, point }] : []
  })
  if (placed.length < 2) return []

  let clusters = placed.map(item => [item])
  const link = (left: typeof placed, right: typeof placed) => {
    let farthest = 0
    for (const a of left) {
      for (const b of right) farthest = Math.max(farthest, distanceMeters(a.point, b.point))
    }
    return farthest
  }

  while (true) {
    let bestI = -1
    let bestJ = -1
    let bestGap = Infinity
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const gap = link(clusters[i], clusters[j])
        if (gap <= MAX_CLUSTER_DIAMETER_M && gap < bestGap) {
          bestGap = gap
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestI < 0) break
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ])
    clusters.splice(bestJ, 1)
  }

  return clusters.filter(group => group.length >= 2).map(group => group.map(item => item.incident))
}

function clusterIncidents(incidents: Incident[]): IncidentCluster[] {
  const groups = new Map<string, Incident[]>()
  incidents.forEach(incident => {
    if (!coordinates(incident) || !incident.clusterId) return
    const existing = groups.get(incident.clusterId)
    if (existing) existing.push(incident)
    else groups.set(incident.clusterId, [incident])
  })

  const clusters: IncidentCluster[] = []
  for (const [id, members] of groups) {
    const parts = splitTightIncidents(members)
    parts.forEach(part => {
      const points = part.flatMap(incident => {
        const point = coordinates(incident)
        return point ? [point] : []
      })
      if (points.length < 2) return
      const center: L.LatLngTuple = [
        points.reduce((sum, point) => sum + point[0], 0) / points.length,
        points.reduce((sum, point) => sum + point[1], 0) / points.length,
      ]
      const spread = Math.max(...points.map(point => distanceMeters(center, point)))
      const partId = parts.length === 1 ? id : `${id}:${part.map(incident => incident.id).sort()[0]}`
      clusters.push({
        id: partId,
        incidents: part,
        center,
        radius: Math.max(100, Math.min(300, spread + 75)),
      })
    })
  }
  return clusters
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character)
}

/** Union of per-report AI responders already on cluster members — no Gemini re-tag. */
function clusterRespondersFromIncidents(incidents: Incident[]): AiResponder[] {
  const seen = new Set<AiResponder>()
  for (const incident of incidents) {
    for (const responder of incident.aiResponders) seen.add(responder)
  }
  return AI_RESPONDERS.filter(responder => seen.has(responder))
}

function responderPillsHtml(responders: AiResponder[]): string {
  if (!responders.length) {
    return '<span class="cluster-popup-meta">Responder tags pending</span>'
  }
  const pills = responders.map(responder => {
    const color = RESPONDER_COLOR[responder]
    return `<span class="responder-pill" title="${escapeHtml(RESPONDER_LABEL[responder])}" style="background:${color.bg};color:${color.fg}">${escapeHtml(RESPONDER_SHORT[responder])}</span>`
  }).join('')
  return `<div class="responder-pills cluster-popup-pills">${pills}</div>`
}

function clusterPriorityLabel(priority: number | null): string {
  if (priority == null) return 'Priority pending'
  if (priority <= 2) return `Low priority P${priority}`
  if (priority === 3) return `Medium priority P${priority}`
  return `High priority P${priority}`
}

function clusterSummaryText(cluster: IncidentCluster): string {
  const summary = cluster.incidents.find(incident => incident.clusterSummary)?.clusterSummary?.trim()
  return summary || 'Cluster summary pending.'
}

function clusterPopup(cluster: IncidentCluster): string {
  const people = cluster.incidents.reduce((sum, incident) => sum + incident.people, 0)
  const maxPriority = clusterMaxPriority(cluster)
  const summary = clusterSummaryText(cluster)
  const responders = clusterRespondersFromIncidents(cluster.incidents)
  return `<div class="cluster-popup-content">
    <span class="cluster-popup-kicker">${cluster.incidents.length} linked reports</span>
    <strong>${escapeHtml(summary)}</strong>
    <span class="cluster-popup-meta">${people} ${people === 1 ? 'person' : 'people'} involved · ${clusterPriorityLabel(maxPriority)}</span>
    ${responderPillsHtml(responders)}
  </div>`
}

function clusterSignature(cluster: IncidentCluster): string {
  const responders = clusterRespondersFromIncidents(cluster.incidents).join(',')
  const summary = clusterSummaryText(cluster)
  const people = cluster.incidents.reduce((sum, incident) => sum + incident.people, 0)
  const priorities = cluster.incidents.map(incident => incident.priority ?? 0).join(',')
  return [
    cluster.id,
    cluster.incidents.length,
    cluster.center[0].toFixed(5),
    cluster.center[1].toFixed(5),
    cluster.radius,
    people,
    summary,
    responders,
    priorities,
  ].join('|')
}

function leftChromeWidth(map: L.Map): number {
  const workspace = map.getContainer().closest('.workspace') as HTMLElement | null
  const queue = workspace?.querySelector('.queue-panel') as HTMLElement | null
  const peek = workspace?.querySelector('.report-detail-peek') as HTMLElement | null
  const queueW = queue?.getBoundingClientRect().width ?? 380
  const peekW = peek ? peek.getBoundingClientRect().width + 12 : 0
  return queueW + peekW + 24
}

/** Map-container pixels covered by the incident list on the left and the dispatch dock on the right. */
function focusInsets(map: L.Map): { left: number; right: number } {
  const mapRect = map.getContainer().getBoundingClientRect()
  const workspace = map.getContainer().closest('.workspace')
  const blockers = [
    workspace?.querySelector('.queue-panel'),
    workspace?.querySelector('.report-detail-peek'),
    document.querySelector('.corner-stack'),
  ]
  let left = 24
  let right = 24
  const midX = (mapRect.left + mapRect.right) / 2
  for (const node of blockers) {
    if (!(node instanceof HTMLElement)) continue
    const rect = node.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) continue
    const overlaps =
      rect.right > mapRect.left + 8 &&
      rect.left < mapRect.right - 8 &&
      rect.bottom > mapRect.top + 8 &&
      rect.top < mapRect.bottom - 8
    if (!overlaps) continue
    const centerX = (rect.left + rect.right) / 2
    if (centerX < midX) left = Math.max(left, rect.right - mapRect.left + 28)
    else right = Math.max(right, mapRect.right - rect.left + 28)
  }
  const minGap = 140
  if (left + right > mapRect.width - minGap) {
    const scale = Math.max(0.2, (mapRect.width - minGap) / Math.max(1, left + right))
    left *= scale
    right *= scale
  }
  return { left, right }
}

const PIN_FOCUS_ZOOM = 17.5
const CLUSTER_FOCUS_ZOOM = 17.25
/** Vertical room reserved above the cluster for the info popup. */
const CLUSTER_POPUP_TOP_PAD = 150

/** Geographic extent of the colored heat, including the blur fringe. */
function heatLatLngBounds(cluster: IncidentCluster, zoom: number): L.LatLngBounds {
  const points = organicHeatPoints(cluster, zoom)
  const style = heatStyleForZoom(zoom, PRIORITY_HEAT_GRADIENTS[3])
  const padPx = (style.radius ?? 25) + (style.blur ?? 15) + 10
  const lat = cluster.center[0]
  const padMeters = padPx * metersPerPixel(lat, zoom)
  const latPad = padMeters / 111_000
  const lonPad = padMeters / Math.max(1e-6, 111_000 * Math.cos((lat * Math.PI) / 180))
  const bounds = L.latLngBounds([cluster.center, cluster.center])
  const samples = points.length ? points : [[cluster.center[0], cluster.center[1], 1] as HeatPoint]
  for (const [pointLat, pointLon] of samples) {
    bounds.extend([pointLat - latPad, pointLon - lonPad])
    bounds.extend([pointLat + latPad, pointLon + lonPad])
  }
  return bounds
}

function clusterPopupBox(map: L.Map): { width: number; height: number } {
  const node = map.getContainer().querySelector('.cluster-popup')
  if (!(node instanceof HTMLElement)) return { width: 250, height: CLUSTER_POPUP_TOP_PAD }
  const rect = node.getBoundingClientRect()
  if (rect.width < 8 || rect.height < 8) return { width: 250, height: CLUSTER_POPUP_TOP_PAD }
  return { width: rect.width, height: rect.height }
}

/**
 * Screen box of the heat plus the cluster card that sits on its north edge.
 * The card is part of the fitted content so the blob itself stays in the
 * map area the card, queue, and docks do not cover.
 */
function clusterScreenLayout(
  map: L.Map,
  cluster: IncidentCluster,
  zoom: number,
  popup: { width: number; height: number },
) {
  const bounds = heatLatLngBounds(cluster, zoom)
  const southWest = map.project(bounds.getSouthWest(), zoom)
  const northEast = map.project(bounds.getNorthEast(), zoom)
  const anchor = map.project(
    clusterPopupAnchor(cluster.center, clusterPopupRadiusMeters(cluster, zoom)),
    zoom,
  )
  // Popup offset (0, 10) pulls the tip down onto the heat fringe.
  const anchorY = anchor.y + 10
  let minX = Math.min(southWest.x, northEast.x)
  let maxX = Math.max(southWest.x, northEast.x)
  let minY = Math.min(southWest.y, northEast.y)
  let maxY = Math.max(southWest.y, northEast.y)
  minX = Math.min(minX, anchor.x - popup.width / 2)
  maxX = Math.max(maxX, anchor.x + popup.width / 2)
  minY = Math.min(minY, anchorY - popup.height)
  maxY = Math.max(maxY, anchorY)
  return {
    width: maxX - minX,
    height: maxY - minY,
    center: L.point((minX + maxX) / 2, (minY + maxY) / 2),
  }
}

/** Zoom out only as far as needed so the whole cluster sits in the open map. */
function fitClusterInFreeSpace(map: L.Map, cluster: IncidentCluster) {
  const size = map.getSize()
  const { left, right } = focusInsets(map)
  const popup = clusterPopupBox(map)
  const margin = 20
  const freeLeft = left + margin
  const freeRight = right + margin
  const freeTop = margin
  const freeBottom = margin
  const availW = Math.max(64, size.x - freeLeft - freeRight)
  const availH = Math.max(64, size.y - freeTop - freeBottom)
  const snap = map.options.zoomSnap || 0.25
  const minZoom = map.getMinZoom()
  const start = map.getZoom()
  const steps = Math.max(0, Math.round((start - minZoom) / snap))
  let chosen = minZoom
  for (let index = 0; index <= steps; index += 1) {
    const zoom = Math.round((start - index * snap) / snap) * snap
    const layout = clusterScreenLayout(map, cluster, zoom, popup)
    if (layout.width <= availW && layout.height <= availH) {
      chosen = zoom
      break
    }
  }
  const layout = clusterScreenLayout(map, cluster, chosen, popup)
  const desiredX = freeLeft + availW / 2
  const desiredY = freeTop + availH / 2
  const viewCenter = map.unproject(
    L.point(layout.center.x - desiredX + size.x / 2, layout.center.y - desiredY + size.y / 2),
    chosen,
  )
  map.flyTo(viewCenter, chosen, { animate: true, duration: 0.4, easeLinearity: 0.35 })
}

function flyPinIntoView(
  map: L.Map,
  latlng: L.LatLngExpression,
  animate: boolean,
  options?: { zoom?: number; topPad?: number; allowZoomOut?: boolean; duration?: number },
) {
  const requested = options?.zoom ?? PIN_FOCUS_ZOOM
  const zoom = options?.allowZoomOut ? requested : Math.max(map.getZoom(), requested)
  const size = map.getSize()
  const { left, right } = focusInsets(map)
  const desiredX = left + (size.x - left - right) / 2
  // Shift the target down so content above it (cluster popup) stays in frame.
  const topPad = options?.topPad ?? 0
  const desiredY = size.y / 2 + topPad / 2
  const projected = map.project(latlng, zoom)
  const centerPoint = L.point(
    projected.x - desiredX + size.x / 2,
    projected.y - desiredY + size.y / 2,
  )
  const center = map.unproject(centerPoint, zoom)
  if (animate) {
    map.flyTo(center, zoom, {
      animate: true,
      duration: options?.duration ?? 0.35,
      easeLinearity: 0.25,
    })
  } else {
    map.setView(center, zoom, { animate: false })
  }
}

function markerTitle(incident: Incident): string {
  const sos = incident.msgId != null ? incident.msgId : incident.id
  const people = incident.people > 0 ? `${incident.people} people` : 'people unknown'
  return `${incident.type} SOS ${sos}, ${people}`
}

function markerClasses(incident: Incident, selectedId: string | null): string {
  return `geo-marker sos ${incident.type.toLowerCase()} ${incident.status === 'NEW' ? 'new' : ''} ${selectedId === incident.id ? 'chosen' : ''}`.trim()
}

function responderIcon() {
  return L.divIcon({
    className: 'responder-marker-host',
    html: '<span class="responder-marker" title="This portal"><i></i></span>',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

function markerDivIcon(button: HTMLButtonElement, size: number): L.DivIcon {
  return L.divIcon({
    className: 'geo-marker-host',
    html: button,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function applyPinElementSize(marker: L.Marker, button: HTMLButtonElement, size: number) {
  button.style.width = '100%'
  button.style.height = '100%'
  button.style.minWidth = '0'
  button.style.minHeight = '0'
  const svg = button.querySelector('svg')
  if (svg) {
    svg.style.width = '55%'
    svg.style.height = '55%'
  }
  const el = marker.getElement()
  if (el) {
    el.style.setProperty('width', `${size}px`, 'important')
    el.style.setProperty('height', `${size}px`, 'important')
    el.style.setProperty('margin-left', `${-size / 2}px`, 'important')
    el.style.setProperty('margin-top', `${-size / 2}px`, 'important')
  }
  const icon = marker.options.icon as L.DivIcon | undefined
  if (icon?.options) {
    icon.options.iconSize = [size, size]
    icon.options.iconAnchor = [size / 2, size / 2]
  }
}

export default function IncidentMap({
  incidents,
  selectedId,
  onSelectIncident,
  onClearSelection,
  devicePosition = null,
  dispatchStops = [],
  dispatchOrder = [],
  highlightedDispatchId = null,
  dispatchFocus = null,
  onDispatchEtas,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<string, { marker: L.Marker; button: HTMLButtonElement }>>(new Map())
  const layerRef = useRef<L.LayerGroup | null>(null)
  const clusterLayerRef = useRef<L.LayerGroup | null>(null)
  const routeLayerRef = useRef<L.LayerGroup | null>(null)
  const deviceLayerRef = useRef<L.LayerGroup | null>(null)
  const deviceMarkerRef = useRef<L.Marker | null>(null)
  const routeSignatureRef = useRef('')
  const heatLayersRef = useRef<Map<PriorityLevel, L.HeatLayer>>(new Map())
  const heatSignatureRef = useRef('')
  const clustersDataRef = useRef<IncidentCluster[]>([])
  const clusterHitRef = useRef<Map<string, {
    circle: L.Circle
    signature: string
    popup: L.Popup
    cluster: IncidentCluster
    memberIds: string[]
  }>>(new Map())
  const openClusterIdRef = useRef<string | null>(null)
  const hoverClusterIdRef = useRef<string | null>(null)
  const hoverPinIdRef = useRef<string | null>(null)
  const savedViewRef = useRef<{ center: L.LatLng; zoom: number } | null>(null)
  const savedClusterViewRef = useRef<{ center: L.LatLng; zoom: number } | null>(null)
  const suppressRestoreRef = useRef(false)
  const selectRef = useRef(onSelectIncident)
  const clearSelectRef = useRef(onClearSelection)
  const selectedRef = useRef(selectedId)
  const clusterFitTokenRef = useRef(0)
  const firstSelect = useRef(true)
  const didFit = useRef(false)
  const [mapError, setMapError] = useState(false)
  const [streetGraph, setStreetGraph] = useState<StreetGraph | null>(null)
  const syncMapChromeRef = useRef<(map: L.Map, opts?: { syncHeat?: boolean }) => void>(() => {})
  const onDispatchEtasRef = useRef(onDispatchEtas)
  onDispatchEtasRef.current = onDispatchEtas
  const seenDispatchStopIdsRef = useRef<Set<string>>(new Set())
  const pendingRouteFitRef = useRef(false)
  const awaitingRouteFitRef = useRef(false)
  const routeFitFrameRef = useRef(0)

  selectRef.current = onSelectIncident
  clearSelectRef.current = onClearSelection
  selectedRef.current = selectedId

  /** Cluster outlines + per-pin hover. Pin-direct hover suppresses cluster-wide outlines. */
  function applyHighlights() {
    const hoverPin = hoverPinIdRef.current
    const activeId = hoverPin ? null : (hoverClusterIdRef.current ?? openClusterIdRef.current)
    const members = activeId ? new Set(clusterHitRef.current.get(activeId)?.memberIds ?? []) : null
    for (const [id, entry] of markersRef.current) {
      entry.button.classList.toggle('cluster-linked', members?.has(id) ?? false)
      entry.button.classList.toggle('pin-highlight', id === hoverPin)
    }
  }

  function clusterIdAtLatLng(latlng: L.LatLng): string | null {
    let best: string | null = null
    let bestDist = Infinity
    for (const [id, entry] of clusterHitRef.current) {
      const dist = latlng.distanceTo(entry.cluster.center)
      if (dist <= entry.circle.getRadius() && dist < bestDist) {
        best = id
        bestDist = dist
      }
    }
    return best
  }

  function eventOverMarker(event: L.LeafletMouseEvent): boolean {
    const target = event.originalEvent?.target
    return target instanceof Element && Boolean(target.closest('.geo-marker, .geo-marker-host'))
  }

  function setHoverCluster(clusterId: string | null) {
    if (hoverClusterIdRef.current === clusterId) return
    hoverClusterIdRef.current = clusterId
    applyHighlights()
  }

  function setHoverPin(pinId: string | null) {
    if (hoverPinIdRef.current === pinId) return
    hoverPinIdRef.current = pinId
    if (pinId) hoverClusterIdRef.current = null
    applyHighlights()
  }

  function bindPinHover(button: HTMLButtonElement, incidentId: string) {
    button.onmouseenter = () => setHoverPin(incidentId)
    button.onmouseleave = event => {
      if (hoverPinIdRef.current === incidentId) {
        hoverPinIdRef.current = null
        applyHighlights()
      }
      const map = mapRef.current
      if (!map) return
      // Leaving a pin onto heat should restore cluster outlines without waiting for the next move.
      setHoverCluster(clusterIdAtLatLng(map.mouseEventToLatLng(event)))
    }
  }

  function applyMarkerSizes(map: L.Map) {
    const size = markerPixelSizeForZoom(map.getZoom())
    map.getContainer().style.setProperty('--pin-size', `${size}px`)
    for (const entry of markersRef.current.values()) {
      applyPinElementSize(entry.marker, entry.button, size)
    }
  }

  function captureView(map: L.Map) {
    if (savedViewRef.current) return
    savedViewRef.current = { center: map.getCenter(), zoom: map.getZoom() }
  }

  function restoreView(map: L.Map) {
    const saved = savedViewRef.current
    if (!saved) return
    savedViewRef.current = null
    map.flyTo(saved.center, saved.zoom, { animate: true, duration: 0.35, easeLinearity: 0.35 })
  }

  function restoreViewIfIdle(map: L.Map) {
    if (suppressRestoreRef.current) return
    if (selectedRef.current != null || openClusterIdRef.current != null) return
    restoreView(map)
  }

  function restoreClusterView(map: L.Map) {
    const saved = savedClusterViewRef.current
    savedClusterViewRef.current = null
    if (!saved || suppressRestoreRef.current) return
    map.flyTo(saved.center, saved.zoom, { animate: true, duration: 0.35, easeLinearity: 0.35 })
  }

  syncMapChromeRef.current = (map, opts) => {
    const zoom = map.getZoom()
    const animating = Boolean((map as L.Map & { _animatingZoom?: boolean })._animatingZoom)
    // setOptions → redraw mid-zoomanim cancels the CSS transform and causes snap/lag.
    // Only refresh heat radius/blur + organic point layout when idle (zoomend).
    const syncHeat = opts?.syncHeat ?? !animating
    if (syncHeat) {
      applyHeatBuckets(heatLayersRef.current, clustersDataRef.current, zoom, heatSignatureRef)
      for (const [level, layer] of heatLayersRef.current) {
        layer.setOptions(heatStyleForZoom(zoom, PRIORITY_HEAT_GRADIENTS[level]))
      }
    }
    applyMarkerSizes(map)
    applyHighlights()
    for (const entry of clusterHitRef.current.values()) {
      entry.circle.setRadius(clusterHitRadiusMeters(entry.cluster, zoom))
      const anchor = clusterPopupAnchor(entry.cluster.center, clusterPopupRadiusMeters(entry.cluster, zoom))
      if (openClusterIdRef.current && clusterHitRef.current.get(openClusterIdRef.current) === entry) {
        entry.popup.setLatLng(anchor)
      }
    }
  }

  useEffect(() => {
    const map = L.map(host.current!, {
      center: [33.771, -84.387],
      zoom: 15,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 11,
      maxZoom: 19,
      bounceAtZoomLimits: false,
      zoomControl: false,
      preferCanvas: true,
    })
    mapRef.current = map
    L.control.zoom({ position: 'bottomleft' }).addTo(map)
    map.attributionControl.setPrefix(false)

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_3z1f_1_5d09fcb81bc5744792fbd5f9', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)

    clusterLayerRef.current = L.layerGroup().addTo(map)
    patchLeafletHeatZoomAnimation()
    // One heat layer per priority so radial fade never samples higher-priority colors.
    const heatLayers = new Map<PriorityLevel, L.HeatLayer>()
    ;([1, 2, 3, 4, 5] as PriorityLevel[]).forEach(level => {
      heatLayers.set(
        level,
        L.heatLayer([], heatStyleForZoom(map.getZoom(), PRIORITY_HEAT_GRADIENTS[level])).addTo(map),
      )
    })
    heatLayersRef.current = heatLayers
    const onZoomChrome = () => syncMapChromeRef.current(map, { syncHeat: false })
    const onZoomEndChrome = () => syncMapChromeRef.current(map, { syncHeat: true })
    onZoomEndChrome()
    // Live chrome (pins/hit targets) on `zoom`; heat setOptions only on zoomend so it
    // does not fight zoomanim CSS transforms on the heat canvases.
    map.on('zoom', onZoomChrome)
    map.on('zoomend', onZoomEndChrome)
    // Map-level hover: heat-area cluster outlines, but not while the pointer is on a pin.
    map.on('mousemove', event => {
      if (eventOverMarker(event) || hoverPinIdRef.current) {
        setHoverCluster(null)
        return
      }
      setHoverCluster(clusterIdAtLatLng(event.latlng))
    })
    map.getContainer().addEventListener('mouseleave', () => {
      setHoverPin(null)
      setHoverCluster(null)
    })
    // Route under the pins; the portal marker sits above both.
    routeLayerRef.current = L.layerGroup().addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    deviceLayerRef.current = L.layerGroup().addTo(map)

    map.on('popupclose', event => {
      for (const [id, entry] of clusterHitRef.current) {
        if (entry.popup !== event.popup) continue
        if (openClusterIdRef.current === id) openClusterIdRef.current = null
        if (hoverClusterIdRef.current === id) hoverClusterIdRef.current = null
        applyHighlights()
        restoreClusterView(map)
        break
      }
    })

    const controller = new AbortController()
    fetch(`${import.meta.env.BASE_URL}maps/atlanta.geojson`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw Error('Local map unavailable')
        return response.json()
      })
      .then((data: FeatureCollection) => {
        if (controller.signal.aborted) return
        setStreetGraph(buildStreetGraph(data))
        const overlay = {
          type: 'FeatureCollection' as const,
          features: data.features.filter(feature => {
            const p = feature.properties
            return Boolean(p?.highway || p?.building || p?.leisure)
          }),
        }
        L.geoJSON(overlay, {
          interactive: false,
          style: feature => {
            const p = feature?.properties
            if (p?.highway) {
              return { color: '#65727a', weight: p.highway === 'footway' || p.highway === 'path' ? 0.7 : 1.1, opacity: 0.34, fillOpacity: 0 }
            }
            return p?.leisure
              ? { color: '#3f6250', weight: 1, fillColor: '#203a2a', fillOpacity: 0.55 }
              : { color: '#58616c', weight: 0.4, fillColor: '#2c333c', fillOpacity: 0.7 }
          },
        }).addTo(map)
      })
      .catch(error => {
        if (error.name !== 'AbortError') setMapError(true)
      })

    const onResize = () => map.invalidateSize({ pan: false })
    onResize()
    const observer = new ResizeObserver(onResize)
    observer.observe(host.current!)
    return () => {
      controller.abort()
      observer.disconnect()
      map.remove()
      mapRef.current = null
      layerRef.current = null
      routeLayerRef.current = null
      deviceLayerRef.current = null
      deviceMarkerRef.current = null
      clusterLayerRef.current = null
      heatLayersRef.current.clear()
      heatSignatureRef.current = ''
      clusterHitRef.current.clear()
      openClusterIdRef.current = null
      hoverClusterIdRef.current = null
      hoverPinIdRef.current = null
      savedViewRef.current = null
      savedClusterViewRef.current = null
      markersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const clusters = clusterLayerRef.current
    const heatLayers = heatLayersRef.current
    if (!map || !clusters || heatLayers.size === 0) return

    const next = clusterIncidents(incidents)
    clustersDataRef.current = next
    const nextIds = new Set(next.map(cluster => cluster.id))
    const reopenId = openClusterIdRef.current
    applyHeatBuckets(heatLayers, next, map.getZoom(), heatSignatureRef)

    for (const [id, entry] of clusterHitRef.current) {
      if (!nextIds.has(id)) {
        clusters.removeLayer(entry.circle)
        clusterHitRef.current.delete(id)
        if (hoverClusterIdRef.current === id) hoverClusterIdRef.current = null
        if (openClusterIdRef.current === id || reopenId === id) {
          openClusterIdRef.current = null
          map.closePopup(entry.popup)
          restoreClusterView(map)
        }
      }
    }

    next.forEach(cluster => {
      const signature = clusterSignature(cluster)
      const hitRadius = clusterHitRadiusMeters(cluster, map.getZoom())
      const anchor = clusterPopupAnchor(cluster.center, clusterPopupRadiusMeters(cluster, map.getZoom()))
      const memberIds = cluster.incidents.map(incident => incident.id)
      const existing = clusterHitRef.current.get(cluster.id)

      if (existing && existing.signature === signature) {
        existing.cluster = cluster
        existing.memberIds = memberIds
        existing.circle.setRadius(hitRadius)
        return
      }

      if (existing) {
        clusters.removeLayer(existing.circle)
      }

      const popup = L.popup({
        className: 'cluster-popup',
        closeButton: true,
        autoClose: true,
        closeOnClick: true,
        autoPan: false,
        // Positive Y pulls the tip down onto the heat fringe instead of floating above it.
        offset: L.point(0, 10),
      }).setContent(clusterPopup(cluster))

      // Invisible hit target — sized to the visible heat footprint at the current zoom.
      const circle = L.circle(cluster.center, {
        radius: hitRadius,
        color: '#000',
        weight: 0,
        opacity: 0,
        fillColor: '#000',
        fillOpacity: 0.001,
        interactive: true,
        renderer: L.svg({ padding: 0.5 }),
        className: 'cluster-heat-hit',
      })

      const clusterId = cluster.id
      circle.on('click', event => {
        L.DomEvent.stopPropagation(event.originalEvent)
        const entry = clusterHitRef.current.get(clusterId)
        if (!entry) return
        const fitToken = ++clusterFitTokenRef.current
        const incidentWasOpen = selectedRef.current != null
        // Always snapshot the view right before cluster focus so close can restore it,
        // even if an incident detail selection is already holding savedViewRef.
        savedClusterViewRef.current = { center: map.getCenter(), zoom: map.getZoom() }
        openClusterIdRef.current = clusterId
        hoverClusterIdRef.current = null
        applyHighlights()
        const nextAnchor = clusterPopupAnchor(
          entry.cluster.center,
          clusterPopupRadiusMeters(entry.cluster, map.getZoom()),
        )
        entry.popup.setLatLng(nextAnchor).openOn(map)
        if (incidentWasOpen) {
          // Drop the report panel first so the fit uses the map it was covering.
          clearSelectRef.current?.()
          const run = (tries: number) => {
            if (clusterFitTokenRef.current !== fitToken) return
            const peek = map.getContainer().closest('.workspace')?.querySelector('.report-detail-peek')
            if (peek && tries > 0) {
              requestAnimationFrame(() => run(tries - 1))
              return
            }
            if (openClusterIdRef.current !== clusterId) return
            const latest = clusterHitRef.current.get(clusterId)
            if (!latest) return
            fitClusterInFreeSpace(map, latest.cluster)
          }
          requestAnimationFrame(() => run(12))
        } else {
          flyPinIntoView(map, entry.cluster.center, true, {
            zoom: CLUSTER_FOCUS_ZOOM,
            topPad: CLUSTER_POPUP_TOP_PAD,
          })
        }
        firstSelect.current = false
      })

      circle.addTo(clusters)
      clusterHitRef.current.set(clusterId, { circle, signature, popup, cluster, memberIds })

      if (reopenId === clusterId) {
        openClusterIdRef.current = clusterId
        popup.setLatLng(anchor).openOn(map)
      }
    })

    applyHighlights()
  }, [incidents])

  // Build / refresh markers only when the incident list changes — not on selection.
  useEffect(() => {
    const map = mapRef.current
    const layers = layerRef.current
    if (!map || !layers) return
    const size = markerPixelSizeForZoom(map.getZoom())
    map.getContainer().style.setProperty('--pin-size', `${size}px`)

    const nextIds = new Set(incidents.map(i => i.id))
    for (const [id, entry] of markersRef.current) {
      if (!nextIds.has(id)) {
        if (hoverPinIdRef.current === id) hoverPinIdRef.current = null
        layers.removeLayer(entry.marker)
        markersRef.current.delete(id)
      }
    }

    incidents.forEach(incident => {
      const point = coordinates(incident)
      if (!point) return
      const existing = markersRef.current.get(incident.id)
      if (existing) {
        const current = existing.marker.getLatLng()
        if (current.lat !== point[0] || current.lng !== point[1]) {
          existing.marker.setLatLng(point)
        }
        existing.button.className = markerClasses(incident, selectedRef.current)
        existing.button.dataset.mapPin = incident.id
        existing.button.innerHTML = emergencyIconHtml(incident.type)
        existing.button.title = markerTitle(incident)
        existing.button.setAttribute('aria-label', existing.button.title)
        applyPinElementSize(existing.marker, existing.button, size)
        bindPinHover(existing.button, incident.id)
        existing.button.onclick = event => {
          event.stopPropagation()
          clusterFitTokenRef.current += 1
          suppressRestoreRef.current = true
          map.closePopup()
          openClusterIdRef.current = null
          hoverClusterIdRef.current = null
          applyHighlights()
          suppressRestoreRef.current = false
          selectRef.current(incident.id)
        }
        return
      }

      const button = document.createElement('button')
      button.type = 'button'
      button.className = markerClasses(incident, selectedRef.current)
      button.dataset.mapPin = incident.id
      button.innerHTML = emergencyIconHtml(incident.type)
      button.title = markerTitle(incident)
      button.setAttribute('aria-label', button.title)
      bindPinHover(button, incident.id)
      button.onclick = event => {
        event.stopPropagation()
        clusterFitTokenRef.current += 1
        suppressRestoreRef.current = true
        map.closePopup()
        openClusterIdRef.current = null
        hoverClusterIdRef.current = null
        applyHighlights()
        suppressRestoreRef.current = false
        selectRef.current(incident.id)
      }
      const marker = L.marker(point, {
        icon: markerDivIcon(button, size),
        keyboard: false,
      }).addTo(layers)
      applyPinElementSize(marker, button, size)
      markersRef.current.set(incident.id, { marker, button })
    })

    applyHighlights()
  }, [incidents])

  useEffect(() => {
    const map = mapRef.current
    if (!map || didFit.current || selectedRef.current) return
    const points = incidents.flatMap(incident => {
      const point = coordinates(incident)
      return point ? [point] : []
    })
    if (!points.length) return
    didFit.current = true
    const left = leftChromeWidth(map)
    map.fitBounds(L.latLngBounds(points).pad(0.2), {
      paddingTopLeft: [left, 32],
      paddingBottomRight: [32, 32],
      animate: false,
    })
  }, [incidents])

  // Selection highlight only — no marker teardown.
  useEffect(() => {
    const order = new Map(dispatchOrder.map((id, index) => [id, index + 1]))
    for (const [id, entry] of markersRef.current) {
      const number = order.get(id)
      const focused = id === highlightedDispatchId
      entry.button.classList.toggle('chosen', id === selectedId)
      entry.button.classList.toggle('on-dispatch', number != null)
      entry.button.classList.toggle('dispatch-focus', focused)
      entry.marker.setZIndexOffset(focused ? 1500 : number != null ? 400 : 0)
      const host = entry.marker.getElement()
      if (host) host.style.overflow = 'visible'
      let badge = entry.button.querySelector('.dispatch-order-badge')
      if (number == null) {
        badge?.remove()
        continue
      }
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'dispatch-order-badge'
        entry.button.appendChild(badge)
      }
      badge.textContent = String(number)
    }
  }, [selectedId, incidents, dispatchOrder, highlightedDispatchId])

  useEffect(() => {
    const layer = deviceLayerRef.current
    if (!layer) return
    if (!devicePosition) {
      layer.clearLayers()
      deviceMarkerRef.current = null
      return
    }
    if (deviceMarkerRef.current) {
      deviceMarkerRef.current.setLatLng(devicePosition)
      return
    }
    deviceMarkerRef.current = L.marker(devicePosition, {
      icon: responderIcon(),
      zIndexOffset: 1200,
      keyboard: false,
    }).addTo(layer)
  }, [devicePosition])

  useEffect(() => {
    const layer = routeLayerRef.current
    if (!layer) return
    const stopIds = dispatchStops.map(stop => stop.id)
    const seen = seenDispatchStopIdsRef.current
    const membershipChanged = seen.size !== stopIds.length || stopIds.some(id => !seen.has(id))
    if (membershipChanged) pendingRouteFitRef.current = true
    seenDispatchStopIdsRef.current = new Set(stopIds)

    const signature = [
      streetGraph ? 'map' : 'wait',
      devicePosition ? `${devicePosition[0].toFixed(4)},${devicePosition[1].toFixed(4)}` : '',
      dispatchStops.map(stop => `${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`).join('|'),
    ].join('~')
    let routeReady = false
    if (signature !== routeSignatureRef.current) {
      routeSignatureRef.current = signature
      layer.clearLayers()
      if (!streetGraph || !devicePosition || dispatchStops.length === 0) {
        onDispatchEtasRef.current?.({})
      } else {
        const { path, minutesById } = routeDispatch(streetGraph, devicePosition, dispatchStops)
        onDispatchEtasRef.current?.(minutesById)
        if (path.length >= 2) {
          routeReady = true
          L.polyline(path, {
            color: '#8de0af',
            weight: 6,
            opacity: 0.2,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false,
          }).addTo(layer)
          L.polyline(path, {
            color: '#b8f2c5',
            weight: 2.5,
            opacity: 0.95,
            dashArray: '8 9',
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false,
          }).addTo(layer)
        }
      }
    } else if (layer.getLayers().length > 0) {
      routeReady = true
    }

    if (routeReady && awaitingRouteFitRef.current) pendingRouteFitRef.current = true
    if (!pendingRouteFitRef.current) return
    // One camera move per queue change. Wait until the street graph can draw the
    // path so the fly is not followed by a second correction.
    if (dispatchStops.length > 0 && !routeReady && !streetGraph) return

    pendingRouteFitRef.current = false
    awaitingRouteFitRef.current = dispatchStops.length > 0 && !routeReady
    suppressRestoreRef.current = true
    window.cancelAnimationFrame(routeFitFrameRef.current)
    routeFitFrameRef.current = window.requestAnimationFrame(() => {
      settleDispatchView()
      window.requestAnimationFrame(() => {
        suppressRestoreRef.current = false
      })
    })
  }, [devicePosition, dispatchStops, streetGraph])

  // Smooth pan when the selected report changes (not when only status updates).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (!selectedId) {
      restoreViewIfIdle(map)
      return
    }

    const entry = markersRef.current.get(selectedId)
    if (!entry) return
    const point = entry.marker.getLatLng()
    const frame = window.requestAnimationFrame(() => {
      captureView(map)
      flyPinIntoView(map, point, !firstSelect.current)
      firstSelect.current = false
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedId])

  const dispatchFocusRef = useRef(dispatchFocus)
  dispatchFocusRef.current = dispatchFocus
  const dispatchStopsRef = useRef(dispatchStops)
  dispatchStopsRef.current = dispatchStops
  const devicePositionRef = useRef(devicePosition)
  devicePositionRef.current = devicePosition

  useEffect(() => {
    const focus = dispatchFocusRef.current
    const map = mapRef.current
    if (!map || !focus) return
    const entry = markersRef.current.get(focus.id)
    const stop = dispatchStopsRef.current.find(item => item.id === focus.id)
    const point = entry?.marker.getLatLng() ?? (stop ? L.latLng(stop.lat, stop.lon) : null)
    if (!point) return
    const frame = window.requestAnimationFrame(() => {
      flyPinIntoView(map, point, true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dispatchFocus?.token])

  function fitCoordinates(points: L.LatLngTuple[]) {
    const map = mapRef.current
    if (!map || !points.length) return
    const { left, right } = focusInsets(map)
    if (points.length === 1) {
      flyPinIntoView(map, points[0], true, { zoom: 16, allowZoomOut: true })
      return
    }
    map.fitBounds(L.latLngBounds(points).pad(0.2), {
      paddingTopLeft: [left, 48],
      paddingBottomRight: [right, 48],
      animate: true,
      duration: 0.35,
      maxZoom: 16,
    })
  }

  function fitIncidents() {
    fitCoordinates(
      incidents.flatMap(incident => {
        const point = coordinates(incident)
        return point ? [point] : []
      }),
    )
  }

  function routeCoordinates(): L.LatLngTuple[] {
    const points: L.LatLngTuple[] = []
    routeLayerRef.current?.eachLayer(layer => {
      const polyline = layer as L.Polyline
      if (typeof polyline.getLatLngs !== 'function') return
      const latlngs = polyline.getLatLngs().flat(2) as L.LatLng[]
      for (const latlng of latlngs) {
        if (latlng && typeof latlng.lat === 'number') points.push([latlng.lat, latlng.lng])
      }
    })
    return points
  }

  function dispatchViewPadding(map: L.Map): { left: number; right: number; top: number; bottom: number } {
    const { left, right } = focusInsets(map)
    return { left, right, top: 56, bottom: 56 }
  }

  /** Pixel size of `bounds` if the map were at `zoom`. */
  function boundsPixelSize(map: L.Map, bounds: L.LatLngBounds, zoom: number) {
    const southWest = map.project(bounds.getSouthWest(), zoom)
    const northEast = map.project(bounds.getNorthEast(), zoom)
    return {
      width: Math.abs(northEast.x - southWest.x),
      height: Math.abs(northEast.y - southWest.y),
    }
  }

  /** Center that puts the bounds in the middle of the map area the panels do not cover. */
  function centerForBounds(
    map: L.Map,
    bounds: L.LatLngBounds,
    zoom: number,
    padding: { left: number; right: number; top: number; bottom: number },
  ) {
    const size = map.getSize()
    const southWest = map.project(bounds.getSouthWest(), zoom)
    const northEast = map.project(bounds.getNorthEast(), zoom)
    const midX = (southWest.x + northEast.x) / 2
    const midY = (southWest.y + northEast.y) / 2
    const freeX = padding.left + (size.x - padding.left - padding.right) / 2
    const freeY = padding.top + (size.y - padding.top - padding.bottom) / 2
    return map.unproject(L.point(midX + size.x / 2 - freeX, midY + size.y / 2 - freeY), zoom)
  }

  function flyMapToPoints(
    points: L.LatLngTuple[],
    padding: { left: number; right: number; top: number; bottom: number },
    maxZoom: number,
  ) {
    const map = mapRef.current
    if (!map || !points.length) return
    const bounds = L.latLngBounds(points)
    if (!bounds.isValid()) return
    const framed = points.length === 1 ? bounds.pad(0.004) : bounds.pad(0.08)
    const options = {
      paddingTopLeft: [padding.left, padding.top] as [number, number],
      paddingBottomRight: [padding.right, padding.bottom] as [number, number],
      maxZoom,
    }
    const fit = (map as L.Map & {
      _getBoundsCenterZoom: (b: L.LatLngBounds, o: typeof options) => { zoom: number; center: L.LatLng }
    })._getBoundsCenterZoom(framed, options)
    const current = map.getZoom()
    const size = map.getSize()
    const needed = boundsPixelSize(map, bounds, current)
    const roomX = size.x - padding.left - padding.right - 48
    const roomY = size.y - padding.top - padding.bottom - 48
    const alreadyInView = needed.width <= roomX && needed.height <= roomY
    // Zoom out only when the route does not fit. If it already fits, stay put
    // unless it is a small patch in a wide view, which should come closer.
    let zoom = current
    if (!alreadyInView) zoom = fit.zoom
    else if (fit.zoom > current + 0.5) zoom = Math.min(fit.zoom, maxZoom)
    const center = centerForBounds(map, bounds, zoom, padding)
    const zoomDelta = Math.abs(zoom - current)
    const pixelDelta = map.project(map.getCenter(), zoom).distanceTo(map.project(center, zoom))
    if (zoomDelta < 0.2 && pixelDelta < 28) return
    map.flyTo(center, zoom, { duration: 1.05, easeLinearity: 0.2 })
  }

  function fitDispatchRoute() {
    const map = mapRef.current
    const points = [
      ...routeCoordinates(),
      ...dispatchStopsRef.current.map(stop => [stop.lat, stop.lon] as L.LatLngTuple),
    ]
    const device = devicePositionRef.current
    if (device) points.push(device)
    if (!map || !points.length) return
    flyMapToPoints(points, dispatchViewPadding(map), 17)
  }

  function settleDispatchView() {
    const map = mapRef.current
    if (!map) return
    if (dispatchStopsRef.current.length) {
      fitDispatchRoute()
      return
    }
    const { left, right } = focusInsets(map)
    flyMapToPoints(
      incidents.flatMap(incident => {
        const point = coordinates(incident)
        return point ? [point] : []
      }),
      { left, right, top: 56, bottom: 64 },
      16,
    )
  }

  return (
    <section className="panel map-panel geographic-panel" aria-label="Incident map">
      <div className="geo-canvas" ref={host} />
      <button type="button" className="fit-network" onClick={fitIncidents} aria-label="Fit incidents" title="Fit incidents">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="9" cy="9" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {mapError && <p className="geo-warning">Local map could not load. Emergency markers remain available.</p>}
    </section>
  )
}
