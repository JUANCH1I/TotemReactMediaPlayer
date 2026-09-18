// A venue may run its own streaming server on the local network with no TLS.
// Plain http is accepted only when the host is a private IPv4 address, so a
// pasted public http URL is still refused.

const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/

export function isPrivateIpv4(host) {
  if (typeof host !== 'string' || !PRIVATE_IPV4.test(host)) return false
  return host.split('.').every((octet) => Number(octet) <= 255)
}

// Returns the host of an http URL when it points into a private network,
// otherwise null. Only the authority is parsed; no URL API is needed on the
// television's JavaScript runtime.
export function privateHttpHost(url) {
  if (typeof url !== 'string') return null
  const match = /^http:\/\/([^/?#:\s]+)(?::\d{1,5})?(?:[/?#][^\s]*)?$/.exec(url)
  if (!match) return null
  return isPrivateIpv4(match[1]) ? match[1] : null
}

export function isAcceptableStreamUrl(url) {
  if (typeof url !== 'string' || /\s/.test(url)) return false
  if (/^https:\/\/[^\s]+$/.test(url)) return true
  return privateHttpHost(url) !== null
}
