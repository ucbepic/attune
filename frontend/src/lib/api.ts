export function getEndpoint(path: string = "") {
  const isLocalhost = typeof window !== "undefined" && window.location.hostname === "localhost"
  const base = isLocalhost ? "http://localhost:8000" : (process.env.NEXT_PUBLIC_API_URL ?? "")
  return `${base}${path}`
}
