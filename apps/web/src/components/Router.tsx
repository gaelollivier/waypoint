/**
 * Minimal client-side router — no external dependency.
 * Uses history.pushState + popstate for navigation.
 */
import { createContext, useContext, useEffect, useState, useCallback } from "react";

interface LocationCtx {
  path: string;
  params: Record<string, string>;
}

const LocationContext = createContext<LocationCtx>({ path: "/", params: {} });

function parsePath(pattern: string, path: string): Record<string, string> | null {
  const patParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function Router({ children }: { children: React.ReactNode }) {
  const [loc, setLoc] = useState<LocationCtx>({
    path: window.location.pathname,
    params: {},
  });

  useEffect(() => {
    const handler = () =>
      setLoc({ path: window.location.pathname, params: {} });
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return (
    <LocationContext.Provider value={loc}>{children}</LocationContext.Provider>
  );
}

export function useLocation() {
  return useContext(LocationContext);
}

export function navigate(href: string) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

interface RouteProps {
  path: string;
  component: React.ComponentType<Record<string, string>>;
}

export function Routes({ routes }: { routes: RouteProps[] }) {
  const { path } = useLocation();
  for (const route of routes) {
    const params = parsePath(route.path, path);
    if (params !== null) {
      return <route.component {...params} />;
    }
  }
  return <div className="text-zinc-500 p-6">Page not found</div>;
}
