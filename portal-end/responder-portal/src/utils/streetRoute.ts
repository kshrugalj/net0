import type { FeatureCollection, LineString } from 'geojson'
import type L from 'leaflet'

type Coordinate = L.LatLngTuple

interface Edge {
  to: string
  cost: number
}

export interface StreetGraph {
  coordinates: Map<string, Coordinate>
  edges: Map<string, Edge[]>
}

const CLOSED_HIGHWAYS = new Set([
  'abandoned',
  'construction',
  'corridor',
  'motorway',
  'motorway_link',
  'planned',
  'proposed',
  'raceway',
  'trunk',
  'trunk_link',
])

function nodeKey(point: Coordinate): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`
}

function distance(a: Coordinate, b: Coordinate): number {
  const latScale = 111_000
  const lonScale = 111_000 * Math.cos((a[0] * Math.PI) / 180)
  return Math.hypot((b[0] - a[0]) * latScale, (b[1] - a[1]) * lonScale)
}

function edgeMultiplier(highway: string): number {
  if (highway === 'steps') return 3
  if (highway === 'footway' || highway === 'path' || highway === 'pedestrian' || highway === 'cycleway') return 1.35
  if (highway === 'service' || highway === 'track') return 1.15
  return 1
}

function addEdge(graph: StreetGraph, from: string, to: string, cost: number) {
  const edges = graph.edges.get(from) ?? []
  if (!edges.some(edge => edge.to === to)) edges.push({ to, cost })
  graph.edges.set(from, edges)
}

export function buildStreetGraph(data: FeatureCollection): StreetGraph {
  const graph: StreetGraph = { coordinates: new Map(), edges: new Map() }
  for (const feature of data.features) {
    const highway = typeof feature.properties?.highway === 'string' ? feature.properties.highway : ''
    if (!highway || CLOSED_HIGHWAYS.has(highway) || feature.geometry.type !== 'LineString') continue
    const coordinates = (feature.geometry as LineString).coordinates
      .map(([lon, lat]) => [lat, lon] as Coordinate)
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
    for (let index = 1; index < coordinates.length; index += 1) {
      const from = coordinates[index - 1]
      const to = coordinates[index]
      const fromKey = nodeKey(from)
      const toKey = nodeKey(to)
      const cost = distance(from, to) * edgeMultiplier(highway)
      graph.coordinates.set(fromKey, from)
      graph.coordinates.set(toKey, to)
      addEdge(graph, fromKey, toKey, cost)
      addEdge(graph, toKey, fromKey, cost)
    }
  }
  return graph
}

function nearestNode(graph: StreetGraph, point: Coordinate): string | null {
  let nearest: string | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const [key, coordinate] of graph.coordinates) {
    const currentDistance = distance(point, coordinate)
    if (currentDistance < nearestDistance) {
      nearest = key
      nearestDistance = currentDistance
    }
  }
  return nearest
}

class MinHeap {
  private values: Array<{ key: string; cost: number }> = []

  push(value: { key: string; cost: number }) {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.values[parent].cost <= value.cost) break
      this.values[index] = this.values[parent]
      index = parent
    }
    this.values[index] = value
  }

  pop(): { key: string; cost: number } | undefined {
    if (!this.values.length) return undefined
    const first = this.values[0]
    const last = this.values.pop()!
    if (this.values.length) {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        if (left >= this.values.length) break
        const child = right < this.values.length && this.values[right].cost < this.values[left].cost ? right : left
        if (this.values[child].cost >= last.cost) break
        this.values[index] = this.values[child]
        index = child
      }
      this.values[index] = last
    }
    return first
  }
}

/** Off-road gaps shorter than this stay a straight stub, such as a pin just inside a building. */
const ROAD_JUMP_METERS = 200

function jumpArc(from: Coordinate, to: Coordinate): Coordinate[] {
  const latScale = 111_000
  const lonScale = 111_000 * Math.cos((from[0] * Math.PI) / 180)
  const dx = (to[1] - from[1]) * lonScale
  const dy = (to[0] - from[0]) * latScale
  const length = Math.hypot(dx, dy)
  if (length < 1) return [to]
  const bow = Math.min(length * 0.14, 280)
  const nx = -dy / length
  const ny = dx / length
  const steps = 8
  const points: Coordinate[] = []
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps
    const lift = Math.sin(Math.PI * t) * bow
    points.push([from[0] + (dy * t + ny * lift) / latScale, from[1] + (dx * t + nx * lift) / lonScale])
  }
  return points
}

/** Straight stub for a short gap. A long gap bows so the missing road reads as a hop. */
function bridge(from: Coordinate, to: Coordinate): Coordinate[] {
  const gap = distance(from, to)
  if (gap < 6) return []
  if (gap < ROAD_JUMP_METERS) return [to]
  return jumpArc(from, to)
}

function appendPoints(path: Coordinate[], points: Coordinate[]) {
  for (const point of points) {
    const previous = path[path.length - 1]
    if (!previous || distance(previous, point) >= 1) path.push(point)
  }
}

function roadPath(graph: StreetGraph, startKey: string, targetKey: string, previous: Map<string, string>): Coordinate[] {
  if (startKey === targetKey) {
    const only = graph.coordinates.get(startKey)
    return only ? [only] : []
  }
  const keys = [targetKey]
  while (keys[0] !== startKey) {
    const parent = previous.get(keys[0])
    if (!parent) {
      const start = graph.coordinates.get(startKey)
      return start ? [start] : []
    }
    keys.unshift(parent)
  }
  return keys.flatMap(key => {
    const point = graph.coordinates.get(key)
    return point ? [point] : []
  })
}

export function findStreetRoute(graph: StreetGraph, start: Coordinate, end: Coordinate): Coordinate[] {
  const startKey = nearestNode(graph, start)
  const endKey = nearestNode(graph, end)
  if (!startKey || !endKey) {
    const path = [start]
    appendPoints(path, bridge(start, end))
    return path.length > 1 ? path : []
  }

  const distances = new Map<string, number>([[startKey, 0]])
  const previous = new Map<string, string>()
  const queue = new MinHeap()
  queue.push({ key: startKey, cost: 0 })
  const startCoordinate = graph.coordinates.get(startKey)!
  let nearestReachable = startKey
  let nearestGap = distance(startCoordinate, end)

  while (true) {
    const current = queue.pop()
    if (!current) break
    if (current.cost !== distances.get(current.key)) continue
    const coordinate = graph.coordinates.get(current.key)
    if (coordinate) {
      const gap = distance(coordinate, end)
      if (gap < nearestGap) {
        nearestGap = gap
        nearestReachable = current.key
      }
    }
    if (current.key === endKey) break
    for (const edge of graph.edges.get(current.key) ?? []) {
      const nextCost = current.cost + edge.cost
      if (nextCost < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, nextCost)
        previous.set(edge.to, current.key)
        queue.push({ key: edge.to, cost: nextCost })
      }
    }
  }

  const targetKey = distances.has(endKey) ? endKey : nearestReachable
  const road = roadPath(graph, startKey, targetKey, previous)
  if (!road.length) return []
  const path = [start]
  appendPoints(path, bridge(start, road[0]))
  appendPoints(path, road)
  appendPoints(path, bridge(road[road.length - 1], end))
  return path.length > 1 ? path : []
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.map(item => item)]
  const result: T[][] = []
  items.forEach((item, index) => {
    const rest = items.slice(0, index).concat(items.slice(index + 1))
    for (const perm of permutations(rest)) result.push([item, ...perm])
  })
  return result
}

function tourCost(start: Coordinate, stops: Coordinate[]): number {
  let total = 0
  let cursor = start
  for (const stop of stops) {
    total += distance(cursor, stop)
    cursor = stop
  }
  return total
}

/** Shortest visit order from `start` through every stop. Open tour, no return leg. */
export function orderCoordinates(start: Coordinate, stops: Coordinate[]): Coordinate[] {
  if (stops.length <= 1) return stops.map(stop => [stop[0], stop[1]] as Coordinate)
  const tours: Coordinate[][] = stops.length > 8 ? [nearestNeighbor(start, stops)] : permutations(stops)
  let best = tours[0]
  let bestCost = Number.POSITIVE_INFINITY
  for (const tour of tours) {
    const cost = tourCost(start, tour)
    if (cost < bestCost) {
      best = tour
      bestCost = cost
    }
  }
  return best.map(stop => [stop[0], stop[1]] as Coordinate)
}

function nearestNeighbor(start: Coordinate, stops: Coordinate[]): Coordinate[] {
  const remaining = stops.map(stop => [stop[0], stop[1]] as Coordinate)
  const ordered: Coordinate[] = []
  let cursor = start
  while (remaining.length) {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY
    remaining.forEach((stop, index) => {
      const current = distance(cursor, stop)
      if (current < bestDistance) {
        bestIndex = index
        bestDistance = current
      }
    })
    const [next] = remaining.splice(bestIndex, 1)
    ordered.push(next)
    cursor = next
  }
  return ordered
}

export function orderByLocation<T extends { lat: number; lon: number }>(start: Coordinate | null, stops: T[]): T[] {
  if (!start || stops.length <= 1) return [...stops]
  const coordinates = orderCoordinates(
    start,
    stops.map(stop => [stop.lat, stop.lon]),
  )
  const remaining = [...stops]
  return coordinates.map(point => {
    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY
    remaining.forEach((stop, index) => {
      const current = distance(point, [stop.lat, stop.lon])
      if (current < bestDistance) {
        bestIndex = index
        bestDistance = current
      }
    })
    return remaining.splice(bestIndex, 1)[0]
  })
}

/** Street-following path from the portal through each stop. A long gap with no road bows across. */
export function routeThrough(graph: StreetGraph, start: Coordinate, stops: Coordinate[]): Coordinate[] {
  const ordered = orderCoordinates(start, stops)
  let path: Coordinate[] = []
  let from = start
  for (const stop of ordered) {
    const leg = findStreetRoute(graph, from, stop)
    if (leg.length < 2) continue
    path = path.length ? path.concat(leg.slice(1)) : leg
    from = stop
  }
  return path
}

/** Urban response speed used to turn the drawn street route into an arrival time. */
const RESPONSE_SPEED_MPS = (25 * 1609.344) / 3600

function pathLength(path: Coordinate[]): number {
  let total = 0
  for (let index = 1; index < path.length; index += 1) {
    total += distance(path[index - 1], path[index])
  }
  return total
}

export function formatArrival(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes))
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  if (!rest) return hours === 1 ? '1 hr' : `${hours} hr`
  return `${hours} hr ${rest} min`
}

/**
 * One pass along the same street route the map draws.
 * Minutes are cumulative driving time from `start` through each stop in visit order.
 */
export function routeDispatch(
  graph: StreetGraph,
  start: Coordinate,
  stops: Array<{ id: string; lat: number; lon: number }>,
): { path: Coordinate[]; minutesById: Record<string, number> } {
  const ordered = orderByLocation(start, stops)
  let path: Coordinate[] = []
  let from = start
  let seconds = 0
  const minutesById: Record<string, number> = {}
  for (const stop of ordered) {
    const target: Coordinate = [stop.lat, stop.lon]
    const leg = findStreetRoute(graph, from, target)
    const meters = leg.length >= 2 ? pathLength(leg) : distance(from, target)
    seconds += meters / RESPONSE_SPEED_MPS
    minutesById[stop.id] = Math.max(1, Math.round(seconds / 60))
    if (leg.length >= 2) path = path.length ? path.concat(leg.slice(1)) : leg
    from = target
  }
  return { path, minutesById }
}
