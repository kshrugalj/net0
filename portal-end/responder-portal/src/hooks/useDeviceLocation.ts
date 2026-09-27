import { useEffect, useState } from 'react'

/** Live GPS for the portal device this page is open on. */
export function useDeviceLocation(): [number, number] | null {
  const [position, setPosition] = useState<[number, number] | null>(null)

  useEffect(() => {
    if (!navigator.geolocation) return
    const watchId = navigator.geolocation.watchPosition(
      next => {
        setPosition([next.coords.latitude, next.coords.longitude])
      },
      () => {
        // Keep the last fix if a later reading fails.
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  return position
}
