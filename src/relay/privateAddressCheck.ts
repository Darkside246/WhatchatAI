import net from 'node:net';

/**
 * Whether a resolved IP address falls in a private, loopback, link-local,
 * or otherwise non-public range. Used by the relay to refuse to connect to
 * the Gemini upstream if DNS resolves its hostname to an internal address
 * (a real DNS-rebinding defense, not a theoretical one - see
 * `openclawRelayServer.ts`'s doc comment). Deliberately hand-rolled rather
 * than pulled in as a dependency: the rule set is small, fixed, and worth
 * being able to read in full without trusting a third-party package's
 * definition of "private."
 */
export function isPrivateOrLoopbackAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a recognizable IP at all - refuse rather than guess
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast/reserved (224.0.0.0/4) and above
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized === '::') return true; // unspecified
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true; // fe80::/10 link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 unique local
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 address - check the embedded IPv4 address too.
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  return false;
}
