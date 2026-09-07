import { useEffect, useState } from "react";

/**
 * Four views and no nested routes, so a router library would be more
 * dependency than design. The hash keeps deep links and the browser back
 * button working, which is what a router was actually for here.
 */
export function useHashRoute(fallback: string): [string, (next: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, "") || fallback;
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  });

  const navigate = (next: string) => { window.location.hash = `/${next}`; };
  return [route, navigate];
}
